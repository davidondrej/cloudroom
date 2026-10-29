//! OpenClaw over ACP. `openclaw acp` only bridges to OpenClaw's Gateway, which runs the agent and keeps the
//! sessions, so Core runs one Gateway for every OpenClaw session. Each new session is first created in its cloud
//! folder with full access (ADR 0045), then opened by its key, which is also its native ID.
use super::{Handle, Progress, Resume, command as child_command, cursor, linux};
use crate::{
    config::{Config, HarnessConfig},
    workspace::storage::Guard,
};
use serde_json::{Value, json};
use std::{
    io,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpStream,
    process::{Child, Command},
    sync::watch,
};

pub(super) const OPENCLAW: cursor::Flavor = cursor::Flavor {
    harness: "openclaw",
    name: "OpenClaw",
    native_path: |home, _| home.join(DATABASE),
    valid_id,
    capture: false,
    notices: &[],
    // Opening by key never replays the conversation; Cloudroom already has it.
    replay: false,
    explain_stops: true,
    // OpenClaw ends a turn it could not run, such as one whose model has no login, without a word.
    empty_turn: Some(
        "OpenClaw ended the turn without replying. Its model probably has no login in Cloud: sign in with OpenClaw on your Mac and Cloudroom copies it, or add the provider's API key in Settings → Cloud environment. Claude plans can't be used in Cloud.",
    ),
};
const DATABASE: &str = "agents/main/agent/openclaw-agent.sqlite";
const KEY: &str = "agent:main:cloudroom-";
/// Cloudroom levels for OpenClaw; each model accepts its own subset, and OpenClaw names `none` `off`.
pub const REASONING_LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

struct Gateway {
    /// None once it was stopped to restart; an exited child also needs a restart.
    child: Option<Child>,
    workload: Option<Arc<linux::Workload>>,
    /// Kept across restarts, so running sessions' bridges reconnect by themselves.
    port: u16,
    token: String,
    /// The Cloud environment it started with; Core reads it at every start.
    environment: String,
    config: Config,
    storage: Arc<Guard>,
}
static GATEWAY: Mutex<Option<Gateway>> = Mutex::new(None);
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Every OpenClaw session's progress, to tell whether a restart would cut a running turn.
static SESSIONS: Mutex<Vec<watch::Receiver<Progress>>> = Mutex::new(Vec::new());

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn environment(config: &Config) -> String {
    std::fs::read_to_string(config.state_dir.join("environment")).unwrap_or_default()
}

/// A stopped Gateway's main thread can exit while its workers still run; it is then a zombie no one reaps.
fn alive(gateway: &mut Gateway) -> bool {
    gateway.child.as_mut().is_some_and(|child| {
        let zombie = child.id().is_some_and(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| {
                    stat.rsplit_once(')')
                        .map(|(_, rest)| rest.trim_start().starts_with('Z'))
                })
                .unwrap_or(false)
        });
        !zombie && matches!(child.try_wait(), Ok(None))
    })
}

/// The running Gateway's port and token.
fn running() -> Option<(u16, String)> {
    let mut gateway = GATEWAY.lock().unwrap();
    let g = gateway.as_mut()?;
    alive(g).then(|| (g.port, g.token.clone()))
}

/// The Gateway's process, under which OpenClaw runs every session's tools.
pub fn gateway_pid() -> Option<u32> {
    let mut gateway = GATEWAY.lock().unwrap();
    let g = gateway.as_mut()?;
    if alive(g) {
        g.child.as_ref()?.id()
    } else {
        None
    }
}

/// Whether an OpenClaw session other than `own` is running a turn.
fn others_busy(own: Option<&watch::Receiver<Progress>>) -> bool {
    let mut sessions = SESSIONS.lock().unwrap();
    sessions.retain(|s| s.has_changed().is_ok());
    sessions.iter().any(|s| {
        let progress = s.borrow();
        own.is_none_or(|own| !s.same_channel(own))
            && progress.request.is_some()
            && !progress.finished
    })
}

/// How every OpenClaw process finds the Gateway. Nothing is written to OpenClaw's config.
fn connect(command: &mut Command, port: u16, token: &str) {
    command
        .env("OPENCLAW_GATEWAY_PORT", port.to_string())
        .env("OPENCLAW_GATEWAY_TOKEN", token)
        .env("OPENCLAW_HIDE_BANNER", "1")
        .env("OPENCLAW_SUPPRESS_NOTES", "1")
        // The image pins OpenClaw; wakes match the Mac's version (ADR 0133).
        .env("OPENCLAW_NO_AUTO_UPDATE", "1");
}

