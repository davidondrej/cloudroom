use crate::{config::Config, runtime, session::Manager, workspace::valid_id};
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
use tokio_stream::{StreamExt, wrappers::ReceiverStream};

const WORKER: &str = include_str!("files.py");
pub struct Sync {
    config: Config,
    path: PathBuf,
    settings: Mutex<Settings>,
    pub(crate) gate: tokio::sync::Mutex<()>,
    scans: Mutex<BTreeMap<String, Value>>,
    reports: Mutex<BTreeMap<String, (u64, String)>>,
}
#[derive(Default, Deserialize, Serialize)]
struct Settings {
    revision: u64,
    device: Option<String>,
    // Older paired installs have no per-root history: never recreate a missing root.
    #[serde(default = "existing_roots")]
    initialized_roots: BTreeSet<String>,
}
fn existing_roots() -> BTreeSet<String> {
    [
        "skills-shared",
        "skills-codex",
        "skills-pi",
        "skills-claude",
        "settings-codex",
        "settings-pi",
        "settings-claude",
        "auth-codex",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
type Result<T> = std::result::Result<T, Failure>;
/// Status plus the underlying cause; an empty cause shows only the generic message.
pub struct Failure(StatusCode, String);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let base = if self.0 == StatusCode::CONFLICT {
            "sync conflict; originals preserved"
        } else {
            "sync unavailable; check setup, paths, and storage"
        };
        let error = if self.1.is_empty() {
            base.to_owned()
        } else {
            format!("{base} ({})", self.1)
        };
        (self.0, Json(json!({"error":error}))).into_response()
    }
}
impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
    }
}
impl From<serde_json::Error> for Failure {
    fn from(error: serde_json::Error) -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("invalid JSON: {error}"),
        )
    }
}
fn failure(status: StatusCode, cause: &str) -> Failure {
    Failure(status, cause.into())
}
fn conflict() -> Failure {
    failure(StatusCode::CONFLICT, "")
}

