import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { BackendClient } from "./backend-client.js";
import { errorFromCause } from "./errors.js";
import type { ExtensionConfig, TranscriptionProvider } from "./generated/contracts.js";

const TRANSCRIPTION_PROVIDER_DEFINITIONS = {
	xai: { id: "xai", label: "xAI", defaultBaseUrl: "https://api.x.ai" },
	deepgram: {
		id: "deepgram",
		label: "Deepgram",
		defaultBaseUrl: "https://api.deepgram.com",
	},
} satisfies {
	readonly [Provider in TranscriptionProvider]: {
		readonly id: Provider;
		readonly label: string;
		readonly defaultBaseUrl: string;
	};
};
const TRANSCRIPTION_PROVIDERS = Object.values(TRANSCRIPTION_PROVIDER_DEFINITIONS);

const PROVIDER_OPTIONS: Array<TranscriptionProvider | null> = [
	null,
	...TRANSCRIPTION_PROVIDERS.map((provider) => provider.id),
];

type ProviderWidgets = {
	group: Adw.PreferencesGroup;
	baseUrlRow: Adw.EntryRow;
	resetBaseUrlButton: Gtk.Button;
	row: Adw.PasswordEntryRow;
	removeButton: Gtk.Button;
};

export default class MeetingRecorderPreferences extends ExtensionPreferences {
	private _backendClient: BackendClient | null = null;
	private _providerRow: Adw.ComboRow | null = null;
	private _meetingDetectionReminderRow: Adw.SwitchRow | null = null;
	private _recordingsDirRow: Adw.ActionRow | null = null;
	private _resetRecordingsDirButton: Gtk.Button | null = null;
	private _postTranscribeHookRow: Adw.ActionRow | null = null;
	private _clearPostTranscribeHookButton: Gtk.Button | null = null;
	private readonly _providerWidgets = new Map<TranscriptionProvider, ProviderWidgets>();
	private _loadingProvider = false;
	private _loadingMeetingDetectionReminder = false;

