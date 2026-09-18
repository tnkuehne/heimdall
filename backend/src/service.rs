use crate::capture::{self, CaptureState};
use crate::recording::{self, RecordingState};
use crate::{auth, config, transcription};
use anyhow::{Context, Result};
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::thread;
use std::time::Duration;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::OwnedFd;
use zbus::DBusError;
use zeroize::Zeroizing;

pub const BUS_NAME: &str = "com.timokuehne.MeetingRecorder1";
pub const OBJECT_PATH: &str = "/com/timokuehne/MeetingRecorder1";
pub const INTERFACE_NAME: &str = "com.timokuehne.MeetingRecorder1";

const MAX_API_KEY_BYTES: u64 = 64 * 1024;

#[derive(Debug, DBusError)]
#[zbus(prefix = "com.timokuehne.MeetingRecorder1.Error")]
enum ServiceError {
    #[zbus(error)]
    ZBus(zbus::Error),
    InvalidProvider(String),
    InvalidArgument(String),
    Failed(String),
}

#[derive(Clone)]
struct RecordingCoordinator {
    gate: Arc<Mutex<()>>,
    state: Arc<RwLock<CoordinatedRecordingState>>,
}

struct CoordinatedRecordingState {
    current: RecordingState,
    notification_pending: bool,
}

impl RecordingCoordinator {
    fn new(state: RecordingState) -> Self {
        Self {
            gate: Arc::new(Mutex::new(())),
            state: Arc::new(RwLock::new(CoordinatedRecordingState {
                current: state,
                notification_pending: false,
            })),
        }
    }

    fn snapshot(&self) -> RecordingState {
        read_lock(&self.state).current.clone()
    }

    fn pending_notification(&self) -> Option<RecordingState> {
        let state = read_lock(&self.state);
        state.notification_pending.then(|| state.current.clone())
    }

    fn mark_notification_published(&self, published: &RecordingState) {
        let mut state = write_lock(&self.state);
        if !recording_state_changed(published, &state.current) {
            state.notification_pending = false;
        }
    }

    fn replace_state(&self, current: RecordingState) {
        let mut state = write_lock(&self.state);
        state.notification_pending |= recording_state_changed(&state.current, &current);
        state.current = current;
    }

    async fn refresh(&self) -> Result<RecordingState> {
        self.run_operation(recording::status).await
    }

    async fn start(&self) -> Result<RecordingState> {
        self.run_operation(recording::start).await
    }

    async fn stop(&self) -> Result<RecordingState> {
        self.run_operation(recording::stop).await
    }

    async fn run_operation(
        &self,
        operation: impl FnOnce() -> Result<RecordingState> + Send + 'static,
    ) -> Result<RecordingState> {
        let coordinator = self.clone();
        blocking::unblock(move || {
            let _guard = mutex_lock(&coordinator.gate);
            let state = operation()?;
            coordinator.replace_state(state.clone());
            Ok(state)
        })
        .await
    }
}

#[derive(Clone)]
struct MeetingRecorderService {
    recordings: RecordingCoordinator,
    capture: Arc<RwLock<CaptureState>>,
}

impl MeetingRecorderService {
    fn new(recording: RecordingState) -> Self {
        Self {
            recordings: RecordingCoordinator::new(recording),
            capture: Arc::new(RwLock::new(CaptureState::default())),
        }
    }

    async fn emit_recording_changes(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.recording_changed(emitter).await?;
        self.recording_file_changed(emitter).await?;
        self.started_at_changed(emitter).await
    }

    async fn publish_pending_recording_changes(
        &self,
        emitter: &SignalEmitter<'_>,
    ) -> zbus::Result<()> {
        while let Some(published) = self.recordings.pending_notification() {
            self.emit_recording_changes(emitter).await?;
            self.recordings.mark_notification_published(&published);
        }
        Ok(())
    }

