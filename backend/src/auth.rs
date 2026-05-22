use anyhow::{bail, Context, Result};
use keyring_core::{set_default_store, Entry, Error as KeyringError};
use secrecy::SecretString;
use serde::Serialize;
use std::io::Read;
use zbus_secret_service_keyring_store::Store;

const SERVICE_NAME: &str = "meeting-recorder";

#[derive(Debug, Serialize)]
pub struct AuthStatus {
    pub provider: &'static str,
    pub configured: bool,
}

pub fn set_api_key(provider: &str) -> Result<AuthStatus> {
    let provider = normalize_provider(provider)?;
    let api_key = rpassword::prompt_password(format!("{provider} API key: "))
        .context("failed to read API key from terminal")?;
    set_api_key_value(provider, &api_key)
}

pub fn set_api_key_from_stdin(provider: &str) -> Result<AuthStatus> {
    let provider = normalize_provider(provider)?;
    let mut api_key = String::new();
    std::io::stdin()
        .read_to_string(&mut api_key)
        .context("failed to read API key from stdin")?;
    set_api_key_value(provider, &api_key)
}

fn set_api_key_value(provider: &'static str, api_key: &str) -> Result<AuthStatus> {
    let api_key = api_key.trim().to_string();

    if api_key.is_empty() {
        bail!("API key cannot be empty");
    }

    entry(provider)?
        .set_password(&api_key)
        .with_context(|| format!("failed to store {provider} API key in GNOME Keyring"))?;

    Ok(AuthStatus {
        provider,
        configured: true,
    })
}

pub fn status(provider: &str) -> Result<AuthStatus> {
    let provider = normalize_provider(provider)?;

    Ok(AuthStatus {
        provider,
        configured: has_api_key(provider)?,
    })
}

pub fn delete_api_key(provider: &str) -> Result<AuthStatus> {
    let provider = normalize_provider(provider)?;

    match entry(provider)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(AuthStatus {
            provider,
            configured: false,
        }),
        Err(error) => Err(error)
            .with_context(|| format!("failed to delete {provider} API key from GNOME Keyring")),
    }
}

pub fn get_api_key(provider: &str) -> Result<SecretString> {
    let provider = normalize_provider(provider)?;
    let password = entry(provider)?.get_password().with_context(|| {
        format!("no {provider} API key configured; run `meeting-recorder auth set {provider}`")
    })?;

    Ok(password.into())
}

pub fn normalize_provider(provider: &str) -> Result<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "xai" | "grok" => Ok("xai"),
        "deepgram" => Ok("deepgram"),
        other => bail!("unsupported transcription provider: {other}"),
    }
}

fn has_api_key(provider: &str) -> Result<bool> {
    match entry(provider)?.get_password() {
        Ok(password) => Ok(!password.is_empty()),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(error) => Err(error)
            .with_context(|| format!("failed to read {provider} API key from GNOME Keyring")),
    }
}

fn entry(provider: &str) -> Result<Entry> {
    let store = Store::new().context("failed to connect to GNOME Keyring Secret Service")?;
    set_default_store(store);

    Entry::new(SERVICE_NAME, provider)
        .with_context(|| format!("failed to open GNOME Keyring entry for {provider}"))
}
