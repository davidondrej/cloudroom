//! Two-way Mac ↔ VM access (ADR 0113). VM agents reach the paired Mac through its helper; the Mac runs commands on the VM.
use crate::{preview::Peer, session::Manager};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Path as RoutePath, Query, State},
    http::StatusCode,
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    convert::Infallible,
    fs, io,
    os::unix::{fs::FileTypeExt, fs::PermissionsExt, net::UnixStream as StdUnixStream},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{mpsc, watch},
};
use tokio_stream::wrappers::ReceiverStream;

mod transfer;

pub(crate) const SOCKET: &str = "/run/cloudroom/mac.sock";
/// Raw bytes per stdin, stdout, or stderr. Hex doubles this on the wire.
const LIMIT: usize = 16 * 1024 * 1024;
const BODY: usize = 5 * LIMIT;
/// A connected helper must confirm each job quickly; a sleeping Mac must not hang agents.
const ACK: Duration = Duration::from_secs(10);
/// Older helpers get a job's stdin inside the job event, before they can confirm it, so big inputs (`push`) get extra
/// time at this many hex bytes per second, a slow link's speed (feedback #386). Newer helpers download it after (#576).
const SLOW_LINK: usize = 32 * 1024;
const KEEP: Duration = Duration::from_secs(3600);
/// The helper needs a few seconds to find a new thread's sandbox or reconnect after a wake, so early calls wait for it.
const FRESH: Duration = Duration::from_secs(60);
const ATTACH: Duration = Duration::from_secs(30);
const UNAVAILABLE: &str = "Mac unavailable: the paired Mac is offline, asleep, or has Mac access turned off. Continue cloud work and try again later.";
const NOT_RESPONDING: &str = "Mac not responding: the paired Mac is connected but did not pick up this command in time. It may be asleep, very busy, or on a slow connection. Continue cloud work and try again later.";
/// For `mac status`, which sends no command: the helper is connected, but the last command went unanswered.
const STALE: &str = "Mac not responding: the paired Mac is connected but did not pick up the last command in time. It may be asleep, very busy, or on a slow connection. Continue cloud work and try again later.";
/// The Mac's helper process restarted while running this command, so its result never arrives (#569).
const LOST: &str = "The Mac app restarted while this command was running, so its output is lost. It may have finished: check its effects before running it again.";
/// The helper connection changed while this command waited for it to confirm the command.
const RECONNECTED: &str = "Mac unavailable: the connection to the Mac restarted while this command was starting. Run it again.";
/// The Mac app resends its report every minute, so an older one may describe a Mac that has since slept.
const REPORTED: Duration = Duration::from_secs(150);
pub const SKILL: &str = include_str!("cloud-mac/SKILL.md");
pub const ROOM_CLI_SKILL: &str = include_str!("room-cli/SKILL.md");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    command: String,
    #[serde(default)]
    stdin: String,
    cwd: Option<String>,
    /// The command changes the Mac. Below Full access the helper refuses it or asks the user first (ADR 0186).
    #[serde(default)]
    write: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    device: String,
    state: String,
    code: Option<i32>,
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    truncated: bool,
    /// A `part` report's position in its stream's hex text. Some sandbox proxies drop requests over about 8 MB,
    /// so the helper sends large output in parts before a final `done` report (`upload_parts`).
    offset: Option<usize>,
}
#[derive(Deserialize)]
pub struct Device {
    device: String,
    /// New each time the helper process starts. Older helpers send none (#569).
    boot: Option<String>,
    /// The helper downloads each job's stdin after confirming it, so a big push never holds up other jobs (#576).
    #[serde(default)]
    fetch: bool,
}
/// What the user's Mac app sees of Mac access (#109). The app reaches this sandbox even when the Mac's helper can't,
/// so agents learn why the Mac is unavailable. `problem` is the short reason Settings shows, never technical detail.
#[derive(Deserialize)]
pub struct AppReport {
    access: String,
    problem: Option<String>,
}

struct Job {
    device: String,
    /// The helper process that took the job; its replacement marks the job lost.
    boot: Option<String>,
    acked: bool,
    result: Option<Value>,
    at: Instant,
    /// Hex output received in parts so far: stdout, stderr.
    parts: [Vec<u8>; 2],
    /// Raw stdin a fetching helper downloads after confirming; freed with the result.
    stdin: Bytes,
}
struct Helper {
    generation: u64,
    device: String,
    boot: Option<String>,
    fetch: bool,
    events: mpsc::Sender<std::result::Result<Event, Infallible>>,
    /// A job went unanswered: the Mac likely slept while a proxy kept its stream open.
    stale: bool,
}

