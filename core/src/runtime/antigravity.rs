//! Google's Antigravity CLI over ACP. Sessions are individual SQLite databases.
use super::{Handle, Kind, Model, Resume, command as child_command, cursor, files};
use crate::{
    config::{Config, HarnessConfig},
    workspace::storage::Guard,
};
use serde_json::json;
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

pub(crate) const LEVELS: &[&str] = &["none", "low", "medium", "high", "xhigh", "max"];
pub(crate) const SIGN_IN: &str =
    "Sign in with Google or enter a Gemini API key to use Antigravity in Cloud.";
const KEY: &str = "cloudroom-api-key";

fn awaits_install(profile: &HarnessConfig) -> bool {
    std::fs::read_link(&profile.binary).ok().as_deref()
        == Some(Path::new("/usr/local/lib/cloudroom/antigravity.sh"))
}

pub(super) async fn prepare(config: &Config, storage: &Guard) -> io::Result<()> {
    if let Some(profile) = config.harnesses.get(&Kind::Antigravity)
        && awaits_install(profile)
    {
        let mut command = child_command(&profile.binary, config);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, _workload) = storage.spawn_writer(&mut command)?;
        if !child.wait().await?.success() {
            return Err(io::Error::other(
                "Antigravity could not install in this sandbox. Retry the thread.",
            ));
        }
    }
    Ok(())
}

fn database(home: &Path, id: &str) -> PathBuf {
    home.join("conversations").join(format!("{id}.db"))
}

pub(super) const AGY: cursor::Flavor = cursor::Flavor {
    harness: "antigravity",
    name: "Antigravity",
    native_path: database,
    valid_id: cursor::valid_id,
    capture: false,
    replay: false,
    notices: &[],
    explain_stops: true,
    cumulative_text: false,
    empty_turn: Some("Antigravity ended the turn without a reply."),
};

fn cli(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    let mut command = child_command(&profile.binary, config);
    command.env("AGY_CLI_DISABLE_AUTO_UPDATE", "1");
    // Only this harness receives the saved key. Core opens agent-owned files without following links.
    match files::open(
        &config.account_home,
        &profile.home.join(KEY),
        config.storage.as_ref().map(|p| (p.agent_uid, p.agent_gid)),
    ) {
        Ok(file) => {
            let mut key = String::new();
            file.take(4097).read_to_string(&mut key)?;
            if key.is_empty() || key.len() > 4096 || !key.bytes().all(|b| b.is_ascii_graphic()) {
                return Err(io::Error::other("Invalid saved Antigravity key"));
            }
            command.env("GEMINI_API_KEY", key);
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    Ok(command)
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    let mut command = cli(config, profile)?;
    command.args([
        "acp",
        "--dangerously-skip-permissions",
        "--disable-telemetry",
    ]);
    Ok(command)
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    cursor::initialize(handle, "Antigravity").await?;
    let mut params = json!({"cwd":handle.repository,"mcpServers":[]});
    let method = match &handle.resume {
        Some(saved) => {
            params["sessionId"] = json!(saved.id);
            "session/resume"
        }
        None => "session/new",
    };
    let (id, mut session) = cursor::attach(handle, "Antigravity", method, params)
        .await
        .map_err(|e| {
            if e.to_string().contains("Authentication required") {
                io::Error::new(io::ErrorKind::PermissionDenied, SIGN_IN)
            } else {
                e
            }
        })?;
    *handle.acp_config.lock().unwrap() = session.clone();
    let model = handle.profile.model.as_str();
    if model != "default" && cursor::option_value(&session, "model") != Some(model) {
        if !cursor::offers(&session, "model", model) {
            return Err(io::Error::other(
                "Antigravity no longer offers the selected model.",
            ));
        }
        session = set_option(handle, &id, "model", model).await?;
    }
    // New sessions default to high. A level the model lacks keeps Antigravity's default, like fx, so a saved one
    // never blocks a resume.
    let requested = handle
        .reasoning
        .as_deref()
        .or_else(|| handle.resume.is_none().then_some("high"));
    if let Some(level) = requested.filter(|level| cursor::offers(&session, "thought_level", level))
        && cursor::option_value(&session, "thought_level") != Some(level)
    {
        set_option(handle, &id, "thought_level", level).await?;
    }
    Ok(id)
}

/// Switches to the turn's effort before the prompt, when it changed and the model offers it (like fx).
pub(super) async fn prepare_turn(handle: &Handle) -> io::Result<()> {
    let Some(level) = handle.reasoning.as_deref() else {
        return Ok(());
    };
    let change = {
        let state = handle.acp_config.lock().unwrap();
        cursor::offers(&state, "thought_level", level)
            && cursor::option_value(&state, "thought_level") != Some(level)
    };
    if change {
        set_option(handle, &handle.native()?, "thought_level", level).await?;
    }
    Ok(())
}

async fn set_option(
    handle: &Handle,
    session: &str,
    option: &str,
    value: &str,
) -> io::Result<serde_json::Value> {
    let state = handle
        .call(
            "session/set_config_option",
            json!({"sessionId":session,"configId":option,"value":value}),
        )
        .await?;
    if cursor::option_value(&state, option) != Some(value) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Antigravity did not accept {option} {value}"),
        ));
    }
    *handle.acp_config.lock().unwrap() = state.clone();
    Ok(state)
}

