use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::path::PathBuf;

#[derive(
    Debug, Clone, Copy, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionProvider {
    Xai,
    Deepgram,
}

impl TranscriptionProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Xai => "xai",
            Self::Deepgram => "deepgram",
        }
    }
}

impl fmt::Display for TranscriptionProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordingStatus {
    pub recording: bool,
    #[schemars(range(min = -2147483648, max = 2147483647))]
    pub pid: Option<i32>,
    pub file: Option<PathBuf>,
    pub partial_file: Option<PathBuf>,
    pub started_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderBaseUrls {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub xai: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub deepgram: Option<String>,
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExtensionConfig {
    pub transcription_provider: Option<TranscriptionProvider>,
    pub provider_base_urls: ProviderBaseUrls,
    pub meeting_detection_reminder_enabled: bool,
    pub recordings_dir: PathBuf,
    pub post_transcribe_hook: Option<PathBuf>,
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthStatus {
    pub provider: TranscriptionProvider,
    pub configured: bool,
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptionSummary {
    pub provider: TranscriptionProvider,
    pub audio_file: PathBuf,
    pub transcript_file: PathBuf,
    pub text: Option<String>,
    pub duration: Option<f64>,
    pub channels: Option<Value>,
    pub post_transcribe_hook_error: Option<String>,
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpenFolderResult {
    pub opened: bool,
    pub folder: PathBuf,
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureEventType {
    CaptureState,
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureStateEvent {
    #[serde(rename = "type")]
    pub event_type: CaptureEventType,
    pub browser_audio_capture: bool,
    pub browser_video_capture: bool,
    pub browser_capture: bool,
}

#[derive(JsonSchema)]
#[schemars(rename = "BackendContract")]
#[allow(dead_code)]
pub struct ContractSchema {
    pub recording_status: RecordingStatus,
    pub extension_config: ExtensionConfig,
    pub auth_status: AuthStatus,
    pub transcription_summary: TranscriptionSummary,
    pub open_folder_result: OpenFolderResult,
    pub capture_state_event: CaptureStateEvent,
}

#[cfg(test)]
mod tests {
    use super::{CaptureEventType, CaptureStateEvent, TranscriptionProvider};

    #[test]
    fn provider_wire_values_are_stable() {
        assert_eq!(
            serde_json::to_string(&TranscriptionProvider::Xai).unwrap(),
            "\"xai\""
        );
        assert_eq!(
            serde_json::to_string(&TranscriptionProvider::Deepgram).unwrap(),
            "\"deepgram\""
        );
    }

    #[test]
    fn capture_event_has_the_protocol_discriminator() {
        let event = CaptureStateEvent {
            event_type: CaptureEventType::CaptureState,
            browser_audio_capture: true,
            browser_video_capture: false,
            browser_capture: true,
        };
        let value = serde_json::to_value(event).unwrap();

        assert_eq!(value["type"], "capture-state");
    }
}
