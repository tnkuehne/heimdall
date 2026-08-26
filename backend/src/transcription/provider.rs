use crate::protocol::TranscriptionProvider as ProviderId;
use anyhow::Result;
use secrecy::SecretString;
use serde_json::Value;
use std::path::{Path, PathBuf};
use url::Url;

#[derive(Debug)]
pub struct TranscriptionRequest {
    pub audio_file: PathBuf,
    pub language: Option<String>,
    pub format: bool,
    pub multichannel: bool,
}

pub trait TranscriptionProvider {
    fn id(&self) -> ProviderId;
    fn default_base_url(&self) -> &'static str;
    fn transcribe(
        &self,
        request: &TranscriptionRequest,
        base_url: &str,
        api_key: Option<&SecretString>,
    ) -> Result<Value>;
}

pub fn endpoint_url(base_url: &str, path: &str) -> Result<Url> {
    Url::parse(&format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    ))
    .map_err(Into::into)
}

pub fn default_transcript_path(audio_file: &Path) -> PathBuf {
    let parent = audio_file.parent().unwrap_or_else(|| Path::new("."));
    let stem = audio_file
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("transcript");

    parent.join(format!("{stem}.transcript.md"))
}
