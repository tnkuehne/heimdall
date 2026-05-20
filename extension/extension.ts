import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const STATUS_INTERVAL_SECONDS = 2;

type BackendStatus = {
    recording: boolean;
    pid: number | null;
    file: string | null;
    partial_file: string | null;
    started_at: string | null;
    message: string | null;
};

class MeetingRecorderExtension extends Extension {
    backendPath = '';
    private _indicator: MeetingRecorderIndicator | null = null;
    private _timeoutId: number | null = null;

    override enable() {
        this.backendPath = GLib.build_filenamev([this.path, 'bin', 'meeting-recorder']);
        this._indicator = new MeetingRecorderIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator.button);

        this._indicator.refresh();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            STATUS_INTERVAL_SECONDS,
            () => {
                this._indicator?.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    override disable() {
        if (this._timeoutId !== null) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
    }
}

class MeetingRecorderIndicator {
    readonly button: PanelMenu.Button;

    private readonly _extension: MeetingRecorderExtension;
    private readonly _menu: PopupMenu.PopupMenu;
    private readonly _icon: St.Icon;
    private readonly _toggleItem: PopupMenu.PopupMenuItem;
    private readonly _statusItem: PopupMenu.PopupMenuItem;
    private readonly _openFolderItem: PopupMenu.PopupMenuItem;
    private _notificationSource: MessageTray.Source | null = null;
    private _recording = false;
    private _lastFile: string | null = null;

    constructor(extension: MeetingRecorderExtension) {
        this._extension = extension;
        this.button = new PanelMenu.Button(0.0, 'Meeting Recorder');
        this._menu = this._requirePopupMenu(this.button.menu);

        this._icon = new St.Icon({
            icon_name: 'media-record-symbolic',
            style_class: 'system-status-icon',
        });
        this.button.add_child(this._icon);

        this._toggleItem = new PopupMenu.PopupMenuItem('Start Recording');
        this._toggleItem.connect('activate', () => this._toggleRecording());
        this._menu.addMenuItem(this._toggleItem);

        this._statusItem = new PopupMenu.PopupMenuItem('Not recording', {
            reactive: false,
        });
        this._menu.addMenuItem(this._statusItem);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._openFolderItem = new PopupMenu.PopupMenuItem('Open Recordings Folder');
        this._openFolderItem.connect('activate', () => {
            this._runBackend(['open-folder']).catch(error => this._notifyError(error));
        });
        this._menu.addMenuItem(this._openFolderItem);
    }

    destroy() {
        this._notificationSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notificationSource = null;
        this.button.destroy();
    }

    async refresh() {
        try {
            const status = await this._runBackend(['status']);
            this._applyStatus(status);
        } catch (error) {
            this._recording = false;
            this._setUi(false, 'Recorder unavailable', 'Start Recording');
            logUnknownError(error, 'Meeting Recorder status refresh');
        }
    }

    private async _toggleRecording() {
        try {
            const result = await this._runBackend([this._recording ? 'stop' : 'start']);
            this._applyStatus(result);

            if (result.recording)
                Main.notify('Meeting Recorder', 'Recording started');
            else if (result.file)
                this._notifyRecordingSaved(result.file);
        } catch (error) {
            this._notifyError(error);
        }
    }

    private _applyStatus(status: BackendStatus) {
        this._recording = Boolean(status.recording);
        if (status.file)
            this._lastFile = status.file;

        if (this._recording) {
            this._setUi(true, 'Recording', 'Stop Recording');
            return;
        }

        if (status.message)
            this._setUi(false, status.message, 'Start Recording');
        else if (this._lastFile)
            this._setUi(false, `Last: ${GLib.path_get_basename(this._lastFile)}`, 'Start Recording');
        else
            this._setUi(false, 'Not recording', 'Start Recording');
    }

    private _setUi(recording: boolean, statusText: string, toggleText: string) {
        this._icon.icon_name = recording ? 'media-playback-stop-symbolic' : 'media-record-symbolic';
        this._icon.style = recording ? 'color: #ff4d4d;' : '';
        this._statusItem.label.text = statusText;
        this._toggleItem.label.text = toggleText;
    }

    private async _runBackend(args: string[]): Promise<BackendStatus> {
        const argv = [this._extension.backendPath, ...args];
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );

        const [, stdoutBytes, stderrBytes] = await communicateUtf8(proc);
        const stdout = stdoutBytes ?? '';
        const stderr = stderrBytes ?? '';

        if (!proc.get_successful()) {
            const detail = stderr.trim() || stdout.trim() || `exit status ${proc.get_exit_status()}`;
            throw new Error(detail);
        }

        try {
            return JSON.parse(stdout) as BackendStatus;
        } catch {
            throw new Error(`invalid backend response: ${stdout}`);
        }
    }

    private _requirePopupMenu(menu: PopupMenu.PopupMenu | PopupMenu.PopupDummyMenu): PopupMenu.PopupMenu {
        if (menu instanceof PopupMenu.PopupMenu)
            return menu;

        throw new Error('Meeting Recorder indicator was created without a popup menu');
    }

    private _notifyRecordingSaved(file: string) {
        const source = this._getNotificationSource();
        const notification = new MessageTray.Notification({
            source,
            title: 'Meeting Recorder',
            body: `Recording saved: ${GLib.path_get_basename(file)}`,
            iconName: 'audio-x-generic-symbolic',
        });

        notification.connect('activated', () => this._openFileLocation(file));
        notification.addAction('Open Location', () => this._openFileLocation(file));
        source.addNotification(notification);
    }

    private _getNotificationSource() {
        if (this._notificationSource)
            return this._notificationSource;

        const source = new MessageTray.Source({
            title: 'Meeting Recorder',
            iconName: 'media-record-symbolic',
            policy: new MessageTray.NotificationGenericPolicy(),
        });

        source.connect('destroy', () => {
            if (this._notificationSource === source)
                this._notificationSource = null;
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
            this._notifyError(error);
        }
    }

    private _notifyError(error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logUnknownError(error, 'Meeting Recorder');
        Main.notifyError('Meeting Recorder', message);
    }
}

function communicateUtf8(proc: Gio.Subprocess): Promise<[boolean, string, string]> {
    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, null, (_source, result) => {
            try {
                resolve(proc.communicate_utf8_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function logUnknownError(error: unknown, context: string) {
    if (error instanceof Error) {
        logError(error, context);
        return;
    }

    logError(new Error(String(error)), context);
}

export default MeetingRecorderExtension;
