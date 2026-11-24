//! Two-way Mac ↔ VM access (ADR 0113). VM agents reach the paired Mac through its helper; the Mac runs commands on the VM.
use crate::{
    observability::{Signal, elapsed_ms},
    preview::Peer,
    session::Manager,
};
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
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    convert::Infallible,
    fs,
    hash::{BuildHasher, RandomState},
    io,
    os::unix::{fs::FileTypeExt, fs::PermissionsExt, net::UnixStream as StdUnixStream},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
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
/// A helper pairs with each awake sandbox once a minute, on its 10 s check (PAIR_SECONDS and POLL_SECONDS in
/// client.py, PAIR and POLL in helper/mod.rs), so a longer silence means its Mac sleeps or is gone.
const CHECK_IN: Duration = Duration::from_secs(90);
const UNAVAILABLE: &str = "Mac unavailable: the paired Mac is offline, asleep, or has Mac access turned off. Continue cloud work and try again later.";
const NOT_RESPONDING: &str = "Mac not responding: the paired Mac is connected but did not pick up this command in time. It may be asleep, very busy, or on a slow connection. Continue cloud work and try again later.";
/// For `mac status`, which sends no command: the helper is connected, but the last command or check went unanswered.
const STALE: &str = "Mac not responding: the paired Mac is connected but didn't answer in time. It may be asleep, very busy, or on a slow connection. Continue cloud work and try again later.";
/// The Mac's helper process restarted while running this command, so its result never arrives (#569).
const LOST: &str = "The Mac app restarted while this command was running, so its output is lost. It may have finished: check its effects before running it again.";
/// Core keeps jobs in memory, so a Core restart (update, crash, sandbox wake) forgets them (#1952).
const RESTARTED: &str = "Cloudroom restarted in this sandbox after this command started, so its result is lost. It may have run, fully or in part: check its effects before running it again.";
/// The helper connection changed while this command waited for it to confirm the command.
const RECONNECTED: &str = "Mac unavailable: the connection to the Mac restarted while this command was starting. Run it again.";
/// How long room-cli waits for a read Core answers from what it knows (`status`): under Codex's 10 s command
/// default, so the agent sees why instead of a killed command (#1977).
pub(crate) const QUICK: Duration = Duration::from_secs(8);
/// The same for a read that may ask the website, whose calls end within 30 s (history.rs).
pub(crate) const READ: Duration = Duration::from_secs(45);
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
    /// A `push`: the helper builds its own unpack from this and ignores `command` (#222).
    #[serde(default)]
    copy: Option<Copy>,
}
/// What a `push` copies, for the Mac helper's own unpack: the item's `name`, its place as typed (`to`), and the Mac
/// temp folder holding a copy over 16 MiB (`staged`). The helper places only that item, so a sandbox's archive can't
/// add other files there. Older helpers run the job's `command` instead.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Copy {
    name: String,
    to: String,
    staged: Option<String>,
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
    /// The Mac's computer name, so `mac run` and `mac status` say which Mac runs commands (#608). Older helpers send none.
    name: Option<String>,
    /// The computer's system, `macos`, `linux`, or `windows`, for `mac status` (#958). Older helpers send none.
    os: Option<String>,
}
/// What the user's Mac app sees of Mac access (#109). The app reaches this sandbox even when the Mac's helper can't,
/// so agents learn why the Mac is unavailable. `problem` is the short reason Settings shows, never technical detail.
#[derive(Deserialize)]
pub struct AppReport {
    access: String,
    problem: Option<String>,
    /// An older Windows app, which hid Mac access (#871); newer ones send none.
    #[serde(default)]
    unsupported: bool,
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
    events: Events,
    /// A job went unanswered: the Mac likely slept while a proxy kept its stream open.
    stale: bool,
}

