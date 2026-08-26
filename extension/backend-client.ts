import Gio from "gi://Gio";

import type {
	AuthStatus,
	CaptureStateEvent,
	ExtensionConfig,
	OpenFolderResult,
	RecordingStatus,
	TranscriptionProvider,
	TranscriptionSummary,
} from "./generated/contracts.js";
import {
	validateAuthStatus,
	validateCaptureStateEvent,
	validateExtensionConfig,
	validateOpenFolderResult,
	validateRecordingStatus,
	validateTranscriptionSummary,
} from "./generated/validators.js";
import type { ContractValidationError, ContractValidator } from "./generated/validators.js";
import { errorFromCause } from "./errors.js";

export class BackendClient {
	private readonly _backendPath: string;

	constructor(backendPath: string) {
		this._backendPath = backendPath;
	}

	getRecordingStatus(): Promise<RecordingStatus> {
		return this._run("status", ["status"], validateRecordingStatus);
	}

	startRecording(): Promise<RecordingStatus> {
		return this._run("start", ["start"], validateRecordingStatus);
	}

	stopRecording(): Promise<RecordingStatus> {
		return this._run("stop", ["stop"], validateRecordingStatus);
	}

	openRecordingsFolder(): Promise<OpenFolderResult> {
		return this._run("open-folder", ["open-folder"], validateOpenFolderResult);
	}

	getConfig(): Promise<ExtensionConfig> {
		return this._run("config get", ["config", "get"], validateExtensionConfig);
	}

	setTranscriptionProvider(provider: TranscriptionProvider | null): Promise<ExtensionConfig> {
		return this._run(
			"config set-provider",
			["config", "set-provider", provider ?? "disabled"],
			validateExtensionConfig,
		);
	}

	setProviderBaseUrl(provider: TranscriptionProvider, baseUrl: string): Promise<ExtensionConfig> {
		return this._run(
			"config set-provider-base-url",
			["config", "set-provider-base-url", provider, baseUrl],
			validateExtensionConfig,
		);
	}

	resetProviderBaseUrl(provider: TranscriptionProvider): Promise<ExtensionConfig> {
		return this._run(
			"config reset-provider-base-url",
			["config", "reset-provider-base-url", provider],
			validateExtensionConfig,
		);
	}

	setMeetingDetectionReminder(enabled: boolean): Promise<ExtensionConfig> {
		return this._run(
			"config set-meeting-detection-reminder",
			["config", "set-meeting-detection-reminder", String(enabled)],
			validateExtensionConfig,
		);
	}

	setRecordingsDir(path: string): Promise<ExtensionConfig> {
		return this._run(
			"config set-recordings-dir",
			["config", "set-recordings-dir", path],
			validateExtensionConfig,
		);
	}

	resetRecordingsDir(): Promise<ExtensionConfig> {
		return this._run(
			"config reset-recordings-dir",
			["config", "reset-recordings-dir"],
			validateExtensionConfig,
		);
	}

	setPostTranscribeHook(path: string): Promise<ExtensionConfig> {
		return this._run(
			"config set-post-transcribe-hook",
			["config", "set-post-transcribe-hook", path],
			validateExtensionConfig,
		);
	}

	clearPostTranscribeHook(): Promise<ExtensionConfig> {
		return this._run(
			"config clear-post-transcribe-hook",
			["config", "clear-post-transcribe-hook"],
			validateExtensionConfig,
		);
	}

	getAuthStatus(provider: TranscriptionProvider): Promise<AuthStatus> {
		return this._run("auth status", ["auth", "status", provider], validateAuthStatus);
	}

	setApiKey(provider: TranscriptionProvider, apiKey: string): Promise<AuthStatus> {
		return this._run(
			"auth set-stdin",
			["auth", "set-stdin", provider],
			validateAuthStatus,
			apiKey,
		);
	}

	deleteApiKey(provider: TranscriptionProvider): Promise<AuthStatus> {
		return this._run("auth delete", ["auth", "delete", provider], validateAuthStatus);
	}

	transcribe(audioFile: string, provider: TranscriptionProvider): Promise<TranscriptionSummary> {
		return this._run(
			"transcribe",
			["transcribe", audioFile, "--provider", provider],
			validateTranscriptionSummary,
		);
	}

	private async _run<T>(
		operation: string,
		args: string[],
		validator: ContractValidator<T>,
		stdin: string | null = null,
	): Promise<T> {
		const flags =
			stdin === null
				? Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
				: Gio.SubprocessFlags.STDIN_PIPE |
					Gio.SubprocessFlags.STDOUT_PIPE |
					Gio.SubprocessFlags.STDERR_PIPE;
		const process = Gio.Subprocess.new([this._backendPath, ...args], flags);
		const [, stdoutBytes, stderrBytes] = await communicateUtf8(process, stdin);
		const stdout = stdoutBytes ?? "";
		const stderr = stderrBytes ?? "";

		if (!process.get_successful()) {
			const detail =
				stderr.trim() || stdout.trim() || `exit status ${process.get_exit_status()}`;
			throw new Error(`backend ${operation} failed: ${detail}`);
		}

		return decodeBackendResponse(operation, stdout, validator);
	}
}

export function decodeCaptureStateEvent(line: string): CaptureStateEvent {
	return decodeBackendResponse("monitor-capture", line, validateCaptureStateEvent);
}

function decodeBackendResponse<T>(
	operation: string,
	text: string,
	validator: ContractValidator<T>,
): T {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw new Error(`backend ${operation} returned invalid JSON`, {
			cause: errorFromCause(cause),
		});
	}

	if (!validator(value)) {
		throw new Error(
			`backend ${operation} violated its response contract: ${formatValidationErrors(validator.errors)}`,
		);
	}

	return value;
}

function formatValidationErrors(
	errors: readonly ContractValidationError[] | null | undefined,
): string {
	if (!errors || errors.length === 0) return "unknown validation error";

	return errors
		.map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
		.join("; ");
}

function communicateUtf8(
	process: Gio.Subprocess,
	stdin: string | null,
): Promise<[boolean, string, string]> {
	return new Promise((resolve, reject) => {
		process.communicate_utf8_async(stdin, null, (_source, result) => {
			try {
				resolve(process.communicate_utf8_finish(result));
			} catch (cause) {
				reject(errorFromCause(cause));
			}
		});
	});
}
