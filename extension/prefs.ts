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
    private _loadingProvider = false;

    override fillPreferencesWindow(window: Adw.PreferencesWindow) {
        this._backendPath = GLib.build_filenamev([this.path, 'bin', 'meeting-recorder']);
        window.set_title('Meeting Recorder');

        const page = new Adw.PreferencesPage({
            title: 'Meeting Recorder',
            icon_name: 'media-record-symbolic',
        });

        const recordingGroup = new Adw.PreferencesGroup({
            title: 'Recording',
            description: 'Audio files are saved in ~/Recordings/Meetings.',
        });
        page.add(recordingGroup);

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
            .then(config => this._applyProvider(config.transcription_provider))
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

    private _setTranscriptionProvider(
        provider: TranscriptionProvider | null,
        window: Adw.PreferencesWindow
    ) {
        const value = provider ?? 'disabled';
        this._runBackend<BackendConfig>(['config', 'set-provider', value])
            .then(config => {
                this._applyProvider(config.transcription_provider);
                this._toast(window, `Transcription provider: ${providerLabel(config.transcription_provider)}`);
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

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
