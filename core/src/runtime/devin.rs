//! Devin CLI over ACP. Reuses the Cursor ACP protocol; Devin keeps its sessions in its own SQLite file.
use super::{Handle, Resume, command as child_command, cursor};
use crate::config::{Config, HarnessConfig};
use serde_json::{Value, json};
use std::{io, path::Path};
use tokio::process::Command;

pub(super) const DEVIN: cursor::Flavor = cursor::Flavor {
    harness: "devin",
    name: "Devin",
    native_path: |home, _| home.join(DATABASE),
    valid_id,
    capture: false,
    notices: &[],
    // Devin keeps the conversation itself; Cloudroom already has it.
    replay: false,
    explain_stops: true,
    empty_turn: None,
};
const DATABASE: &str = "cli/sessions.db";
/// The efforts Local threads offer for Devin (provider-acp); Devin applies them per model as `thought_level`.
pub const REASONING_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Devin names sessions with lowercase words, such as `oasis-writer`.
fn valid_id(id: &str) -> bool {
    (3..=64).contains(&id.len())
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    let data = config.account_home.join(".local/share");
    if profile.home.canonicalize()? != data.join("devin").canonicalize()? {
        return Err(invalid(
            "Devin home must belong to the configured agent account".into(),
        ));
    }
    let mut command = child_command(&profile.binary, config);
    // The login and sessions live in this folder, whatever the user's Cloud environment sets.
    command.env("XDG_DATA_HOME", data).arg("acp");
    Ok(command)
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    // Devin's own message asks for `/login`, which Cloud threads can't run.
    if !handle.profile.home.join("credentials.toml").is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Devin is signed out in Cloud. Sign in with `devin auth login` on your Mac; Cloudroom copies that login to Cloud.",
        ));
    }
    let (id, session) = cursor::open(handle, "Devin").await?;
    // Cloud agents run in full access (ADR 0045).
    if session["modes"]["currentModeId"] != "bypass" {
        handle
            .call(
                "session/set_mode",
                json!({"sessionId":id,"modeId":"bypass"}),
            )
            .await?;
    }
    let mut options = session;
    let requested = handle.profile.model.as_str();
    let mut effort = handle.reasoning.clone();
    if requested != "default" && cursor::option_value(&options, "model") != Some(requested) {
        let offered = models(&options);
        let (model, named) = match_model(&offered, requested);
        effort = named.or(effort);
        options = handle
            .call(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"model","value":model}),
            )
            .await
            .map_err(|error| {
                invalid(format!(
                    "Devin in this Cloud sandbox refused model {requested}: {error}. It offers: {}",
                    offered.join(", ")
                ))
            })?;
    }
    // Like Local threads, the effort applies when the model offers it, and is skipped otherwise.
    if let Some(value) = effort
        .as_deref()
        .and_then(|level| thought_level(&options, level))
    {
        handle
            .call(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"thought_level","value":value}),
            )
            .await?;
    }
    Ok(id)
}

/// The model names this Devin offers.
fn models(options: &Value) -> Vec<String> {
    let Some(option) = options["configOptions"]
        .as_array()
        .and_then(|all| all.iter().find(|option| option["id"] == "model"))
    else {
        return Vec::new();
    };
    option["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|choice| choice["value"].as_str().map(str::to_owned))
        .collect()
}

/// The offered model for a requested one, and the effort its name carried.
/// Older Devin put the effort in model names (`claude-opus-5-5-max`); newer Devin offers one name
/// per model (`claude-opus-5-5-medium`) and sets the effort with `thought_level` (feedback #546).
fn match_model(offered: &[String], requested: &str) -> (String, Option<String>) {
    let is_effort = |text: &str| text == "minimal" || REASONING_LEVELS.contains(&text);
    if !offered.iter().any(|model| model == requested)
        && let Some((base, effort)) = requested.rsplit_once('-').filter(|(_, e)| is_effort(e))
        && let Some(model) = offered.iter().find(|model| {
            *model == base
                || model
                    .strip_prefix(base)
                    .and_then(|rest| rest.strip_prefix('-'))
                    .is_some_and(is_effort)
        })
    {
        return (model.clone(), Some(effort.to_owned()));
    }
    (requested.to_owned(), None)
}

/// The model's `thought_level` value for an effort, with the fallbacks Local threads use.
fn thought_level(options: &Value, level: &str) -> Option<String> {
    let offered = options["configOptions"]
        .as_array()?
        .iter()
        .find(|option| option["id"] == "thought_level")?["options"]
        .as_array()?;
    let candidates: &[&str] = match level {
        "low" => &["low", "minimal"],
        "max" => &["max", "xhigh"],
        other => &[other],
    };
    candidates
        .iter()
        .find(|value| offered.iter().any(|option| option["value"] == **value))
        .map(|value| (*value).to_owned())
}

pub(super) fn validate(
    profile: &HarnessConfig,
    saved: &Resume,
    identity: super::files::Identity,
) -> io::Result<()> {
    if !valid_id(&saved.id) || saved.path != profile.home.join(DATABASE) {
        return Err(io::Error::other(
            "Devin native path does not match its session",
        ));
    }
    let file = super::files::open(&profile.home, Path::new(&saved.path), identity)?;
    if file.metadata()?.len() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Devin session store is empty",
        ));
    }
    Ok(())
}