pub struct Mac {
    jobs: Mutex<BTreeMap<String, Job>>,
    helper: Mutex<Option<Helper>>,
    changed: watch::Sender<u64>,
    next: AtomicU64,
    /// Random per Core run and the start of each job ID, so `mac result` can tell a job from before a restart (#1952).
    /// A process ID can repeat after a sandbox wakes.
    run: u32,
    since: Mutex<Instant>,
    /// When the helper last disconnected; None if it hasn't connected since Core started.
    left: Mutex<Option<Instant>>,
    report: Mutex<Option<(AppReport, Instant)>>,
    /// The last `mac run` refusal put in diagnostics. Agents retry fast, so at most one a minute per reason.
    refused: Mutex<Option<(&'static str, Instant)>>,
    /// When the helper last really answered, kept across reconnects: a short wake's new stream is no answer (#608).
    answered: Mutex<Option<Instant>>,
    /// An agent couldn't reach the Mac, so the Mac app's next report asks it to check now, like `room-cli cloud check`.
    check: AtomicBool,
    /// The helper device of the Mac app that last sent this sandbox a prompt: the only Mac a sleeping one's pairing
    /// moves to (#608).
    using: Mutex<Option<String>>,
    /// The last helper that connected, and its computer name if it sent one.
    named: Mutex<Option<(String, Option<String>)>>,
    /// The device whose helper last streamed, and the system it said it runs (#958).
    os: Mutex<Option<(String, String)>>,
    /// When a Mac with access on last asked for jobs but the pairing stayed with an away Mac, because that Mac's app
    /// isn't the one using this sandbox (no prompt from it: loops, phones, website wakes). Cleared on attach.
    kept_out: Mutex<Option<Instant>>,
    /// The device that ran the last finished command here, or that held the pairing before it moved. A finished
    /// `mac run` names its Mac only when this changes (Marko, 2026-11-03).
    last_ran: Mutex<Option<String>>,
    /// Commands an agent or terminal is waiting on the Mac for right now. They use no CPU here (an approval pop-up, a
    /// long copy), so the dashboard and the drain count them, or the sandbox sleeps under them (feedback 0024).
    waiting: AtomicUsize,
}
impl Default for Mac {
    fn default() -> Self {
        Self {
            jobs: Mutex::default(),
            helper: Mutex::default(),
            changed: watch::channel(0).0,
            next: AtomicU64::new(0),
            run: RandomState::new().hash_one(std::process::id()) as u32,
            since: Mutex::new(Instant::now()),
            left: Mutex::default(),
            report: Mutex::default(),
            refused: Mutex::default(),
            answered: Mutex::default(),
            check: AtomicBool::default(),
            using: Mutex::default(),
            named: Mutex::default(),
            os: Mutex::default(),
            kept_out: Mutex::default(),
            last_ran: Mutex::default(),
            waiting: AtomicUsize::default(),
        }
    }
}
impl Mac {
    pub(crate) fn waiting(&self) -> usize {
        self.waiting.load(Ordering::Relaxed)
    }
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
    fn job_id(&self) -> String {
        format!("{}-{}", self.run, self.next.fetch_add(1, Ordering::Relaxed))
    }
    fn touch(&self) {
        self.changed.send_modify(|n| *n += 1);
    }
    /// Whether a hosted sandbox's pairing may move from `holder` to `next`, a Mac with access on that asks for jobs
    /// (#608). `checked_in` is when `holder` last paired since Core started: an awake helper does once a minute.
    fn may_move(&self, holder: &str, next: &str, checked_in: Option<Instant>) -> bool {
        let using = self.using.lock().unwrap().clone();
        // The Mac whose app sends this sandbox prompts keeps it, even with Mac access off, so its previews stay there.
        if using.as_deref() == Some(holder) {
            return false;
        }
        let awake = checked_in.is_some_and(|at| at.elapsed() < CHECK_IN);
        let stream = self
            .helper
            .lock()
            .unwrap()
            .as_ref()
            .map(|h| (h.device == holder, h.stale));
        match stream {
            // A stream counts while its Mac answers and checks in: a proxy can hold a sleeping Mac's stream open.
            Some((true, false)) if awake || checked_in.is_none() => return false,
            // One is due (the first minute of a new thread or after a drop), so a reconnecting Mac keeps its pairing.
            None if self.since.lock().unwrap().elapsed() < FRESH => return false,
            _ => {}
        }
        let streaming = stream.is_some_and(|(holds, _)| holds);
        let streamed = self
            .named
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(d, _)| d == holder);
        // Takes no jobs (Mac access off): awake without a stream, or seen since Core started but never on one.
        if !streaming && (awake || checked_in.is_some() && !streamed) {
            return true;
        }
        // Away (asleep, gone, an old install): only the Mac whose app uses this sandbox takes it, so a Mac that merely
        // checks in never takes the user's other sandboxes (Marko, 2026-11-03).
        if using.as_deref() == Some(next) {
            return true;
        }
        if !awake {
            *self.kept_out.lock().unwrap() = Some(Instant::now());
        }
        false
    }
    /// The pairing moved off `from`. Its stream, maybe a sleeping Mac's that a proxy holds open, takes no more jobs, and
    /// a `mac run` waits for the new Mac as after a drop.
    fn moved(&self, from: String) {
        let mut helper = self.helper.lock().unwrap();
        if helper.as_ref().is_some_and(|h| h.device == from) {
            *helper = None;
            *self.left.lock().unwrap() = Some(Instant::now());
        }
        drop(helper);
        self.expect();
        *self.last_ran.lock().unwrap() = Some(from);
        self.touch();
    }
    /// The Mac app sends its helper's device with each prompt (`mac_device` capability), so Core knows which Mac uses
    /// this sandbox.
    pub(crate) fn note_using(&self, headers: &axum::http::HeaderMap) {
        if let Some(device) = headers
            .get("x-cloudroom-mac-device")
            .and_then(|v| v.to_str().ok())
            .filter(|d| d.len() == 32 && d.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            *self.using.lock().unwrap() = Some(device.to_owned());
        }
    }
    /// `device`'s name if it isn't the Mac that ran the last command, so the first run after a move says where it ran.
    fn moved_to(&self, device: &str) -> Option<String> {
        let previous = self.last_ran.lock().unwrap().replace(device.to_owned());
        previous
            .filter(|previous| previous != device)
            .and_then(|_| self.name_of(device))
    }
    /// `device`'s computer name, if its helper sent one.
    fn name_of(&self, device: &str) -> Option<String> {
        let named = self.named.lock().unwrap();
        named
            .as_ref()
            .filter(|(d, _)| d == device)
            .and_then(|(_, name)| name.clone())
    }
    fn connected(&self, generation: u64) -> bool {
        self.helper
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|h| h.generation == generation)
    }
    /// The app runs on Windows, so no helper will ever connect: refuse at once instead of waiting (#1334).
    fn unsupported(&self) -> bool {
        self.report
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(r, at)| r.unsupported && at.elapsed() < REPORTED)
    }
    /// Why agents can't reach the Mac: the newest thing Core or the Mac app knows (#109).
    fn unavailable(&self) -> String {
        self.why_unavailable().1
    }
    /// The same answer, with a fixed reason for diagnostics. An agent asked, so the Mac app is asked to check too,
    /// unless an away Mac keeps the pairing.
    fn why_unavailable(&self) -> (&'static str, String) {
        // A Mac checking now can't take a pairing an away Mac keeps (Marko, 2026-11-03), so it isn't asked to.
        let kept_out = self
            .kept_out
            .lock()
            .unwrap()
            .is_some_and(|at| at.elapsed() < REPORTED);
        self.check.store(!kept_out, Ordering::Relaxed);
        match self.helper.lock().unwrap().as_ref().map(|h| h.stale) {
            Some(true) => {
                let last = self.answered.lock().unwrap().map_or(String::new(), |at| {
                    format!(" It last answered {} ago.", ago(at))
                });
                return ("stale", format!("{STALE}{last}"));
            }
            Some(false) => return ("reconnected", RECONNECTED.into()),
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
            Some((AppReport { unsupported: true, .. }, _)) => ("unsupported", "Mac unavailable: the user's Cloudroom app on Windows is too old to let cloud agents use their computer. If you need it, ask them to update Cloudroom, then pick Computer access in its sidebar; otherwise continue cloud work.".into()),
            Some((report, _)) if report.access == "off" => ("access_off", "Mac unavailable: the user turned Mac access off. If you need their Mac, ask them to turn it on in Cloudroom; otherwise continue cloud work.".into()),
            Some((AppReport { problem: Some(problem), .. }, at)) if after(at) => ("mac_problem", format!("Mac unavailable: the user's Mac is online, but Mac access can't connect to Cloudroom{since}. Cloudroom shows them why in Settings → Machines, with a Check now link: {problem} Continue cloud work; mention it only if you need their Mac.")),
            Some((_, at)) if after(at) && kept_out => ("paired_away", format!("Mac unavailable: this sandbox is paired with another of the user's Macs, which is away (asleep or offline){since}. It moves to the Mac the user is on once they send this thread a message from Cloudroom there. Continue cloud work meanwhile.")),
            Some((_, at)) if after(at) => ("not_connected", format!("Mac unavailable: the user's Mac is online with Mac access on, but it isn't connected to this sandbox{since}. Cloudroom asked the Mac to reconnect; try again in a minute or two. If it still doesn't connect within a few minutes, the user can restart Cloudroom on their Mac. Continue cloud work meanwhile.")),
            _ => left.map_or(("never_connected", UNAVAILABLE.into()), |at| ("disconnected", format!("Mac unavailable: the paired Mac disconnected {} ago. It may be asleep, offline, or have Mac access turned off. Continue cloud work and try again later.", ago(at)))),
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
    events: Events,
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

/// Counts one command as waiting on the Mac until its `mac run` returns: done, refused, disconnected, or stopped.
struct Waiting<'a>(&'a AtomicUsize);
impl<'a> Waiting<'a> {
    fn start(count: &'a AtomicUsize) -> Self {
        count.fetch_add(1, Ordering::Relaxed);
        Self(count)
    }
}
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
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
    // An agent here couldn't reach the Mac: the app checks now, as `room-cli cloud check` does (#608). Not when off.
    let check = input.access != "off" && m.mac.check.swap(false, Ordering::Relaxed);
    *m.mac.report.lock().unwrap() = Some((input, Instant::now()));
    // A `mac run` waiting for the helper rechecks, so a Windows report ends its wait.
    m.mac.touch();
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"accepted":true,"check":check})),
    ))
}

