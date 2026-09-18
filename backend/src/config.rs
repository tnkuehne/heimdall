use crate::auth;
use anyhow::{anyhow, bail, Context, Result};
use gio::prelude::SettingsExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const SCHEMA_ID: &str = "com.timokuehne.meeting-recorder";

const XAI_BASE_URL_KEY: &str = "xai-base-url";
const DEEPGRAM_BASE_URL_KEY: &str = "deepgram-base-url";
const TRANSCRIPTION_PROVIDER_KEY: &str = "transcription-provider";
const RECORDINGS_DIRECTORY_KEY: &str = "recordings-directory";
const POST_TRANSCRIBE_HOOK_KEY: &str = "post-transcribe-hook";

#[derive(Debug, Eq, PartialEq)]
pub struct ProviderBaseUrl {
    pub value: String,
    pub is_custom: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub struct PostTranscribeSettings {
    pub hook: PathBuf,
    pub recordings_dir: PathBuf,
}

pub fn provider_base_url(provider: &str, default_base_url: &str) -> Result<ProviderBaseUrl> {
    let provider = auth::normalize_provider(provider)?;
    let key = match provider {
        "xai" => XAI_BASE_URL_KEY,
        "deepgram" => DEEPGRAM_BASE_URL_KEY,
        _ => unreachable!("provider should have been normalized before selecting its setting"),
    };
    let value = normalize_base_url(&read_string(key)?)?;
    let default = normalize_base_url(default_base_url)
        .context("built-in transcription provider base URL is invalid")?;

    Ok(ProviderBaseUrl {
        is_custom: value != default,
        value,
    })
}

pub fn transcription_provider() -> Result<Option<&'static str>> {
    match read_string(TRANSCRIPTION_PROVIDER_KEY)?.as_str() {
        "disabled" => Ok(None),
        "xai" => Ok(Some("xai")),
        "deepgram" => Ok(Some("deepgram")),
        provider => bail!(
            "GSettings key {TRANSCRIPTION_PROVIDER_KEY} contains an unsupported provider: {provider}"
        ),
    }
}

pub fn recordings_dir() -> Result<PathBuf> {
    resolve_recordings_dir(&read_string(RECORDINGS_DIRECTORY_KEY)?, &home_dir()?)
}

pub fn post_transcribe_settings() -> Result<Option<PostTranscribeSettings>> {
    let configured_hook = read_string(POST_TRANSCRIBE_HOOK_KEY)?;
    if configured_hook.is_empty() {
        return Ok(None);
    }

    let hook = validate_post_transcribe_hook(Path::new(&configured_hook))?;
    Ok(Some(PostTranscribeSettings {
        hook,
        recordings_dir: recordings_dir()?,
    }))
}

fn settings() -> Result<gio::Settings> {
    let source = gio::SettingsSchemaSource::default()
        .ok_or_else(|| anyhow!("the default GSettings schema source is unavailable"))?;

    if let Some(directory) = adjacent_schema_directory() {
        let local_source =
            gio::SettingsSchemaSource::from_directory(&directory, Some(&source), false)
                .with_context(|| {
                    format!(
                        "failed to load the bundled GSettings schemas from {}",
                        directory.display()
                    )
                })?;
        return settings_from_source(&local_source, gio::SettingsBackend::NONE);
    }

    settings_from_source(&source, gio::SettingsBackend::NONE)
}

fn adjacent_schema_directory() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    schema_directory_adjacent_to(&executable)
}

fn schema_directory_adjacent_to(executable: &Path) -> Option<PathBuf> {
    let extension_directory = executable.parent()?.parent()?;
    let schema_directory = extension_directory.join("schemas");
    schema_directory.is_dir().then_some(schema_directory)
}

fn settings_from_source(
    source: &gio::SettingsSchemaSource,
    backend: Option<&gio::SettingsBackend>,
) -> Result<gio::Settings> {
    let schema = source.lookup(SCHEMA_ID, true).ok_or_else(|| {
        anyhow!("GSettings schema {SCHEMA_ID} is not installed; reinstall Meeting Recorder")
    })?;

    Ok(gio::Settings::new_full(&schema, backend, None))
}

fn read_string(key: &str) -> Result<String> {
    Ok(settings()?.string(key).to_string())
}

fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow!("could not determine home directory"))
}

