mod auth;
mod capture;
mod config;
mod recording;
mod service;
mod transcription;

use anyhow::Result;
use clap::{ArgAction, Parser, Subcommand};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "meeting-recorder")]
#[command(about = "Record the default microphone and current system output into an MP3 file.")]
struct Cli {
    #[command(subcommand)]
    command: CommandKind,
}

#[derive(Subcommand)]
enum CommandKind {
    #[command(hide = true)]
    Service,
    Start,
    Stop,
    Status,
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

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        CommandKind::Service => service::run(),
        CommandKind::Start => print_json(&service::start()?),
        CommandKind::Stop => print_json(&service::stop()?),
        CommandKind::Status => print_json(&service::status()?),
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

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    serde_json::to_writer_pretty(std::io::stdout().lock(), value)?;
    println!();
    Ok(())
}
