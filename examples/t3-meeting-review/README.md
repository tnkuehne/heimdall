# Interactive meeting review in T3 Code

This optional post-transcribe hook opens a [T3 Code](https://t3.codes/) chat in your
notes project. The agent reads the transcript, asks about missing details such as
a participant's name, and prepares a meeting note with the original transcript.
It then shows the note and asks before committing and pushing it to `main`.

The hook itself only starts the chat. It does not edit your notes, call Git, or
send desktop notifications. T3 handles questions and notifications. The review
and Git approval steps are instructions to the agent, **not an OS-level permission
boundary**; T3's own runtime permissions still apply. Choose a T3 provider you are
comfortable using for the transcript and the project context it can read.

## Requirements

- Python 3.9+ on Linux; no additional Python packages.
- A running T3 Code installation with a configured provider and your notes folder
  already added as a project.
- A T3 CLI supporting `thread list`, `thread start --json`, and `thread show`.
  Check with `~/.t3/bin/t3 thread start --help`.
- For the supplied Git workflow, a notes repository with `main` and `origin`.
  Adapt `meeting-prompt.md` if your project uses different names or no Git.

## Install

Run these commands from the Heimdall repository root. They install a separate
example directory without overwriting another hook script:

```sh
install -d -m 700 "$HOME/.config/meeting-recorder/t3-review"
install -m 700 examples/t3-meeting-review/post-transcribe \
  "$HOME/.config/meeting-recorder/t3-review/post-transcribe"
install -m 600 examples/t3-meeting-review/meeting-prompt.md \
  "$HOME/.config/meeting-recorder/t3-review/meeting-prompt.md"
```

For the first installation, copy the configuration template (do not overwrite
an existing customized configuration):

```sh
cp -n examples/t3-meeting-review/config.example.json \
  "$HOME/.config/meeting-recorder/t3-review/config.json"
chmod 600 "$HOME/.config/meeting-recorder/t3-review/config.json"
```

Edit `config.json`:

- `project_path`: your existing T3 notes project, for example `~/notes`.
- `notes_directory`: note destination relative to the project, such as `meetings`.
- `timezone` and `language`: your recording timezone and preferred note language.
- `t3_binary`: the absolute path or `~` path to the T3 CLI. Desktop hooks may have
  a different `PATH` from your interactive shell.

Optional keys: `t3_home` selects a T3 data directory via `--base-dir`;
`state_directory` overrides the default state location described below. `~` is
expanded in filesystem settings, but shell variables such as `$HOME` are not.
The adjacent `meeting-prompt.md` can be adapted to your note format and review
process. No provider or model is forced; T3 uses the project's default.

Preview the prompt without starting a chat or touching Git:

```sh
"$HOME/.config/meeting-recorder/t3-review/post-transcribe" \
  --dry-run "$HOME/Recordings/Meetings/2026-01-15_10-00-00.transcript.md"
```

Use an existing transcript path. Inspect the generated `.prompt.md` and `.log`
files in the state directory. For a real test, run the same command without
`--dry-run` and open the resulting chat in T3. Finish any questions there; the
agent must ask for approval after showing the completed note.

Finally, select the installed executable in Meeting Recorder Preferences, or:

```sh
gsettings set com.timokuehne.meeting-recorder post-transcribe-hook \
  "$HOME/.config/meeting-recorder/t3-review/post-transcribe"
```

This replaces the configured hook. It does not change the transcription provider.
Older releases with JSON configuration instead support:

```sh
meeting-recorder config set-post-transcribe-hook \
  "$HOME/.config/meeting-recorder/t3-review/post-transcribe"
```

To disable the example on current releases:

```sh
gsettings reset com.timokuehne.meeting-recorder post-transcribe-hook
```

## Behavior and recovery

The recorder supplies `MEETING_RECORDER_TRANSCRIPT_FILE` and
`MEETING_RECORDER_AUDIO_FILE`. A transcript argument also supports manual use,
including custom transcript names and locations from `transcribe --output`.
If no audio path is supplied, the prompt leaves it unknown rather than guessing.

The hook returns as soon as T3 starts the chat; it does not use `--wait`. A lock
serializes launches. By default, logs and launch records are stored under
`${XDG_STATE_HOME:-~/.local/state}/meeting-recorder/t3-review/`. Filenames use a
hash of the project and transcript paths; each `.json` record includes the source
path, source hash, thread ID, and chat link. Logs and generated prompts are local
runtime data; do not commit them with this example.

- A repeat call for the same project and transcript reuses its chat and sends no
  extra message. If the transcript changed, the log directs you to continue in
  that chat. Tell the agent there to reread the updated transcript.
- If T3 is unreachable during the initial project check, no launch is recorded;
  start T3 and rerun the hook manually. There is no automatic retry scheduler.
- If a launch times out or returns an invalid response, its result is uncertain.
  A later call tries to recover the chat by its exact title. If it cannot find
  one (for example, its title changed), it stops instead of creating a duplicate.
  Inspect T3 and the log. Only after confirming that no chat exists, remove the
  corresponding `.json` record and rerun. To deliberately start a replacement,
  first stop the old chat, then remove its record and rename/archive its title
  so the title lookup does not rediscover it.
- Errors are logged and the script exits nonzero. No `notify-send` call is made.
  Meeting Recorder's fire-and-forget launcher does not monitor hook exit codes;
  failures inside this example therefore do not create a recorder notification.
  Failures to spawn the executable itself can still be reported by the recorder.

The hook never falls back to an automatic commit or push when T3 is unavailable.
The original audio and transcript are left untouched.

## Tests

From the repository root:

```sh
python3 -B -m unittest discover -s examples/t3-meeting-review -p 'test_*.py' -v
```

Tests use temporary directories and a fake T3 CLI. They do not start real chats,
modify the user's recorder configuration, or contact a model provider.
