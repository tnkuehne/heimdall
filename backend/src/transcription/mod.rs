mod deepgram;
pub mod provider;
mod xai;

use crate::{auth, config};
use anyhow::{bail, Context, Result};
use deepgram::DeepgramProvider;
use provider::{
    default_transcript_path, TranscriptionProvider, TranscriptionRequest, TranscriptionSummary,
};
use serde_json::Value;
use std::env;
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use xai::XaiProvider;

pub fn transcribe(
    provider: &str,
    audio_file: PathBuf,
    language: Option<String>,
    format: bool,
    _multichannel: bool,
    output: Option<PathBuf>,
) -> Result<TranscriptionSummary> {
    let provider_id = auth::normalize_provider(provider)?;
    let provider = provider_for(provider_id);

    let audio_file = audio_file
        .canonicalize()
        .with_context(|| format!("failed to resolve audio file {}", audio_file.display()))?;
    let transcript_file = output.unwrap_or_else(|| default_transcript_path(&audio_file));
    let api_key = auth::get_api_key(provider.id())?;
    let downmixed_audio = prepare_transcription_audio(&audio_file)?;
    let provider_audio_file = downmixed_audio
        .as_ref()
        .map(|audio| audio.path.clone())
        .unwrap_or_else(|| audio_file.clone());
    let request = TranscriptionRequest {
        audio_file: provider_audio_file,
        language,
        format,
        multichannel: false,
    };

    let response = provider.transcribe(&request, &api_key)?;
    write_transcript(&transcript_file, &response)?;
    let duration = transcript_duration(&response);
    let channels = transcript_channels(&response);
    let channel_count = channels.as_ref().and_then(transcript_channel_count);
    let post_transcribe_hook_error = spawn_post_transcribe_hook(
        provider.id(),
        &audio_file,
        &transcript_file,
        duration,
        channel_count,
    );

    Ok(TranscriptionSummary {
        provider: provider.id(),
        audio_file,
        transcript_file,
        text: transcript_text(&response),
        duration,
        channels,
        post_transcribe_hook_error,
    })
}

fn provider_for(provider: &str) -> Box<dyn TranscriptionProvider> {
    match provider {
        "xai" => Box::new(XaiProvider),
        "deepgram" => Box::new(DeepgramProvider),
        _ => unreachable!("provider should have been normalized before dispatch"),
    }
}

struct TempAudio {
    path: PathBuf,
}

impl Drop for TempAudio {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn prepare_transcription_audio(audio_file: &Path) -> Result<Option<TempAudio>> {
    let channels = audio_channel_count(audio_file)?;

    if channels <= 1 {
        return Ok(None);
    }

    let output = temp_downmix_path(audio_file);
    let status = Command::new("ffmpeg")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(audio_file)
        .arg("-filter_complex")
        .arg("pan=mono|c0=0.5*c0+0.5*c1,aformat=channel_layouts=mono")
        .arg("-ar")
        .arg("24000")
        .arg("-ac")
        .arg("1")
        .arg("-codec:a")
        .arg("libmp3lame")
        .arg("-b:a")
        .arg("64k")
        .arg(&output)
        .status()
        .context("failed to start ffmpeg for transcription downmix")?;

    if !status.success() {
        bail!("ffmpeg failed to create transcription downmix");
    }

