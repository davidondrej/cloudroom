//! Agent Zero over ACP (ADR 20261116-153548). Its `a0 acp` bridge sends each prompt to the user's own Agent Zero
//! server and runs that agent's file edits and commands here. The server keeps the sessions; Core keeps the ACP stream.
use super::{Handle, Resume, command as child_command, cursor};
use crate::config::{Config, HarnessConfig};
use serde_json::json;
use std::{io, io::Read, net::IpAddr, path::Path};
use tokio::process::Command;

pub(super) const AGENT_ZERO: cursor::Flavor = cursor::Flavor {
    harness: "agent-zero",
    name: "Agent Zero",
    native_path: |home, _| home.to_path_buf(),
    valid_id,
    capture: false,
    notices: &[],
    // The bridge replays the whole chat on load and resume; Cloudroom already has it.
    replay: false,
    explain_stops: true,
    empty_turn: None,
    cumulative_text: true,
};
/// The agent's model and effort are the server's own settings, so any effort is accepted and none is applied.
pub const REASONING_LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const NO_SERVER: &str = "Agent Zero in Cloud needs your own Agent Zero server that Cloud can reach, such as one on a VPS. Set AGENT_ZERO_HOST to its URL in Settings → Cloud environment, or sign in to it with `a0` on your computer and Cloudroom copies that login. An Agent Zero on your computer's localhost works only in Local threads.";

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Agent Zero reaches the thread's folder only through the bridge's host tools, and uses them only when told to. Local
/// threads send the same words (provider-bridge-acp's AGENT_ZERO_ACP_DIALECT).
pub(super) fn workspace(folder: &Path) -> String {
    format!(
        "You run through the A0 CLI. The user's project folder is {} on the A0 CLI host. Do all file work and run every command there, with code_execution_remote and text_editor_remote. Never use code_execution_tool or your own server's files for this project.",
        folder.display()
    )
}

/// Agent Zero names a chat with letters, digits, `-` and `_`.
fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `AGENT_ZERO_HOST` from a `NAME=value` file, as the bridge reads its own `.env`.
fn host_in(text: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let (name, value) = line
            .trim()
            .strip_prefix("export ")
            .unwrap_or(line.trim())
            .split_once('=')?;
        let value = value.trim().trim_matches(['"', '\'']).trim_end_matches('/');
        (name.trim() == "AGENT_ZERO_HOST" && !value.is_empty()).then(|| value.to_owned())
    })
}

/// A server only the user's own computer or network can reach: localhost, Docker's host name, or a private address.
fn local(host: &str) -> bool {
    let rest = host.split_once("://").map_or(host, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let name = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    }
    .to_ascii_lowercase();
    match name.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_loopback() || ip.is_unspecified() || ip.is_private() || ip.is_link_local()
        }
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00
        }
        Err(_) => {
            name.is_empty()
                || name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local")
                || name == "host.docker.internal"
        }
    }
}

/// The server: the Cloud environment's `AGENT_ZERO_HOST`, else the copied `a0` login's (ADR 20261116-153548).
fn server(config: &Config, profile: &HarnessConfig) -> io::Result<String> {
    let saved = std::fs::read_to_string(config.state_dir.join("environment")).unwrap_or_default();
    let host = match host_in(&saved) {
        Some(host) => Some(host),
        None => {
            let identity = config.storage.as_ref().map(|p| (p.agent_uid, p.agent_gid));
            let mut text = String::new();
            match super::files::open(&profile.home, &profile.home.join(".env"), identity) {
                Ok(mut file) => {
                    file.read_to_string(&mut text)?;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            host_in(&text)
        }
    };
    match host {
        Some(host) if !local(&host) => Ok(host),
        Some(host) => Err(invalid(format!("{NO_SERVER} (It points at {host}.)"))),
        None => Err(invalid(NO_SERVER.into())),
    }
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    if profile.home.canonicalize()? != config.account_home.join(".agent-zero").canonicalize()? {
        return Err(invalid(
            "Agent Zero home must belong to the configured agent account".into(),
        ));
    }
    let host = server(config, profile)?;
    let mut command = child_command(&profile.binary, config);
    // Only the server's own agent runs here, through the bridge: never Docker, the host's screen, or its browser.
    command
        .env("AGENT_ZERO_COMPUTER_USE_ENABLED", "0")
        .env("AGENT_ZERO_HOST_BROWSER_ENABLED", "0")
        .args(["acp", "--host", &host]);
    Ok(command)
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    cursor::initialize(handle, "Agent Zero").await?;
    let mut params = json!({"cwd":handle.repository,"mcpServers":[]});
    let method = if let Some(saved) = &handle.resume {
        params["sessionId"] = json!(saved.id);
        "session/resume"
    } else {
        "session/new"
    };
    let (id, _) = cursor::attach(handle, "Agent Zero", method, params)
        .await
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Agent Zero could not open this chat on your Agent Zero server: {error}. Check that the server is running and reachable from the internet, and that you're signed in: run `a0` on your computer, or set A0_USERNAME and A0_PASSWORD in Settings → Cloud environment."),
            )
        })?;
    let requested = handle.profile.model.as_str();
    if requested != "default" {
        handle
            .call(
                "session/set_model",
                json!({"sessionId":id,"modelId":requested}),
            )
            .await?;
    }
    Ok(id)
}

pub(super) fn validate(
    profile: &HarnessConfig,
    saved: &Resume,
    _identity: super::files::Identity,
) -> io::Result<()> {
    // The server keeps the chat; resuming one it lost fails there.
    if !valid_id(&saved.id) || Path::new(&saved.path) != profile.home {
        return Err(io::Error::other(
            "Agent Zero native path does not match its session",
        ));
    }
    Ok(())
}
