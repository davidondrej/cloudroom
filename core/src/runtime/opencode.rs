//! OpenCode over ACP (ADR 0172). Reuses the Cursor ACP protocol; OpenCode keeps its sessions in its own SQLite file.
use super::{Handle, Model, Resume, command as child_command, cursor};
use crate::config::{Config, HarnessConfig};
use serde_json::{Value, json};
use std::{io, path::Path};
use tokio::process::Command;

pub(super) const OPENCODE: cursor::Flavor = cursor::Flavor {
    harness: "opencode",
    name: "OpenCode",
    native_path: |home, _| home.join(DATABASE),
    valid_id,
    capture: false,
    notices: &[],
    replay: true,
    explain_stops: true,
    empty_turn: None,
    cumulative_text: false,
};
const DATABASE: &str = "opencode.db";
/// Cloudroom levels for OpenCode; each model offers its own subset of efforts.
pub const REASONING_LEVELS: &[&str] = &["none", "low", "medium", "high", "xhigh", "max"];

/// OpenCode's efforts for a Cloudroom level, in the order Local threads try them (provider-bridge-acp).
fn efforts(level: &str) -> Vec<&str> {
    match level {
        "low" => vec!["low", "minimal"],
        "max" => vec!["max", "xhigh"],
        _ => vec![level],
    }
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    let mut command = base(config, profile)?;
    command.arg("acp");
    Ok(command)
}

fn base(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    let home = config.account_home.join(".local/share/opencode");
    if profile.home.canonicalize()? != home.canonicalize()? {
        return Err(invalid(
            "OpenCode home must belong to the configured agent account".into(),
        ));
    }
    let mut command = child_command(&profile.binary, config);
    // The image pins the OpenCode version. OpenCode 2's question tool ends the turn over ACP, and
    // Cloudroom asks in plain chat (ADR 0108). OpenCode 1 and 2 both read this config.
    command.env("OPENCODE_DISABLE_AUTOUPDATE", "1").env(
        "OPENCODE_CONFIG_CONTENT",
        r#"{"autoupdate":false,"permission":{"question":"deny"}}"#,
    );
    Ok(command)
}

/// Teleport: OpenCode resumes only sessions in its own database, so the exported session is imported
/// from the cloud folder, which also rebinds it to that folder. OpenCode 1 re-imports add only new messages.
/// `staged` is Core's own verified copy of `export`, which sits where the agent can write.
pub async fn import(
    config: &Config,
    profile: &HarnessConfig,
    export: &str,
    staged: &Path,
    cwd: &Path,
    storage: &crate::workspace::storage::Guard,
) -> io::Result<String> {
    // OpenCode 2 moved import under `session` (#2686); `--standalone` runs it on a private server that exits with it,
    // not on a background service left running. An unreadable version runs OpenCode 1's.
    let version = run(config, profile, cwd, storage, vec!["--version"])
        .await
        .unwrap_or_default()
        .0;
    let session = |action| match major(&String::from_utf8_lossy(&version)) {
        Some(2..) => vec!["session", action, "--standalone"],
        _ => vec![action],
    };
    let (_, stderr) = run(
        config,
        profile,
        cwd,
        storage,
        [session("import"), vec![export]].concat(),
    )
    .await?;
    // OpenCode 2 keeps a session it already has instead of adding its new messages. Only a copy with the same
    // messages, as a retried move leaves, counts as imported; resuming an older one would lose turns. Any doubt refuses.
    if String::from_utf8_lossy(&stderr).contains("Session already exists") {
        let same = async {
            use std::io::Read;
            let mut bytes = Vec::new();
            std::fs::File::open(staged)?
                .take(OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)?;
            let incoming: Value = serde_json::from_slice(&bytes)?;
            let id = incoming["info"]["id"].as_str().filter(|id| valid_id(id));
            let id = id.ok_or_else(|| invalid("OpenCode export has no valid session ID".into()))?;
            let local: Value = serde_json::from_slice(
                &run(
                    config,
                    profile,
                    cwd,
                    storage,
                    [session("export"), vec![id]].concat(),
                )
                .await?
                .0,
            )?;
            Ok::<_, io::Error>(
                local["messages"].is_array() && local["messages"] == incoming["messages"],
            )
        };
        if !same.await.unwrap_or(false) {
            return Err(io::Error::other(
                "OpenCode already has an older copy of this session",
            ));
        }
    }
    Ok(profile.home.join(DATABASE).to_string_lossy().into_owned())
}

