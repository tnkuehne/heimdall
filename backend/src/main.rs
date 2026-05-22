use anyhow::{anyhow, bail, Context, Result};
use chrono::Local;
mod auth;
mod config;
mod transcription;

use clap::{ArgAction, Parser, Subcommand};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

const STATE_DIR_NAME: &str = "meeting-recorder";
const STATE_FILE_NAME: &str = "state.json";
const LOG_FILE_NAME: &str = "ffmpeg.log";

#[derive(Parser)]
#[command(name = "meeting-recorder")]
#[command(about = "Record the default microphone and current system output into an MP3 file.")]
struct Cli {
    #[command(subcommand)]
    command: CommandKind,
}

#[derive(Subcommand)]
enum CommandKind {
    Start,
    Stop,
    Status,
    OpenFolder,
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    Transcribe {
        audio_file: PathBuf,
        #[arg(long, default_value = "xai")]
        provider: String,
        #[arg(long)]
        language: Option<String>,
        #[arg(long)]
        format: bool,
        #[arg(long = "single-channel", action = ArgAction::SetFalse)]
        multichannel: bool,
        #[arg(long)]
        output: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum AuthCommand {
    Set { provider: String },
    SetStdin { provider: String },
    Status { provider: String },
    Delete { provider: String },
}

#[derive(Subcommand)]
enum ConfigCommand {
    Get,
    SetProvider { provider: String },
    SetRecordingsDir { path: PathBuf },
    ResetRecordingsDir,
    SetPostTranscribeHook { path: PathBuf },
    ClearPostTranscribeHook,
}

#[derive(Debug, Serialize, Deserialize)]
struct RecordingState {
    recording: bool,
    pid: Option<i32>,
    file: Option<PathBuf>,
    partial_file: Option<PathBuf>,
    started_at: Option<String>,
    message: Option<String>,
}

impl RecordingState {
    fn idle(message: impl Into<Option<String>>) -> Self {
        Self {
            recording: false,
            pid: None,
            file: None,
            partial_file: None,
            started_at: None,
            message: message.into(),
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        CommandKind::Start => print_json(&start()?),
        CommandKind::Stop => print_json(&stop()?),
        CommandKind::Status => print_json(&status()?),
        CommandKind::OpenFolder => {
            let folder = config::recordings_dir()?;
            fs::create_dir_all(&folder)?;
            Command::new("xdg-open")
                .arg(&folder)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .context("failed to open recordings folder with xdg-open")?;
            print_json(&serde_json::json!({ "opened": true, "folder": folder }))
        }
        CommandKind::Config { command } => match command {
            ConfigCommand::Get => print_json(&config::get()?),
            ConfigCommand::SetProvider { provider } => {
                print_json(&config::set_transcription_provider(&provider)?)
            }
            ConfigCommand::SetRecordingsDir { path } => {
                print_json(&config::set_recordings_dir(&path)?)
            }
            ConfigCommand::ResetRecordingsDir => print_json(&config::reset_recordings_dir()?),
            ConfigCommand::SetPostTranscribeHook { path } => {
                print_json(&config::set_post_transcribe_hook(&path)?)
            }
            ConfigCommand::ClearPostTranscribeHook => {
                print_json(&config::clear_post_transcribe_hook()?)
            }
        },
        CommandKind::Auth { command } => match command {
            AuthCommand::Set { provider } => print_json(&auth::set_api_key(&provider)?),
            AuthCommand::SetStdin { provider } => {
                print_json(&auth::set_api_key_from_stdin(&provider)?)
            }
            AuthCommand::Status { provider } => print_json(&auth::status(&provider)?),
            AuthCommand::Delete { provider } => print_json(&auth::delete_api_key(&provider)?),
        },
        CommandKind::Transcribe {
            audio_file,
            provider,
            language,
            format,
            multichannel,
            output,
        } => print_json(&transcription::transcribe(
            &provider,
            audio_file,
            language,
            format,
            multichannel,
            output,
        )?),
    }
}

fn start() -> Result<RecordingState> {
    ensure_dependency("ffmpeg")?;
    ensure_dependency("wpctl")?;

    let current = status()?;
    if current.recording {
        return Ok(current);
    }

    let recordings = config::recordings_dir()?;
    let state_dir = state_dir()?;
    fs::create_dir_all(&recordings)?;
    fs::create_dir_all(&state_dir)?;

    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let partial_file = recordings.join(format!("{timestamp}.part.mp3"));
    let final_file = recordings.join(format!("{timestamp}.mp3"));
    let log_file = state_dir.join(LOG_FILE_NAME);
    let microphone_source = default_pipewire_node_name("@DEFAULT_AUDIO_SOURCE@")?;
    let monitor_source = format!(
        "{}.monitor",
        default_pipewire_node_name("@DEFAULT_AUDIO_SINK@")?
    );

    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .with_context(|| format!("failed to open ffmpeg log at {}", log_file.display()))?;
    let log_err = log
        .try_clone()
        .context("failed to clone ffmpeg log handle")?;

    let mut ffmpeg = Command::new("ffmpeg");
    ffmpeg
        .args([
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "warning",
            "-f",
            "pulse",
            "-i",
            &microphone_source,
            "-f",
            "pulse",
            "-i",
            &monitor_source,
            "-filter_complex",
            "[0:a]aformat=channel_layouts=mono[mic];[1:a]aformat=channel_layouts=mono[system];[mic][system]amerge=inputs=2[a]",
            "-map",
            "[a]",
            "-ac",
            "2",
            "-ar",
            "24000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "64k",
            "-y",
        ])
        .arg(&partial_file)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    unsafe {
        ffmpeg.pre_exec(|| {
            nix::unistd::setsid().map_err(std::io::Error::other)?;
            Ok(())
        });
    }

    let child = ffmpeg.spawn().context("failed to start ffmpeg")?;
    let pid = child.id() as i32;

    thread::sleep(Duration::from_millis(300));
    if !recording_process_is_running(pid, Some(&partial_file)) {
        bail!(
            "ffmpeg exited immediately; check {} for details",
            log_file.display()
        );
    }

    let state = RecordingState {
        recording: true,
        pid: Some(pid),
        file: Some(final_file),
        partial_file: Some(partial_file),
        started_at: Some(Local::now().to_rfc3339()),
        message: None,
    };

    write_state(&state)?;
    Ok(state)
}

fn stop() -> Result<RecordingState> {
    let mut state = read_state()?.unwrap_or_else(|| RecordingState::idle(None));
    let Some(pid) = state.pid else {
        clear_state()?;
        return Ok(RecordingState::idle(Some("not recording".to_string())));
    };

    if recording_process_is_running(pid, state.partial_file.as_deref()) {
        kill(Pid::from_raw(pid), Signal::SIGINT)
            .with_context(|| format!("failed to send SIGINT to ffmpeg pid {pid}"))?;

        for _ in 0..50 {
            if !recording_process_is_running(pid, state.partial_file.as_deref()) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }

        if recording_process_is_running(pid, state.partial_file.as_deref()) {
            kill(Pid::from_raw(pid), Signal::SIGTERM)
                .with_context(|| format!("failed to send SIGTERM to ffmpeg pid {pid}"))?;
        }
    }

    if let (Some(partial), Some(final_file)) = (&state.partial_file, &state.file) {
        if partial.exists() {
            fs::rename(partial, final_file).with_context(|| {
                format!(
                    "failed to rename {} to {}",
                    partial.display(),
                    final_file.display()
                )
            })?;
        }
    }

    state.recording = false;
    state.pid = None;
    state.partial_file = None;
    state.message = Some("stopped".to_string());
    clear_state()?;
    Ok(state)
}

fn status() -> Result<RecordingState> {
    let Some(mut state) = read_state()? else {
        return Ok(RecordingState::idle(None));
    };

    match state.pid {
        Some(pid) if recording_process_is_running(pid, state.partial_file.as_deref()) => {
            state.recording = true;
            Ok(state)
        }
        Some(_) => {
            state.recording = false;
            state.message = Some("recording process exited unexpectedly".to_string());
            Ok(state)
        }
        None => Ok(RecordingState::idle(None)),
    }
}

fn recording_process_is_running(pid: i32, partial_file: Option<&Path>) -> bool {
    if kill(Pid::from_raw(pid), None).is_err() {
        return false;
    }

    let Ok(cmdline) = fs::read(format!("/proc/{pid}/cmdline")) else {
        return false;
    };

    if cmdline.is_empty() || !cmdline.windows(b"ffmpeg".len()).any(|w| w == b"ffmpeg") {
        return false;
    }

    let Some(partial_file) = partial_file else {
        return true;
    };

    let partial_file = partial_file.as_os_str().as_encoded_bytes();
    cmdline
        .windows(partial_file.len())
        .any(|window| window == partial_file)
}

fn ensure_dependency(name: &str) -> Result<()> {
    Command::new(name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("required command not found: {name}"))?;

    Ok(())
}

fn command_output(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("failed to run {program}"))?;

    if !output.status.success() {
        bail!(
            "{} failed: {}",
            program,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(String::from_utf8(output.stdout)
        .with_context(|| format!("{program} returned non-UTF-8 output"))?)
}

fn default_pipewire_node_name(node: &str) -> Result<String> {
    let output = command_output("wpctl", &["inspect", node])?;

    for line in output.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };

        if key.trim().trim_start_matches('*').trim() != "node.name" {
            continue;
        }

        return Ok(value.trim().trim_matches('"').to_string());
    }

    bail!("wpctl inspect {node} did not include node.name");
}

fn state_dir() -> Result<PathBuf> {
    if let Some(state_home) = dirs::state_dir() {
        return Ok(state_home.join(STATE_DIR_NAME));
    }

    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not determine home directory"))?;
    Ok(home.join(".local").join("state").join(STATE_DIR_NAME))
}

fn state_file() -> Result<PathBuf> {
    Ok(state_dir()?.join(STATE_FILE_NAME))
}

fn read_state() -> Result<Option<RecordingState>> {
    let path = state_file()?;
    if !path.exists() {
        return Ok(None);
    }

    let file = File::open(&path).with_context(|| format!("failed to open {}", path.display()))?;
    let state = serde_json::from_reader(file)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(Some(state))
}

fn write_state(state: &RecordingState) -> Result<()> {
    let dir = state_dir()?;
    fs::create_dir_all(&dir)?;
    let path = state_file()?;
    let tmp = path.with_extension("json.tmp");
    let file = File::create(&tmp).with_context(|| format!("failed to create {}", tmp.display()))?;
    serde_json::to_writer_pretty(file, state)
        .with_context(|| format!("failed to write {}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .with_context(|| format!("failed to move {} to {}", tmp.display(), path.display()))?;
    Ok(())
}

fn clear_state() -> Result<()> {
    let path = state_file()?;
    if path.exists() {
        fs::remove_file(&path).with_context(|| format!("failed to remove {}", path.display()))?;
    }
    Ok(())
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
