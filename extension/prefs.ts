import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TRANSCRIPTION_PROVIDERS = [
    {id: 'xai', label: 'xAI'},
    {id: 'deepgram', label: 'Deepgram'},
] as const;

const PROVIDER_OPTIONS: Array<TranscriptionProvider | null> = [
    null,
    ...TRANSCRIPTION_PROVIDERS.map(provider => provider.id),
];

type TranscriptionProvider = typeof TRANSCRIPTION_PROVIDERS[number]['id'];

type BackendConfig = {
    transcription_provider: TranscriptionProvider | null;
    meeting_detection_reminder_enabled: boolean;
    recordings_dir: string;
    post_transcribe_hook: string | null;
};

type AuthStatus = {
    provider: TranscriptionProvider;
    configured: boolean;
};

type ProviderKeyWidgets = {
    group: Adw.PreferencesGroup;
    row: Adw.PasswordEntryRow;
    removeButton: Gtk.Button;
};

export default class MeetingRecorderPreferences extends ExtensionPreferences {
    private _backendPath = '';
    private _providerRow: Adw.ComboRow | null = null;
    private _meetingDetectionReminderRow: Adw.SwitchRow | null = null;
    private _recordingsDirRow: Adw.ActionRow | null = null;
    private _resetRecordingsDirButton: Gtk.Button | null = null;
    private _postTranscribeHookRow: Adw.ActionRow | null = null;
    private _clearPostTranscribeHookButton: Gtk.Button | null = null;
    private _loadingProvider = false;
    private _loadingMeetingDetectionReminder = false;

