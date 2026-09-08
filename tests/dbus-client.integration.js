import Gio from "gi://Gio";

import { MeetingRecorderClient } from "./dbus-client.js";

const executable = ARGV[0];
if (!executable) throw new Error("Usage: dbus-client.integration.js BACKEND");

let service = startService();
let client = await connectToService();
const availabilityEvents = [];
const availabilitySignal = client.connectAvailabilityChanged(() => {
	availabilityEvents.push(client.available);
});

try {
	const status = await client.getStatus();
	assertEqual(status.recording, false, "initial recording state");
	assertEqual(status.file, "", "initial recording file");
	assertEqual(client.recording, false, "recording property");
	assertEqual(client.recordingFile, "", "recording-file property");
	assertEqual(client.browserAudioCapture, false, "browser-audio property");
	assertEqual(client.browserVideoCapture, false, "browser-video property");

	let propertyChanges = 0;
	const propertySignal = client.connectPropertiesChanged(() => {
		propertyChanges += 1;
	});
	const [firstStart, secondStart] = await Promise.all([
		client.startRecording(),
		client.startRecording(),
	]);
	assertEqual(firstStart.file, secondStart.file, "serialized duplicate start file");
	assertEqual(client.recording, true, "recording property after start");
	const cliStatus = JSON.parse(await runCli("status"));
	assertEqual(cliStatus.recording, true, "CLI shared recording state");

	const [firstStop, secondStop] = await Promise.all([
		client.stopRecording(),
		client.stopRecording(),
	]);
	assertEqual(firstStop, firstStart.file, "first serialized stop file");
	assertEqual(secondStop, "", "second serialized stop file");
	assertEqual(client.recording, false, "recording property after stop");
	if (propertyChanges === 0) throw new Error("Recording did not emit property changes");
	client.disconnect(propertySignal);

	await expectDbusError(
		() => client.getApiKeyStatus("not-a-provider"),
		"com.timokuehne.MeetingRecorder1.Error.InvalidProvider",
	);
	await expectDbusError(
		() => client.setApiKey("not-a-provider", "test-secret"),
		"com.timokuehne.MeetingRecorder1.Error.InvalidProvider",
	);
	await expectDbusError(
		() => client.setApiKey("xai", ""),
		"com.timokuehne.MeetingRecorder1.Error.InvalidArgument",
	);

	service.force_exit();
	await waitUntil(() => !client.available, "service name to disappear");
	service = startService();
	await waitUntil(() => client.available, "service name to return");

	const restartedStatus = await client.getStatus();
	assertEqual(restartedStatus.recording, false, "recording state after service restart");
	assertEqual(client.recording, false, "recording property after service restart");
	if (!availabilityEvents.includes(false) || !availabilityEvents.includes(true))
		throw new Error("D-Bus proxy did not report both sides of the service restart");
} finally {
	try {
		if (client.available && client.recording) await client.stopRecording();
	} catch {
		// The service may already be unavailable while testing restart handling.
	}
	client.disconnect(availabilitySignal);
	service.force_exit();
}

print("GJS D-Bus integration passed");

function startService() {
	return Gio.Subprocess.new(
		[executable, "service"],
		Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
	);
}

function runCli(command) {
	const process = Gio.Subprocess.new(
		[executable, command],
		Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
	);
	return new Promise((resolve, reject) => {
		process.communicate_utf8_async(null, null, (_source, result) => {
			try {
				const [, stdout, stderr] = process.communicate_utf8_finish(result);
				if (!process.get_successful())
					throw new Error(stderr ?? `CLI exited with ${process.get_exit_status()}`);
				resolve(stdout ?? "");
			} catch (error) {
				reject(error);
			}
		});
	});
}

async function connectToService() {
	let lastError = new Error("Meeting Recorder service did not become available");
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const candidate = await MeetingRecorderClient.connect();
			if (candidate.available) return candidate;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
		await delay(20);
	}
	throw lastError;
}

async function expectDbusError(operation, errorName) {
	try {
		await operation();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes(errorName)) return;
		throw new Error(`Unexpected D-Bus error: ${message}`);
	}
	throw new Error(`Expected D-Bus error ${errorName}`);
}

function waitUntil(predicate, description) {
	return new Promise((resolve, reject) => {
		let attempts = 0;
		const sourceId = setInterval(() => {
			attempts += 1;
			if (predicate()) {
				clearInterval(sourceId);
				resolve();
			} else if (attempts >= 100) {
				clearInterval(sourceId);
				reject(new Error(`Timed out waiting for ${description}`));
			}
		}, 20);
	});
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertEqual(actual, expected, description) {
	if (actual !== expected)
		throw new Error(`${description}: expected ${expected}, received ${actual}`);
}
