# Meeting Recorder

GNOME Shell extension plus Rust backend for recording meetings from the top bar.

The recorder uses `wpctl` to find the default microphone and current default system output, captures them through `ffmpeg`'s Pulse-compatible PipeWire path, mixes them, and writes a mono MP3 file.

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

On the first install, GNOME Shell may not discover the newly copied extension until the session restarts. If the enable command says `Extension "meeting-recorder@local" does not exist`, log out and back in, then run the enable command again.

## Usage

- Click the top bar icon to start or stop recording.
- Use the dropdown menu to start/stop recording or open the recordings folder.
- Recordings are saved to:

```text
~/Recordings/Meetings
```

Active recordings use a `.part.mp3` filename and are renamed to `.mp3` after a clean stop.

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
```

State and logs are written under:

```text
~/.local/state/meeting-recorder
```

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