	override fillPreferencesWindow(window: Adw.PreferencesWindow) {
		const backendPath = GLib.build_filenamev([this.path, "bin", "meeting-recorder"]);
		this._backendClient = new BackendClient(backendPath);
		window.set_title("Meeting Recorder");

		const page = new Adw.PreferencesPage({
			title: "Meeting Recorder",
			icon_name: "media-record-symbolic",
		});

		const recordingGroup = new Adw.PreferencesGroup({
			title: "Recording",
		});
		page.add(recordingGroup);

		const recordingsDirRow = new Adw.ActionRow({
			title: "Save recordings to",
			subtitle: defaultRecordingsDir(),
			subtitle_selectable: true,
			use_markup: false,
		});
		const chooseRecordingsDirButton = new Gtk.Button({
			label: "Choose...",
			valign: Gtk.Align.CENTER,
		});
		chooseRecordingsDirButton.connect("clicked", () => this._chooseRecordingsDir(window));

		const resetRecordingsDirButton = new Gtk.Button({
			label: "Reset",
			valign: Gtk.Align.CENTER,
			visible: false,
		});
		resetRecordingsDirButton.connect("clicked", () => this._resetRecordingsDir(window));

		recordingsDirRow.add_suffix(resetRecordingsDirButton);
		recordingsDirRow.add_suffix(chooseRecordingsDirButton);
		recordingsDirRow.set_activatable_widget(chooseRecordingsDirButton);
		recordingGroup.add(recordingsDirRow);
		this._recordingsDirRow = recordingsDirRow;
		this._resetRecordingsDirButton = resetRecordingsDirButton;

		const providerModel = Gtk.StringList.new(
			PROVIDER_OPTIONS.map((provider) => providerLabel(provider)),
		);
		const providerRow = new Adw.ComboRow({
			title: "Transcription provider",
			model: providerModel,
		});
		providerRow.connect("notify::selected", () => {
			if (this._loadingProvider) return;

			const provider = PROVIDER_OPTIONS[providerRow.selected] ?? null;
			this._setTranscriptionProvider(provider, window);
		});
		recordingGroup.add(providerRow);
		this._providerRow = providerRow;

		const automationGroup = new Adw.PreferencesGroup({
			title: "Automation",
		});
		page.add(automationGroup);

		const meetingDetectionReminderRow = new Adw.SwitchRow({
			title: "Meeting reminders",
			subtitle: "Notify when a browser meeting starts using microphone or camera.",
		});
		meetingDetectionReminderRow.connect("notify::active", () => {
			if (this._loadingMeetingDetectionReminder) return;

			this._setMeetingDetectionReminder(meetingDetectionReminderRow.get_active(), window);
		});
		automationGroup.add(meetingDetectionReminderRow);
		this._meetingDetectionReminderRow = meetingDetectionReminderRow;

		const postTranscribeHookRow = new Adw.ActionRow({
			title: "Post-transcribe hook",
			subtitle: "No hook configured",
			subtitle_selectable: true,
			use_markup: false,
		});
		const choosePostTranscribeHookButton = new Gtk.Button({
			label: "Choose...",
			valign: Gtk.Align.CENTER,
		});
		choosePostTranscribeHookButton.connect("clicked", () =>
			this._choosePostTranscribeHook(window),
		);

		const clearPostTranscribeHookButton = new Gtk.Button({
			label: "Clear",
			valign: Gtk.Align.CENTER,
			visible: false,
		});
		clearPostTranscribeHookButton.connect("clicked", () =>
			this._clearPostTranscribeHook(window),
		);

		postTranscribeHookRow.add_suffix(clearPostTranscribeHookButton);
		postTranscribeHookRow.add_suffix(choosePostTranscribeHookButton);
		postTranscribeHookRow.set_activatable_widget(choosePostTranscribeHookButton);
		automationGroup.add(postTranscribeHookRow);
		this._postTranscribeHookRow = postTranscribeHookRow;
		this._clearPostTranscribeHookButton = clearPostTranscribeHookButton;

		const keysGroup = new Adw.PreferencesGroup({
			title: "Transcription Providers",
			description: "Keys are stored in GNOME Keyring.",
		});
		page.add(keysGroup);

		for (const provider of TRANSCRIPTION_PROVIDERS) {
			const providerGroup = new Adw.PreferencesGroup({
				title: provider.label,
				description: "Checking key status...",
			});
			page.add(providerGroup);

			const baseUrlRow = new Adw.EntryRow({
				title: "Base URL",
				show_apply_button: true,
			});
			baseUrlRow.set_text(provider.defaultBaseUrl);
			baseUrlRow.connect("apply", () => {
				this._saveProviderBaseUrl(provider.id, baseUrlRow, window);
			});

			const resetBaseUrlButton = new Gtk.Button({
				label: "Reset",
				valign: Gtk.Align.CENTER,
				visible: false,
			});
			resetBaseUrlButton.connect("clicked", () => {
				this._resetProviderBaseUrl(provider.id, window);
			});
			baseUrlRow.add_suffix(resetBaseUrlButton);
			providerGroup.add(baseUrlRow);

			const row = new Adw.PasswordEntryRow({
				title: "API key",
				show_apply_button: true,
			});
			row.connect("apply", () => {
				this._saveApiKey(provider.id, row, providerGroup, removeButton, window);
			});

			const removeButton = new Gtk.Button({
				label: "Remove",
				valign: Gtk.Align.CENTER,
				visible: false,
			});
			removeButton.add_css_class("destructive-action");
			removeButton.connect("clicked", () => {
				this._deleteApiKey(provider.id, row, providerGroup, removeButton, window);
			});
			row.add_suffix(removeButton);
			providerGroup.add(row);

			this._providerWidgets.set(provider.id, {
				group: providerGroup,
				baseUrlRow,
				resetBaseUrlButton,
				row,
				removeButton,
			});
		}

		window.add(page);
		this._load(window);
	}

	private _load(window: Adw.PreferencesWindow) {
		this._requireBackendClient()
			.getConfig()
			.then((config) => this._applyConfig(config))
			.catch((cause) => this._showError(window, errorFromCause(cause)));

		for (const provider of TRANSCRIPTION_PROVIDERS) {
			const widgets = this._providerWidgets.get(provider.id);
			if (!widgets) continue;

			this._requireBackendClient()
				.getAuthStatus(provider.id)
				.then((status) =>
					this._applyAuthStatus(widgets.group, widgets.removeButton, status.configured),
				)
				.catch((cause) => this._showGroupError(widgets.group, errorFromCause(cause)));
		}
	}

	private _applyProvider(provider: TranscriptionProvider | null) {
		if (!this._providerRow) return;

		this._loadingProvider = true;
		this._providerRow.set_selected(providerIndex(provider));
		this._loadingProvider = false;
	}