/// Bytes read from an OpenCode command's output or a staged export.
const OUTPUT_LIMIT: u64 = 64 << 20;

/// Runs OpenCode through the storage guard, as every agent command, and returns its stdout and stderr, each up to
/// `OUTPUT_LIMIT`. A non-zero exit or longer output fails.
async fn run(
    config: &Config,
    profile: &HarnessConfig,
    cwd: &Path,
    storage: &crate::workspace::storage::Guard,
    args: Vec<&str>,
) -> io::Result<(Vec<u8>, Vec<u8>)> {
    use tokio::io::AsyncReadExt;
    let mut command = base(config, profile)?;
    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .args(args);
    let (mut child, _workload) = storage.spawn_writer(&mut command)?;
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let status = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        if let (Some(stdout), Some(stderr)) = (stdout, stderr) {
            // Each pipe closes as soon as its read ends, so output past the cap can't block OpenCode until the timeout.
            async fn read(
                pipe: impl tokio::io::AsyncRead + Unpin,
                buf: &mut Vec<u8>,
            ) -> io::Result<usize> {
                pipe.take(OUTPUT_LIMIT + 1).read_to_end(buf).await
            }
            tokio::try_join!(read(stdout, &mut out), read(stderr, &mut err))?;
        }
        child.wait().await
    })
    .await
    .map_err(|_| io::Error::other("OpenCode session import timed out"))??;
    if !status.success() || out.len() as u64 > OUTPUT_LIMIT || err.len() as u64 > OUTPUT_LIMIT {
        return Err(io::Error::other(format!(
            "OpenCode session import failed: {}",
            String::from_utf8_lossy(&err[..err.len().min(4096)]).trim()
        )));
    }
    Ok((out, err))
}

/// The major version in `opencode --version` output: "1.19.6" or "opencode v2.3.0".
fn major(version: &str) -> Option<u32> {
    version
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .find(|token| token.contains('.'))?
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// Lists configured OpenCode models without creating a session in OpenCode's database.
pub(crate) async fn list_models(
    config: &Config,
    storage: &crate::workspace::storage::Guard,
) -> io::Result<Vec<Model>> {
    let profile = config
        .harnesses
        .get(&super::Kind::OpenCode)
        .ok_or_else(|| io::Error::other("OpenCode is not configured"))?;
    let mut command = base(config, profile)?;
    command
        .current_dir(&config.account_home)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .arg("models");
    let (child, _workload) = storage.spawn_writer(&mut command)?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "OpenCode model list timed out"))??;
    if !output.status.success() {
        return Err(io::Error::other("OpenCode model list unavailable"));
    }
    let models = parse_models(&String::from_utf8_lossy(&output.stdout));
    if models.is_empty() {
        return Err(io::Error::other("OpenCode model list is empty"));
    }
    Ok(models)
}

fn parse_models(stdout: &str) -> Vec<Model> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && line.contains('/') && !line.contains(char::is_whitespace)
        })
        .map(|model| Model {
            model: model.to_owned(),
            reasoning_levels: REASONING_LEVELS
                .iter()
                .map(|level| (*level).to_owned())
                .collect(),
            service_tiers: Vec::new(),
        })
        .collect()
}