impl Sync {
    pub fn open(config: &Config) -> io::Result<Self> {
        let path = config.state_dir.join("sync.json");
        let settings = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e),
        };
        Ok(Self {
            config: config.clone(),
            path,
            settings: Mutex::new(settings),
            gate: tokio::sync::Mutex::new(()),
            scans: Mutex::new(BTreeMap::new()),
            reports: Mutex::new(BTreeMap::new()),
        })
    }
    fn save(&self, settings: &Settings) -> io::Result<()> {
        use std::io::Write;
        let temporary = self.path.with_extension("pending");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(settings)?)?;
        file.sync_all()?;
        fs::rename(temporary, &self.path)?;
        fs::File::open(self.path.parent().unwrap())?.sync_all()
    }
    fn check_device(&self, device: &str) -> Result<()> {
        if self.settings.lock().unwrap().device.as_deref() != Some(device) {
            return Err(conflict());
        }
        Ok(())
    }
    fn tree(&self, id: &str) -> Result<Value> {
        let home = &self.config.account_home;
        let profile = |kind, fallback: &str| {
            self.config
                .harnesses
                .get(&kind)
                .map(|h| h.home.clone())
                .unwrap_or_else(|| home.join(fallback))
        };
        let (root, kind, filename) = match id {
            "skills-shared" => (home.join(".agents/skills"), "skills", None),
            "skills-codex" => (
                profile(runtime::Kind::Codex, ".codex").join("skills"),
                "skills",
                None,
            ),
            "skills-pi" => (
                profile(runtime::Kind::Pi, ".pi/agent").join("skills"),
                "skills",
                None,
            ),
            "extensions-pi" => (
                profile(runtime::Kind::Pi, ".pi/agent").join("extensions"),
                "skills",
                None,
            ),
            "skills-claude" => (home.join(".claude/skills"), "skills", None),
            "skills-cursor" => (home.join(".cursor/skills"), "skills", None),
            "rules-cursor" => (home.join(".cursor/rules"), "skills", None),
            "settings-cursor" => (home.join(".cursor"), "cursor", Some("cli-config.json")),
            "settings-codex" => (
                profile(runtime::Kind::Codex, ".codex"),
                "codex",
                Some("config.toml"),
            ),
            "settings-pi" => (
                profile(runtime::Kind::Pi, ".pi/agent"),
                "pi",
                Some("settings.json"),
            ),
            "settings-claude" => (home.join(".claude"), "claude", Some("settings.json")),
            "mcp-codex" => (
                profile(runtime::Kind::Codex, ".codex"),
                "mcp-toml",
                Some("config.toml"),
            ),
            "mcp-claude" => (home.clone(), "mcp-json", Some(".claude.json")),
            "mcp-cursor" => (home.join(".cursor"), "mcp-json", Some("mcp.json")),
            _ => return Err(failure(StatusCode::GONE, "unknown sync root")),
        };
        Ok(json!({"root":root,"kind":kind,"filename":filename}))
    }
    fn state(&self) -> &'static str {
        let reports = self.reports.lock().unwrap();
        if reports.is_empty()
            || reports
                .values()
                .any(|(at, _)| now().saturating_sub(*at) > 30)
        {
            "offline"
        } else if reports.values().any(|(_, s)| s == "conflict") {
            "conflict"
        } else if reports.values().any(|(_, s)| s != "synced") {
            "syncing"
        } else {
            "synced"
        }
    }
    pub fn view(&self, manager: &Manager) -> Result<Value> {
        let workspaces = manager.workspaces.list()?;
        let settings = self.settings.lock().unwrap();
        Ok(
            json!({"revision":settings.revision.to_string(),"autoSync":true,"repositorySync":false,"syncState":self.state(),
            "repositories":workspaces.iter().map(|w| json!({"id":w.id,"name":w.path.file_name().map(|v|v.to_string_lossy()),"sync":false,"workspaceMode":"shared"})).collect::<Vec<_>>(),
            "accounts":[],"worktreesSupported":false}),
        )
    }
}

