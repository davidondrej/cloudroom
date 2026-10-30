//! Factory Droid over ACP. Reuses the Cursor ACP protocol; Droid keeps its sessions in ~/.factory/sessions.
use super::{Handle, Resume, command as child_command, cursor};
use crate::config::{Config, HarnessConfig};
use serde_json::{Value, json};
use std::io;
use tokio::process::Command;

pub(super) const DROID: cursor::Flavor = cursor::Flavor {
    harness: "droid",
    name: "Droid",
    native_path: |home, _| home.join(SESSIONS),
    valid_id: cursor::valid_id,
    capture: false,
    notices: &[],
    // Droid replays the whole conversation on `session/load`; Cloudroom already has it.
    replay: false,
    explain_stops: true,
    empty_turn: None,
};
const SESSIONS: &str = "sessions";
/// The efforts Local threads offer for Droid (provider-acp); Droid offers some of them per model.
pub const REASONING_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const SIGNED_OUT: &str = "Droid is signed out in Cloud. Create a Factory API key at https://app.factory.ai/settings/api-keys and add it as FACTORY_API_KEY under API keys in Settings → Cloud environment.";

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    if profile.home.canonicalize()? != config.account_home.join(".factory").canonicalize()? {
        return Err(invalid(
            "Droid home must belong to the configured agent account".into(),
        ));
    }
    // Droid signs in with FACTORY_API_KEY from the user's Cloud environment; a browser login can't run here.
    let mut command = child_command(&profile.binary, config);
    command.args(["exec", "--output-format", "acp"]);
    Ok(command)
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    let (id, session) = cursor::open(handle, "Droid").await.map_err(|error| {
        if error.to_string().contains("Authentication required") {
            io::Error::new(io::ErrorKind::PermissionDenied, SIGNED_OUT)
        } else {
            error
        }
    })?;
    // Cloud agents run in full access (ADR 0045). The CLI's `--auto` flag does not apply to ACP sessions.
    if session["modes"]["currentModeId"] != "auto-high" {
        handle
            .call(
                "session/set_mode",
                json!({"sessionId":id,"modeId":"auto-high"}),
            )
            .await?;
    }
    let mut options = session;
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
                    "Droid in this Cloud sandbox refused model {requested}: {error}"
                ))
            })?;
    }
    // Like Local threads, the effort applies when the model offers it, and is skipped otherwise.
    if let Some(value) = handle
        .reasoning
        .as_deref()
        .filter(|level| offers(&options, "reasoning_effort", level))
    {
        handle
            .call(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"reasoning_effort","value":value}),
            )
            .await?;
    }
    Ok(id)
}

fn offers(options: &Value, config: &str, value: &str) -> bool {
    options["configOptions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|option| option["id"] == config)
        .flat_map(|option| option["options"].as_array().into_iter().flatten())
        .any(|choice| choice["value"] == value)
}

pub(super) fn validate(
    profile: &HarnessConfig,
    saved: &Resume,
    identity: super::files::Identity,
) -> io::Result<()> {
    let sessions = profile.home.join(SESSIONS);
    if !cursor::valid_id(&saved.id) || saved.path != sessions {
        return Err(io::Error::other(
            "Droid native path does not match its session",
        ));
    }
    // Droid files each session under a folder named after its working directory.
    let name = format!("{}.jsonl", saved.id);
    for folder in std::fs::read_dir(&sessions)? {
        let path = folder?.path().join(&name);
        if path.is_file()
            && super::files::open(&profile.home, &path, identity)?
                .metadata()?
                .len()
                > 0
        {
            return Ok(());
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "Droid no longer has session {} in ~/.factory/{SESSIONS}",
            saved.id
        ),
    ))
}