pub struct Mac {
    jobs: Mutex<BTreeMap<String, Job>>,
    helper: Mutex<Option<Helper>>,
    changed: watch::Sender<u64>,
    next: AtomicU64,
    since: Mutex<Instant>,
    /// When the helper last disconnected; None if it hasn't connected since Core started.
    left: Mutex<Option<Instant>>,
    report: Mutex<Option<(AppReport, Instant)>>,
}
impl Default for Mac {
    fn default() -> Self {
        Self {
            jobs: Mutex::default(),
            helper: Mutex::default(),
            changed: watch::channel(0).0,
            next: AtomicU64::new(0),
            since: Mutex::new(Instant::now()),
            left: Mutex::default(),
            report: Mutex::default(),
        }
    }
}
impl Mac {
    /// A new thread or a dropped helper reopens the short wait for the Mac.
    pub(crate) fn expect(&self) {
        *self.since.lock().unwrap() = Instant::now();
    }
    /// A restarted helper can't report jobs its old process was running, so end them instead of leaving them
    /// "running" for a day (#569). A plain reconnect keeps its boot and still reports its own results.
    fn end_lost(&self, device: &str, boot: Option<&str>) {
        let Some(boot) = boot else { return };
        for job in self.jobs.lock().unwrap().values_mut() {
            if job.device == device
                && job.acked
                && job.result.is_none()
                && job.boot.as_deref().is_some_and(|old| old != boot)
            {
                job.result = Some(json!({"state":"lost","message":LOST}));
                job.stdin = Bytes::new();
                job.at = Instant::now();
            }
        }
    }
    fn touch(&self) {
        self.changed.send_modify(|n| *n += 1);
    }
    fn connected(&self, generation: u64) -> bool {
        self.helper
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|h| h.generation == generation)
    }
    /// Why agents can't reach the Mac: the newest thing Core or the Mac app knows (#109).
    fn unavailable(&self) -> String {
        match self.helper.lock().unwrap().as_ref().map(|h| h.stale) {
            Some(true) => return STALE.into(),
            Some(false) => return RECONNECTED.into(),
            None => {}
        }
        let left = *self.left.lock().unwrap();
        let since = left.map_or(String::new(), |at| {
            format!(" (last connected {} ago)", ago(at))
        });
        // A report from before the Mac last dropped off can't know about the drop: a sleeping Mac sends none.
        let after = |at: &Instant| left.is_none_or(|left| *at > left);
        let reported = self.report.lock().unwrap();
        match reported.as_ref().filter(|(_, at)| at.elapsed() < REPORTED) {
            Some((report, _)) if report.access == "off" => "Mac unavailable: the user turned Mac access off. If you need their Mac, ask them to turn it on in Cloudroom; otherwise continue cloud work.".into(),
            Some((AppReport { problem: Some(problem), .. }, at)) if after(at) => format!("Mac unavailable: the user's Mac is online, but Mac access can't connect to Cloudroom{since}. Cloudroom shows them why in Settings → Machines, with a Check now link: {problem} Continue cloud work; mention it only if you need their Mac."),
            Some((_, at)) if after(at) => format!("Mac unavailable: the user's Mac is online with Mac access on, but it isn't connected to this sandbox{since}. If it doesn't connect within a few minutes, the user can restart Cloudroom on their Mac. Continue cloud work meanwhile."),
            _ => left.map_or(UNAVAILABLE.into(), |at| format!("Mac unavailable: the paired Mac disconnected {} ago. It may be asleep, offline, or have Mac access turned off. Continue cloud work and try again later.", ago(at))),
        }
    }
}

fn ago(at: Instant) -> String {
    match at.elapsed().as_secs() / 60 {
        0 => "less than a minute".into(),
        1 => "1 minute".into(),
        minutes @ ..120 => format!("{minutes} minutes"),
        minutes => format!("{} hours", minutes / 60),
    }
}

