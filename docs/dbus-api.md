# Meeting Recorder D-Bus API

The authoritative structural contract is
`data/com.timokuehne.MeetingRecorder1.xml`. The service owns the session-bus name
`com.timokuehne.MeetingRecorder1` and exports
`/com/timokuehne/MeetingRecorder1`.

Empty strings represent absent optional paths, timestamps, messages, and language values. Public
methods are:

| Method | Purpose |
| --- | --- |
| `GetStatus` | Return the current recording state and diagnostic message. |
| `StartRecording` | Start or reuse the current recording and return its path and start time. |
| `StopRecording` | Stop and finalize the current recording and return its path. |
| `Transcribe` | Transcribe one audio file with explicit options. |
| `GetApiKeyStatus` | Report whether a provider key exists. |
| `SetApiKey` | Store a provider key received through a Unix file descriptor. |
| `DeleteApiKey` | Remove a provider key. |

The read-only `Recording`, `RecordingFile`, `StartedAt`, `BrowserAudioCapture`, and
`BrowserVideoCapture` properties publish shared state. Gio delivers their changes through the
standard `org.freedesktop.DBus.Properties.PropertiesChanged` signal. The service additionally
emits `TranscriptionCompleted` and `TranscriptionFailed` for automatic transcription.

Methods can return these stable domain errors:

| Error name | Meaning |
| --- | --- |
| `com.timokuehne.MeetingRecorder1.Error.InvalidProvider` | The provider is not supported. |
| `com.timokuehne.MeetingRecorder1.Error.InvalidArgument` | A method argument is invalid. |
| `com.timokuehne.MeetingRecorder1.Error.Failed` | The requested operation failed. |

`SetApiKey` receives the secret through a Unix file descriptor. The descriptor is consumed during
the method call, its UTF-8 contents are limited to 64 KiB, and the secret is never included in a
D-Bus value, command-line argument, response, signal, or log message.

`StopRecording` finalizes the audio file before returning. If automatic transcription is enabled,
the service starts it after the response and reports its outcome through `TranscriptionCompleted`
or `TranscriptionFailed`.