/// Ends a Gateway: asked first, so it stops its workers and closes its databases cleanly.
async fn end(mut child: Option<Child>, workload: Option<Arc<linux::Workload>>) {
    if let Some(child) = child.as_mut() {
        let asked = child.id().is_some_and(linux::terminate);
        if !asked
            || tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .is_err()
        {
            let _ = child.kill().await;
        }
    }
    if let Some(workload) = workload {
        let _ = workload.stop().await;
    }
}

/// Starts the Gateway when it is not running, such as after a sandbox slept. It also restarts it when the Cloud
/// environment changed, unless another OpenClaw turn is running. Returns whether it started one.
async fn ensure(
    config: &Config,
    storage: &Arc<Guard>,
    own: Option<&watch::Receiver<Progress>>,
) -> io::Result<bool> {
    let _starting = STARTING.lock().await;
    let (port, token, old) = {
        let mut gateway = GATEWAY.lock().unwrap();
        match gateway.as_mut() {
            Some(g) => {
                if alive(g) && (g.environment == environment(config) || others_busy(own)) {
                    return Ok(false);
                }
                (g.port, g.token.clone(), (g.child.take(), g.workload.take()))
            }
            None => (
                std::net::TcpListener::bind(("127.0.0.1", 0))?
                    .local_addr()?
                    .port(),
                super::claude::uuid()?,
                (None, None),
            ),
        }
    };
    end(old.0, old.1).await;
    let profile = config
        .harnesses
        .get(&super::Kind::OpenClaw)
        .ok_or_else(|| io::Error::other("OpenClaw is not installed"))?;
    if profile.home.canonicalize()? != config.account_home.join(".openclaw").canonicalize()? {
        return Err(invalid(
            "OpenClaw home must belong to the configured agent account".into(),
        ));
    }
    let mut command = child_command(&profile.binary, config);
    connect(&mut command, port, &token);
    super::strip_ai_co_authors_env(&mut command);
    // The Mac's chat apps stay on the Mac: a second Gateway would answer them twice.
    command
        .env("OPENCLAW_SKIP_CHANNELS", "1")
        .current_dir(&config.account_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .args(["gateway", "run", "--bind", "loopback", "--auth", "token"])
        .args(["--allow-unconfigured", "--port", &port.to_string()]);
    let (child, workload) = storage.spawn_writer(&mut command)?;
    *GATEWAY.lock().unwrap() = Some(Gateway {
        child: Some(child),
        workload,
        port,
        token,
        environment: environment(config),
        config: config.clone(),
        storage: storage.clone(),
    });
    // A cold Gateway takes about 15 seconds.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        if running().is_none() {
            return Err(io::Error::other(
                "OpenClaw's Gateway stopped while starting; its log is in /tmp/openclaw/",
            ));
        }
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(true);
        }
        if tokio::time::Instant::now() > deadline {
            let old = GATEWAY
                .lock()
                .unwrap()
                .as_mut()
                .map(|g| (g.child.take(), g.workload.take()));
            if let Some((child, workload)) = old {
                end(child, workload).await;
            }
            return Err(io::Error::other(
                "OpenClaw's Gateway did not start within 2 minutes; its log is in /tmp/openclaw/",
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Readies the Gateway before an OpenClaw session starts. Later sessions share it.
pub async fn prepare(config: &Config, storage: &Arc<Guard>) -> io::Result<()> {
    ensure(config, storage, None).await.map(drop)
}

/// Before each turn: restarts a stopped or outdated Gateway, then waits for this session's bridge to reconnect,
/// which it does by itself about ten seconds after a restart.
pub(super) async fn refresh(handle: &Handle) -> io::Result<()> {
    let shared = GATEWAY
        .lock()
        .unwrap()
        .as_ref()
        .map(|g| (g.config.clone(), g.storage.clone()));
    let Some((config, storage)) = shared else {
        return Ok(());
    };
    if !ensure(&config, &storage, Some(&handle.process.progress)).await? {
        return Ok(());
    }
    let reconnected =
        json!({"sessionId":handle.native()?,"configId":"reasoning_level","value":"stream"});
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        match handle
            .call("session/set_config_option", reconnected.clone())
            .await
        {
            Ok(_) => return Ok(()),
            Err(error) if tokio::time::Instant::now() > deadline => {
                return Err(io::Error::other(format!(
                    "OpenClaw did not reconnect to its restarted Gateway: {error}"
                )));
            }
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
}

/// Stops the Gateway with Core, after its sessions have closed.
pub async fn stop() {
    let old = GATEWAY.lock().unwrap().take();
    if let Some(gateway) = old {
        end(gateway.child, gateway.workload).await;
    }
}

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    let (port, token) =
        running().ok_or_else(|| io::Error::other("OpenClaw's Gateway is not running"))?;
    let mut command = child_command(&profile.binary, config);
    connect(&mut command, port, &token);
    command.args(["acp", "--no-prefix-cwd"]);
    Ok(command)
}

/// One `openclaw gateway call`, as the agent, with its JSON answer.
async fn call(method: &str, params: &Value) -> io::Result<Value> {
    let mut command = {
        let gateway = GATEWAY.lock().unwrap();
        let g = gateway
            .as_ref()
            .ok_or_else(|| io::Error::other("OpenClaw's Gateway is not running"))?;
        let binary = &g.config.harnesses[&super::Kind::OpenClaw].binary;
        let mut command = Command::new(binary);
        command
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", &g.config.account_home)
            .env("LANG", "C.UTF-8")
            .current_dir(&g.config.account_home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .args([
                "gateway",
                "call",
                method,
                "--json",
                "--params",
                &params.to_string(),
            ]);
        connect(&mut command, g.port, &g.token);
        if let Some(policy) = &g.config.storage {
            linux::as_agent(
                &mut command,
                policy.agent_uid,
                policy.agent_gid,
                None,
                !policy.agent_sudo,
            )?;
        }
        command
    };
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| io::Error::other(format!("OpenClaw's {method} timed out")))??;
    serde_json::from_slice(&output.stdout).map_err(|_| {
        io::Error::other(format!(
            "OpenClaw's {method} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    })
}

/// Creates the session in the cloud folder with the chosen model and effort.
async fn create(handle: &Handle, key: &str) -> io::Result<()> {
    let mut params = json!({"key":key,"cwd":handle.repository,"permissionMode":"full","displayName":"Cloudroom"});
    if handle.profile.model != "default" {
        params["model"] = json!(handle.profile.model);
    }
    if let Some(level) = handle.reasoning.as_deref() {
        params["thinkingLevel"] = json!(if level == "none" { "off" } else { level });
    }
    let mut result = call("sessions.create", &params).await?;
    let message = |result: &Value| result["error"]["message"].as_str().unwrap_or("").to_owned();
    // Like Local threads, a model without this effort keeps OpenClaw's default (ADR 0133).
    if result["ok"] != true && message(&result).contains("thinkingLevel") {
        params.as_object_mut().unwrap().remove("thinkingLevel");
        result = call("sessions.create", &params).await?;
    }
    if result["ok"] != true {
        let message = message(&result);
        // OpenClaw's own advice ("Refresh the model catalog") can't help a Cloud agent. The same text also
        // covers a mistyped model or a catalog not ready yet, so this only says "probably".
        let hint = if message.contains("Refresh the model catalog")
            || message.contains("Unknown provider")
        {
            " That model's provider probably isn't set up in Cloud: sign in with OpenClaw on your Mac and Cloudroom copies it, add the provider's API key in Settings → Cloud environment, or pick another model."
        } else {
            ""
        };
        return Err(invalid(format!(
            "OpenClaw could not start the session: {message}{hint}"
        )));
    }
    // Claude plans only run in Claude Code under Anthropic's terms (ADR 0265).
    let resolved = &result["resolved"];
    if resolved["modelProvider"] == "claude-cli" {
        let _ = call("sessions.delete", &json!({"key":key})).await;
        return Err(invalid(format!(
            "OpenClaw's model claude-cli/{} uses a Claude plan, which Cloudroom can't use with OpenClaw. Pick another model.",
            resolved["model"].as_str().unwrap_or("")
        )));
    }
    Ok(())
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    let key = match &handle.resume {
        Some(saved) => saved.id.clone(),
        None => {
            let key = format!("{KEY}{}", super::claude::uuid()?);
            create(handle, &key).await?;
            key
        }
    };
    SESSIONS
        .lock()
        .unwrap()
        .push(handle.process.progress.clone());
    cursor::initialize(handle, "OpenClaw").await?;
    let params = json!({"sessionId":key,"cwd":handle.repository,"mcpServers":[]});
    let (id, _) = cursor::attach(handle, "OpenClaw", "session/resume", params).await?;
    if handle.resume.is_none() {
        // Stream the model's thinking, as the other harnesses do.
        handle
            .call(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"reasoning_level","value":"stream"}),
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
    if !valid_id(&saved.id) || saved.path != profile.home.join(DATABASE) {
        return Err(io::Error::other(
            "OpenClaw native path does not match its session",
        ));
    }
    let file = super::files::open(&profile.home, Path::new(&saved.path), identity)?;
    if file.metadata()?.len() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "OpenClaw session store is empty",
        ));
    }
    Ok(())
}

/// Cloudroom's session keys: `agent:main:cloudroom-` and a UUID.
fn valid_id(id: &str) -> bool {
    id.strip_prefix(KEY).is_some_and(|rest| {
        rest.len() == 36 && rest.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
    })
}
