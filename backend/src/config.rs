use crate::auth;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const CONFIG_DIR_NAME: &str = "meeting-recorder";
const CONFIG_FILE_NAME: &str = "config.json";

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub transcription_provider: Option<String>,
    #[serde(default = "default_recordings_dir_unchecked")]
    pub recordings_dir: PathBuf,
    pub post_transcribe_hook: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            transcription_provider: None,
            recordings_dir: default_recordings_dir_unchecked(),
            post_transcribe_hook: None,
        }
    }
}

pub fn get() -> Result<Config> {
    read_config()
}

pub fn set_transcription_provider(provider: &str) -> Result<Config> {
    let mut config = read_config()?;
    config.transcription_provider = normalize_optional_provider(provider)?.map(ToOwned::to_owned);
    write_config(&config)?;
    Ok(config)
}

pub fn set_recordings_dir(path: &Path) -> Result<Config> {
    if !path.is_absolute() {
        bail!("recordings directory must be an absolute path");
    }

    std::fs::create_dir_all(path)
        .with_context(|| format!("failed to create recordings directory {}", path.display()))?;
    if !path.is_dir() {
        bail!(
            "recordings directory is not a directory: {}",
            path.display()
        );
    }

    let mut config = read_config()?;
    config.recordings_dir = path.to_path_buf();
    write_config(&config)?;
    Ok(config)
}

pub fn reset_recordings_dir() -> Result<Config> {
    let mut config = read_config()?;
    config.recordings_dir = default_recordings_dir()?;
    write_config(&config)?;
    Ok(config)
}

pub fn set_post_transcribe_hook(path: &Path) -> Result<Config> {
    if !path.is_absolute() {
        bail!("post-transcribe hook must be an absolute path");
    }

    let metadata =
        std::fs::metadata(path).with_context(|| format!("failed to read {}", path.display()))?;
    if !metadata.is_file() {
        bail!("post-transcribe hook is not a file: {}", path.display());
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        bail!("post-transcribe hook is not executable: {}", path.display());
    }

    let mut config = read_config()?;
    config.post_transcribe_hook = Some(path.to_path_buf());
    write_config(&config)?;
    Ok(config)
}

pub fn clear_post_transcribe_hook() -> Result<Config> {
    let mut config = read_config()?;
    config.post_transcribe_hook = None;
    write_config(&config)?;
    Ok(config)
}

pub fn recordings_dir() -> Result<PathBuf> {
    Ok(read_config()?.recordings_dir)
}

pub fn default_recordings_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not determine home directory"))?;
    Ok(home.join("Recordings").join("Meetings"))
}

fn default_recordings_dir_unchecked() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Recordings")
        .join("Meetings")
}

fn normalize_optional_provider(provider: &str) -> Result<Option<&'static str>> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "none" | "disabled" | "off" => Ok(None),
        value => Ok(Some(auth::normalize_provider(value)?)),
    }
}

fn read_config() -> Result<Config> {
    let path = config_file()?;
    if !path.exists() {
        return Ok(Config::default());
    }

    let file = File::open(&path).with_context(|| format!("failed to open {}", path.display()))?;
    serde_json::from_reader(file).with_context(|| format!("failed to parse {}", path.display()))
}

fn write_config(config: &Config) -> Result<()> {
    let dir = config_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;

    let path = config_file()?;
    let tmp = path.with_extension("json.tmp");
    let file = File::create(&tmp).with_context(|| format!("failed to create {}", tmp.display()))?;
    serde_json::to_writer_pretty(file, config)
        .with_context(|| format!("failed to write {}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .with_context(|| format!("failed to move {} to {}", tmp.display(), path.display()))?;
    Ok(())
}

fn config_dir() -> Result<PathBuf> {
    if let Some(config_home) = dirs::config_dir() {
        return Ok(config_home.join(CONFIG_DIR_NAME));
    }

    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not determine home directory"))?;
    Ok(home.join(".config").join(CONFIG_DIR_NAME))
}

fn config_file() -> Result<PathBuf> {
    Ok(config_dir()?.join(CONFIG_FILE_NAME))
}
