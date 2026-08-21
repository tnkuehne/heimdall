use crate::transcription::provider::{endpoint_url, TranscriptionProvider, TranscriptionRequest};
use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;

const DEFAULT_BASE_URL: &str = "https://api.deepgram.com";

pub struct DeepgramProvider;

impl TranscriptionProvider for DeepgramProvider {
    fn id(&self) -> &'static str {
        "deepgram"
    }

    fn default_base_url(&self) -> &'static str {
        DEFAULT_BASE_URL
    }

    fn transcribe(
        &self,
        request: &TranscriptionRequest,
        base_url: &str,
        api_key: Option<&SecretString>,
    ) -> Result<Value> {
        let audio = std::fs::read(&request.audio_file)
            .with_context(|| format!("failed to read {}", request.audio_file.display()))?;

        let mut query = vec![
            ("model", "nova-3-general".to_string()),
            ("smart_format", "true".to_string()),
            ("punctuate", "true".to_string()),
            ("utterances", "true".to_string()),
            ("diarize_model", "latest".to_string()),
            ("multichannel", request.multichannel.to_string()),
            ("mip_opt_out", "true".to_string()),
        ];

        if let Some(language) = &request.language {
            query.push(("language", language.clone()));
        } else {
            query.push(("detect_language", "true".to_string()));
        }

        let mut request_builder = Client::new()
            .post(endpoint_url(base_url, "v1/listen")?)
            .query(&query)
            .header(CONTENT_TYPE, "audio/mpeg")
            .body(audio);
        if let Some(api_key) = api_key {
            request_builder =
                request_builder.header(AUTHORIZATION, format!("Token {}", api_key.expose_secret()));
        }

        let response = request_builder
            .send()
            .context("failed to send Deepgram transcription request")?;

        let status = response.status();
        let body = response
            .text()
            .context("failed to read Deepgram transcription response")?;

        if !status.is_success() {
            bail!("Deepgram transcription failed with HTTP {status}: {body}");
        }

        serde_json::from_str(&body).context("Deepgram transcription response was not valid JSON")
    }
}