    override fillPreferencesWindow(window: Adw.PreferencesWindow) {
        this._backendPath = GLib.build_filenamev([this.path, 'bin', 'meeting-recorder']);
        window.set_title('Meeting Recorder');

        const page = new Adw.PreferencesPage({
            title: 'Meeting Recorder',
            icon_name: 'media-record-symbolic',
        });

        const recordingGroup = new Adw.PreferencesGroup({
            title: 'Recording',
        });
        page.add(recordingGroup);

        const recordingsDirRow = new Adw.ActionRow({
            title: 'Save recordings to',
            subtitle: defaultRecordingsDir(),
            subtitle_selectable: true,
            use_markup: false,
        });
        const chooseRecordingsDirButton = new Gtk.Button({
            label: 'Choose...',
            valign: Gtk.Align.CENTER,
        });
        chooseRecordingsDirButton.connect('clicked', () => this._chooseRecordingsDir(window));

        const resetRecordingsDirButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        resetRecordingsDirButton.connect('clicked', () => this._resetRecordingsDir(window));

        recordingsDirRow.add_suffix(resetRecordingsDirButton);
        recordingsDirRow.add_suffix(chooseRecordingsDirButton);
        recordingsDirRow.set_activatable_widget(chooseRecordingsDirButton);
        recordingGroup.add(recordingsDirRow);
        this._recordingsDirRow = recordingsDirRow;
        this._resetRecordingsDirButton = resetRecordingsDirButton;

        const providerModel = Gtk.StringList.new(
            PROVIDER_OPTIONS.map(provider => providerLabel(provider))
        );
        const providerRow = new Adw.ComboRow({
            title: 'Transcription provider',
            model: providerModel,
        });
        providerRow.connect('notify::selected', () => {
            if (this._loadingProvider)
                return;

            const provider = PROVIDER_OPTIONS[providerRow.selected] ?? null;
            this._setTranscriptionProvider(provider, window);
        });
        recordingGroup.add(providerRow);
        this._providerRow = providerRow;

        const automationGroup = new Adw.PreferencesGroup({
            title: 'Automation',
        });
        page.add(automationGroup);

        const meetingDetectionReminderRow = new Adw.SwitchRow({
            title: 'Meeting reminders',
            subtitle: 'Notify when a browser meeting starts using microphone or camera.',
        });
        meetingDetectionReminderRow.connect('notify::active', () => {
            if (this._loadingMeetingDetectionReminder)
                return;

            this._setMeetingDetectionReminder(meetingDetectionReminderRow.get_active(), window);
        });
        automationGroup.add(meetingDetectionReminderRow);
        this._meetingDetectionReminderRow = meetingDetectionReminderRow;

        const postTranscribeHookRow = new Adw.ActionRow({
            title: 'Post-transcribe hook',
            subtitle: 'No hook configured',
            subtitle_selectable: true,
            use_markup: false,
        });
        const choosePostTranscribeHookButton = new Gtk.Button({
            label: 'Choose...',
            valign: Gtk.Align.CENTER,
        });
        choosePostTranscribeHookButton.connect('clicked', () => this._choosePostTranscribeHook(window));

        const clearPostTranscribeHookButton = new Gtk.Button({
            label: 'Clear',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        clearPostTranscribeHookButton.connect('clicked', () => this._clearPostTranscribeHook(window));

        postTranscribeHookRow.add_suffix(clearPostTranscribeHookButton);
        postTranscribeHookRow.add_suffix(choosePostTranscribeHookButton);
        postTranscribeHookRow.set_activatable_widget(choosePostTranscribeHookButton);
        automationGroup.add(postTranscribeHookRow);
        this._postTranscribeHookRow = postTranscribeHookRow;
        this._clearPostTranscribeHookButton = clearPostTranscribeHookButton;

        const keysGroup = new Adw.PreferencesGroup({
            title: 'API Keys',
            description: 'Keys are stored in GNOME Keyring.',
        });
        page.add(keysGroup);

        const keyWidgets = new Map<TranscriptionProvider, ProviderKeyWidgets>();
        for (const provider of TRANSCRIPTION_PROVIDERS) {
            const providerGroup = new Adw.PreferencesGroup({
                title: provider.label,
                description: 'Checking key status...',
            });
            page.add(providerGroup);

            const row = new Adw.PasswordEntryRow({
                title: 'API key',
                show_apply_button: true,
            });
            row.connect('apply', () => {
                this._saveApiKey(provider.id, row, providerGroup, removeButton, window);
            });

            const removeButton = new Gtk.Button({
                label: 'Remove',
                valign: Gtk.Align.CENTER,
                visible: false,
            });
            removeButton.add_css_class('destructive-action');
            removeButton.connect('clicked', () => {
                this._deleteApiKey(provider.id, row, providerGroup, removeButton, window);
            });
            row.add_suffix(removeButton);
            providerGroup.add(row);

            keyWidgets.set(provider.id, {group: providerGroup, row, removeButton});
        }

        window.add(page);
        this._load(window, keyWidgets);
    }

    private _load(
        window: Adw.PreferencesWindow,
        keyWidgets: Map<TranscriptionProvider, ProviderKeyWidgets>
    ) {
        this._runBackend<BackendConfig>(['config', 'get'])
            .then(config => this._applyConfig(config))
            .catch(error => this._showError(window, error));

        for (const provider of TRANSCRIPTION_PROVIDERS) {
            const widgets = keyWidgets.get(provider.id);
            if (!widgets)
                continue;

            this._runBackend<AuthStatus>(['auth', 'status', provider.id])
                .then(status => this._applyAuthStatus(widgets.group, widgets.removeButton, status.configured))
                .catch(error => this._showGroupError(widgets.group, error));
        }
    }

    private _applyProvider(provider: TranscriptionProvider | null) {
        if (!this._providerRow)
            return;

        this._loadingProvider = true;
        this._providerRow.set_selected(providerIndex(provider));
        this._loadingProvider = false;
    }

    private _applyConfig(config: BackendConfig) {
        this._applyProvider(config.transcription_provider);
        this._applyMeetingDetectionReminder(config.meeting_detection_reminder_enabled);
        this._applyRecordingsDir(config.recordings_dir);
        this._applyPostTranscribeHook(config.post_transcribe_hook);
    }

    private _applyMeetingDetectionReminder(enabled: boolean) {
        if (!this._meetingDetectionReminderRow)
            return;

        this._loadingMeetingDetectionReminder = true;
        this._meetingDetectionReminderRow.set_active(enabled);
        this._loadingMeetingDetectionReminder = false;
    }

    private _applyRecordingsDir(path: string) {
        if (!this._recordingsDirRow || !this._resetRecordingsDirButton)
            return;

        this._recordingsDirRow.set_subtitle(path);
        this._resetRecordingsDirButton.set_visible(path !== defaultRecordingsDir());
    }

    private _applyPostTranscribeHook(path: string | null) {
        if (!this._postTranscribeHookRow || !this._clearPostTranscribeHookButton)
            return;

        this._postTranscribeHookRow.set_subtitle(path ?? 'No hook configured');
        this._clearPostTranscribeHookButton.set_visible(path !== null);
    }

    private _setTranscriptionProvider(
        provider: TranscriptionProvider | null,
        window: Adw.PreferencesWindow
    ) {
        const value = provider ?? 'disabled';
        this._runBackend<BackendConfig>(['config', 'set-provider', value])
            .then(config => {
                this._applyConfig(config);
                this._toast(window, `Transcription provider: ${providerLabel(config.transcription_provider)}`);
            })
            .catch(error => this._showError(window, error));
    }

    private _setMeetingDetectionReminder(enabled: boolean, window: Adw.PreferencesWindow) {
        this._runBackend<BackendConfig>(['config', 'set-meeting-detection-reminder', String(enabled)])
            .then(config => {
                this._applyConfig(config);
                this._toast(window, `Meeting reminders ${enabled ? 'enabled' : 'disabled'}`);
            })
            .catch(error => this._showError(window, error));
    }

    private _chooseRecordingsDir(window: Adw.PreferencesWindow) {
        const dialog = Gtk.FileChooserNative.new(
            'Choose Recordings Folder',
            window,
            Gtk.FileChooserAction.SELECT_FOLDER,
            'Choose',
            'Cancel'
        );
        dialog.set_modal(true);
        dialog.set_create_folders(true);
        dialog.set_current_folder(Gio.File.new_for_path(this._recordingsDirRow?.get_subtitle() ?? defaultRecordingsDir()));

        dialog.connect('response', (_source, response) => {
            try {
                if (response !== Gtk.ResponseType.ACCEPT)
                    return;

                const folder = dialog.get_file();
                const path = folder?.get_path();
                if (!path) {
                    this._toast(window, 'Only local folders are supported');
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
        this._runBackend<BackendConfig>(['config', 'set-recordings-dir', path])
            .then(config => {
                this._applyConfig(config);
                this._toast(window, 'Recordings folder updated');
            })
            .catch(error => this._showError(window, error));
    }

    private _resetRecordingsDir(window: Adw.PreferencesWindow) {
        this._runBackend<BackendConfig>(['config', 'reset-recordings-dir'])
            .then(config => {
                this._applyConfig(config);
                this._toast(window, 'Recordings folder reset');
            })
            .catch(error => this._showError(window, error));
    }

    private _choosePostTranscribeHook(window: Adw.PreferencesWindow) {
        const dialog = Gtk.FileChooserNative.new(
            'Choose Post-transcribe Hook',
            window,
            Gtk.FileChooserAction.OPEN,
            'Choose',
            'Cancel'
        );
        dialog.set_modal(true);

        const currentHook = this._postTranscribeHookRow?.get_subtitle();
        if (currentHook && currentHook !== 'No hook configured')
            dialog.set_file(Gio.File.new_for_path(currentHook));

        dialog.connect('response', (_source, response) => {
            try {
                if (response !== Gtk.ResponseType.ACCEPT)
                    return;

                const file = dialog.get_file();
                const path = file?.get_path();
                if (!path) {
                    this._toast(window, 'Only local executable files are supported');
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
        this._runBackend<BackendConfig>(['config', 'set-post-transcribe-hook', path])
            .then(config => {
                this._applyConfig(config);
                this._toast(window, 'Post-transcribe hook updated');
            })
            .catch(error => this._showError(window, error));
    }

    private _clearPostTranscribeHook(window: Adw.PreferencesWindow) {
        this._runBackend<BackendConfig>(['config', 'clear-post-transcribe-hook'])
            .then(config => {
                this._applyConfig(config);
                this._toast(window, 'Post-transcribe hook cleared');
            })
            .catch(error => this._showError(window, error));
    }

    private _saveApiKey(
        provider: TranscriptionProvider,
        row: Adw.PasswordEntryRow,
        group: Adw.PreferencesGroup,
        removeButton: Gtk.Button,
        window: Adw.PreferencesWindow
    ) {
        const apiKey = row.get_text().trim();
        row.set_text('');

        if (apiKey.length === 0) {
            this._toast(window, 'API key cannot be empty');
            return;
        }

        this._runBackend<AuthStatus>(['auth', 'set-stdin', provider], apiKey)
            .then(status => {
                this._applyAuthStatus(group, removeButton, status.configured);
                this._toast(window, `${providerLabel(provider)} API key saved`);
            })
            .catch(error => this._showError(window, error));
    }

    private _deleteApiKey(
        provider: TranscriptionProvider,
        row: Adw.PasswordEntryRow,
        group: Adw.PreferencesGroup,
        removeButton: Gtk.Button,
        window: Adw.PreferencesWindow
    ) {
        row.set_text('');
        this._runBackend<AuthStatus>(['auth', 'delete', provider])
            .then(status => {
                this._applyAuthStatus(group, removeButton, status.configured);
                this._toast(window, `${providerLabel(provider)} API key removed`);
            })
            .catch(error => this._showError(window, error));
    }

    private _applyAuthStatus(group: Adw.PreferencesGroup, removeButton: Gtk.Button, configured: boolean) {
        group.set_description(configured ? 'API key configured.' : 'No API key configured.');
        removeButton.set_visible(configured);
    }

    private _showGroupError(group: Adw.PreferencesGroup, error: unknown) {
        group.set_description(errorMessage(error));
    }

    private async _runBackend<T>(args: string[], stdin: string | null = null): Promise<T> {
        const flags = stdin === null
            ? Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            : Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
        const proc = Gio.Subprocess.new([this._backendPath, ...args], flags);
        const [, stdoutBytes, stderrBytes] = await communicateUtf8(proc, stdin);
        const stdout = stdoutBytes ?? '';
        const stderr = stderrBytes ?? '';

        if (!proc.get_successful()) {
            const detail = stderr.trim() || stdout.trim() || `exit status ${proc.get_exit_status()}`;
            throw new Error(detail);
        }

        try {
            return JSON.parse(stdout) as T;
        } catch {
            throw new Error(`invalid backend response: ${stdout}`);
        }
    }

    private _showError(window: Adw.PreferencesWindow, error: unknown) {
        this._toast(window, errorMessage(error));
    }

    private _toast(window: Adw.PreferencesWindow, title: string) {
        window.add_toast(new Adw.Toast({title}));
    }
}

function communicateUtf8(proc: Gio.Subprocess, stdin: string | null): Promise<[boolean, string, string]> {
    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(stdin, null, (_source, result) => {
            try {
                resolve(proc.communicate_utf8_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function providerIndex(provider: TranscriptionProvider | null) {
    const index = PROVIDER_OPTIONS.findIndex(candidate => candidate === provider);
    return index < 0 ? 0 : index;
}

function providerLabel(provider: TranscriptionProvider | null) {
    if (provider === null)
        return 'Off';

    return TRANSCRIPTION_PROVIDERS.find(candidate => candidate.id === provider)?.label ?? provider;
}

function defaultRecordingsDir() {
    return GLib.build_filenamev([GLib.get_home_dir(), 'Recordings', 'Meetings']);
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
