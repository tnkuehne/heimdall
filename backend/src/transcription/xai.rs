use crate::transcription::provider::{TranscriptionProvider, TranscriptionRequest};
use anyhow::{bail, Context, Result};
use reqwest::blocking::multipart::{Form, Part};
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

const STT_ENDPOINT: &str = "https://api.x.ai/v1/stt";

pub struct XaiProvider;

impl TranscriptionProvider for XaiProvider {
    fn id(&self) -> &'static str {
        "xai"
    }

    fn transcribe(&self, request: &TranscriptionRequest, api_key: &SecretString) -> Result<Value> {
        let mut form = Form::new()
            .text("diarize", "true")
            .text("multichannel", request.multichannel.to_string());

        if request.format {
            let Some(language) = &request.language else {
                bail!("xAI format=true requires --language");
            };

            form = form
                .text("format", "true")
                .text("language", language.clone());
        } else if let Some(language) = &request.language {
            form = form.text("language", language.clone());
        }

        // xAI requires the file field to be the last multipart field.
        let file_part = audio_file_part(&request.audio_file)?;
        form = form.part("file", file_part);

        let response = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .context("failed to build xAI HTTP client")?
            .post(STT_ENDPOINT)
            .bearer_auth(api_key.expose_secret())
            .multipart(form)
            .send()
            .context("failed to send xAI transcription request")?;

        let status = response.status();
        let body = response
            .text()
            .context("failed to read xAI transcription response")?;

        if !status.is_success() {
            bail!("xAI transcription failed with HTTP {status}: {body}");
        }

        serde_json::from_str(&body).context("xAI transcription response was not valid JSON")
    }
}

fn audio_file_part(path: &Path) -> Result<Part> {
    let part = Part::file(path).with_context(|| format!("failed to open {}", path.display()))?;

    match path.extension().and_then(|extension| extension.to_str()) {
        Some("mp3") => part.mime_str("audio/mpeg"),
        Some("wav") => part.mime_str("audio/wav"),
        Some("ogg") => part.mime_str("audio/ogg"),
        Some("opus") => part.mime_str("audio/opus"),
        Some("flac") => part.mime_str("audio/flac"),
        Some("m4a") => part.mime_str("audio/mp4"),
        Some("aac") => part.mime_str("audio/aac"),
        Some("mp4") => part.mime_str("audio/mp4"),
        Some("webm") => part.mime_str("audio/webm"),
        _ => Ok(part),
    }
    .with_context(|| format!("failed to set MIME type for {}", path.display()))
}
