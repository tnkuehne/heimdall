# Interactive meeting review in T3 Code

This optional hook starts a T3 chat after transcription. The agent clarifies
missing details, prepares a meeting note with the original transcript, and asks
for approval before committing and pushing it. The hook only launches the chat;
`meeting-prompt.md` defines the note and Git workflow and can be customized.
These instructions do not replace T3's runtime permissions.

## Setup

Requires Python 3.9+, a running T3 Code installation with your notes folder added
as a project, and a T3 CLI supporting `thread start`. The supplied prompt assumes
that the notes repository uses `main` and `origin`.

From the Heimdall repository root:

```sh
install -d -m 700 "$HOME/.config/meeting-recorder/t3-review"
install -m 700 examples/t3-meeting-review/post-transcribe \
  "$HOME/.config/meeting-recorder/t3-review/post-transcribe"
install -m 600 examples/t3-meeting-review/meeting-prompt.md \
  "$HOME/.config/meeting-recorder/t3-review/meeting-prompt.md"
cp -n examples/t3-meeting-review/config.example.json \
  "$HOME/.config/meeting-recorder/t3-review/config.json"
```

Edit the installed `config.json`: set `project_path` to your existing T3 notes
project, `notes_directory` to a relative destination inside it, and choose the
note language and recording timezone. Set `t3_binary` to your CLI path; `~` is
expanded in the project and CLI paths. Adapt the prompt to your notes conventions.

Preview the prompt using an existing transcript, without starting a chat:

```sh
"$HOME/.config/meeting-recorder/t3-review/post-transcribe" --dry-run \
  "$HOME/Recordings/Meetings/2026-01-15_10-00-00.transcript.md"
```

Select the installed executable in Meeting Recorder Preferences, or run:

```sh
gsettings set com.timokuehne.meeting-recorder post-transcribe-hook \
  "$HOME/.config/meeting-recorder/t3-review/post-transcribe"
```

Each invocation starts a new chat and returns after launch, without waiting for
review. There is no duplicate tracking or automatic retry. To retry manually,
run the preview command without `--dry-run`. The hook gets the transcript and
optional audio path from Heimdall's environment variables.

## Optional logging

Errors go to stderr and a failed T3 command exits nonzero. Heimdall launches hooks
without capturing output or monitoring their exit status. To keep a log, save
this wrapper alongside the hook, make it executable, and select the wrapper in
Preferences instead:

```sh
#!/bin/sh
umask 077
exec "$HOME/.config/meeting-recorder/t3-review/post-transcribe" \
  >>"$HOME/.config/meeting-recorder/t3-review/hook.log" 2>&1
```

To disable the hook:

```sh
gsettings reset com.timokuehne.meeting-recorder post-transcribe-hook
```
