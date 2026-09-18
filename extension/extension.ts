import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { MeetingRecorderClient, type GetStatusResult } from "./dbus-client.js";
import {
	SETTINGS_KEYS,
	SETTINGS_SCHEMA_ID,
	TRANSCRIPTION_PROVIDERS,
	providerLabel,
	recordingsDirectory,
	transcriptionProvider,
	type TranscriptionProvider,
} from "./settings.js";

Gio._promisify(
	Gio,
	"app_info_launch_default_for_uri_async",
	"app_info_launch_default_for_uri_finish",
);

const MEETING_REMINDER_COOLDOWN_SECONDS = 10 * 60;
const GOOGLE_MEET_TITLE_MARKERS = ["google meet", "meet - google chrome"] as const;
const GOOGLE_MEET_URL_MARKER = "meet.google.com";
const TEAMS_TITLE_MARKER = "microsoft teams";
const TEAMS_URL_MARKER = "teams.microsoft.com";
const CHROME_APP_ID = "google-chrome.desktop";
const CHROME_PWA_APP_ID_PREFIX = "chrome-";
const FLATPAK_CHROME_APP_ID_PREFIX = "com.google.chrome";
const DESKTOP_APP_ID_SUFFIX = ".desktop";

class MeetingRecorderExtension extends Extension {
	private _indicator: MeetingRecorderIndicator | null = null;

	override enable() {
		this._indicator = new MeetingRecorderIndicator(this, this.getSettings(SETTINGS_SCHEMA_ID));
		Main.panel.addToStatusArea(this.uuid, this._indicator.button);
		void this._indicator.initialize();
	}

	override disable() {
		this._indicator?.destroy();
		this._indicator = null;
	}
}

class MeetingRecorderIndicator {
	readonly button: PanelMenu.Button;

	private readonly _extension: MeetingRecorderExtension;
	private readonly _settings: Gio.Settings;
	private readonly _settingsChangedSignalId: number;
	private readonly _serviceCancellable = new Gio.Cancellable();
	private readonly _menu: PopupMenu.PopupMenu;
	private readonly _icon: St.Icon;
	private readonly _toggleItem: PopupMenu.PopupMenuItem;
	private readonly _statusItem: PopupMenu.PopupMenuItem;
	private readonly _openFolderItem: PopupMenu.PopupMenuItem;
	private readonly _preferencesItem: PopupMenu.PopupMenuItem;
	private readonly _providerSubmenu: PopupMenu.PopupSubMenuMenuItem;
	private readonly _providerDisabledItem: PopupMenu.PopupMenuItem;
	private readonly _providerItems = new Map<TranscriptionProvider, PopupMenu.PopupMenuItem>();
	private _notificationSource: MessageTray.Source | null = null;
	private _client: MeetingRecorderClient | null = null;
	private readonly _clientSignalIds: number[] = [];
	private _focusedWindow: Meta.Window | null = null;
	private _focusedWindowTitleSignalId: number | null = null;
	private _focusWindowSignalId: number | null = null;
	private _browserCaptureActive = false;
	private _lastMeetingReminderAt = 0;
	private _recording = false;
	private _lastFile: string | null = null;
	private _meetingDetectionReminderEnabled = true;

	constructor(extension: MeetingRecorderExtension, settings: Gio.Settings) {
		this._extension = extension;
		this._settings = settings;
		this.button = new PanelMenu.Button(0.0, "Meeting Recorder");
		this._menu = this._requirePopupMenu(this.button.menu);

		this._icon = new St.Icon({
			icon_name: "media-record-symbolic",
			style_class: "system-status-icon",
		});
		this.button.add_child(this._icon);

		this._toggleItem = new PopupMenu.PopupMenuItem("Start Recording");
		this._toggleItem.connect("activate", () => this._toggleRecording());
		this._menu.addMenuItem(this._toggleItem);

		this._statusItem = new PopupMenu.PopupMenuItem("Not recording", {
			reactive: false,
		});
		this._menu.addMenuItem(this._statusItem);

		this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

		this._openFolderItem = new PopupMenu.PopupMenuItem("Open Recordings Folder");
		this._openFolderItem.connect("activate", () => {
			void this._openRecordingsFolder();
		});
		this._menu.addMenuItem(this._openFolderItem);

		this._providerSubmenu = new PopupMenu.PopupSubMenuMenuItem("Transcription: Disabled");
		this._providerDisabledItem = this._providerItem("Disabled", null);
		this._providerSubmenu.menu.addMenuItem(this._providerDisabledItem);
		for (const provider of TRANSCRIPTION_PROVIDERS) {
			const item = this._providerItem(provider.label, provider.id);
			this._providerItems.set(provider.id, item);
			this._providerSubmenu.menu.addMenuItem(item);
		}

		this._menu.addMenuItem(this._providerSubmenu);

		this._preferencesItem = new PopupMenu.PopupMenuItem("Preferences");
		this._preferencesItem.connect("activate", () => this._extension.openPreferences());
		this._menu.addMenuItem(this._preferencesItem);

		this._settingsChangedSignalId = this._settings.connect("changed", (_settings, key) => {
			this._applySetting(key);
		});
		this._applySettings();
		this._watchFocusedWindow();
		this._focusWindowSignalId = global.display.connect("notify::focus-window", () => {
			this._watchFocusedWindow();
		});
	}

