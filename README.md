# Meeting Recorder

GNOME Shell extension plus Rust backend for recording meetings from the top bar.

The recorder uses `wpctl` to find the default microphone and current default system output, captures them through `ffmpeg`'s Pulse-compatible PipeWire path, and writes a stereo MP3 file with microphone audio on the left channel and system audio on the right channel.

## Requirements

- GNOME Shell 46
- Rust/Cargo
- pnpm
- `ffmpeg`
- `wpctl`
- `gnome-extensions`

Install Rust/Cargo with `rustup`:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable
```

After installing `rustup`, restart the shell or run `source "$HOME/.cargo/env"` so `cargo` is on `PATH`.

On Fedora-like systems:

```sh
sudo dnf install wireplumber ffmpeg gnome-extensions-app
```

On Debian/Ubuntu-like systems:

```sh
sudo apt install wireplumber ffmpeg gnome-shell-extension-prefs
```

## Install

```sh
./install.sh
```

Then enable the extension:

```sh
gnome-extensions enable meeting-recorder@local
```

On GNOME Wayland, log out and back in after installing extension JavaScript or preferences changes. GNOME Shell does not reliably reload changed extension modules inside the same session. If the enable command says `Extension "meeting-recorder@local" does not exist`, log out and back in, then run the enable command again.

## Usage

- Click the top bar icon to start or stop recording.
- Use the dropdown menu to start/stop recording or open the recordings folder.
- Use the `Transcription` submenu to choose `Disabled`, `xAI`, or `Deepgram`.
- Open `Preferences` from the extension menu or GNOME Extensions to choose the recordings folder and configure API keys.
- Recordings are saved to this folder by default:

```text
~/Recordings/Meetings
```

Active recordings use a `.part.mp3` filename and are renamed to `.mp3` after a clean stop.
Transcription is disabled until a provider is selected. When `xAI` or `Deepgram` is selected,
stopping a recording automatically transcribes the saved audio and writes a Markdown transcript
next to the audio file.

## Backend

The Rust CLI is installed inside the extension directory:

```text
~/.local/share/gnome-shell/extensions/meeting-recorder@local/bin/meeting-recorder
```

Commands:

```sh
meeting-recorder start
meeting-recorder stop
meeting-recorder status
meeting-recorder open-folder
meeting-recorder config get
meeting-recorder config set-recordings-dir /absolute/path
meeting-recorder config reset-recordings-dir
```

State and logs are written under:

```text
~/.local/state/meeting-recorder
```

## Transcription

API keys are stored in GNOME Keyring through the Secret Service API. They are not written to the recorder state or config files.

Configure a provider from the extension menu:

- Open `Preferences`.
- Choose the transcription provider.
- Enter the provider API key in its password row and apply it.

The CLI can also configure keys:

```sh
meeting-recorder auth set xai
meeting-recorder auth status xai
meeting-recorder auth set deepgram
meeting-recorder auth status deepgram
```

For non-interactive callers, `auth set-stdin <provider>` reads the key from stdin.

The provider selection and recordings folder are stored in:

```text
~/.config/meeting-recorder/config.json
```

Transcribe a recording:

```sh
meeting-recorder transcribe ~/Recordings/Meetings/example.mp3 --provider xai
meeting-recorder transcribe ~/Recordings/Meetings/example.mp3 --provider deepgram
```

By default, transcription is requested with multichannel mode enabled, matching the recorder's stereo layout. The transcript Markdown document is written next to the recording as:

```text
example.transcript.md
```

Use `--output <path>` to choose a different transcript path. Use `--language <code> --format` when requesting formatted xAI output, because xAI requires a language when formatting is enabled. For Deepgram, the backend uses Nova 3 with smart formatting, punctuation, utterances, diarization, and multichannel transcription enabled.

## Development

The GNOME Shell source of truth is TypeScript:

```text
extension/extension.ts
```

Build the generated extension JavaScript with:

```sh
pnpm install
pnpm run build
```

Generated GNOME Shell files are written to `build/extension` and should not be committed.

GNOME/GJS types come from the published `@girs/gnome-shell` package pinned for GNOME Shell 46.
