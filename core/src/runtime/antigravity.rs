//! Google Antigravity over ACP (`agy acp`). Reuses the Cursor ACP protocol; Antigravity keeps each conversation as a
//! database under ~/.gemini/antigravity-cli/conversations.
use super::{Handle, Resume, command as child_command, cursor};
use crate::config::{Config, HarnessConfig};
use serde_json::{Value, json};
use std::io;
use tokio::process::Command;

pub(super) const ANTIGRAVITY: cursor::Flavor = cursor::Flavor {
    harness: "antigravity",
    name: "Antigravity",
    native_path: |home, _| home.join(CONVERSATIONS),
    valid_id: cursor::valid_id,
    capture: false,
    notices: &[],
    // Resume uses `session/resume`, which replays nothing; Cloudroom already has the conversation.
    replay: false,
    explain_stops: true,
    empty_turn: None,
};
const CONVERSATIONS: &str = "antigravity-cli/conversations";
/// The thinking levels Local threads offer for Antigravity; each model offers some of them.
pub const REASONING_LEVELS: &[&str] = &["low", "medium", "high", "xhigh"];
const SIGNED_OUT: &str = "Antigravity is signed out in Cloud. Sign in with Google: run `agy acp --login` as the agent account on the Cloud machine.";

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    if profile.home.canonicalize()? != config.account_home.join(".gemini").canonicalize()? {
        return Err(invalid(
            "Antigravity home must belong to the configured agent account".into(),
        ));
    }
    let mut command = child_command(&profile.binary, config);
    command.args(["acp", "--disable-telemetry"]);
    Ok(command)
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    cursor::initialize(handle, "Antigravity").await?;
    let mut params = json!({"cwd":handle.repository,"mcpServers":[]});
    let method = if let Some(saved) = &handle.resume {
        params["sessionId"] = json!(saved.id);
        "session/resume"
    } else {
        "session/new"
    };
    // Cloud agents run in full access (ADR 0045): Antigravity asks before each edit and command in its default mode,
    // and the shared ACP protocol approves every request.
    let (id, mut options) = cursor::attach(handle, "Antigravity", method, params)
        .await
        .map_err(|error| {
            if error.to_string().contains("Authentication required") {
                io::Error::new(io::ErrorKind::PermissionDenied, SIGNED_OUT)
            } else {
                error
            }
        })?;
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
                    "Antigravity in this Cloud sandbox refused model {requested}: {error}"
                ))
            })?;
    }
    // Like Local threads, the thinking level applies when the model offers it, and is skipped otherwise.
    if let Some(value) = handle
        .reasoning
        .as_deref()
        .filter(|level| offers(&options, "thought_level", level))
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
    let conversations = profile.home.join(CONVERSATIONS);
    if !cursor::valid_id(&saved.id) || saved.path != conversations {
        return Err(io::Error::other(
            "Antigravity native path does not match its session",
        ));
    }
    let path = conversations.join(format!("{}.db", saved.id));
    if path.is_file()
        && super::files::open(&profile.home, &path, identity)?
            .metadata()?
            .len()
            > 0
    {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "Antigravity no longer has conversation {} in ~/.gemini/{CONVERSATIONS}",
            saved.id
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thinking_level_applies_only_when_the_model_offers_it() {
        // `session/new` from Antigravity CLI 1.5.8 on Gemini 4 Carbon.
        let options = json!({"configOptions":[
            {"id":"model","currentValue":"gemini-4-carbon","options":[{"value":"gemini-4-carbon"},{"value":"gemini-4-hydrogen"}]},
            {"id":"thought_level","currentValue":"medium","options":[{"value":"low"},{"value":"medium"},{"value":"high"}]}
        ]});
        assert!(offers(&options, "thought_level", "high"));
        assert!(!offers(&options, "thought_level", "xhigh"));
        assert!(!offers(&json!({}), "thought_level", "low"));
    }
}