	destroy() {
		this._serviceCancellable.cancel();
		if (this._client)
			for (const signalId of this._clientSignalIds) this._client.disconnect(signalId);
		this._clientSignalIds.length = 0;
		this._client = null;
		this._settings.disconnect(this._settingsChangedSignalId);
		if (this._focusWindowSignalId !== null) {
			global.display.disconnect(this._focusWindowSignalId);
			this._focusWindowSignalId = null;
		}
		this._disconnectFocusedWindow();
		this._notificationSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
		this._notificationSource = null;
		this.button.destroy();
	}

	async initialize() {
		try {
			const client = await MeetingRecorderClient.connect(this._serviceCancellable);
			if (this._serviceCancellable.is_cancelled()) return;

			this._client = client;
			this._clientSignalIds.push(
				client.connectPropertiesChanged(() => this._handlePropertiesChanged()),
				client.connectAvailabilityChanged(() => {
					void this._handleAvailabilityChanged();
				}),
				client.connectTranscriptionCompleted((_audioFile, transcriptFile, hookError) => {
					this._notifyTranscriptSaved(transcriptFile);
					if (hookError) this._notifyError(new Error(hookError));
				}),
				client.connectTranscriptionFailed((_audioFile, message) => {
					this._notifyError(new Error(message));
				}),
			);
			this._applyServiceProperties();
			const status = await client.getStatus(this._serviceCancellable);
			this._applyStatus(status);
		} catch (error) {
			if (this._serviceCancellable.is_cancelled()) return;
			this._recording = false;
			this._setUi(false, "Recorder unavailable", "Start Recording");
			logError(
				error instanceof Error ? error : new Error(String(error)),
				"Meeting Recorder service connection",
			);
		}
	}

