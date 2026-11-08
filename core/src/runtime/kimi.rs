//! Kimi Code over ACP. Reuses the Cursor ACP protocol; Kimi keeps each session in a folder under ~/.kimi-code/sessions.
use super::{Handle, Resume, command as child_command, cursor};
use crate::config::{Config, HarnessConfig};
use serde_json::{Value, json};
use std::io;
use tokio::process::Command;

pub(super) const KIMI: cursor::Flavor = cursor::Flavor {
    harness: "kimi",
    name: "Kimi Code",
    native_path: |home, _| home.join(SESSIONS),
    valid_id,
    capture: false,
    notices: &[],
    // Resume uses `session/resume`, which replays nothing; Cloudroom already has the conversation.
    replay: false,
    explain_stops: true,
    empty_turn: None,
};
const SESSIONS: &str = "sessions";
/// The efforts Local threads offer for Kimi (provider-acp reads its `thinking` option); Kimi offers some of them per model.
pub const REASONING_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const SIGNED_OUT: &str = "Kimi Code is signed out in Cloud. Sign in with `kimi login` on your Mac; Cloudroom copies that login to Cloud.";

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Kimi names sessions `session_<lowercase UUID>`.
fn valid_id(id: &str) -> bool {
    id.strip_prefix("session_").is_some_and(cursor::valid_id)
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    if profile.home.canonicalize()? != config.account_home.join(".kimi-code").canonicalize()? {
        return Err(invalid(
            "Kimi Code home must belong to the configured agent account".into(),
        ));
    }
    let mut command = child_command(&profile.binary, config);
    // The login and sessions live in this folder, whatever the user's Cloud environment sets. The image pins the version.
    command
        .env("KIMI_CODE_HOME", &profile.home)
        .env("KIMI_CODE_NO_AUTO_UPDATE", "1")
        .env("KIMI_DISABLE_TELEMETRY", "1")
        .arg("acp");
    Ok(command)
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    cursor::initialize(handle, "Kimi Code").await?;
    let mut params = json!({"cwd":handle.repository,"mcpServers":[]});
    let method = if let Some(saved) = &handle.resume {
        params["sessionId"] = json!(saved.id);
        "session/resume"
    } else {
        "session/new"
    };
    let (id, mut options) = cursor::attach(handle, "Kimi Code", method, params)
        .await
        .map_err(|error| {
            if error.to_string().contains("Authentication required") {
                io::Error::new(io::ErrorKind::PermissionDenied, SIGNED_OUT)
            } else {
                error
            }
        })?;
    // Cloud agents run in full access (ADR 0045). `auto` approves every tool call and has Kimi decide instead of asking.
    if options["modes"]["currentModeId"] != "auto" {
        handle
            .call("session/set_mode", json!({"sessionId":id,"modeId":"auto"}))
            .await?;
    }
    let requested = handle.profile.model.as_str();
    if requested != "default" && cursor::option_value(&options, "model") != Some(requested) {
        options = handle
            .call(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"model","value":requested}),
            )
            .await
            .map_err(|error| {
                invalid(format!(
                    "Kimi Code in this Cloud sandbox refused model {requested}: {error}"
                ))
            })?;
    }
    // Like Local threads, the effort applies when the model offers it, and is skipped otherwise.
    if let Some(value) = handle
        .reasoning
        .as_deref()
        .and_then(|level| thinking(&options, level))
    {
        handle
            .call(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"thinking","value":value}),
            )
            .await?;
    }
    Ok(id)
}

/// The model's `thinking` value for an effort, with the fallbacks Local threads use.
fn thinking(options: &Value, level: &str) -> Option<&'static str> {
    let offered = options["configOptions"]
        .as_array()?
        .iter()
        .find(|option| option["id"] == "thinking")?["options"]
        .as_array()?;
    let candidates: &[&'static str] = match level {
        "low" => &["low", "minimal"],
        "medium" => &["medium"],
        "high" => &["high"],
        "xhigh" => &["xhigh"],
        "max" => &["max", "xhigh"],
        _ => &[],
    };
    candidates
        .iter()
        .copied()
        .find(|value| offered.iter().any(|option| option["value"] == *value))
}

pub(super) fn validate(
    profile: &HarnessConfig,
    saved: &Resume,
    identity: super::files::Identity,
) -> io::Result<()> {
    let sessions = profile.home.join(SESSIONS);
    if !valid_id(&saved.id) || saved.path != sessions {
        return Err(io::Error::other(
            "Kimi Code native path does not match its session",
        ));
    }
    // Kimi files each session folder under a key for its working directory.
    for folder in std::fs::read_dir(&sessions)? {
        let path = folder?.path().join(&saved.id);
        if path.is_dir() && super::files::open_directory(&profile.home, &path, identity).is_ok() {
            return Ok(());
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "Kimi Code no longer has session {} in ~/.kimi-code/{SESSIONS}",
            saved.id
        ),
    ))
}