/// The paired Mac's helper receives jobs here. The newest connection replaces older ones.
async fn stream(
    State(m): State<Arc<Manager>>,
    Query(input): Query<Device>,
) -> Result<impl IntoResponse> {
    let (events, receiver) = mpsc::channel(64);
    let generation = m.mac.next.fetch_add(1, Ordering::Relaxed);
    let name = input.name.as_deref().map(str::trim).filter(|name| {
        !name.is_empty() && name.chars().count() <= 64 && !name.chars().any(char::is_control)
    });
    let device = input.device;
    // Attached with the registry locked, so `release_for` sees this stream or the stream sees the release (#608).
    let attached = m.previews.while_paired(&device, || {
        *m.mac.kept_out.lock().unwrap() = None;
        *m.mac.named.lock().unwrap() = Some((device.clone(), name.map(str::to_owned)));
        *m.mac.os.lock().unwrap() = input
            .os
            .as_deref()
            .filter(|os| matches!(*os, "macos" | "linux" | "windows"))
            .map(|os| (device.clone(), os.to_owned()));
        *m.mac.helper.lock().unwrap() = Some(Helper {
            generation,
            device: device.clone(),
            boot: input.boot.clone(),
            fetch: input.fetch,
            events: events.clone(),
            stale: false,
        });
    });
    if !attached {
        // A sandbox keeps its one Mac for good, so a device that left or has Mac access off would lock this Mac out
        // for hours (#608). Free its pairing; the helper pairs again right after this 403. The new holder gets the same
        // minute's grace to open its stream, so a second Mac can't free it in between, back and forth.
        let mut moved_from = None;
        let freed = m.previews.release_for(&device, |holder, checked_in| {
            moved_from = Some(holder.to_owned());
            m.mac.may_move(holder, &device, checked_in)
        });
        if let Some(from) = moved_from.filter(|_| freed) {
            m.mac.moved(from);
        }
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "This Mac is not paired with the VM".into(),
        ));
    }
    m.mac.end_lost(&device, input.boot.as_deref());
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
        *m.mac.answered.lock().unwrap() = Some(Instant::now());
        m.mac.touch();
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