    fn start_automatic_transcription(
        &self,
        audio_file: PathBuf,
        connection: &zbus::Connection,
        emitter: SignalEmitter<'static>,
    ) {
        let audio_file_for_signal = audio_file.to_string_lossy().into_owned();
        connection
            .executor()
            .spawn(
                async move {
                    let result = blocking::unblock(move || {
                        let Some(provider) = config::transcription_provider()? else {
                            return Ok(None);
                        };
                        transcription::transcribe(provider, audio_file, None, false, true, None)
                            .map(Some)
                    })
                    .await;

                    match result {
                        Ok(Some(summary)) => {
                            let transcript_file = summary.transcript_file.to_string_lossy();
                            if let Err(error) = Self::transcription_completed(
                                &emitter,
                                &audio_file_for_signal,
                                &transcript_file,
                                summary
                                    .post_transcribe_hook_error
                                    .as_deref()
                                    .unwrap_or_default(),
                            )
                            .await
                            {
                                eprintln!("failed to emit transcription completion: {error}");
                            }
                        }
                        Err(error) => {
                            if let Err(signal_error) = Self::transcription_failed(
                                &emitter,
                                &audio_file_for_signal,
                                &error.to_string(),
                            )
                            .await
                            {
                                eprintln!("failed to emit transcription failure: {signal_error}");
                            }
                        }
                        Ok(None) => {}
                    }
                },
                "automatic transcription",
            )
            .detach();
    }

    async fn apply_capture_state(
        &self,
        state: CaptureState,
        emitter: &SignalEmitter<'_>,
    ) -> zbus::Result<()> {
        let previous = {
            let mut capture = write_lock(&self.capture);
            let previous = *capture;
            *capture = state;
            previous
        };

        if previous.browser_audio_capture != state.browser_audio_capture {
            self.browser_audio_capture_changed(emitter).await?;
        }
        if previous.browser_video_capture != state.browser_video_capture {
            self.browser_video_capture_changed(emitter).await?;
        }
        Ok(())
    }
}

