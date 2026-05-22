use anyhow::Result;
use secrecy::SecretString;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct TranscriptionRequest {
    pub audio_file: PathBuf,
    pub language: Option<String>,
    pub format: bool,
    pub multichannel: bool,
}

#[derive(Debug, Serialize)]
pub struct TranscriptionSummary {
    pub provider: &'static str,
    pub audio_file: PathBuf,
    pub transcript_file: PathBuf,
    pub text: Option<String>,
    pub duration: Option<f64>,
    pub channels: Option<Value>,
    pub post_transcribe_hook_error: Option<String>,
}

pub trait TranscriptionProvider {
    fn id(&self) -> &'static str;
    fn transcribe(&self, request: &TranscriptionRequest, api_key: &SecretString) -> Result<Value>;
}

pub fn default_transcript_path(audio_file: &Path) -> PathBuf {
    let parent = audio_file.parent().unwrap_or_else(|| Path::new("."));
    let stem = audio_file
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("transcript");

    parent.join(format!("{stem}.transcript.md"))
}