/// Records why a `mac run` got no Mac, so a lost link can be traced after the sandbox is gone.
fn record_refusal(m: &Manager, reason: &'static str, started: Instant) {
    {
        let mut last = m.mac.refused.lock().unwrap();
        if last
            .as_ref()
            .is_some_and(|(r, at)| *r == reason && at.elapsed() < Duration::from_secs(60))
        {
            return;
        }
        *last = Some((reason, Instant::now()));
    }
    m.observability.record(Signal::MacUnavailable {
        reason,
        waited_ms: elapsed_ms(started),
        holder: m.previews.holder(),
    });
}
fn refused(m: &Manager, started: Instant) -> Failure {
    let (reason, message) = m.mac.why_unavailable();
    record_refusal(m, reason, started);
    Failure(StatusCode::CONFLICT, naming(m, message))
}
/// The computer name of the Mac this sandbox is paired with, if its helper sent one.
fn paired_name(m: &Manager) -> Option<String> {
    let named = m.mac.named.lock().unwrap().clone();
    named
        .filter(|(device, _)| m.previews.paired(device))
        .and_then(|(_, name)| name)
}
/// Names the Mac that runs this sandbox's commands, so agents and users see when the pairing moves (#608).
fn naming(m: &Manager, message: String) -> String {
    match paired_name(m) {
        Some(name) => format!("{message} This sandbox uses the Mac \"{name}\"."),
        None => message,
    }
}
type Events = mpsc::Sender<std::result::Result<Event, Infallible>>;
/// The connected helper: generation, device, boot, fetch, and its job stream. A new thread or a dropped helper gets
/// up to 30 s for it to connect; otherwise None at once.
async fn attach(mac: &Mac) -> Option<(u64, String, Option<String>, bool, Events)> {
    let mut changed = mac.changed.subscribe();
    let fresh = mac.since.lock().unwrap().elapsed() < FRESH;
    let wait = Instant::now() + if fresh { ATTACH } else { Duration::ZERO };
    loop {
        if let Some(h) = mac.helper.lock().unwrap().as_ref() {
            return Some((
                h.generation,
                h.device.clone(),
                h.boot.clone(),
                h.fetch,
                h.events.clone(),
            ));
        }
        if Instant::now() >= wait || mac.unsupported() {
            return None;
        }
        tokio::select! {
            _ = changed.changed() => {},
            _ = tokio::time::sleep_until(wait.into()) => {},
        }
    }
}
async fn local_run(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(run): Json<Run>,
) -> Result<Json<Value>> {
    local_auth(&m, peer)?;
    let stdin = validate(&run)?;
    let started = Instant::now();
    let mac = &m.mac;
    let mut changed = mac.changed.subscribe();
    let Some((generation, device, boot, fetch, events)) = attach(mac).await else {
        return Err(refused(&m, started));
    };
    let id = mac.job_id();
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
    if let Some(copy) = run.copy {
        data["copy"] = json!(copy);
    }
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
        return Err(refused(&m, started));
    }
    let mut cancel = Cancel {
        id: id.clone(),
        events,
        armed: true,
    };
    let _waiting = Waiting::start(&mac.waiting);
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
            let job = jobs.get(&id).ok_or_else(|| refused(&m, started))?;
            if let Some(result) = &job.result {
                cancel.armed = false;
                let mut result = result.clone();
                result["job"] = json!(id);
                // Named only on the first command after the Mac changed; `mac status` and errors always name it.
                if let Some(name) = mac.moved_to(&job.device) {
                    result["mac"] = json!(name);
                }
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
                    mac.check.store(true, Ordering::Relaxed);
                    record_refusal(&m, "not_responding", started);
                    Failure(StatusCode::CONFLICT, naming(&m, NOT_RESPONDING.into()))
                } else {
                    refused(&m, started)
                });
            }
            // In-flight work keeps running on the Mac; its helper reports the result after reconnecting.
            if !connected {
                cancel.armed = false;
                return Ok(Json(
                    json!({"job":id,"state":"unknown","mac":mac.name_of(&job.device),
                    "message":format!("The Mac disconnected while this command was running. It may still finish; check later with: room-cli mac result {id}")}),
                ));
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
    let Some(job) = jobs.get(&id) else {
        // Only confirmed jobs reach the agent, so one from an earlier Core run may have run (#1952).
        if id
            .split_once('-')
            .is_some_and(|(run, _)| run != m.mac.run.to_string())
        {
            return Ok(Json(json!({"job":id,"state":"lost","message":RESTARTED})));
        }
        return Err(Failure(
            StatusCode::NOT_FOUND,
            "Unknown or expired Mac job".into(),
        ));
    };
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

/// The same check as `mac run` (#608): wait for the helper as it does, then ask the helper for a real answer, so a
/// stream left open by a sleeping Mac isn't "connected". The check is a job Core never keeps: the helper confirms it
/// first, gets 404, and runs nothing. Helpers older than `fetch` might run it, so they get the old answer.
async fn local_status(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>> {
    local_auth(&m, peer)?;
    let mac = &m.mac;
    let mut changed = mac.changed.subscribe();
    let connected = match attach(mac).await {
        Some((generation, _, _, true, events)) => {
            let asked = Instant::now();
            let id = mac.job_id();
            let data = json!({"id":id,"command":"true","write":false}).to_string();
            // try_send: a full stream means the helper stopped reading, which is no answer either.
            let sent = events
                .try_send(Ok(Event::default().event("job").data(data)))
                .is_ok();
            let deadline = asked + ACK;
            loop {
                if mac.answered.lock().unwrap().is_some_and(|at| at >= asked) {
                    break true;
                }
                if !sent || Instant::now() >= deadline || !mac.connected(generation) {
                    if let Some(h) = mac
                        .helper
                        .lock()
                        .unwrap()
                        .as_mut()
                        .filter(|h| h.generation == generation)
                    {
                        h.stale = true;
                    }
                    break false;
                }
                tokio::select! {
                    _ = changed.changed() => {},
                    _ = tokio::time::sleep_until(deadline.into()) => {},
                }
            }
        }
        Some(_) => mac
            .helper
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|h| !h.stale),
        None => false,
    };
    let name = paired_name(&m);
    let mut status = if connected {
        json!({"connected":true,"mac":name})
    } else {
        json!({"connected":false,"reason":naming(&m, mac.unavailable()),"mac":name})
    };
    // Which system the paired computer's helper said it runs: Windows runs commands in Git Bash, with only Off and
    // Full access (#958). Omitted while unknown, or for a computer that is no longer paired.
    let os = mac.os.lock().unwrap().clone();
    if let Some((_, os)) = os.filter(|(device, _)| m.previews.paired(device)) {
        status["os"] = json!(os);
    }
    Ok(Json(status))
}

/// Every route on the agent socket. Two modules using the same method and path panic here, which a test catches.
fn agent_router() -> Router<Arc<Manager>> {
    Router::new()
        .route("/jobs", post(local_run))
        .route("/jobs/{id}", get(local_result).delete(local_forget))
        .route("/status", get(local_status))
        .merge(crate::secrets::agent_routes())
        .merge(crate::session::thread::agent_routes())
        .merge(crate::session::report::agent_routes())
        .merge(crate::session::snippets::agent_routes())
        .merge(crate::session::team::agent_routes())
        .merge(crate::session::automation::agent_routes())
        .merge(crate::computer_use::agent_routes())
        .merge(crate::gpu::agent_routes())
        .layer(DefaultBodyLimit::max(BODY))
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
    let app = agent_router().with_state(manager.clone());
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

/// `?keep=true`: the command outlives its request, for up to 15 minutes (#1970). A proxy that drops a long request
/// (Cloudflare's 524 after 100 s) then loses only the answer: the app's GitHub clone goes on, and the app checks back.
/// Older Cores ignore the query and end the command with its request, as before.
#[derive(Deserialize)]
struct Keep {
    #[serde(default)]
    keep: bool,
}
const KEPT: Duration = Duration::from_secs(15 * 60);
const LATE: &str = "VM command did not finish in 15 minutes";

/// The paired Mac runs a shell command as the VM agent account.
async fn vm_run(
    State(m): State<Arc<Manager>>,
    Query(keep): Query<Keep>,
    Json(run): Json<Run>,
) -> Result<Json<Value>> {
    let stdin = validate(&run)?;
    if !keep.keep {
        return execute(&m, run, stdin, false).await;
    }
    // Its own task, which a dropped request doesn't cancel; past the limit, it ends like a dropped request did.
    let task = tokio::spawn(async move {
        let ran = tokio::time::timeout(KEPT, execute(&m, run, stdin, false)).await;
        ran.unwrap_or_else(|_| Err(Failure(StatusCode::GATEWAY_TIMEOUT, LATE.into())))
    });
    task.await
        .map_err(|error| Failure(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
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
    request_within(socket, method, path, body, None).await
}

/// `request` that gives up after `limit`, saying which step Core stalled at, so a Core that is busy or restarting
/// never leaves room-cli silent (#1977). A Unix socket takes the connection even while Core's accept loop is stuck.
pub(crate) async fn request_within(
    socket: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    limit: Option<Duration>,
) -> io::Result<Value> {
    let sent = AtomicBool::new(false);
    let exchange = async {
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
        sent.store(true, Ordering::Relaxed);
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await?;
        Ok::<_, io::Error>(response)
    };
    let response = match limit {
        None => exchange.await?,
        Some(limit) => tokio::time::timeout(limit, exchange).await.map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "Cloudroom Core did not {} this request within {} s: it is busy or restarting. Continue other work and try again in a minute.",
                    if sent.load(Ordering::Relaxed) { "answer" } else { "take" },
                    limit.as_secs_f64().round()
                ),
            )
        })??,
    };
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
Flags go before COMMAND: room-cli mac run --cwd DIR 'COMMAND'. Later words,
flags included, go to COMMAND. DIR is relative to their home folder, or absolute.
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
            let path = format!("/jobs/{job}");
            let value = request_within(&socket, "GET", &path, None, Some(QUICK)).await?;
            let stdout = value["stdout"].as_str().and_then(unhex);
            if stdout.is_some_and(|stdout| transfer::archive(&stdout)) {
                return Err(io::Error::other(format!(
                    "Mac job {job} was part of a room-cli mac pull. Its output is copy data only that pull could use, so it isn't printed. Nothing was copied to the VM: run the pull again."
                )));
            }
            print_result(value).await
        }
        ("status", []) => {
            println!("{}", request(&socket, "GET", "/status", None).await?);
            Ok(0)
        }
        ("pull", [source, rest @ ..]) if rest.len() <= 1 => {
            transfer::pull(&socket, source, rest.first().map_or(".", String::as_str)).await
        }
        ("push", [source, rest @ ..]) if rest.len() <= 1 => {
            let to = rest.first().map_or("~", String::as_str);
            transfer::stoppable(&socket, None, transfer::push(&socket, source, to)).await
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
    let mac = value["mac"].as_str().map(str::to_owned);
    // #1817: cut output must not pass `&&` or `set -e` as complete. A failed command keeps its own code.
    let cut = value["truncated"] == true;
    let (code, stdout, stderr) = finished(value)?;
    use std::io::Write;
    std::io::stdout().write_all(&stdout)?;
    std::io::stdout().flush()?;
    std::io::stderr().write_all(&stderr)?;
    let gap = if stderr.is_empty() || stderr.ends_with(b"\n") {
        ""
    } else {
        "\n"
    };
    // Only after the Mac changed; stderr, so piped output and `mac pull` archives stay unchanged (#608).
    if let Some(mac) = &mac {
        eprintln!("{gap}Ran on the Mac \"{mac}\".");
    }
    if cut && code == Some(0) {
        let gap = if mac.is_some() { "" } else { gap };
        eprintln!(
            "{gap}The command exited 0, but its output passed 16 MiB and was cut, so this exits 1. Do not rerun it as is: write the output to a file on the Mac and copy it with `room-cli mac pull`."
        );
        return Ok(1);
    }
    Ok(code.unwrap_or(1))
}

