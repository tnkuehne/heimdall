import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	validateAuthStatus,
	validateCaptureStateEvent,
	validateExtensionConfig,
	validateOpenFolderResult,
	validateRecordingStatus,
	validateTranscriptionSummary,
} from "../extension/generated/validators.js";

const validRecordingStatus = {
	recording: false,
	pid: null,
	file: null,
	partial_file: null,
	started_at: null,
	message: null,
};

const validExtensionConfig = {
	transcription_provider: "xai",
	provider_base_urls: { xai: "https://example.test" },
	meeting_detection_reminder_enabled: true,
	recordings_dir: "/tmp/recordings",
	post_transcribe_hook: null,
};

test("all backend result validators accept representative wire values", () => {
	assert.equal(validateRecordingStatus(validRecordingStatus), true);
	assert.equal(validateExtensionConfig(validExtensionConfig), true);
	assert.equal(validateAuthStatus({ provider: "deepgram", configured: true }), true);
	assert.equal(
		validateTranscriptionSummary({
			provider: "xai",
			audio_file: "/tmp/audio.mp3",
			transcript_file: "/tmp/audio.transcript.md",
			text: "hello",
			duration: 1.25,
			channels: { arbitrary: ["provider", "payload"] },
			post_transcribe_hook_error: null,
		}),
		true,
	);
	assert.equal(validateOpenFolderResult({ opened: true, folder: "/tmp/recordings" }), true);
	assert.equal(
		validateCaptureStateEvent({
			type: "capture-state",
			browser_audio_capture: true,
			browser_video_capture: false,
			browser_capture: true,
		}),
		true,
	);
});

test("validators accept fixtures serialized by the Rust protocol types", async () => {
	const fixtures = JSON.parse(
		await readFile(new URL("../contracts/backend.fixtures.json", import.meta.url), "utf8"),
	);

	assert.equal(validateRecordingStatus(fixtures.recording_status), true);
	assert.equal(validateExtensionConfig(fixtures.extension_config), true);
	assert.equal(validateAuthStatus(fixtures.auth_status), true);
	assert.equal(validateTranscriptionSummary(fixtures.transcription_summary), true);
	assert.equal(validateOpenFolderResult(fixtures.open_folder_result), true);
	assert.equal(validateCaptureStateEvent(fixtures.capture_state_event), true);
});

test("closed protocol objects reject additional fields", () => {
	assert.equal(validateRecordingStatus({ ...validRecordingStatus, surprise: true }), false);
	assert.equal(validateExtensionConfig({ ...validExtensionConfig, surprise: true }), false);
	assert.equal(
		validateExtensionConfig({
			...validExtensionConfig,
			provider_base_urls: { xai: "https://example.test", surprise: "value" },
		}),
		false,
	);
	assert.match(validateExtensionConfig.errors?.[0]?.instancePath ?? "", /provider_base_urls/);
});

test("validators reject missing, mistyped, and invalid enum values", () => {
	const { recording: _recording, ...missingRecording } = validRecordingStatus;
	assert.equal(validateRecordingStatus(missingRecording), false);
	assert.equal(validateRecordingStatus({ ...validRecordingStatus, pid: 1.5 }), false);
	assert.equal(validateRecordingStatus({ ...validRecordingStatus, pid: 2_147_483_648 }), false);
	assert.equal(
		validateExtensionConfig({ ...validExtensionConfig, transcription_provider: "other" }),
		false,
	);
	assert.equal(
		validateCaptureStateEvent({
			type: "other",
			browser_audio_capture: false,
			browser_video_capture: false,
			browser_capture: false,
		}),
		false,
	);
});

test("the generated schema and TypeScript keep the intended boundary semantics", async () => {
	const [schemaText, types] = await Promise.all([
		readFile(new URL("../contracts/backend.schema.json", import.meta.url), "utf8"),
		readFile(new URL("../extension/generated/contracts.ts", import.meta.url), "utf8"),
	]);
	const schema = JSON.parse(schemaText);

	assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
	for (const property of Object.values(schema.properties)) {
		const definitionName = property.$ref.slice("#/$defs/".length);
		assert.equal(schema.$defs[definitionName].additionalProperties, false);
	}
	assert.equal(schema.$defs.TranscriptionSummary.properties.channels, true);
	assert.match(types, /channels: unknown;/);
	assert.doesNotMatch(types, /\bany\b/);
});
