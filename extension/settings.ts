import Gio from "gi://Gio";
import GLib from "gi://GLib";

export const SETTINGS_SCHEMA_ID = "com.timokuehne.meeting-recorder";

export const SETTINGS_KEYS = {
	transcriptionProvider: "transcription-provider",
	xaiBaseUrl: "xai-base-url",
	deepgramBaseUrl: "deepgram-base-url",
	recordingsDirectory: "recordings-directory",
	postTranscribeHook: "post-transcribe-hook",
	meetingDetectionReminderEnabled: "meeting-detection-reminder-enabled",
} as const;

export const TRANSCRIPTION_PROVIDERS = [
	{ id: "xai", label: "xAI" },
	{ id: "deepgram", label: "Deepgram" },
] as const;

export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number]["id"];

export function transcriptionProvider(settings: Gio.Settings): TranscriptionProvider | null {
	const provider = settings.get_string(SETTINGS_KEYS.transcriptionProvider);
	switch (provider) {
		case "disabled":
			return null;
		case "xai":
		case "deepgram":
			return provider;
		default:
			throw new Error(`Unsupported transcription provider in GSettings: ${provider}`);
	}
}

export function providerBaseUrlKey(provider: TranscriptionProvider) {
	switch (provider) {
		case "xai":
			return SETTINGS_KEYS.xaiBaseUrl;
		case "deepgram":
			return SETTINGS_KEYS.deepgramBaseUrl;
	}
}

export function defaultRecordingsDirectory() {
	return GLib.build_filenamev([GLib.get_home_dir(), "Recordings", "Meetings"]);
}

export function recordingsDirectory(settings: Gio.Settings) {
	return settings.get_string(SETTINGS_KEYS.recordingsDirectory) || defaultRecordingsDirectory();
}

export function postTranscribeHook(settings: Gio.Settings) {
	return settings.get_string(SETTINGS_KEYS.postTranscribeHook) || null;
}

export function providerLabel(provider: TranscriptionProvider | null) {
	if (provider === null) return "Disabled";

	return (
		TRANSCRIPTION_PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider
	);
}