#[derive(Debug)]
pub struct Failure(StatusCode, String);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
type Result<T> = std::result::Result<T, Failure>;
fn conflict(message: &'static str) -> Failure {
    Failure(StatusCode::CONFLICT, message.into())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(DIGITS[usize::from(byte >> 4)] as char);
        text.push(DIGITS[usize::from(byte & 15)] as char);
    }
    text
}
fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}
fn validate(run: &Run) -> Result<Vec<u8>> {
    if run.command.trim().is_empty() || run.command.len() > 65536 || run.command.contains('\0') {
        return Err(conflict("command must contain 1-65536 bytes"));
    }
    if run
        .cwd
        .as_ref()
        .is_some_and(|d| d.is_empty() || d.len() > 4096 || d.contains('\0'))
    {
        return Err(conflict("invalid folder"));
    }
    if run.stdin.len() > 2 * LIMIT {
        return Err(conflict("input exceeds the 16 MiB limit"));
    }
    unhex(&run.stdin).ok_or(conflict("stdin must be hex"))
}

/// Cancels the Mac command when its waiting agent disappears, for example after Stop.
struct Cancel {
    id: String,
    events: mpsc::Sender<std::result::Result<Event, Infallible>>,
    armed: bool,
}
impl Drop for Cancel {
    fn drop(&mut self) {
        if self.armed {
            let data = json!({"id":self.id}).to_string();
            let _ = self
                .events
                .try_send(Ok(Event::default().event("cancel").data(data)));
        }
    }
}

pub fn routes() -> Router<Arc<Manager>> {
    Router::new()
        .route("/v1/mac/jobs", get(stream))
        .route("/v1/mac/helper", post(app_report))
        .route(
            "/v1/mac/results/{id}",
            post(report).layer(DefaultBodyLimit::max(BODY)),
        )
        .route("/v1/mac/jobs/{id}/stdin", get(job_stdin))
        .route(
            "/v1/vm/run",
            post(vm_run).layer(DefaultBodyLimit::max(BODY)),
        )
        .route(
            "/v1/vm/run/raw",
            post(vm_run_raw).layer(DefaultBodyLimit::max(LIMIT)),
        )
}

/// The Mac app reports what it sees of Mac access, on change and every few minutes (#109).
async fn app_report(
    State(m): State<Arc<Manager>>,
    Json(input): Json<AppReport>,
) -> Result<(StatusCode, Json<Value>)> {
    if input.access.len() > 32 || input.problem.as_ref().is_some_and(|p| p.len() > 2048) {
        return Err(conflict("Invalid Mac access report"));
    }
    *m.mac.report.lock().unwrap() = Some((input, Instant::now()));
    Ok((StatusCode::ACCEPTED, Json(json!({"accepted":true}))))
}

/// The paired Mac's helper receives jobs here. The newest connection replaces older ones.
async fn stream(
    State(m): State<Arc<Manager>>,
    Query(input): Query<Device>,
) -> Result<impl IntoResponse> {
    if !m.previews.paired(&input.device) {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "This Mac is not paired with the VM".into(),
        ));
    }
    let (events, receiver) = mpsc::channel(64);
    let generation = m.mac.next.fetch_add(1, Ordering::Relaxed);
    m.mac.end_lost(&input.device, input.boot.as_deref());
    *m.mac.helper.lock().unwrap() = Some(Helper {
        generation,
        device: input.device,
        boot: input.boot,
        fetch: input.fetch,
        events: events.clone(),
        stale: false,
    });
    m.mac.touch();
    let mac = m.clone();
    tokio::spawn(async move {
        events.closed().await;
        let mut helper = mac.mac.helper.lock().unwrap();
        if helper.as_ref().is_some_and(|h| h.generation == generation) {
            *helper = None;
            mac.mac.expect();
            *mac.mac.left.lock().unwrap() = Some(Instant::now());
        }
        drop(helper);
        mac.mac.touch();
    });
    Ok(Sse::new(ReceiverStream::new(receiver)).keep_alive(KeepAlive::default()))
}