pub async fn settings(State(manager): State<Arc<Manager>>) -> Result<Json<Value>> {
    Ok(Json(manager.sync.view(&manager)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckIn {
    device: String,
    #[serde(default)]
    repositories: Vec<String>,
    #[serde(default)]
    states: BTreeMap<String, String>,
}
pub async fn check_in(
    State(manager): State<Arc<Manager>>,
    Json(input): Json<CheckIn>,
) -> Result<Json<Value>> {
    valid_id(&input.device)?;
    if !manager.recording_available() || manager.is_stopping() {
        return Err(failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "service is stopping or the session journal is not writable",
        ));
    }
    let _guard = manager.sync.gate.lock().await;
    let mut settings = manager.sync.settings.lock().unwrap();
    if settings.device.as_ref().is_some_and(|d| d != &input.device) {
        return Err(conflict());
    }
    // Refuse old workers before they can interpret an empty cloud folder as deletions.
    if !input.repositories.is_empty() {
        return Err(failure(
            StatusCode::GONE,
            "this sync worker is outdated; update Cloudroom",
        ));
    }
    if settings.device.is_none() {
        let next = Settings {
            revision: settings.revision + 1,
            device: Some(input.device),
            initialized_roots: settings.initialized_roots.clone(),
        };
        manager.sync.save(&next)?;
        *settings = next;
    }
    drop(settings);
    for (id, state) in &input.states {
        manager.sync.tree(id)?;
        if !["synced", "syncing", "conflict", "offline"].contains(&state.as_str()) {
            return Err(conflict());
        }
    }
    if !input.states.is_empty() {
        *manager.sync.reports.lock().unwrap() = input
            .states
            .into_iter()
            .map(|(id, state)| (id, (now(), state)))
            .collect();
    }
    Ok(Json(manager.sync.view(&manager)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    device: String,
    path: Option<String>,
    expected: Option<String>,
    incoming: Option<String>,
    size: Option<u64>,
    kind: Option<String>,
    executable: Option<bool>,
}

async fn run(
    manager: Arc<Manager>,
    id: String,
    input: Operation,
    op: &str,
    body: Body,
) -> Result<Response> {
    let guard = manager.clone();
    let _gate = guard.sync.gate.lock().await;
    manager.sync.check_device(&input.device)?;
    if manager.is_stopping() || manager.storage.blocks() || !manager.recording_available() {
        return Err(failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "service is stopping, disk protection is blocking writes, or the session journal is not writable",
        ));
    }
    let mut tree = manager.sync.tree(&id)?;
    let initialize = op == "scan"
        && !manager
            .sync
            .settings
            .lock()
            .unwrap()
            .initialized_roots
            .contains(&id);
    tree["create"] = json!(initialize);
    let mut request = json!({"tree":tree,"op":op,"path":input.path,"expected":input.expected});
    if op == "scan" {
        request["cache"] = manager
            .sync
            .scans
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .unwrap_or(json!({}));
    }
    if op == "apply" && input.kind.is_some() {
        request["entry"] = json!({"kind":input.kind,"executable":input.executable.unwrap_or(false),"tag":input.incoming,"size":input.size});
    }
    let mut command = Command::new("python3");
    command
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .args(["-c", WORKER])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let (mut child, workload) = manager.storage.spawn_writer(&mut command)?;
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&serde_json::to_vec(&request)?).await?;
    stdin.write_all(b"\n").await?;
    let mut bytes = 0u64;
    let mut chunks = body.into_data_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|error| Failure(StatusCode::BAD_REQUEST, error.to_string()))?;
        bytes += chunk.len() as u64;
        if bytes > 4 * 1024 * 1024 * 1024 {
            return Err(failure(
                StatusCode::PAYLOAD_TOO_LARGE,
                "upload exceeds 4 GiB",
            ));
        }
        stdin.write_all(&chunk).await?;
    }
    drop(stdin);
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).await?;
    let value: Value = serde_json::from_str(&line)?;
    if value["ok"] != true {
        return Err(if value["error"] == "conflict" {
            conflict()
        } else {
            Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("sync worker failed: {}", value["error"]),
            )
        });
    }
    if op != "read" {
        let status = child.wait().await?;
        if !status.success() {
            return Err(Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("sync worker exited with {status}"),
            ));
        }
        if op == "scan" {
            if initialize {
                let mut settings = manager.sync.settings.lock().unwrap();
                let mut next = Settings {
                    revision: settings.revision + 1,
                    device: settings.device.clone(),
                    initialized_roots: settings.initialized_roots.clone(),
                };
                next.initialized_roots.insert(id.clone());
                manager.sync.save(&next)?;
                *settings = next;
            }
            manager
                .sync
                .scans
                .lock()
                .unwrap()
                .insert(id, value["files"].clone());
        }
        return Ok(Json(value).into_response());
    }
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    tokio::spawn(async move {
        let _workload = workload;
        loop {
            let mut buffer = vec![0; 64 * 1024];
            match stdout.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    buffer.truncate(n);
                    if sender.send(Ok::<_, io::Error>(buffer)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = sender.send(Err(e)).await;
                    break;
                }
            }
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    });
    Ok((
        [("content-type", "application/octet-stream")],
        Body::from_stream(ReceiverStream::new(receiver)),
    )
        .into_response())
}
pub async fn scan(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(input): Query<Operation>,
) -> Result<Response> {
    run(manager, id, input, "scan", Body::empty()).await
}
pub async fn read(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(input): Query<Operation>,
) -> Result<Response> {
    run(manager, id, input, "read", Body::empty()).await
}
pub async fn apply(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(input): Query<Operation>,
    body: Body,
) -> Result<Response> {
    run(manager, id, input, "apply", body).await
}
