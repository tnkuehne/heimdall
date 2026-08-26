import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
	validateExtensionConfig,
	validateRecordingStatus,
} from "../extension/generated/validators.js";

const backend = resolve(import.meta.dirname, "../backend/target/debug/meeting-recorder");

test("real backend commands satisfy their generated response contracts", async () => {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "heimdall-contract-"));
	const environment = {
		...process.env,
		HOME: join(temporaryDirectory, "home"),
		XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
		XDG_STATE_HOME: join(temporaryDirectory, "state"),
	};

	try {
		const status = runBackend(["status"], environment);
		assert.equal(
			validateRecordingStatus(status),
			true,
			validationFailure(validateRecordingStatus),
		);

		const initialConfig = runBackend(["config", "get"], environment);
		assert.equal(
			validateExtensionConfig(initialConfig),
			true,
			validationFailure(validateExtensionConfig),
		);

		const updatedConfig = runBackend(["config", "set-provider", "deepgram"], environment);
		assert.equal(
			validateExtensionConfig(updatedConfig),
			true,
			validationFailure(validateExtensionConfig),
		);
		assert.equal(updatedConfig.transcription_provider, "deepgram");
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
});

function runBackend(args, environment) {
	const result = spawnSync(backend, args, {
		encoding: "utf8",
		env: environment,
	});
	assert.equal(result.status, 0, result.stderr || `backend terminated with ${result.signal}`);
	return JSON.parse(result.stdout);
}

function validationFailure(validator) {
	return JSON.stringify(validator.errors ?? []);
}