	private _applyConfig(config: ExtensionConfig) {
		this._applyProvider(config.transcription_provider);
		this._applyProviderBaseUrls(config.provider_base_urls);
		this._applyMeetingDetectionReminder(config.meeting_detection_reminder_enabled);
		this._applyRecordingsDir(config.recordings_dir);
		this._applyPostTranscribeHook(config.post_transcribe_hook);
	}

	private _applyProviderBaseUrls(baseUrls: ExtensionConfig["provider_base_urls"]) {
		for (const provider of TRANSCRIPTION_PROVIDERS) {
			const widgets = this._providerWidgets.get(provider.id);
			if (!widgets) continue;

			const customBaseUrl = baseUrls[provider.id];
			widgets.baseUrlRow.set_text(customBaseUrl ?? provider.defaultBaseUrl);
			widgets.resetBaseUrlButton.set_visible(customBaseUrl !== undefined);
		}
	}

	private _applyMeetingDetectionReminder(enabled: boolean) {
		if (!this._meetingDetectionReminderRow) return;

		this._loadingMeetingDetectionReminder = true;
		this._meetingDetectionReminderRow.set_active(enabled);
		this._loadingMeetingDetectionReminder = false;
	}

	private _applyRecordingsDir(path: string) {
		if (!this._recordingsDirRow || !this._resetRecordingsDirButton) return;

		this._recordingsDirRow.set_subtitle(path);
		this._resetRecordingsDirButton.set_visible(path !== defaultRecordingsDir());
	}

	private _applyPostTranscribeHook(path: string | null) {
		if (!this._postTranscribeHookRow || !this._clearPostTranscribeHookButton) return;

		this._postTranscribeHookRow.set_subtitle(path ?? "No hook configured");
		this._clearPostTranscribeHookButton.set_visible(path !== null);
	}