    Ok(Some(TempAudio { path: output }))
}

fn audio_channel_count(audio_file: &Path) -> Result<usize> {
    let output = Command::new("ffprobe")
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("a:0")
        .arg("-show_entries")
        .arg("stream=channels")
        .arg("-of")
        .arg("default=nokey=1:noprint_wrappers=1")
        .arg(audio_file)
        .output()
        .context("failed to start ffprobe for transcription input")?;

    if !output.status.success() {
        bail!("ffprobe failed to inspect transcription input");
    }

    let channels = String::from_utf8(output.stdout)
        .context("ffprobe returned non-UTF-8 channel count")?
        .trim()
        .parse()
        .context("ffprobe returned invalid channel count")?;

    Ok(channels)
}

fn temp_downmix_path(audio_file: &Path) -> PathBuf {
    let stem = audio_file
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("audio");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    env::temp_dir().join(format!(
        "meeting-recorder-{stem}-{}-{nonce}.downmix.mp3",
        std::process::id()
    ))
}

fn write_transcript(path: &PathBuf, response: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| {
            format!("failed to create transcript directory {}", parent.display())
        })?;
    }

    std::fs::write(path, render_markdown(response))
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn spawn_post_transcribe_hook(
    provider: &str,
    audio_file: &PathBuf,
    transcript_file: &PathBuf,
    duration: Option<f64>,
    channel_count: Option<usize>,
) -> Option<String> {
    let config = match config::get() {
        Ok(config) => config,
        Err(error) => return Some(error.to_string()),
    };
    let Some(hook) = config.post_transcribe_hook else {
        return None;
    };

    let mut command = Command::new(&hook);
    command
        .env("MEETING_RECORDER_EVENT", "post_transcribe")
        .env("MEETING_RECORDER_PROVIDER", provider)
        .env("MEETING_RECORDER_AUDIO_FILE", audio_file)
        .env("MEETING_RECORDER_TRANSCRIPT_FILE", transcript_file)
        .env("MEETING_RECORDER_RECORDINGS_DIR", &config.recordings_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if let Some(duration) = duration {
        command.env(
            "MEETING_RECORDER_DURATION_SECONDS",
            format!("{duration:.3}"),
        );
    }
    if let Some(channel_count) = channel_count {
        command.env("MEETING_RECORDER_CHANNELS", channel_count.to_string());
    }

    command
        .spawn()
        .map(|_| None)
        .unwrap_or_else(|error| Some(format!("failed to spawn {}: {error}", hook.display())))
}

fn render_markdown(response: &Value) -> String {
    let mut markdown = String::new();
    markdown.push_str("# Transcript\n\n");

    if let Some(turns) = deepgram_utterance_turns(response) {
        for turn in turns {
            let _ = writeln!(markdown, "**{}:** {}\n", turn.speaker, turn.text);
        }
    } else if let Some(turns) = xai_diarized_turns(response) {
        for turn in turns {
            let _ = writeln!(markdown, "**{}:** {}\n", turn.speaker, turn.text);
        }
    } else if let Some(text) = response.get("text").and_then(Value::as_str) {
        markdown.push_str(text.trim());
        markdown.push('\n');
    } else if let Some(turns) = transcript_turns(response) {
        for turn in turns {
            let _ = writeln!(markdown, "**{}:** {}\n", turn.speaker, turn.text);
        }
    } else if is_empty_transcription(response) {
        markdown.push_str("_No speech was detected in this recording._\n");
    } else {
        markdown.push_str("```json\n");
        markdown.push_str(
            &serde_json::to_string_pretty(response).unwrap_or_else(|_| response.to_string()),
        );
        markdown.push_str("\n```\n");
    }

    markdown
}

#[derive(Debug)]
struct Word {
    speaker: String,
    start: f64,
    end: f64,
    text: String,
}

#[derive(Debug)]
struct Turn {
    speaker: String,
    text: String,
}

fn transcript_text(response: &Value) -> Option<String> {
    response
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| first_deepgram_transcript(response))
}

fn first_deepgram_transcript(response: &Value) -> Option<String> {
    response
        .pointer("/results/channels")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|channel| {
            channel
                .get("alternatives")
                .and_then(Value::as_array)?
                .iter()
                .filter_map(|alternative| alternative.get("transcript").and_then(Value::as_str))
                .find(|transcript| !transcript.trim().is_empty())
        })
        .map(ToOwned::to_owned)
        .next()
}

fn transcript_duration(response: &Value) -> Option<f64> {
    response
        .get("duration")
        .and_then(Value::as_f64)
        .or_else(|| {
            response
                .pointer("/metadata/duration")
                .and_then(Value::as_f64)
        })
}

fn transcript_channels(response: &Value) -> Option<Value> {
    response
        .get("channels")
        .cloned()
        .or_else(|| response.pointer("/results/channels").cloned())
}

fn transcript_channel_count(channels: &Value) -> Option<usize> {
    channels
        .as_array()
        .map(Vec::len)
        .or_else(|| channels.as_u64().map(|count| count as usize))
}

fn is_empty_transcription(response: &Value) -> bool {
    let utterances_empty = response
        .pointer("/results/utterances")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    let channels = response
        .pointer("/results/channels")
        .and_then(Value::as_array);

    let Some(channels) = channels else {
        return false;
    };

    utterances_empty
        && channels.iter().all(|channel| {
            channel
                .get("alternatives")
                .and_then(Value::as_array)
                .is_none_or(|alternatives| {
                    alternatives.iter().all(|alternative| {
                        let transcript_empty = alternative
                            .get("transcript")
                            .and_then(Value::as_str)
                            .is_none_or(|transcript| transcript.trim().is_empty());
                        let words_empty = alternative
                            .get("words")
                            .and_then(Value::as_array)
                            .is_none_or(Vec::is_empty);

                        transcript_empty && words_empty
                    })
                })
        })
}

