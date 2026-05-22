use crate::transcription::provider::{TranscriptionProvider, TranscriptionRequest};
use anyhow::{bail, Context, Result};
use reqwest::blocking::multipart::{Form, Part};
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;

const STT_ENDPOINT: &str = "https://api.x.ai/v1/stt";

pub struct XaiProvider;

impl TranscriptionProvider for XaiProvider {
    fn id(&self) -> &'static str {
        "xai"
    }

    fn transcribe(&self, request: &TranscriptionRequest, api_key: &SecretString) -> Result<Value> {
        let mut form = Form::new().text("multichannel", request.multichannel.to_string());

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
        let file_part = Part::file(&request.audio_file)
            .with_context(|| format!("failed to open {}", request.audio_file.display()))?;
        form = form.part("file", file_part);

        let response = reqwest::blocking::Client::new()
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