async fn report(
    State(m): State<Arc<Manager>>,
    RoutePath(id): RoutePath<String>,
    Json(input): Json<Report>,
) -> Result<Json<Value>> {
    // Any answer, even one too late for its job, shows the Mac is awake. A late answer must not leave
    // `mac status` offline until some other job succeeds: agents that wait on status would never send one.
    if let Some(h) = m
        .mac
        .helper
        .lock()
        .unwrap()
        .as_mut()
        .filter(|h| h.device == input.device)
    {
        h.stale = false;
    }
    let mut jobs = m.mac.jobs.lock().unwrap();
    let job = jobs
        .get_mut(&id)
        .filter(|j| j.device == input.device)
        .ok_or(Failure(
            StatusCode::NOT_FOUND,
            "Unknown or expired Mac job".into(),
        ))?;
    let output = [input.stdout, input.stderr];
    if output.iter().any(|hex| unhex(hex).is_none()) {
        return Err(conflict("Invalid Mac job report"));
    }
    match (input.state.as_str(), input.offset) {
        ("running", None) => job.acked = true,
        ("part", Some(offset)) => {
            for (parts, hex) in job.parts.iter_mut().zip(&output) {
                if !hex.is_empty() {
                    crate::api::append_part(parts, offset, hex.as_bytes(), 2 * LIMIT)
                        .map_err(conflict)?;
                }
            }
            job.acked = true;
            job.at = Instant::now();
        }
        ("done", None) => {
            let [stdout, stderr] = std::mem::take(&mut job.parts);
            let [stdout, stderr] =
                [(stdout, &output[0]), (stderr, &output[1])].map(|(mut parts, rest)| {
                    parts.extend_from_slice(rest.as_bytes());
                    String::from_utf8(parts).unwrap_or_default()
                });
            if stdout.len() > 2 * LIMIT || stderr.len() > 2 * LIMIT {
                return Err(conflict("Invalid Mac job report"));
            }
            job.acked = true;
            job.at = Instant::now();
            job.stdin = Bytes::new();
            job.result = Some(json!({"state":"done","code":input.code,"stdout":stdout,
                "stderr":stderr,"truncated":input.truncated}));
        }
        _ => return Err(conflict("Invalid Mac job report")),
    }
    drop(jobs);
    m.mac.touch();
    Ok(Json(json!({"accepted":true})))
}

/// A fetching helper downloads a confirmed job's raw stdin here.
async fn job_stdin(
    State(m): State<Arc<Manager>>,
    RoutePath(id): RoutePath<String>,
    Query(input): Query<Device>,
) -> Result<Bytes> {
    let jobs = m.mac.jobs.lock().unwrap();
    jobs.get(&id)
        .filter(|j| j.device == input.device && j.acked && j.result.is_none())
        .map(|j| j.stdin.clone())
        .ok_or(Failure(
            StatusCode::NOT_FOUND,
            "Unknown or expired Mac job".into(),
        ))
}

fn local_auth(m: &Manager, peer: Peer) -> Result<()> {
    match m.previews.agent() {
        Some((_, uid)) if peer.0 == Some(uid) => Ok(()),
        _ => Err(Failure(
            StatusCode::FORBIDDEN,
            "Only the VM agent account may use Mac access".into(),
        )),
    }
}