fn deepgram_utterance_turns(response: &Value) -> Option<Vec<Turn>> {
    let utterances = response.pointer("/results/utterances")?.as_array()?;
    let mut turns = Vec::new();

    for utterance in utterances {
        let text = utterance
            .get("transcript")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();

        if text.is_empty() {
            continue;
        }

        turns.push(Turn {
            speaker: deepgram_speaker(utterance),
            text: text.to_string(),
        });
    }

    if turns.is_empty() {
        None
    } else {
        Some(turns)
    }
}

fn deepgram_speaker(utterance: &Value) -> String {
    if let Some(speaker) = utterance.get("speaker").and_then(Value::as_u64) {
        return format!("Speaker {}", speaker + 1);
    }

    let channel = utterance
        .get("channel")
        .and_then(Value::as_u64)
        .or_else(|| {
            utterance
                .get("channel")
                .and_then(Value::as_array)
                .and_then(|channel| channel.first())
                .and_then(Value::as_u64)
        });

    match channel {
        Some(0) => "Me".to_string(),
        Some(_) => "Meeting".to_string(),
        None => "Speaker".to_string(),
    }
}

fn transcript_turns(response: &Value) -> Option<Vec<Turn>> {
    let channels = response
        .get("channels")
        .or_else(|| response.pointer("/results/channels"))?;
    words_to_turns(channel_words(channels))
}

fn xai_diarized_turns(response: &Value) -> Option<Vec<Turn>> {
    let words = response.get("words")?.as_array()?;
    let mut diarized_words = Vec::new();

    for word in words {
        let speaker = word.get("speaker")?.as_u64()?;
        diarized_words.push(Word {
            speaker: format!("Speaker {}", speaker + 1),
            start: word.get("start")?.as_f64()?,
            end: word
                .get("end")
                .and_then(Value::as_f64)
                .unwrap_or_else(|| word.get("start").and_then(Value::as_f64).unwrap_or(0.0)),
            text: word.get("text")?.as_str()?.to_string(),
        });
    }

    words_to_turns(diarized_words)
}

fn words_to_turns(mut words: Vec<Word>) -> Option<Vec<Turn>> {
    if words.is_empty() {
        return None;
    }

    words.sort_by(|left, right| {
        left.start
            .partial_cmp(&right.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut turns: Vec<Turn> = Vec::new();
    let mut current_speaker = words[0].speaker.clone();
    let mut current_end = words[0].end;
    let mut current_text = String::new();

    for word in words {
        let same_turn = word.speaker == current_speaker && word.start - current_end <= 1.0;

        if !same_turn && !current_text.is_empty() {
            turns.push(Turn {
                speaker: current_speaker.clone(),
                text: current_text.trim().to_string(),
            });
            current_text.clear();
        }

        if !same_turn {
            current_speaker = word.speaker;
        }

        current_end = word.end;
        push_word(&mut current_text, &word.text);
    }

    if !current_text.is_empty() {
        turns.push(Turn {
            speaker: current_speaker,
            text: current_text.trim().to_string(),
        });
    }

    Some(turns)
}

fn channel_words(channels: &Value) -> Vec<Word> {
    let Some(channels) = channels.as_array() else {
        return Vec::new();
    };

    channels
        .iter()
        .enumerate()
        .flat_map(|(fallback_index, channel)| {
            let speaker = channel_speaker(channel, fallback_index);
            channel
                .get("words")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(move |word| {
                    Some(Word {
                        speaker: speaker.clone(),
                        start: word.get("start")?.as_f64()?,
                        end: word.get("end").and_then(Value::as_f64).unwrap_or_else(|| {
                            word.get("start").and_then(Value::as_f64).unwrap_or(0.0)
                        }),
                        text: word.get("text")?.as_str()?.to_string(),
                    })
                })
        })
        .collect()
}

fn channel_speaker(channel: &Value, fallback_index: usize) -> String {
    let index = channel
        .get("index")
        .or_else(|| channel.get("channel_index"))
        .and_then(Value::as_u64)
        .unwrap_or(fallback_index as u64);

    match index {
        0 => "Me".to_string(),
        1 => "Meeting".to_string(),
        _ => "Unknown".to_string(),
    }
}

fn push_word(output: &mut String, word: &str) {
    if output.is_empty() || is_punctuation(word) {
        output.push_str(word);
    } else {
        output.push(' ');
        output.push_str(word);
    }
}

fn is_punctuation(word: &str) -> bool {
    matches!(word, "." | "," | "!" | "?" | ":" | ";" | ")" | "]" | "}")
}
