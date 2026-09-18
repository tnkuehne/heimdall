use anyhow::{bail, Context, Result};
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::process::{Command, Stdio};

#[derive(Debug, Default, Clone, Copy, Eq, PartialEq)]
pub(crate) struct CaptureState {
    pub(crate) browser_audio_capture: bool,
    pub(crate) browser_video_capture: bool,
}

#[derive(Debug, Clone)]
struct PipeWireNode {
    state: Option<String>,
    media_class: Option<String>,
    application_name: Option<String>,
    application_binary: Option<String>,
}

#[derive(Debug, Clone)]
struct PipeWireLink {
    state: Option<String>,
    output_node_id: u64,
    input_node_id: u64,
}

#[derive(Default)]
struct PipeWireGraph {
    nodes: HashMap<u64, PipeWireNode>,
    links: HashMap<u64, PipeWireLink>,
}

impl PipeWireGraph {
    fn apply_object(&mut self, object: &serde_json::Value) {
        let Some(id) = object.get("id").and_then(serde_json::Value::as_u64) else {
            return;
        };
        let Some(object_type) = object.get("type").and_then(serde_json::Value::as_str) else {
            self.remove(id);
            return;
        };

        match object_type {
            "PipeWire:Interface:Node" => {
                if let Some(node) = parse_node(object) {
                    self.nodes.insert(id, node);
                } else {
                    self.nodes.remove(&id);
                }
            }
            "PipeWire:Interface:Link" => {
                if let Some(link) = parse_link(object) {
                    self.links.insert(id, link);
                } else {
                    self.links.remove(&id);
                }
            }
            _ => self.remove(id),
        }
    }

    fn remove(&mut self, id: u64) {
        self.nodes.remove(&id);
        self.links.remove(&id);
    }

    fn capture_state(&self) -> CaptureState {
        let active_audio_capture_nodes = self.active_browser_capture_nodes("audio");
        let active_video_capture_nodes = self.active_browser_capture_nodes("video");

        CaptureState {
            browser_audio_capture: self
                .has_active_capture_link(&active_audio_capture_nodes, "audio"),
            browser_video_capture: self
                .has_active_capture_link(&active_video_capture_nodes, "video"),
        }
    }

    fn active_browser_capture_nodes(&self, media_kind: &str) -> HashSet<u64> {
        self.nodes
            .iter()
            .filter_map(|(id, node)| {
                let media_class = node.media_class.as_deref()?.to_ascii_lowercase();
                if node.state.as_deref() == Some("running")
                    && is_browser_node(node)
                    && media_class.contains("stream/input")
                    && media_class.contains(media_kind)
                {
                    Some(*id)
                } else {
                    None
                }
            })
            .collect()
    }

    fn has_active_capture_link(&self, capture_nodes: &HashSet<u64>, media_kind: &str) -> bool {
        self.links.values().any(|link| {
            if link.state.as_deref() != Some("active")
                || !capture_nodes.contains(&link.input_node_id)
            {
                return false;
            }

            let Some(source_node) = self.nodes.get(&link.output_node_id) else {
                return false;
            };
            let Some(media_class) = source_node.media_class.as_deref() else {
                return false;
            };

            let media_class = media_class.to_ascii_lowercase();
            media_class.contains(media_kind) && media_class.contains("source")
        })
    }
}

pub(crate) fn monitor(mut emit: impl FnMut(CaptureState) -> Result<()>) -> Result<()> {
    ensure_pw_dump()?;

    let mut pw_dump = Command::new("pw-dump")
        .arg("--monitor")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .context("failed to start pw-dump --monitor")?;

    let stdout = pw_dump
        .stdout
        .take()
        .context("failed to capture pw-dump stdout")?;
    let reader = BufReader::new(stdout);
    let stream = serde_json::Deserializer::from_reader(reader).into_iter::<serde_json::Value>();
    let mut graph = PipeWireGraph::default();
    let mut last_state: Option<CaptureState> = None;

    for value in stream {
        let value = value.context("failed to parse pw-dump monitor JSON")?;
        let Some(objects) = value.as_array() else {
            continue;
        };

        for object in objects {
            graph.apply_object(object);
        }

        let state = graph.capture_state();
        if last_state != Some(state) {
            emit(state)?;
            last_state = Some(state);
        }
    }

    let status = pw_dump
        .wait()
        .context("failed to wait for pw-dump --monitor")?;
    if !status.success() {
        bail!("pw-dump --monitor exited with {status}");
    }

    Ok(())
}

fn ensure_pw_dump() -> Result<()> {
    Command::new("pw-dump")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("required command not found: pw-dump")?;
    Ok(())
}

fn parse_node(object: &serde_json::Value) -> Option<PipeWireNode> {
    let info = object.get("info")?;
    let props = info.get("props")?;

    Some(PipeWireNode {
        state: value_string(info, "state"),
        media_class: value_string(props, "media.class"),
        application_name: value_string(props, "application.name"),
        application_binary: value_string(props, "application.process.binary"),
    })
}

fn parse_link(object: &serde_json::Value) -> Option<PipeWireLink> {
    let info = object.get("info")?;

    Some(PipeWireLink {
        state: value_string(info, "state"),
        output_node_id: info
            .get("output-node-id")
            .or_else(|| info.pointer("/props/link.output.node"))?
            .as_u64()?,
        input_node_id: info
            .get("input-node-id")
            .or_else(|| info.pointer("/props/link.input.node"))?
            .as_u64()?,
    })
}

fn value_string(object: &serde_json::Value, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn is_browser_node(node: &PipeWireNode) -> bool {
    node.application_binary
        .as_deref()
        .is_some_and(is_browser_identifier)
        || node
            .application_name
            .as_deref()
            .is_some_and(is_browser_identifier)
}

fn is_browser_identifier(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    ["chrome", "chromium", "brave", "msedge", "firefox"]
        .iter()
        .any(|browser| value.contains(browser))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn active_browser_audio_link_is_reported() {
        let mut graph = PipeWireGraph::default();
        graph.apply_object(&node(1, "running", "Audio/Source", "PipeWire"));
        graph.apply_object(&node(2, "running", "Stream/Input/Audio", "Firefox"));
        graph.apply_object(&link(3, "active", 1, 2));

        assert_eq!(
            graph.capture_state(),
            CaptureState {
                browser_audio_capture: true,
                browser_video_capture: false,
            }
        );
    }

    #[test]
    fn inactive_or_non_browser_links_are_not_reported() {
        let mut graph = PipeWireGraph::default();
        graph.apply_object(&node(1, "running", "Audio/Source", "PipeWire"));
        graph.apply_object(&node(2, "running", "Stream/Input/Audio", "Recorder"));
        graph.apply_object(&link(3, "active", 1, 2));

        assert_eq!(graph.capture_state(), CaptureState::default());
    }

    fn node(id: u64, state: &str, media_class: &str, application: &str) -> serde_json::Value {
        json!({
            "id": id,
            "type": "PipeWire:Interface:Node",
            "info": {
                "state": state,
                "props": {
                    "media.class": media_class,
                    "application.name": application,
                },
            },
        })
    }

    fn link(id: u64, state: &str, output: u64, input: u64) -> serde_json::Value {
        json!({
            "id": id,
            "type": "PipeWire:Interface:Link",
            "info": {
                "state": state,
                "output-node-id": output,
                "input-node-id": input,
            },
        })
    }
}
