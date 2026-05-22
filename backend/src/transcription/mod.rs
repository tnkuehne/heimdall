pub mod provider;
mod xai;

use crate::auth;
use anyhow::{Context, Result};
use provider::{
    default_transcript_path, TranscriptionProvider, TranscriptionRequest, TranscriptionSummary,
};
use serde_json::Value;
use std::fmt::Write;
use std::path::PathBuf;
use xai::XaiProvider;

pub fn transcribe(
    provider: &str,
    audio_file: PathBuf,
    language: Option<String>,
    format: bool,
    multichannel: bool,
    output: Option<PathBuf>,
) -> Result<TranscriptionSummary> {
    let provider_id = auth::normalize_provider(provider)?;
    let provider = provider_for(provider_id);

    let audio_file = audio_file
        .canonicalize()
        .with_context(|| format!("failed to resolve audio file {}", audio_file.display()))?;
    let transcript_file =
        output.unwrap_or_else(|| default_transcript_path(&audio_file, provider.id()));
    let api_key = auth::get_api_key(provider.id())?;
    let request = TranscriptionRequest {
        audio_file: audio_file.clone(),
        language,
        format,
        multichannel,
    };

    let response = provider.transcribe(&request, &api_key)?;
    write_transcript(&transcript_file, &response)?;

    Ok(TranscriptionSummary {
        provider: provider.id(),
        audio_file,
        transcript_file,
        text: response
            .get("text")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        duration: response.get("duration").and_then(Value::as_f64),
        channels: response.get("channels").cloned(),
    })
}

fn provider_for(provider: &str) -> Box<dyn TranscriptionProvider> {
    match provider {
        "xai" => Box::new(XaiProvider),
        _ => unreachable!("provider should have been normalized before dispatch"),
    }
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

fn render_markdown(response: &Value) -> String {
    let mut markdown = String::new();
    markdown.push_str("# Transcript\n\n");

    if let Some(text) = response.get("text").and_then(Value::as_str) {
        markdown.push_str(text.trim());
        markdown.push('\n');
    } else if let Some(turns) = transcript_turns(response) {
        for turn in turns {
            let _ = writeln!(markdown, "**{}:** {}\n", turn.speaker, turn.text);
        }
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
    speaker: &'static str,
    start: f64,
    end: f64,
    text: String,
}

#[derive(Debug)]
struct Turn {
    speaker: &'static str,
    text: String,
}

fn transcript_turns(response: &Value) -> Option<Vec<Turn>> {
    let channels = response.get("channels")?;
    let mut words = channel_words(channels);

    if words.is_empty() {
        return None;
    }

    words.sort_by(|left, right| {
        left.start
            .partial_cmp(&right.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut turns: Vec<Turn> = Vec::new();
    let mut current_speaker = words[0].speaker;
    let mut current_end = words[0].end;
    let mut current_text = String::new();

    for word in words {
        let same_turn = word.speaker == current_speaker && word.start - current_end <= 1.0;

        if !same_turn && !current_text.is_empty() {
            turns.push(Turn {
                speaker: current_speaker,
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
                        speaker,
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

fn channel_speaker(channel: &Value, fallback_index: usize) -> &'static str {
    let index = channel
        .get("index")
        .or_else(|| channel.get("channel_index"))
        .and_then(Value::as_u64)
        .unwrap_or(fallback_index as u64);

    match index {
        0 => "Me",
        1 => "Meeting",
        _ => "Unknown",
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