#[zbus::interface(interface = "com.timokuehne.MeetingRecorder1")]
impl MeetingRecorderService {
    #[zbus(out_args("recording", "file", "started_at", "message"))]
    async fn get_status(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> Result<(bool, String, String, String), ServiceError> {
        let state = self
            .recordings
            .refresh()
            .await
            .map_err(ServiceError::operation)?;
        self.publish_pending_recording_changes(&emitter).await?;
        Ok(status_tuple(&state))
    }

    #[zbus(out_args("file", "started_at"))]
    async fn start_recording(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> Result<(String, String), ServiceError> {
        let state = self
            .recordings
            .start()
            .await
            .map_err(ServiceError::operation)?;
        self.publish_pending_recording_changes(&emitter).await?;
        Ok((
            optional_path(&state.file),
            optional_string(&state.started_at),
        ))
    }

    #[zbus(out_args("file"))]
    async fn stop_recording(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> Result<String, ServiceError> {
        let state = self
            .recordings
            .stop()
            .await
            .map_err(ServiceError::operation)?;
        self.publish_pending_recording_changes(&emitter).await?;

        if let Some(audio_file) = state.file.clone() {
            self.start_automatic_transcription(audio_file, connection, emitter.to_owned());
        }

        Ok(optional_path(&state.file))
    }

    #[zbus(out_args("transcript_file", "post_transcribe_hook_error"))]
    async fn transcribe(
        &self,
        audio_file: String,
        provider: String,
        language: String,
        format: bool,
        multichannel: bool,
        output: String,
    ) -> Result<(String, String), ServiceError> {
        let provider = normalize_provider(&provider)?;
        if audio_file.is_empty() {
            return Err(ServiceError::InvalidArgument(
                "audio_file must not be empty".to_owned(),
            ));
        }

        let summary = blocking::unblock(move || {
            transcription::transcribe(
                provider,
                PathBuf::from(audio_file),
                nonempty(language),
                format,
                multichannel,
                nonempty(output).map(PathBuf::from),
            )
        })
        .await
        .map_err(ServiceError::operation)?;

        Ok((
            summary.transcript_file.to_string_lossy().into_owned(),
            summary.post_transcribe_hook_error.unwrap_or_default(),
        ))
    }

    #[zbus(out_args("configured"))]
    async fn get_api_key_status(&self, provider: String) -> Result<bool, ServiceError> {
        let provider = normalize_provider(&provider)?;
        blocking::unblock(move || auth::status(provider).map(|status| status.configured))
            .await
            .map_err(ServiceError::operation)
    }

    async fn set_api_key(&self, provider: String, api_key: OwnedFd) -> Result<(), ServiceError> {
        let provider = normalize_provider(&provider)?;
        let api_key = blocking::unblock(move || read_api_key(api_key)).await?;
        if api_key.trim().is_empty() {
            return Err(ServiceError::InvalidArgument(
                "API key must not be empty".to_owned(),
            ));
        }

        blocking::unblock(move || auth::set_api_key_value(provider, &api_key).map(|_| ()))
            .await
            .map_err(ServiceError::operation)
    }

    async fn delete_api_key(&self, provider: String) -> Result<(), ServiceError> {
        let provider = normalize_provider(&provider)?;
        blocking::unblock(move || auth::delete_api_key(provider).map(|_| ()))
            .await
            .map_err(ServiceError::operation)
    }

    #[zbus(property)]
    fn recording(&self) -> bool {
        self.recordings.snapshot().recording
    }

    #[zbus(property)]
    fn recording_file(&self) -> String {
        optional_path(&self.recordings.snapshot().file)
    }

    #[zbus(property)]
    fn started_at(&self) -> String {
        optional_string(&self.recordings.snapshot().started_at)
    }

    #[zbus(property)]
    fn browser_audio_capture(&self) -> bool {
        read_lock(&self.capture).browser_audio_capture
    }

    #[zbus(property)]
    fn browser_video_capture(&self) -> bool {
        read_lock(&self.capture).browser_video_capture
    }

    #[zbus(signal)]
    async fn transcription_completed(
        emitter: &SignalEmitter<'_>,
        audio_file: &str,
        transcript_file: &str,
        post_transcribe_hook_error: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn transcription_failed(
        emitter: &SignalEmitter<'_>,
        audio_file: &str,
        message: &str,
    ) -> zbus::Result<()>;
}

impl ServiceError {
    fn operation(error: anyhow::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

pub fn run() -> Result<()> {
    zbus::block_on(async {
        let initial_state = blocking::unblock(recording::status)
            .await
            .context("failed to read initial recording state")?;
        let service = MeetingRecorderService::new(initial_state);
        let connection = zbus::connection::Builder::session()?
            .name(BUS_NAME)?
            .serve_at(OBJECT_PATH, service.clone())?
            .build()
            .await
            .context("failed to publish Meeting Recorder on the session bus")?;

        let emitter = SignalEmitter::new(&connection, OBJECT_PATH)?.into_owned();
        spawn_capture_monitor(connection.clone(), service.clone(), emitter.clone());
        spawn_recording_monitor(connection, service, emitter);

        std::future::pending::<()>().await;
        #[allow(unreachable_code)]
        Ok(())
    })
}

pub fn start() -> Result<RecordingState> {
    let (file, started_at): (String, String) =
        with_blocking_proxy(|proxy| proxy.call("StartRecording", &()))?;
    Ok(RecordingState {
        recording: true,
        pid: None,
        file: path_from_string(file),
        partial_file: None,
        started_at: nonempty(started_at),
        message: None,
    })
}

pub fn stop() -> Result<RecordingState> {
    let file: String = with_blocking_proxy(|proxy| proxy.call("StopRecording", &()))?;
    Ok(RecordingState {
        recording: false,
        pid: None,
        file: path_from_string(file),
        partial_file: None,
        started_at: None,
        message: Some("stopped".to_owned()),
    })
}

pub fn status() -> Result<RecordingState> {
    let (recording, file, started_at, message): (bool, String, String, String) =
        with_blocking_proxy(|proxy| proxy.call("GetStatus", &()))?;
    Ok(RecordingState {
        recording,
        pid: None,
        file: path_from_string(file),
        partial_file: None,
        started_at: nonempty(started_at),
        message: nonempty(message),
    })
}

fn with_blocking_proxy<T>(
    call: impl FnOnce(&zbus::blocking::Proxy<'_>) -> zbus::Result<T>,
) -> Result<T> {
    let connection =
        zbus::blocking::Connection::session().context("failed to connect to the session bus")?;
    let proxy = zbus::blocking::Proxy::new(&connection, BUS_NAME, OBJECT_PATH, INTERFACE_NAME)
        .context("failed to create Meeting Recorder D-Bus proxy")?;
    call(&proxy).context("Meeting Recorder D-Bus call failed")
}

fn spawn_capture_monitor(
    connection: zbus::Connection,
    service: MeetingRecorderService,
    emitter: SignalEmitter<'static>,
) {
    let (sender, receiver) = async_channel::unbounded();
    thread::Builder::new()
        .name("capture-monitor".to_owned())
        .spawn(move || loop {
            let result = capture::monitor(|state| {
                sender
                    .send_blocking(state)
                    .context("D-Bus service stopped receiving capture state")
            });
            if sender.is_closed() {
                return;
            }
            if let Err(error) = result {
                eprintln!("capture monitor failed: {error:#}");
            }
            thread::sleep(Duration::from_secs(5));
        })
        .expect("failed to start capture monitor thread");

    connection
        .executor()
        .spawn(
            async move {
                while let Ok(state) = receiver.recv().await {
                    if let Err(error) = service.apply_capture_state(state, &emitter).await {
                        eprintln!("failed to publish capture state: {error}");
                    }
                }
            },
            "capture property publisher",
        )
        .detach();
}

fn spawn_recording_monitor(
    connection: zbus::Connection,
    service: MeetingRecorderService,
    emitter: SignalEmitter<'static>,
) {
    connection
        .executor()
        .spawn(
            async move {
                loop {
                    async_io::Timer::after(Duration::from_secs(1)).await;
                    if let Err(error) = service.recordings.refresh().await {
                        eprintln!("failed to refresh recording state: {error:#}");
                    }
                    if let Err(error) = service.publish_pending_recording_changes(&emitter).await {
                        eprintln!("failed to publish recording state: {error}");
                    }
                }
            },
            "recording state monitor",
        )
        .detach();
}

fn recording_state_changed(previous: &RecordingState, current: &RecordingState) -> bool {
    previous.recording != current.recording
        || previous.file != current.file
        || previous.started_at != current.started_at
}

fn normalize_provider(provider: &str) -> Result<&'static str, ServiceError> {
    auth::normalize_provider(provider)
        .map_err(|error| ServiceError::InvalidProvider(error.to_string()))
}

fn read_api_key(api_key: OwnedFd) -> Result<Zeroizing<String>, ServiceError> {
    let fd: std::os::fd::OwnedFd = api_key.into();
    let mut bytes = Zeroizing::new(Vec::new());
    File::from(fd)
        .take(MAX_API_KEY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            ServiceError::Failed(format!(
                "failed to read API key from Unix file descriptor: {error}"
            ))
        })?;
    if bytes.len() as u64 > MAX_API_KEY_BYTES {
        return Err(ServiceError::InvalidArgument(
            "API key exceeds the 64 KiB limit".to_owned(),
        ));
    }
    let value = String::from_utf8(std::mem::take(&mut *bytes))
        .map_err(|_| ServiceError::InvalidArgument("API key is not UTF-8".to_owned()))?;
    Ok(Zeroizing::new(value))
}

fn status_tuple(state: &RecordingState) -> (bool, String, String, String) {
    (
        state.recording,
        optional_path(&state.file),
        optional_string(&state.started_at),
        optional_string(&state.message),
    )
}

fn optional_path(path: &Option<PathBuf>) -> String {
    path.as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn optional_string(value: &Option<String>) -> String {
    value.clone().unwrap_or_default()
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn path_from_string(value: String) -> Option<PathBuf> {
    nonempty(value).map(PathBuf::from)
}

fn mutex_lock<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::fd::OwnedFd as StdOwnedFd;
    use std::os::unix::net::UnixStream;

    fn normalized_interface(xml: &str) -> String {
        let interface_start = format!(r#"<interface name="{INTERFACE_NAME}">"#);
        let mut inside_interface = false;
        let mut lines = Vec::new();

        for line in xml.lines() {
            let line = line.trim();
            if line == interface_start {
                inside_interface = true;
            }
            if inside_interface {
                lines.push(line);
            }
            if inside_interface && line == "</interface>" {
                return lines.join("\n");
            }
        }

        panic!("XML does not contain {INTERFACE_NAME}");
    }

    #[test]
    fn rust_interface_matches_authoritative_xml() {
        let service = MeetingRecorderService::new(RecordingState::idle(None));
        let mut generated = String::new();
        <MeetingRecorderService as zbus::object_server::Interface>::introspect_to_writer(
            &service,
            &mut generated,
            0,
        );

        let expected = include_str!("../../data/com.timokuehne.MeetingRecorder1.xml");
        assert!(expected.contains(&format!(r#"<node name="{OBJECT_PATH}">"#)));
        assert_eq!(
            normalized_interface(&generated),
            normalized_interface(expected)
        );
    }

    #[test]
    fn empty_dbus_values_map_to_absent_domain_values() {
        assert_eq!(nonempty(String::new()), None);
        assert_eq!(path_from_string(String::new()), None);
    }

    #[test]
    fn provider_errors_use_the_public_domain_error() {
        let error = normalize_provider("unknown").unwrap_err();
        assert!(matches!(error, ServiceError::InvalidProvider(_)));
    }

    #[test]
    fn api_key_is_read_from_a_unix_file_descriptor() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"secret-value").unwrap();
        drop(writer);

        let descriptor = OwnedFd::from(StdOwnedFd::from(reader));
        assert_eq!(&*read_api_key(descriptor).unwrap(), "secret-value");
    }

    #[test]
    fn api_key_file_descriptor_rejects_invalid_utf8() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(&[0xff]).unwrap();
        drop(writer);

        let descriptor = OwnedFd::from(StdOwnedFd::from(reader));
        let error = read_api_key(descriptor).unwrap_err();
        assert!(error.to_string().contains("API key is not UTF-8"));
    }

    #[test]
    fn api_key_file_descriptor_has_a_size_limit() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        let writer = thread::spawn(move || {
            writer
                .write_all(&vec![b'x'; MAX_API_KEY_BYTES as usize + 1])
                .unwrap();
        });

        let descriptor = OwnedFd::from(StdOwnedFd::from(reader));
        let error = read_api_key(descriptor).unwrap_err();
        writer.join().unwrap();
        assert!(error.to_string().contains("exceeds the 64 KiB limit"));
    }

    #[test]
    fn unchanged_refresh_cannot_consume_a_pending_recording_notification() {
        let running = RecordingState {
            recording: true,
            pid: Some(42),
            file: Some(PathBuf::from("recording.mp3")),
            partial_file: Some(PathBuf::from("recording.part.mp3")),
            started_at: Some("2026-09-09T12:00:00Z".to_owned()),
            message: None,
        };
        let coordinator = RecordingCoordinator::new(running);
        let stopped =
            RecordingState::idle(Some("recording process exited unexpectedly".to_owned()));

        coordinator.replace_state(stopped.clone());
        coordinator.replace_state(stopped);

        let pending = coordinator
            .pending_notification()
            .expect("the externally observed transition must remain pending");
        coordinator.mark_notification_published(&pending);
        assert!(coordinator.pending_notification().is_none());
    }
}