#[cfg(test)]
mod tests {
    #[test]
    fn agent_socket_routes_do_not_collide() {
        // A duplicate method and path panics when Core opens the socket, which would stop Core in every sandbox.
        let _ = super::agent_router();
    }

    #[test]
    fn a_command_counts_as_waiting_until_its_run_returns() {
        // The dashboard and the drain read this count, so a sandbox never sleeps under a Mac approval pop-up.
        let mac = super::Mac::default();
        let (first, second) = (
            super::Waiting::start(&mac.waiting),
            super::Waiting::start(&mac.waiting),
        );
        assert_eq!(mac.waiting(), 2);
        drop(first);
        assert_eq!(mac.waiting(), 1);
        drop(second);
        assert_eq!(mac.waiting(), 0);
    }

    #[test]
    fn a_push_job_keeps_its_copy_for_the_mac() {
        // Security fix (#222): without `copy`, the Mac helper falls back to the sandbox's own unpack command.
        let copy =
            serde_json::json!({"name":"notes.txt","to":"~/x/","staged":"/tmp/cloudroom.abc"});
        let body = serde_json::json!({"command":"true","stdin":"","write":true,"copy":copy});
        let run: super::Run = serde_json::from_value(body).unwrap();
        assert_eq!(serde_json::json!(run.copy), copy);
    }

