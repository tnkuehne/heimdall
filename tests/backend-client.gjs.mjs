import { decodeCaptureStateEvent } from "../build/extension/backend-client.js";

const event = decodeCaptureStateEvent(
	JSON.stringify({
		type: "capture-state",
		browser_audio_capture: true,
		browser_video_capture: false,
		browser_capture: true,
	}),
);
if (!event.browser_capture) throw new Error("bundled decoder changed a valid capture event");

assertContractFailure("not JSON", /backend monitor-capture returned invalid JSON/, "invalid JSON");
assertContractFailure(
	JSON.stringify({
		type: "capture-state",
		browser_audio_capture: true,
		browser_video_capture: false,
	}),
	/backend monitor-capture violated its response contract.*browser_capture/,
	"missing field",
);

function assertContractFailure(payload, expectedMessage, label) {
	try {
		decodeCaptureStateEvent(payload);
	} catch (cause) {
		if (cause instanceof Error && expectedMessage.test(cause.message)) return;
		throw cause;
	}

	throw new Error(`bundled decoder accepted ${label}`);
}