async fn local_run(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(run): Json<Run>,
) -> Result<Json<Value>> {
    local_auth(&m, peer)?;
    let stdin = validate(&run)?;
    let mac = &m.mac;
    let mut changed = mac.changed.subscribe();
    let fresh = mac.since.lock().unwrap().elapsed() < FRESH;
    let wait = Instant::now() + if fresh { ATTACH } else { Duration::ZERO };
    let (generation, device, boot, fetch, events) = loop {
        if let Some(h) = mac.helper.lock().unwrap().as_ref() {
            break (
                h.generation,
                h.device.clone(),
                h.boot.clone(),
                h.fetch,
                h.events.clone(),
            );
        }
        if Instant::now() >= wait {
            return Err(Failure(StatusCode::CONFLICT, mac.unavailable()));
        }
        tokio::select! {
            _ = changed.changed() => {},
            _ = tokio::time::sleep_until(wait.into()) => {},
        }
    };
    let id = format!(
        "{}-{}",
        std::process::id(),
        mac.next.fetch_add(1, Ordering::Relaxed)
    );
    {
        let mut jobs = mac.jobs.lock().unwrap();
        jobs.retain(|_, j| j.at.elapsed() < if j.result.is_some() { KEEP } else { 24 * KEEP });
        jobs.insert(
            id.clone(),
            Job {
                device,
                boot,
                acked: false,
                result: None,
                at: Instant::now(),
                parts: Default::default(),
                stdin: if fetch { stdin.into() } else { Bytes::new() },
            },
        );
    }
    let mut data = json!({"id":id,"command":run.command,"cwd":run.cwd,"write":run.write});
    if fetch {
        data["stdin_bytes"] = json!(run.stdin.len() / 2);
    } else {
        data["stdin"] = json!(run.stdin);
    }
    let data = data.to_string();
    if events
        .send(Ok(Event::default().event("job").data(data)))
        .await
        .is_err()
    {
        mac.jobs.lock().unwrap().remove(&id);
        return Err(Failure(StatusCode::CONFLICT, mac.unavailable()));
    }
    let mut cancel = Cancel {
        id: id.clone(),
        events,
        armed: true,
    };
    let slow = if fetch {
        0
    } else {
        run.stdin.len() / SLOW_LINK
    };
    let deadline = Instant::now() + ACK + Duration::from_secs(slow as u64);
    loop {
        let connected = mac.connected(generation);
        {
            let mut jobs = mac.jobs.lock().unwrap();
            let job = jobs
                .get(&id)
                .ok_or_else(|| Failure(StatusCode::CONFLICT, mac.unavailable()))?;
            if let Some(result) = &job.result {
                cancel.armed = false;
                let mut result = result.clone();
                result["job"] = json!(id);
                return Ok(Json(result));
            }
            if !job.acked && (!connected || Instant::now() >= deadline) {
                jobs.remove(&id);
                if let Some(h) = mac
                    .helper
                    .lock()
                    .unwrap()
                    .as_mut()
                    .filter(|h| h.generation == generation)
                {
                    h.stale = true;
                }
                return Err(if connected {
                    conflict(NOT_RESPONDING)
                } else {
                    Failure(StatusCode::CONFLICT, mac.unavailable())
                });
            }
            // In-flight work keeps running on the Mac; its helper reports the result after reconnecting.
            if !connected {
                cancel.armed = false;
                return Ok(Json(json!({"job":id,"state":"unknown",
                    "message":format!("The Mac disconnected while this command was running. It may still finish; check later with: room-cli mac result {id}")})));
            }
        }
        tokio::select! {
            _ = changed.changed() => {},
            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
        }
    }
}

async fn local_result(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>> {
    local_auth(&m, peer)?;
    let jobs = m.mac.jobs.lock().unwrap();
    let job = jobs.get(&id).ok_or(Failure(
        StatusCode::NOT_FOUND,
        "Unknown or expired Mac job".into(),
    ))?;
    let mut result = job.result.clone().unwrap_or(json!({"state":"running"}));
    result["job"] = json!(id);
    Ok(Json(result))
}

/// The caller has its result: free it now. Big copies confirm each piece, so they never pile up in memory.
async fn local_forget(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>> {
    local_auth(&m, peer)?;
    let mut jobs = m.mac.jobs.lock().unwrap();
    if jobs.get(&id).is_some_and(|job| job.result.is_some()) {
        jobs.remove(&id);
    }
    Ok(Json(json!({"forgotten":true})))
}

async fn local_status(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>> {
    local_auth(&m, peer)?;
    let connected = m
        .mac
        .helper
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|h| !h.stale);
    Ok(Json(if connected {
        json!({"connected":true})
    } else {
        json!({"connected":false,"reason":m.mac.unavailable()})
    }))
}

pub async fn listen(manager: &Arc<Manager>) -> io::Result<()> {
    let Some((path, _)) = manager.previews.agent() else {
        return Ok(());
    };
    if let Ok(info) = fs::symlink_metadata(&path) {
        if !info.file_type().is_socket() || StdUnixStream::connect(&path).is_ok() {
            return Err(io::Error::other("Mac access socket is already occupied"));
        }
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666))?;
    let app = Router::new()
        .route("/jobs", post(local_run))
        .route("/jobs/{id}", get(local_result).delete(local_forget))
        .route("/status", get(local_status))
        .merge(crate::secrets::agent_routes())
        .merge(crate::session::thread::agent_routes())
        .merge(crate::session::report::agent_routes())
        .merge(crate::session::automation::agent_routes())
        .merge(crate::computer_use::agent_routes())
        .layer(DefaultBodyLimit::max(BODY))
        .with_state(manager.clone());
    tokio::spawn(async move {
        if axum::serve(listener, app.into_make_service_with_connect_info::<Peer>())
            .await
            .is_err()
        {
            eprintln!("Cloudroom Mac access socket stopped");
        }
    });
    Ok(())
}

/// Keeps output even when a background process holds the pipe open after the command exits.
async fn capped(mut reader: impl AsyncRead + Unpin, kept: Arc<Mutex<(Vec<u8>, bool)>>) {
    let mut buffer = vec![0; 65536];
    while let Ok(n) = reader.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        let mut kept = kept.lock().unwrap();
        let room = LIMIT - kept.0.len();
        kept.1 |= n > room;
        kept.0.extend_from_slice(&buffer[..n.min(room)]);
    }
}

