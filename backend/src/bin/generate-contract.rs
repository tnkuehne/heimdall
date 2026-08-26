use anyhow::{bail, Context, Result};
use meeting_recorder::protocol::{
    AuthStatus, CaptureEventType, CaptureStateEvent, ContractSchema, ExtensionConfig,
    OpenFolderResult, ProviderBaseUrls, RecordingStatus, TranscriptionProvider,
    TranscriptionSummary,
};
use schemars::generate::SchemaSettings;
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const SCHEMA_ID: &str = "urn:heimdall:contract:backend:v1";

#[derive(Serialize)]
struct ContractFixtures {
    recording_status: RecordingStatus,
    extension_config: ExtensionConfig,
    auth_status: AuthStatus,
    transcription_summary: TranscriptionSummary,
    open_folder_result: OpenFolderResult,
    capture_state_event: CaptureStateEvent,
}

fn main() -> Result<()> {
    let check = match env::args().nth(1).as_deref() {
        None => false,
        Some("--check") => true,
        Some(argument) => bail!("unsupported argument: {argument}"),
    };

    let schema = generated_schema()?;
    let fixtures = generated_fixtures()?;
    let repository = repository_path()?;
    let schema_path = repository.join("contracts").join("backend.schema.json");
    let fixtures_path = repository.join("contracts").join("backend.fixtures.json");

    if check {
        check_file(&schema_path, &schema)?;
        check_file(&fixtures_path, &fixtures)
    } else {
        write_file(&schema_path, &schema)?;
        write_file(&fixtures_path, &fixtures)
    }
}

fn generated_schema() -> Result<String> {
    let schema = SchemaSettings::draft2020_12()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<ContractSchema>();
    let mut value = serde_json::to_value(schema).context("failed to serialize contract schema")?;
    let object = value
        .as_object_mut()
        .context("Schemars generated a non-object root schema")?;
    object.insert("$id".to_owned(), Value::String(SCHEMA_ID.to_owned()));

    let mut output =
        serde_json::to_string_pretty(&value).context("failed to format contract schema")?;
    output.push('\n');
    Ok(output)
}

fn generated_fixtures() -> Result<String> {
    let fixtures = ContractFixtures {
        recording_status: RecordingStatus {
            recording: true,
            pid: Some(4242),
            file: Some(PathBuf::from("/tmp/meeting.mp3")),
            partial_file: Some(PathBuf::from("/tmp/meeting.part.mp3")),
            started_at: Some("2026-08-26T12:00:00+02:00".to_owned()),
            message: None,
        },
        extension_config: ExtensionConfig {
            transcription_provider: Some(TranscriptionProvider::Xai),
            provider_base_urls: ProviderBaseUrls {
                xai: Some("https://example.test".to_owned()),
                deepgram: None,
            },
            meeting_detection_reminder_enabled: true,
            recordings_dir: PathBuf::from("/tmp/recordings"),
            post_transcribe_hook: None,
        },
        auth_status: AuthStatus {
            provider: TranscriptionProvider::Deepgram,
            configured: true,
        },
        transcription_summary: TranscriptionSummary {
            provider: TranscriptionProvider::Xai,
            audio_file: PathBuf::from("/tmp/meeting.mp3"),
            transcript_file: PathBuf::from("/tmp/meeting.transcript.md"),
            text: Some("Hello".to_owned()),
            duration: Some(1.25),
            channels: Some(json!({ "provider_specific": ["value"] })),
            post_transcribe_hook_error: None,
        },
        open_folder_result: OpenFolderResult {
            opened: true,
            folder: PathBuf::from("/tmp/recordings"),
        },
        capture_state_event: CaptureStateEvent {
            event_type: CaptureEventType::CaptureState,
            browser_audio_capture: true,
            browser_video_capture: false,
            browser_capture: true,
        },
    };

    let mut output =
        serde_json::to_string_pretty(&fixtures).context("failed to format contract fixtures")?;
    output.push('\n');
    Ok(output)
}

fn repository_path() -> Result<PathBuf> {
    let backend = Path::new(env!("CARGO_MANIFEST_DIR"));
    backend
        .parent()
        .map(Path::to_path_buf)
        .context("backend manifest directory has no repository parent")
}

fn check_file(path: &Path, expected: &str) -> Result<()> {
    let actual = fs::read_to_string(path)
        .with_context(|| format!("generated contract is missing: {}", path.display()))?;
    if actual != expected {
        bail!(
            "generated contract is stale: {}; run `pnpm generate:contracts`",
            path.display()
        );
    }

    Ok(())
}

fn write_file(path: &Path, contents: &str) -> Result<()> {
    let parent = path
        .parent()
        .context("contract schema output path has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    fs::write(path, contents).with_context(|| format!("failed to write {}", path.display()))
}