	private _handlePropertiesChanged() {
		try {
			this._applyServiceProperties();
		} catch (error) {
			if (!this._serviceCancellable.is_cancelled())
				this._notifyError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private async _handleAvailabilityChanged() {
		const client = this._client;
		if (!client?.available) {
			this._recording = false;
			this._setUi(false, "Recorder unavailable", "Start Recording");
			return;
		}

		try {
			this._applyServiceProperties();
			this._applyStatus(await client.getStatus(this._serviceCancellable));
		} catch (error) {
			if (!this._serviceCancellable.is_cancelled())
				this._notifyError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private async _toggleRecording() {
		try {
			const client = this._requireClient();
			if (this._recording) {
				const file = await client.stopRecording(this._serviceCancellable);
				this._applyServiceProperties();
				if (file) {
					this._lastFile = file;
					this._notifyRecordingSaved(file);
					const provider = transcriptionProvider(this._settings);
					if (provider)
						Main.notify(
							"Meeting Recorder",
							`Transcribing with ${providerLabel(provider)}`,
						);
				}
			} else {
				await client.startRecording(this._serviceCancellable);
				this._applyServiceProperties();
				Main.notify("Meeting Recorder", "Recording started");
			}
		} catch (error) {
			this._notifyError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private _applyStatus(status: GetStatusResult) {
		this._recording = status.recording;
		if (status.file) this._lastFile = status.file;

		if (this._recording) {
			this._setUi(true, "Recording", "Stop Recording");
			return;
		}

		if (status.message) this._setUi(false, status.message, "Start Recording");
		else if (this._lastFile)
			this._setUi(
				false,
				`Last: ${GLib.path_get_basename(this._lastFile)}`,
				"Start Recording",
			);
		else this._setUi(false, "Not recording", "Start Recording");
	}

	private _applyServiceProperties() {
		const client = this._requireClient();
		this._recording = client.recording;
		if (client.recordingFile) this._lastFile = client.recordingFile;
		this._browserCaptureActive = client.browserAudioCapture || client.browserVideoCapture;
		this._setUi(
			this._recording,
			this._recording
				? "Recording"
				: this._lastFile
					? `Last: ${GLib.path_get_basename(this._lastFile)}`
					: "Not recording",
			this._recording ? "Stop Recording" : "Start Recording",
		);
		this._maybeNotifyMeetingDetected();
	}

	private _requireClient() {
		if (this._client?.available) return this._client;
		throw new Error("Meeting Recorder service is unavailable");
	}

	private _setUi(recording: boolean, statusText: string, toggleText: string) {
		this._icon.icon_name = recording ? "media-playback-stop-symbolic" : "media-record-symbolic";
		this._icon.style = recording ? "color: #ff4d4d;" : "";
		this._statusItem.label.text = statusText;
		this._toggleItem.label.text = toggleText;
	}

	private _requirePopupMenu(
		menu: PopupMenu.PopupMenu | PopupMenu.PopupDummyMenu,
	): PopupMenu.PopupMenu {
		if (menu instanceof PopupMenu.PopupMenu) return menu;

		throw new Error("Meeting Recorder indicator was created without a popup menu");
	}

	private _providerItem(label: string, provider: TranscriptionProvider | null) {
		const item = new PopupMenu.PopupMenuItem(label);
		item.connect("activate", () => {
			this._setTranscriptionProvider(provider);
		});
		return item;
	}

	private _applySettings() {
		this._applyTranscriptionProvider(transcriptionProvider(this._settings));
		this._meetingDetectionReminderEnabled = this._settings.get_boolean(
			SETTINGS_KEYS.meetingDetectionReminderEnabled,
		);
	}

	private _applySetting(key: string) {
		switch (key) {
			case SETTINGS_KEYS.transcriptionProvider:
				this._applyTranscriptionProvider(transcriptionProvider(this._settings));
				break;
			case SETTINGS_KEYS.meetingDetectionReminderEnabled:
				this._meetingDetectionReminderEnabled = this._settings.get_boolean(key);
				break;
		}
	}

	private async _openRecordingsFolder() {
		try {
			const directory = recordingsDirectory(this._settings);
			if (GLib.mkdir_with_parents(directory, 0o755) !== 0)
				throw new Error(`Failed to create recordings folder: ${directory}`);

			const uri = Gio.File.new_for_path(directory).get_uri();
			await Gio.app_info_launch_default_for_uri_async(uri, null, null);
		} catch (error) {
			this._notifyError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private _setTranscriptionProvider(provider: TranscriptionProvider | null) {
		try {
			const value = provider ?? "disabled";
			if (!this._settings.set_string(SETTINGS_KEYS.transcriptionProvider, value))
				throw new Error("Transcription provider setting is not writable");
		} catch (error) {
			this._notifyError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private _applyTranscriptionProvider(provider: TranscriptionProvider | null) {
		this._providerSubmenu.label.text = `Transcription: ${providerLabel(provider)}`;
		this._providerDisabledItem.setOrnament(
			provider === null ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
		);
		for (const [providerId, item] of this._providerItems)
			item.setOrnament(
				provider === providerId ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
			);
	}

	private _watchFocusedWindow() {
		this._disconnectFocusedWindow();

		const window = global.display.focus_window ?? null;
		this._focusedWindow = window;
		if (window) {
			this._focusedWindowTitleSignalId = window.connect("notify::title", () => {
				this._maybeNotifyMeetingDetected();
			});
		}

		this._maybeNotifyMeetingDetected();
	}

	private _disconnectFocusedWindow() {
		if (this._focusedWindow && this._focusedWindowTitleSignalId !== null)
			this._focusedWindow.disconnect(this._focusedWindowTitleSignalId);

		this._focusedWindow = null;
		this._focusedWindowTitleSignalId = null;
	}

	private _maybeNotifyMeetingDetected() {
		if (!this._meetingDetectionReminderEnabled) return;
		if (this._recording) return;

		const window = this._focusedWindow;
		if (!window) return;
		if (!this._browserCaptureActive) return;

		const title = window.get_title();
		const appId = Shell.WindowTracker.get_default().get_window_app(window)?.get_id() ?? "";
		const meetingWindow = isRelevantMeetingWindow(title, appId);
		if (!meetingWindow) return;

		const now = GLib.get_monotonic_time() / 1_000_000;
		if (now - this._lastMeetingReminderAt < MEETING_REMINDER_COOLDOWN_SECONDS) return;

		this._lastMeetingReminderAt = now;
		this._notifyMeetingDetected(title);
	}

	private _notifyMeetingDetected(title: string) {
		const source = this._getNotificationSource();
		const notification = new MessageTray.Notification({
			source,
			title: "Meeting detected",
			body: `Start recording? ${title}`,
			iconName: "media-record-symbolic",
		});

		notification.connect("activated", () => {
			notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
			this._startRecordingFromReminder();
		});
		notification.addAction("Start Recording", () => {
			notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
			this._startRecordingFromReminder();
		});
		notification.addAction("Dismiss", () => {
			notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
		});
		source.addNotification(notification);
	}

	private _startRecordingFromReminder() {
		if (!this._recording) void this._toggleRecording();
	}

	private _notifyRecordingSaved(file: string) {
		const source = this._getNotificationSource();
		const notification = new MessageTray.Notification({
			source,
			title: "Meeting Recorder",
			body: `Recording saved: ${GLib.path_get_basename(file)}`,
			iconName: "audio-x-generic-symbolic",
		});

		notification.connect("activated", () => this._openFileLocation(file));
		notification.addAction("Open Location", () => this._openFileLocation(file));
		source.addNotification(notification);
	}

	private _notifyTranscriptSaved(file: string) {
		const source = this._getNotificationSource();
		const notification = new MessageTray.Notification({
			source,
			title: "Meeting Recorder",
			body: `Transcript saved: ${GLib.path_get_basename(file)}`,
			iconName: "text-x-generic-symbolic",
		});

		notification.connect("activated", () => this._openFileLocation(file));
		notification.addAction("Open Location", () => this._openFileLocation(file));
		source.addNotification(notification);
	}

	private _getNotificationSource() {
		if (this._notificationSource) return this._notificationSource;

		const source = new MessageTray.Source({
			title: "Meeting Recorder",
			iconName: "media-record-symbolic",
			policy: new MessageTray.NotificationGenericPolicy(),
		});

		source.connect("destroy", () => {
			if (this._notificationSource === source) this._notificationSource = null;
		});

		Main.messageTray.add(source);
		this._notificationSource = source;
		return source;
	}

	private _openFileLocation(file: string) {
		try {
			const folder = GLib.path_get_dirname(file);
			const uri = Gio.File.new_for_path(folder).get_uri();
			Gio.AppInfo.launch_default_for_uri(uri, null);
		} catch (error) {
			this._notifyError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private _notifyError(error: Error) {
		logError(error, "Meeting Recorder");
		Main.notifyError("Meeting Recorder", error.message);
	}
}

function isRelevantMeetingWindow(title: string, appId: string) {
	const normalizedTitle = normalizeWindowText(title);

	return (
		isChromeApplication(appId) &&
		(isGoogleMeetWindow(normalizedTitle) || isTeamsWindow(normalizedTitle))
	);
}

function isChromeApplication(appId: string) {
	const normalizedAppId = normalizeWindowText(appId);
	if (!normalizedAppId.endsWith(DESKTOP_APP_ID_SUFFIX)) return false;

	return (
		normalizedAppId === CHROME_APP_ID ||
		normalizedAppId.startsWith(CHROME_PWA_APP_ID_PREFIX) ||
		normalizedAppId.startsWith(`${FLATPAK_CHROME_APP_ID_PREFIX}.`) ||
		normalizedAppId.startsWith(`${FLATPAK_CHROME_APP_ID_PREFIX}-`)
	);
}

function isGoogleMeetWindow(normalizedTitle: string) {
	return (
		hasAny(normalizedTitle, GOOGLE_MEET_TITLE_MARKERS) ||
		normalizedTitle.includes(GOOGLE_MEET_URL_MARKER)
	);
}

function isTeamsWindow(normalizedTitle: string) {
	return (
		normalizedTitle.includes(TEAMS_TITLE_MARKER) || normalizedTitle.includes(TEAMS_URL_MARKER)
	);
}

function hasAny(value: string, markers: readonly string[]) {
	return markers.some((marker) => value.includes(marker));
}

function normalizeWindowText(value: string) {
	return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export default MeetingRecorderExtension;