fn missing_hosted_login(config: &Config, profile: &HarnessConfig) -> bool {
    profile.home.join(".cloudroom-managed").is_file()
        && !profile.home.join(KEY).is_file()
        && !profile.home.join("antigravity-oauth-token").is_file()
        && !std::fs::read_to_string(config.state_dir.join("environment"))
            .unwrap_or_default()
            .lines()
            .any(|line| {
                line.strip_prefix("GEMINI_API_KEY=")
                    .is_some_and(|value| !value.is_empty())
            })
}

pub(crate) fn needs_login(config: &Config) -> bool {
    config
        .harnesses
        .get(&Kind::Antigravity)
        .is_some_and(|profile| missing_hosted_login(config, profile))
}

/// Only our own sign-in error, never an OS permission error such as an `agy` that can't run (#2634).
pub(crate) fn signed_out(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied && error.to_string() == SIGN_IN
}

pub(crate) async fn models(config: &Config, storage: &Guard) -> io::Result<Vec<Model>> {
    let profile = config
        .harnesses
        .get(&Kind::Antigravity)
        .ok_or_else(|| io::Error::other("Antigravity is unavailable"))?;
    if missing_hosted_login(config, profile) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, SIGN_IN));
    }
    // The hosted sign-in probes ACP itself. This also avoids starting a CLI on each dashboard read.
    let identity = config.storage.as_ref().map(|p| (p.agent_uid, p.agent_gid));
    let cache = profile.home.join("cloudroom-models");
    if cache.is_file() {
        let mut text = String::new();
        files::open(&config.account_home, &cache, identity)?
            .take(65537)
            .read_to_string(&mut text)?;
        if text.len() > 65536 {
            return Err(io::Error::other("Invalid Antigravity model list"));
        }
        let models: Vec<_> = text
            .lines()
            .filter_map(|row| {
                let mut columns = row.split('\t');
                let model = columns.next()?;
                let _label = columns.next()?;
                let levels = columns
                    .next()?
                    .split(',')
                    .filter(|level| LEVELS.contains(level))
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                (!model.is_empty() && !levels.is_empty()).then(|| Model {
                    model: model.to_owned(),
                    reasoning_levels: levels,
                    service_tiers: vec![],
                })
            })
            .collect();
        if !models.is_empty() {
            return Ok(models);
        }
    }
    // Merely listing the sandbox's agents must never download an unused CLI on an older image.
    if awaits_install(profile) {
        return Err(io::Error::other("Antigravity installs on first use"));
    }
    let text = cli_models(config, profile, storage).await?;
    let ids: Vec<_> = text
        .lines()
        .filter_map(|line| line.split_once('\t').map(|(id, _)| id.trim()))
        .filter(|id| !id.is_empty() && id.len() <= 256 && !id.contains(char::is_whitespace))
        .collect();
    let mut result: Vec<Model> = Vec::new();
    for id in &ids {
        // The CLI lists concrete variants. ACP keeps a lone variant's full ID (e.g. gpt-oss-120b-medium).
        let (family, level) = id
            .rsplit_once('-')
            .filter(|(_, level)| LEVELS.contains(level))
            .map_or((*id, "none"), |(base, level)| {
                let grouped = ids.iter().any(|other| {
                    other != id
                        && other
                            .rsplit_once('-')
                            .is_some_and(|(name, l)| name == base && LEVELS.contains(&l))
                });
                (if grouped { base } else { *id }, level)
            });
        if let Some(entry) = result.iter_mut().find(|entry| entry.model == family) {
            if !entry.reasoning_levels.iter().any(|e| e == level) {
                entry.reasoning_levels.push(level.into());
            }
        } else {
            result.push(Model {
                model: family.into(),
                reasoning_levels: vec![level.into()],
                service_tiers: vec![],
            });
        }
    }
    if result.is_empty() {
        return Err(io::Error::other("Antigravity returned no models"));
    }
    Ok(result)
}

async fn cli_models(
    config: &Config,
    profile: &HarnessConfig,
    storage: &Guard,
) -> io::Result<String> {
    let mut command = cli(config, profile)?;
    command
        .arg("models")
        .current_dir(&config.account_home)
        .stdin(Stdio::null());
    let (child, _workload) = storage.spawn_writer(&mut command)?;
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| io::Error::other("Antigravity model lookup timed out"))??;
    if !output.status.success() {
        let signed_out = [&output.stderr, &output.stdout].iter().any(|v| {
            let message = String::from_utf8_lossy(v).to_lowercase();
            [
                "please sign in",
                "authentication required",
                "not logged in",
                "invalid_grant",
                "token has been expired or revoked",
            ]
            .iter()
            .any(|cause| message.contains(cause))
        });
        return Err(if signed_out {
            io::Error::new(io::ErrorKind::PermissionDenied, SIGN_IN)
        } else {
            io::Error::other("Antigravity could not list models")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(super) fn validate(
    profile: &HarnessConfig,
    saved: &Resume,
    identity: files::Identity,
) -> io::Result<()> {
    if !cursor::valid_id(&saved.id) || saved.path != database(&profile.home, &saved.id) {
        return Err(io::Error::other(
            "Antigravity session path does not match its ID",
        ));
    }
    files::open(&profile.home, &saved.path, identity).map(drop)
}

#[cfg(test)]
mod tests {
    use std::io::{Error, ErrorKind};

    // #2634: a non-executable `agy` (EACCES) once read as a missing login.
    #[test]
    fn only_our_sign_in_error_means_signed_out() {
        let ours = Error::new(ErrorKind::PermissionDenied, super::SIGN_IN);
        assert!(super::signed_out(&ours));
        assert!(!super::signed_out(&Error::from_raw_os_error(13)));
        assert!(!super::signed_out(&Error::other(super::SIGN_IN)));
    }
}