/// The paired Mac runs a shell command as the VM agent account.
async fn vm_run(State(m): State<Arc<Manager>>, Json(run): Json<Run>) -> Result<Json<Value>> {
    let stdin = validate(&run)?;
    execute(&m, run, stdin, false).await
}

/// Like `vm_run`, with the command in the query and stdin as the raw body: half the bytes of hex.
/// Bulk project copies use it, so it stays blocked while disk space is critically low.
async fn vm_run_raw(
    State(m): State<Arc<Manager>>,
    Query(run): Query<Run>,
    stdin: Bytes,
) -> Result<Json<Value>> {
    validate(&run)?;
    execute(&m, run, stdin.into(), true).await
}

async fn execute(m: &Manager, run: Run, stdin: Vec<u8>, gated: bool) -> Result<Json<Value>> {
    let home = &m.config.account_home;
    let folder = run.cwd.as_ref().map_or(home.clone(), |d| home.join(d));
    if !folder.is_dir() {
        return Err(conflict("VM folder not found"));
    }
    let mut command = tokio::process::Command::new("/bin/bash");
    command
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", home)
        .env("LANG", "C.UTF-8")
        .args(["-lc", &run.command])
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Plain commands are the emergency way in: they still run while storage is blocked.
    let spawned = if gated {
        m.storage.spawn_writer(&mut command)
    } else {
        m.storage.spawn_operator(&mut command)
    };
    let (mut child, _workload) = spawned.map_err(|error| {
        Failure(
            StatusCode::CONFLICT,
            format!("VM command could not start: {error}"),
        )
    })?;
    let mut input = child.stdin.take().unwrap();
    tokio::spawn(async move {
        let _ = input.write_all(&stdin).await;
    });
    let (out, err) = (Arc::new(Mutex::default()), Arc::new(Mutex::default()));
    let readers = [
        tokio::spawn(capped(child.stdout.take().unwrap(), out.clone())),
        tokio::spawn(capped(child.stderr.take().unwrap(), err.clone())),
    ];
    let status = child.wait().await.map_err(|error| {
        Failure(
            StatusCode::CONFLICT,
            format!("VM command status unavailable: {error}"),
        )
    })?;
    for reader in readers {
        let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
    }
    let (out, err) = (out.lock().unwrap(), err.lock().unwrap());
    Ok(Json(
        json!({"code":status.code(),"stdout":hex(&out.0),"stderr":hex(&err.0),
        "truncated":out.1 || err.1}),
    ))
}

/// Mac paths may start with ~; everything else stays literal.
fn quote(path: &str) -> String {
    let (prefix, rest) = match path {
        "~" => ("\"$HOME\"", ""),
        _ => match path.strip_prefix("~/") {
            Some(rest) => ("\"$HOME\"/", rest),
            None => ("", path),
        },
    };
    if rest.is_empty() {
        return prefix.to_owned();
    }
    format!("{prefix}{}", literal(rest))
}

/// Quotes `text` for the shell exactly as written, `~` included.
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

pub(crate) async fn request(
    socket: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> io::Result<Value> {
    let mut stream = UnixStream::connect(socket).await.map_err(|error| {
        io::Error::other(format!(
            "Cloudroom agent access is not installed on this VM ({socket}: {error})"
        ))
    })?;
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| io::Error::other("invalid Mac access response"))?;
    let value: Value = serde_json::from_slice(&response[split + 4..])?;
    if let Some(message) = value.get("error").and_then(Value::as_str) {
        return Err(io::Error::other(message.to_owned()));
    }
    Ok(value)
}

/// Returns the finished command's stdout, or an error with its output.
fn finished(value: Value) -> io::Result<(Option<i32>, Vec<u8>, Vec<u8>)> {
    if value["state"] != "done" {
        return Err(io::Error::other(value.to_string()));
    }
    let stream = |key: &str| {
        value[key]
            .as_str()
            .and_then(unhex)
            .ok_or_else(|| io::Error::other("invalid Mac output"))
    };
    if value["truncated"] == true {
        eprintln!("Output exceeded 16 MiB and was truncated.");
    }
    Ok((
        value["code"].as_i64().map(|c| c as i32),
        stream("stdout")?,
        stream("stderr")?,
    ))
}

