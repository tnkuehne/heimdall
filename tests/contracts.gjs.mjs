import {
	validateCaptureStateEvent,
	validateRecordingStatus,
} from "../extension/generated/validators.js";

const status = {
	recording: false,
	pid: null,
	file: null,
	partial_file: null,
	started_at: null,
	message: null,
};

if (!validateRecordingStatus(status)) throw new Error("GJS rejected a valid recording status");
if (validateRecordingStatus({ ...status, unexpected: true }))
	throw new Error("GJS accepted an additional recording status field");
if (
	!validateCaptureStateEvent({
		type: "capture-state",
		browser_audio_capture: false,
		browser_video_capture: true,
		browser_capture: true,
	})
)
	throw new Error("GJS rejected a valid capture event");