	private _setTranscriptionProvider(
		provider: TranscriptionProvider | null,
		window: Adw.PreferencesWindow,
	) {
		this._requireBackendClient()
			.setTranscriptionProvider(provider)
			.then((config) => {
				this._applyConfig(config);
				this._toast(
					window,
					`Transcription provider: ${providerLabel(config.transcription_provider)}`,
				);
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _saveProviderBaseUrl(
		provider: TranscriptionProvider,
		row: Adw.EntryRow,
		window: Adw.PreferencesWindow,
	) {
		const baseUrl = row.get_text().trim();
		if (baseUrl.length === 0) {
			this._toast(window, "Base URL cannot be empty");
			return;
		}

		this._requireBackendClient()
			.setProviderBaseUrl(provider, baseUrl)
			.then((config) => {
				this._applyConfig(config);
				this._toast(window, `${providerLabel(provider)} Base URL updated`);
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _resetProviderBaseUrl(provider: TranscriptionProvider, window: Adw.PreferencesWindow) {
		this._requireBackendClient()
			.resetProviderBaseUrl(provider)
			.then((config) => {
				this._applyConfig(config);
				this._toast(window, `${providerLabel(provider)} Base URL reset`);
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _setMeetingDetectionReminder(enabled: boolean, window: Adw.PreferencesWindow) {
		this._requireBackendClient()
			.setMeetingDetectionReminder(enabled)
			.then((config) => {
				this._applyConfig(config);
				this._toast(window, `Meeting reminders ${enabled ? "enabled" : "disabled"}`);
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _chooseRecordingsDir(window: Adw.PreferencesWindow) {
		const dialog = Gtk.FileChooserNative.new(
			"Choose Recordings Folder",
			window,
			Gtk.FileChooserAction.SELECT_FOLDER,
			"Choose",
			"Cancel",
		);
		dialog.set_modal(true);
		dialog.set_create_folders(true);
		dialog.set_current_folder(
			Gio.File.new_for_path(this._recordingsDirRow?.get_subtitle() ?? defaultRecordingsDir()),
		);

		dialog.connect("response", (_source, response) => {
			try {
				if (response !== Gtk.ResponseType.ACCEPT) return;

				const folder = dialog.get_file();
				const path = folder?.get_path();
				if (!path) {
					this._toast(window, "Only local folders are supported");
					return;
				}

				this._setRecordingsDir(path, window);
			} finally {
				dialog.destroy();
			}
		});
		dialog.show();
	}

	private _setRecordingsDir(path: string, window: Adw.PreferencesWindow) {
		this._requireBackendClient()
			.setRecordingsDir(path)
			.then((config) => {
				this._applyConfig(config);
				this._toast(window, "Recordings folder updated");
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _resetRecordingsDir(window: Adw.PreferencesWindow) {
		this._requireBackendClient()
			.resetRecordingsDir()
			.then((config) => {
				this._applyConfig(config);
				this._toast(window, "Recordings folder reset");
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _choosePostTranscribeHook(window: Adw.PreferencesWindow) {
		const dialog = Gtk.FileChooserNative.new(
			"Choose Post-transcribe Hook",
			window,
			Gtk.FileChooserAction.OPEN,
			"Choose",
			"Cancel",
		);
		dialog.set_modal(true);

		const currentHook = this._postTranscribeHookRow?.get_subtitle();
		if (currentHook && currentHook !== "No hook configured")
			dialog.set_file(Gio.File.new_for_path(currentHook));

		dialog.connect("response", (_source, response) => {
			try {
				if (response !== Gtk.ResponseType.ACCEPT) return;

				const file = dialog.get_file();
				const path = file?.get_path();
				if (!path) {
					this._toast(window, "Only local executable files are supported");
					return;
				}

				this._setPostTranscribeHook(path, window);
			} finally {
				dialog.destroy();
			}
		});
		dialog.show();
	}

	private _setPostTranscribeHook(path: string, window: Adw.PreferencesWindow) {
		this._requireBackendClient()
			.setPostTranscribeHook(path)
			.then((config) => {
				this._applyConfig(config);
				this._toast(window, "Post-transcribe hook updated");
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _clearPostTranscribeHook(window: Adw.PreferencesWindow) {
		this._requireBackendClient()
			.clearPostTranscribeHook()
			.then((config) => {
				this._applyConfig(config);
				this._toast(window, "Post-transcribe hook cleared");
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _saveApiKey(
		provider: TranscriptionProvider,
		row: Adw.PasswordEntryRow,
		group: Adw.PreferencesGroup,
		removeButton: Gtk.Button,
		window: Adw.PreferencesWindow,
	) {
		const apiKey = row.get_text().trim();
		row.set_text("");

		if (apiKey.length === 0) {
			this._toast(window, "API key cannot be empty");
			return;
		}

		this._requireBackendClient()
			.setApiKey(provider, apiKey)
			.then((status) => {
				this._applyAuthStatus(group, removeButton, status.configured);
				this._toast(window, `${providerLabel(provider)} API key saved`);
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _deleteApiKey(
		provider: TranscriptionProvider,
		row: Adw.PasswordEntryRow,
		group: Adw.PreferencesGroup,
		removeButton: Gtk.Button,
		window: Adw.PreferencesWindow,
	) {
		row.set_text("");
		this._requireBackendClient()
			.deleteApiKey(provider)
			.then((status) => {
				this._applyAuthStatus(group, removeButton, status.configured);
				this._toast(window, `${providerLabel(provider)} API key removed`);
			})
			.catch((cause) => this._showError(window, errorFromCause(cause)));
	}

	private _applyAuthStatus(
		group: Adw.PreferencesGroup,
		removeButton: Gtk.Button,
		configured: boolean,
	) {
		group.set_description(configured ? "API key configured." : "No API key configured.");
		removeButton.set_visible(configured);
	}

	private _showGroupError(group: Adw.PreferencesGroup, error: Error) {
		group.set_description(error.message);
	}

	private _requireBackendClient(): BackendClient {
		if (this._backendClient) return this._backendClient;

		throw new Error("preferences backend client is not initialized");
	}

	private _showError(window: Adw.PreferencesWindow, error: Error) {
		this._toast(window, error.message);
	}

	private _toast(window: Adw.PreferencesWindow, title: string) {
		window.add_toast(new Adw.Toast({ title }));
	}
}

function providerIndex(provider: TranscriptionProvider | null) {
	const index = PROVIDER_OPTIONS.findIndex((candidate) => candidate === provider);
	return index < 0 ? 0 : index;
}

function providerLabel(provider: TranscriptionProvider | null) {
	if (provider === null) return "Off";

	return (
		TRANSCRIPTION_PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider
	);
}

function defaultRecordingsDir() {
	return GLib.build_filenamev([GLib.get_home_dir(), "Recordings", "Meetings"]);
}