/// Returns the process exit code.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let mut args = args.to_vec();
    let mut socket = SOCKET.to_owned();
    if args.first().map(String::as_str) == Some("--socket") && args.len() > 1 {
        socket = args.remove(1);
        args.remove(0);
    }
    let usage = "room-cli mac run [--cwd DIR] [--stdin] [--write] COMMAND
room-cli mac pull MAC_PATH [VM_PATH]
room-cli mac push VM_PATH [MAC_PATH]
room-cli mac result JOB
room-cli mac status
Runs on the user's paired Mac as the user, in their home folder by default.
Add --write when a command changes the Mac. Unless the user gives Full access,
other commands run read-only, and --write needs their approval.
pull and push work like cp: into an existing folder or a path ending in /,
else under that new name, which must not exist yet.";
    let name = args.first().cloned().unwrap_or_default();
    match (name.as_str(), &args[1.min(args.len())..]) {
        ("run", rest) => {
            let (mut cwd, mut stdin, mut write, mut words) = (None, false, false, Vec::new());
            let mut rest = rest.iter();
            while let Some(word) = rest.next() {
                match word.as_str() {
                    // After the command words, `--help` belongs to the command: `mac run ls --help`.
                    "--help" | "-h" if words.is_empty() => {
                        println!("{usage}");
                        return Ok(0);
                    }
                    "--cwd" if words.is_empty() => cwd = rest.next().cloned(),
                    "--stdin" if words.is_empty() => stdin = true,
                    "--write" if words.is_empty() => write = true,
                    _ => words.push(word.clone()),
                }
            }
            if words.is_empty() {
                return Err(io::Error::other(usage));
            }
            let mut input = Vec::new();
            if stdin {
                std::io::Read::read_to_end(&mut std::io::stdin(), &mut input)?;
            }
            let body =
                json!({"command":words.join(" "),"stdin":hex(&input),"cwd":cwd,"write":write});
            let value = request(&socket, "POST", "/jobs", Some(body)).await?;
            print_result(value).await
        }
        (_, rest) if rest.iter().any(|w| matches!(w.as_str(), "--help" | "-h")) => {
            println!("{usage}");
            Ok(0)
        }
        ("result", [job]) if job.bytes().all(|b| b.is_ascii_digit() || b == b'-') => {
            print_result(request(&socket, "GET", &format!("/jobs/{job}"), None).await?).await
        }
        ("status", []) => {
            println!("{}", request(&socket, "GET", "/status", None).await?);
            Ok(0)
        }
        ("pull", [source, rest @ ..]) if rest.len() <= 1 => {
            transfer::pull(&socket, source, rest.first().map_or(".", String::as_str)).await
        }
        ("push", [source, rest @ ..]) if rest.len() <= 1 => {
            transfer::push(&socket, source, rest.first().map_or("~", String::as_str)).await
        }
        _ => {
            println!("{usage}");
            Ok(if matches!(name.as_str(), "" | "--help" | "-h") {
                0
            } else {
                2
            })
        }
    }
}

async fn print_result(value: Value) -> io::Result<i32> {
    let (code, stdout, stderr) = finished(value)?;
    use std::io::Write;
    std::io::stdout().write_all(&stdout)?;
    std::io::stdout().flush()?;
    std::io::stderr().write_all(&stderr)?;
    Ok(code.unwrap_or(1))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn subcommand_help_prints_usage_but_run_passes_it_after_the_command() {
        let cli = |words: &str| {
            let args = format!("--socket /nonexistent/mac.sock {words}");
            async move { super::cli(&args.split(' ').map(String::from).collect::<Vec<_>>()).await }
        };
        for words in [
            "-h",
            "run --help",
            "run --write -h",
            "pull --help",
            "push -h",
            "push x --help",
            "status --help",
            "result -h",
        ] {
            assert_eq!(cli(words).await.unwrap(), 0, "{words}");
        }
        // The missing socket proves it went to the Mac.
        let error = cli("run ls --help").await.unwrap_err().to_string();
        assert!(error.contains("not installed"), "{error}");
        let error = cli("push /nonexistent/x").await.unwrap_err().to_string();
        assert!(error.starts_with("VM path /nonexistent/x: "), "{error}");
        let error = cli("push Cargo.toml/").await.unwrap_err().to_string();
        assert!(error.contains("not installed"), "{error}");
    }
}
