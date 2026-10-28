//! Hermes Agent over ACP. Reuses the Cursor ACP protocol; Hermes keeps its sessions in its own SQLite file.
use super::{Handle, Resume, command as child_command, cursor};
use crate::config::{Config, HarnessConfig};
use serde_json::json;
use std::{io, path::Path};
use tokio::process::Command;

pub(super) const HERMES: cursor::Flavor = cursor::Flavor {
    harness: "hermes",
    name: "Hermes",
    native_path: |home, _| home.join(DATABASE),
    valid_id: cursor::valid_id,
    capture: false,
    notices: &[],
    // Hermes replays the whole conversation on `session/load`; Cloudroom already has it.
    replay: false,
    explain_stops: true,
    empty_turn: None,
};
const DATABASE: &str = "state.db";
/// The efforts Local threads offer for Hermes (provider-acp).
pub const REASONING_LEVELS: &[&str] = &["none", "low", "medium", "high", "xhigh", "max"];

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    if profile.home.canonicalize()? != config.account_home.join(".hermes").canonicalize()? {
        return Err(invalid(
            "Hermes home must belong to the configured agent account".into(),
        ));
    }
    let mut command = child_command(&profile.binary, config);
    // Cloud agents run in full access (ADR 0045), and their commands run in this sandbox even when the
    // Mac's Hermes uses Docker or SSH. MCP servers from the Mac's config may not exist here (ADR 0044).
    command
        .env("HERMES_YOLO_MODE", "1")
        .env("TERMINAL_ENV", "local")
        .env("HERMES_ACP_SKIP_CONFIGURED_MCP", "1")
        .arg("acp");
    Ok(command)
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    cursor::initialize(handle, "Hermes").await?;
    let mut params = json!({"cwd":handle.repository,"mcpServers":[]});
    // `session/resume` silently starts a new session when Hermes lost the old one; `session/load` says so.
    let method = if let Some(saved) = &handle.resume {
        params["sessionId"] = json!(saved.id);
        "session/load"
    } else {
        "session/new"
    };
    let (id, session) = cursor::attach(handle, "Hermes", method, params).await?;
    // Hermes answers a load of a session it doesn't have with `{}`; a real session always has modes.
    if session["modes"].is_null() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Hermes no longer has session {id} in ~/.hermes/{DATABASE}"),
        ));
    }
    let requested = handle.profile.model.as_str();
    if requested != "default" && session["models"]["currentModelId"] != requested {
        handle
            .call(
                "session/set_model",
                json!({"sessionId":id,"modelId":requested}),
            )
            .await
            .map_err(|error| {
                invalid(format!(
                    "Hermes model {requested} is unavailable in Cloud: {error}. Sign in to its provider with Hermes on your Mac, and Cloudroom copies that login to Cloud."
                ))
            })?;
    }
    // Like Local threads, Hermes takes the effort as a session option (provider-acp).
    if let Some(reasoning) = handle.reasoning.as_deref() {
        handle
            .call(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"reasoning_effort","value":reasoning}),
            )
            .await?;
    }
    Ok(id)
}

pub(super) fn validate(
    profile: &HarnessConfig,
    saved: &Resume,
    identity: super::files::Identity,
) -> io::Result<()> {
    if !cursor::valid_id(&saved.id) || saved.path != profile.home.join(DATABASE) {
        return Err(io::Error::other(
            "Hermes native path does not match its session",
        ));
    }
    let file = super::files::open(&profile.home, Path::new(&saved.path), identity)?;
    if file.metadata()?.len() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Hermes session store is empty",
        ));
    }
    Ok(())
}