    #[test]
    fn mac_status_says_why_from_the_app_report() {
        // #871: older Windows apps send "off" with `unsupported`, so agents ask for an update, not a hidden setting.
        for (extra, reason) in [
            ("", "access_off"),
            (r#","unsupported":true"#, "unsupported"),
        ] {
            let report = format!(r#"{{"access":"off","problem":null{extra}}}"#);
            let mac = super::Mac::default();
            let now = std::time::Instant::now();
            *mac.report.lock().unwrap() = Some((serde_json::from_str(&report).unwrap(), now));
            assert_eq!(mac.why_unavailable().0, reason, "{report}");
            // #1334: only Windows skips the wait for the helper; an old report may predate a reinstall.
            assert_eq!(mac.unsupported(), !extra.is_empty(), "{report}");
            let old = now.checked_sub(super::REPORTED).unwrap();
            mac.report.lock().unwrap().as_mut().unwrap().1 = old;
            assert!(!mac.unsupported(), "{report}");
        }
    }

    #[tokio::test]
    async fn cut_output_fails_a_successful_command_but_keeps_a_failed_ones_code() {
        // #1817: a shell check must not take output cut at 16 MiB as complete.
        for (code, truncated, want) in [(0, true, 1), (3, true, 3), (0, false, 0)] {
            let value = serde_json::json!({"state":"done","code":code,"stdout":"","stderr":"","truncated":truncated});
            assert_eq!(
                super::print_result(value).await.unwrap(),
                want,
                "{code} {truncated}"
            );
        }
    }

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
        // #1977: a Core that takes a request and never answers says so instead of leaving room-cli silent.
        let socket =
            std::env::temp_dir().join(format!("cloudroom-silent-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let _silent = tokio::net::UnixListener::bind(&socket).unwrap();
        let limit = Some(std::time::Duration::from_millis(200));
        let answer = super::request_within(socket.to_str().unwrap(), "GET", "/thread", None, limit);
        let error = answer.await.unwrap_err();
        let _ = std::fs::remove_file(&socket);
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut, "{error}");
    }
}