fn unavailable_model_message(requested: &str, offered: &[&str]) -> String {
    if let Some((_, suffix)) = requested.split_once('/') {
        let mut alternatives: Vec<&str> = offered
            .iter()
            .copied()
            .filter(|candidate| {
                candidate
                    .split_once('/')
                    .is_some_and(|(_, model)| model == suffix)
            })
            .collect();
        alternatives.truncate(4);
        if !alternatives.is_empty() {
            return format!(
                "OpenCode model {requested} is unavailable in Cloud. Available under another provider: {}. Or sign in to its provider on your computer with `opencode auth login`, add it to ~/.config/opencode/opencode.json (or opencode.jsonc), or add its API key in Settings → Cloud environment.",
                alternatives.join(", ")
            );
        }
    }
    let mut providers: Vec<&str> = Vec::new();
    for candidate in offered {
        if let Some((provider, _)) = candidate.split_once('/')
            && !providers.contains(&provider)
        {
            providers.push(provider);
            if providers.len() == 6 {
                break;
            }
        }
    }
    let context = if providers.is_empty() {
        " (no OpenCode models are available in Cloud)".to_owned()
    } else {
        format!(" (Cloud has providers: {})", providers.join(", "))
    };
    format!(
        "OpenCode model {requested} is unavailable in Cloud{context}. On your computer, sign in to its provider with `opencode auth login`, or add the provider to ~/.config/opencode/opencode.json (or opencode.jsonc); Cloudroom copies both to Cloud. A provider on your computer's localhost can't be reached from Cloud. Provider keys set only as shell variables are not copied; add them in Settings → Cloud environment."
    )
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    let (id, mut session) = cursor::open(handle, "OpenCode").await?;
    let requested = handle.profile.model.as_str();
    if requested != "default" && cursor::option_value(&session, "model") != Some(requested) {
        let available = choices(&session, "model");
        if !available.contains(&requested) {
            return Err(invalid(unavailable_model_message(requested, &available)));
        }
        session = set(handle, &id, "model", requested).await?;
    }
    // Like Local threads, a model without this effort keeps OpenCode's default (ADR 0133).
    let offered = choices(&session, "effort");
    if let Some(effort) = handle
        .reasoning
        .as_deref()
        .and_then(|reasoning| efforts(reasoning).into_iter().find(|e| offered.contains(e)))
        && cursor::option_value(&session, "effort") != Some(effort)
    {
        // OpenCode can reply before the effort applies, so like Local threads, don't require a confirmation.
        handle
            .call(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"effort","value":effort}),
            )
            .await?;
    }
    Ok(id)
}

async fn set(handle: &Handle, id: &str, option: &str, value: &str) -> io::Result<Value> {
    let result = handle
        .call(
            "session/set_config_option",
            json!({"sessionId":id,"configId":option,"value":value}),
        )
        .await?;
    if cursor::option_value(&result, option) != Some(value) {
        return Err(io::Error::other(format!(
            "OpenCode did not confirm {option} {value}"
        )));
    }
    Ok(result)
}

fn session_option<'a>(session: &'a Value, name: &str) -> Option<&'a Value> {
    session["configOptions"]
        .as_array()?
        .iter()
        .find(|option| option["id"] == name)
}

fn choices<'a>(session: &'a Value, name: &str) -> Vec<&'a str> {
    session_option(session, name)
        .and_then(|option| option["options"].as_array())
        .map(|options| options.iter().filter_map(|o| o["value"].as_str()).collect())
        .unwrap_or_default()
}

pub(super) fn validate(
    profile: &HarnessConfig,
    saved: &Resume,
    identity: super::files::Identity,
) -> io::Result<()> {
    if !valid_id(&saved.id) || saved.path != profile.home.join(DATABASE) {
        return Err(io::Error::other(
            "OpenCode native path does not match its session",
        ));
    }
    let file = super::files::open(&profile.home, Path::new(&saved.path), identity)?;
    if file.metadata()?.len() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "OpenCode session store is empty",
        ));
    }
    Ok(())
}

/// OpenCode session IDs look like `ses_` and 26 letters or digits.
fn valid_id(id: &str) -> bool {
    id.strip_prefix("ses_")
        .is_some_and(|rest| rest.len() == 26 && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

#[cfg(test)]
#[test]
fn reads_the_major_version_opencode_prints() {
    assert_eq!(major("opencode v2.3.0\n"), Some(2));
    assert_eq!(major("1.19.6\n"), Some(1));
    assert_eq!(major(""), None);
}