fn resolve_recordings_dir(configured: &str, home: &Path) -> Result<PathBuf> {
    let path = if configured.is_empty() {
        home.join("Recordings").join("Meetings")
    } else {
        PathBuf::from(configured)
    };

    if !path.is_absolute() {
        bail!(
            "GSettings key {RECORDINGS_DIRECTORY_KEY} must contain an absolute path or be empty: {}",
            path.display()
        );
    }

    Ok(path)
}

fn validate_post_transcribe_hook(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!(
            "GSettings key {POST_TRANSCRIBE_HOOK_KEY} must contain an absolute path or be empty: {}",
            path.display()
        );
    }

    let metadata =
        std::fs::metadata(path).with_context(|| format!("failed to read {}", path.display()))?;
    if !metadata.is_file() {
        bail!("post-transcribe hook is not a file: {}", path.display());
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        bail!("post-transcribe hook is not executable: {}", path.display());
    }

    Ok(path.to_path_buf())
}

fn normalize_base_url(base_url: &str) -> Result<String> {
    let base_url = base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(base_url).context("base URL is not a valid URL")?;

    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("base URL must use http or https");
    }
    if parsed.host_str().is_none() {
        bail!("base URL must include a host");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("base URL must not contain credentials");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        bail!("base URL must not contain a query or fragment");
    }

    Ok(base_url.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = Self(std::env::temp_dir().join(format!(
                "meeting-recorder-{label}-{}-{unique}",
                std::process::id()
            )));
            std::fs::create_dir(&directory.0).unwrap();
            directory
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn empty_recordings_directory_uses_home_default() {
        assert_eq!(
            resolve_recordings_dir("", Path::new("/home/tester")).unwrap(),
            Path::new("/home/tester/Recordings/Meetings")
        );
    }

    #[test]
    fn recordings_directory_must_be_absolute() {
        let error = resolve_recordings_dir("relative/path", Path::new("/home/tester")).unwrap_err();
        assert!(error.to_string().contains("must contain an absolute path"));
    }

    #[test]
    fn base_url_is_normalized_and_validated() {
        assert_eq!(
            normalize_base_url(" https://api.example.com/root/ ").unwrap(),
            "https://api.example.com/root"
        );
        assert!(normalize_base_url("file:///tmp/service").is_err());
        assert!(normalize_base_url("https://user@example.com").is_err());
        assert!(normalize_base_url("https://example.com?token=value").is_err());
    }

    #[test]
    fn discovers_schema_next_to_installed_backend() {
        let directory = TestDirectory::new("layout");
        let binary_directory = directory.0.join("bin");
        let schema_directory = directory.0.join("schemas");
        std::fs::create_dir(&binary_directory).unwrap();
        std::fs::create_dir(&schema_directory).unwrap();

        assert_eq!(
            schema_directory_adjacent_to(&binary_directory.join("meeting-recorder")),
            Some(schema_directory)
        );
    }

    #[test]
    fn schema_defaults_and_choices_are_available_through_gio() {
        let directory = TestDirectory::new("settings");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../data")
                .join(format!("{SCHEMA_ID}.gschema.xml")),
            directory.0.join(format!("{SCHEMA_ID}.gschema.xml")),
        )
        .unwrap();
        let status = Command::new("glib-compile-schemas")
            .arg("--strict")
            .arg(&directory.0)
            .status()
            .unwrap();
        assert!(status.success());

        let source = gio::SettingsSchemaSource::from_directory(
            &directory.0,
            gio::SettingsSchemaSource::default().as_ref(),
            false,
        )
        .unwrap();
        let backend = gio::memory_settings_backend_new();
        let settings = settings_from_source(&source, Some(&backend)).unwrap();

        assert_eq!(settings.string("transcription-provider"), "disabled");
        assert_eq!(settings.string(XAI_BASE_URL_KEY), "https://api.x.ai");
        assert_eq!(
            settings.string(DEEPGRAM_BASE_URL_KEY),
            "https://api.deepgram.com"
        );
        assert_eq!(settings.string(RECORDINGS_DIRECTORY_KEY), "");
        assert_eq!(settings.string(POST_TRANSCRIBE_HOOK_KEY), "");
        assert!(settings.boolean("meeting-detection-reminder-enabled"));
        assert!(settings.set_string("transcription-provider", "xai").is_ok());
        assert_eq!(settings.string("transcription-provider"), "xai");
    }
}
