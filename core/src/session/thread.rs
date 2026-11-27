//! Cloud agents rename or archive their own thread, change its effort, and start, stop and archive child threads in their own sandbox. Each request
//! is a session record, so the app applies it whenever it next reads the thread, including after it was offline.
//! A child gets a sandbox of its own by default (ADR 0229). The website starts it, so it never needs the user's
//! app (ADR 20261104-015709); only `--shared-sandbox` runs it here. Once started, the website carries its `tell`,
//! `stop`, `archive` and turn reports, even while the app is closed (relay.rs).
//! `thread fork` asks the app the same way to fork this thread into a new Cloud thread; without an answer there is no
//! fork. Only the user forks to their Mac, from the app.
//! `spawn --top-level` asks the website to start a top-level thread instead, with no link back (ADR 0267).
use super::{Manager, SessionState, relay};
use crate::preview::Peer;
use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, Read},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

const USAGE: &str = "room-cli thread show [CHILD_ID]
room-cli thread update --self [--title TITLE] [--reasoning-level LEVEL]
room-cli thread pin --self|CHILD_ID
room-cli thread archive --self
room-cli thread move --self --project PROJECT
room-cli thread stop --self
room-cli thread compact --self|CHILD_ID [--then TEXT|--no-then]
room-cli thread spawn --provider codex|claude-code|cursor|pi|opencode|hermes|devin|droid|kimi|antigravity|fx|openclaw|agent-zero [--model MODEL] [--reasoning-level LEVEL] [--service-tier default|fast] [--title TITLE] [--pin] [--shared-sandbox|--top-level] --prompt TEXT|--prompt-file PATH
room-cli thread fork [--provider codex|claude-code|cursor|pi|opencode|hermes|devin|droid|kimi|antigravity|fx|openclaw|agent-zero] [--model MODEL] [--reasoning-level LEVEL] [--title TITLE] --prompt TEXT|--prompt-file PATH
room-cli thread list [--include-archived]
room-cli thread wait --children
room-cli thread output CHILD_ID [--all | --input TOOL_INPUT_ID [--offset N]]
room-cli thread log CHILD_ID
room-cli thread tell THREAD_ID|--parent [--mode queue|steer|auto] [--request-id ID] TEXT|--message-file PATH
room-cli thread stop CHILD_ID
room-cli thread archive CHILD_ID...
Flags go in any order.";
const ABOUT: &str = "Shows, renames, pins, archives, moves, compacts or changes the effort of this cloud thread, or starts, checks, pins, compacts, stops and archives its child threads. `compact` waits for a running turn to end, then sends the --then message (by default, keep going). --top-level starts a top-level thread instead of a child, only when the user asks for one. `tell` prints a request_id: to send the same message again after an unclear answer, rerun the exact command with --request-id ID, and it is delivered once.";
/// `room-cli thread` commands only the app on the user's computer has.
const LOCAL_ONLY: [&str; 26] = [
    "count",
    "context",
    "open",
    "pane",
    "section",
    "search",
    "history",
    "read",
    "unread",
    "reorder-pinned",
    "queue",
    "tabs",
    "unarchive",
    "unpin",
    "delete",
    "edit-message",
    "retry",
    "clear",
    "cancel-plan",
    "clear-goal",
    "pause-goal",
    "resume-goal",
    "set-goal",
    "chat",
    "interactions",
    "worktree",
];
/// `thread read|unread` in a Cloud thread (#2242). The helper blocks the app's local API for plain commands below Full
/// access, so both Mac commands need `--write`, as in helper/jobs.rs.
fn mark_note(verb: &str) -> String {
    format!(
        "`room-cli thread {verb}` prints no messages: it only changes a thread's unread dot in the user's app. Run it only when the user asks: room-cli mac run --write '~/.local/bin/room-cli thread {verb} THREAD_ID'. To read a thread's messages: room-cli thread log CHILD_ID for your child threads, room-cli team read THREAD_ID for a teammate's, or room-cli mac run --write '~/.local/bin/room-cli thread log THREAD_ID' for another thread of the user's. With --write, Full Mac access runs it at once and Ask first asks the user; with Read-only, ask the user to run it on their Mac."
    )
}
/// `thread compact`'s follow-up unless `--then` or `--no-then`. The Local CLI sends the same.
const COMPACT_THEN: &str = "Keep going with your task. If it's done, say what we should do next.";
const SPAWN_NOTE: &str = "Started in this sandbox and folder. Keep working: Cloudroom sends you a message each time it finishes a turn.";
const STARTING_NOTE: &str = "Still starting: Cloudroom keeps starting it, and `thread archive --self` waits up to 75 s for it to start.";
const CANCELLED_NOTE: &str = "The children in cancelled_starts were still starting after 75 s. This archive stopped waiting, so they may not get their prompt.";
const OWN_NOTE: &str = "It runs in its own sandbox with a copy of your code (commits and uncommitted changes, without gitignored files or dependencies; nested Git repos arrive empty or without history), on its own branch. It doesn't see your later edits; share work through Git. Use this ID with tell, stop and archive. Keep working: Cloudroom sends you a message each time it finishes a turn.";
/// What `thread tell` answers once its message is steered, unconfirmed or queued: for a subagent, which reports back,
/// or for another thread, which doesn't (#177). The website words its own relayed tells the same.
const CHILD_NOTES: [&str; 3] = [
    "Sent into the child's running turn. Cloudroom tells you when that turn finishes.",
    "Could not confirm the child's running turn got it. Check room-cli thread show and thread output. Send it again only if the child is idle and its reply shows it never got the task.",
    "Queued. Cloudroom tells you when the child finishes it.",
];
const OTHER_NOTES: [&str; 3] = [
    "Sent into its running turn. It isn't your subagent, so Cloudroom won't tell you when it finishes.",
    "Could not confirm its running turn got it. It may have, so don't send it again: it could arrive twice.",
    "Queued. It isn't your subagent, so Cloudroom won't tell you when it finishes.",
];
/// A message sent again under its request ID (`tell --request-id`, or the website's own retry). `repeat` marks it,
/// so the website keeps this note (web/lib/mobile.ts).
const REPEAT_NOTE: &str =
    "Not sent again: this request ID's message was already taken. The state is that message's.";
const PAUSED_NOTE: &str = "Queued, paused by a Stop. It sends when that thread is resumed.";
const FORK_NOTE: &str = "Forked this thread at its last finished turn: a new thread with this conversation and your code (commits and uncommitted changes, without gitignored files or dependencies; nested Git repos arrive empty or without history), on its own branch where the project uses Git. It runs on its own and doesn't report back to you; it doesn't see your later edits.";
const TOP_NOTE: &str = "Started as a top-level thread in its own sandbox, from the project's Git repo (push your work first) and .env files. It is not your child: it doesn't report back, and you can't tell, stop or read it. It shows in the user's sidebar within a minute.";
/// How long `spawn --top-level` keeps retrying a start the website could not finish (say, a slow wake).
const LAUNCH_RETRY: Duration = Duration::from_secs(240);
/// How long a spawn waits for the website to name a child it starts in a sandbox of its own. It stays under Claude
/// Code's 2-minute command limit; the start goes on after that (relay.rs).
const SPAWN_WAIT: Duration = Duration::from_secs(75);
/// How long `thread spawn` waits for Core's answer: longer than any start Core answers itself (SPAWN_WAIT after the
/// website's 30 s), under Claude Code's 2-minute command limit. Then it says the start is uncertain (#1977).
const SPAWN_ANSWER: Duration = Duration::from_secs(110);
/// How long a fork waits for the app. It stays under Claude Code's 2-minute command limit, so the agent always
/// sees the outcome instead of a killed command it might retry. The app ignores older requests (AGENT_FORK_WAIT).
const FORK_WAIT: Duration = Duration::from_secs(90);
/// How long `thread wait` blocks before the agent must run it again. It stays under Claude Code's 2-minute command
/// limit, so the agent always sees the outcome instead of a killed command.
const CHILD_WAIT: Duration = Duration::from_secs(100);
/// How long a child request's outcome is remembered, so a retried spawn or a repeated app answer gets the same one.
const OUTCOME_KEPT: Duration = Duration::from_secs(3600);
/// Each fork request's outcome, by session and request ID. It is decided once, under this lock, so a late answer
/// never makes a fork the agent was told failed.
static CHILDREN: LazyLock<Mutex<HashMap<String, Outcome>>> = LazyLock::new(Mutex::default);

/// The calling session's children in sandboxes of their own whose start the website hasn't finished yet. `fresh`: only
/// those in their first 10 minutes, for which `tell`, `stop` and `output` still ask to retry (#1058).
pub(super) fn starting(m: &Manager, parent: &str, fresh: bool) -> Vec<String> {
    let local = m.local.lock().unwrap();
    let Some(session) = local.sessions.get(parent) else {
        return Vec::new();
    };
    let since = crate::observability::now_ms().saturating_sub(10 * 60_000);
    let recent = |child: &String| {
        let mut starts = session.child_starts.values();
        starts.any(|s| s.child.as_ref() == Some(child) && s.at_ms > since)
    };
    session
        .child_states
        .iter()
        .filter(|(child, state)| *state == "starting" && (!fresh || recent(child)))
        .map(|(child, _)| child.clone())
        .collect()
}

/// Why the website refused the calling session's start of `child` for good, while the parent knows nothing newer of it
/// and Core still keeps that start (#1058).
pub(super) fn start_error(m: &Manager, parent: &str, child: &str) -> Option<String> {
    let local = m.local.lock().unwrap();
    let session = local.sessions.get(parent)?;
    if session.child_states.get(child)? != "error" {
        return None;
    }
    let start = session
        .child_starts
        .values()
        .find(|s| s.child.as_deref() == Some(child));
    start?.error.clone()
}

enum Outcome {
    /// Waiting for the app: the fork's thread ID, or why it could not make it.
    Waiting(oneshot::Sender<Result<String, String>>),
    /// The app made the fork.
    Started(String, Instant),
    /// The app did not answer in time (or the agent gave up): a late fork is cancelled.
    Here(Instant),
}
pub(crate) type Failure = (StatusCode, Json<Value>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rename {
    title: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpawnBody {
    request_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    title: Option<String>,
    prompt: String,
    /// Run the child in this sandbox and folder instead of a sandbox of its own (ADR 0229).
    #[serde(default)]
    shared: bool,
    /// Start a top-level thread instead of a child (ADR 0267).
    #[serde(default)]
    top_level: bool,
    /// Pin the new thread in each Mac's sidebar once created (`room-cli thread spawn --pin`).
    #[serde(default)]
    pin: bool,
    service_tier: Option<String>,
}

/// `thread fork`: a Cloud fork of the calling thread, made by the app.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForkBody {
    request_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    title: Option<String>,
    prompt: String,
}

/// The app's answer to a child request: the child thread it started, or why it could not.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChildAnswer {
    thread: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Move {
    project: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Effort {
    reasoning: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Compact {
    /// The message sent once compaction ends; none with `--no-then`.
    #[serde(default)]
    then: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tell {
    text: String,
    /// `--mode queue`: wait for a running turn to end instead of joining it.
    #[serde(default)]
    mode: Option<String>,
    /// `--request-id`: the ID an earlier tell printed, so the same message sent again is delivered once.
    #[serde(default)]
    request_id: Option<String>,
}

fn valid(title: &str) -> bool {
    !title.is_empty() && title.chars().count() <= 200 && !title.chars().any(char::is_control)
}
/// The app answers child requests here.
pub fn routes() -> Router<Arc<Manager>> {
    Router::new().route("/v1/sessions/{id}/children/{request}", post(answer_child))
}

/// Served on the agent-only socket that `room-cli mac` also uses.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new()
        .route("/title", post(rename))
        .route("/reasoning", post(set_reasoning))
        .route("/pin", post(pin_self))
        .route("/archive", post(archive))
        .route("/move", post(move_project))
        .route("/children", get(list).post(spawn))
        .route("/working", get(working))
        .route("/fork", post(fork))
        .route("/children/{id}", get(output))
        .route("/children/{id}/messages", post(tell))
        .route("/children/{id}/stop", post(stop_child))
        .route("/children/{id}/pin", post(pin_child))
        .route("/children/{id}/archive", post(archive_child))
        .route("/compact", post(compact_self))
        .route("/children/{id}/compact", post(compact_child))
        .merge(super::info::agent_routes())
}

/// The session whose harness process sent this `cloudroom <command>` request.
pub(crate) fn caller(m: &Manager, peer: Peer, command: &str) -> Result<String, Failure> {
    agent(m, peer, command)?;
    peer.1
        .and_then(|pid| m.harness_session(&crate::secrets::ancestors(pid)))
        .ok_or(fail(
            StatusCode::CONFLICT,
            &format!("Run room-cli {command} from a Cloudroom cloud thread"),
        ))
}

/// Only the VM agent account, from a thread or not (say, its terminal).
pub(crate) fn agent(m: &Manager, peer: Peer, command: &str) -> Result<(), Failure> {
    if peer.0.is_none() || m.previews.agent().map(|(_, uid)| uid) != peer.0 {
        return Err(fail(
            StatusCode::FORBIDDEN,
            &format!("Only the VM agent account may run cloudroom {command}"),
        ));
    }
    Ok(())
}

pub(crate) fn fail(status: StatusCode, error: &str) -> Failure {
    (status, Json(json!({"error":error})))
}

pub(super) fn record(
    m: &Manager,
    session: &str,
    kind: &str,
    data: Value,
) -> Result<Json<Value>, Failure> {
    m.note(session, kind, data.clone()).map_err(|error| {
        fail(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!("Could not record the {kind}: {error}"),
        )
    })?;
    Ok(Json(data))
}

async fn rename(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Rename>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "thread")?;
    let title = input.title.trim();
    if !valid(title) {
        return Err(fail(
            StatusCode::CONFLICT,
            "Use a title of 1-200 characters",
        ));
    }
    // `wake`: the website drops a report from an earlier wake, so a late one never undoes a newer change (#237).
    record(
        &m,
        &session,
        "title",
        json!({"title":title,"wake":m.wake_id()}),
    )
}

/// The new effort applies from this session's next turn; the app shows it as the thread's effort.
async fn set_reasoning(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Effort>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "thread")?;
    m.check_prompt_reasoning(&session, Some(&input.reasoning))
        .await
        .map_err(session_failure)?;
    record(
        &m,
        &session,
        "reasoning",
        json!({"reasoning":input.reasoning,"wake":m.wake_id()}),
    )
}

/// Stable payload for a self-pin: `at` is stamped once so website retries never write a second timestamp.
fn pin_data(m: &Manager) -> Value {
    json!({"pinned": true, "at": crate::observability::now_ms(), "wake": m.wake_id()})
}

/// Pins this thread on the website so every Mac pins it once on sync, even if it was closed while this ran.
async fn pin_self(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "thread")?;
    record(&m, &session, "pin", pin_data(&m))
}

/// Pins a child thread (in its own sandbox through the website, or in this sandbox as a record), or this thread when
/// given its own `thr_...` or Core session ID.
async fn pin_child(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread pin")?;
    let own = id == parent
        || m.local
            .lock()
            .unwrap()
            .sessions
            .get(&parent)
            .is_some_and(|s| s.thread_id() == Some(id.as_str()));
    if own {
        return record(&m, &parent, "pin", pin_data(&m));
    }
    if relay::thread_id(&id) {
        return relay::pin(&m, &parent, &id).await;
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    record(&m, &id, "pin", json!({"pinned": true}))
}

/// The app archives the thread and its children, which also stops this session. Children it still starts get their
/// first prompt first, for up to SPAWN_WAIT; the archive cancels and names any still starting then (#2562).
async fn archive(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "thread")?;
    // Core never clears `archived`, so only an archive during the wait counts: a restored thread archives again.
    let archived = || (m.local.lock().unwrap().sessions.get(&session)).is_some_and(|s| s.archived);
    let before = archived();
    // No task of its own: an archive whose command was killed or stopped shouldn't land later, after the user moved on.
    let cancelled = relay::settle_starts(&m.local, &session, SPAWN_WAIT).await;
    // The user, the app or its parent archived it meanwhile: never a second, self archive on top.
    if !before && archived() {
        return Ok(Json(json!({"archived":true})));
    }
    let kept = archive_under(&m, &session)?;
    let mut data = json!({"archived":true,"kept_live":kept,"self":true,"wake":m.wake_id()});
    if !cancelled.is_empty() {
        data["cancelled_starts"] = json!(cancelled);
        data["note"] = json!(CANCELLED_NOTE);
    }
    record(&m, &session, "archive", data)
}

/// The app moves this thread to another project once its turn ends: a fresh session in that project's folder, in
/// this sandbox, with the conversation so far (ADR 0281). The old folder stays.
async fn move_project(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Move>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "thread")?;
    let project = input.project.trim();
    if !valid(project) {
        return Err(fail(
            StatusCode::CONFLICT,
            "Name a project by its ID or name",
        ));
    }
    let _ = record(&m, &session, "move", json!({"project":project}))?;
    Ok(Json(json!({
        "project": project,
        "note": "Cloudroom moves this thread when this turn ends. End your turn now; the next one runs in that project's folder.",
    })))
}

/// Stops and archives every thread under `id` now: the app archives them too, but never stops them,
/// and it may be offline. An archived thread is stopped again, in case it still runs. Children that still work
/// stay open, like the app's own archive (#603); returns their IDs.
pub(super) fn archive_under(m: &Arc<Manager>, id: &str) -> Result<Vec<String>, Failure> {
    let mut kept = Vec::new();
    for (child, archived, keep) in m.descendants(id) {
        // Core never clears `archived`, and the app may have restored the thread since: keep whatever still works.
        if keep {
            kept.push(child);
            continue;
        }
        retire(m, &child)?;
        if !archived {
            let _ = record(m, &child, "archive", json!({"id":child,"archived":true}))?;
        }
    }
    m.detach_kept(id, &kept).map_err(session_failure)?;
    Ok(kept)
}

/// Stops an archived thread's turn, and its agent exits once that turn settles. It frees its memory now, not after
/// 30 idle minutes (feedback #614). A later message still resumes it.
pub(super) fn retire(m: &Arc<Manager>, id: &str) -> Result<(), Failure> {
    for (command, input) in [("stop", json!({})), ("sleep", json!({"end_jobs":true}))] {
        let request =
            random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?;
        let _ = m.command(id, request, command, input);
    }
    Ok(())
}

pub(super) fn session_failure(error: super::Error) -> Failure {
    let status = match error {
        super::Error::NotFound => StatusCode::NOT_FOUND,
        super::Error::Conflict(_)
        | super::Error::Refused(_)
        | super::Error::NeverStarted(_)
        | super::Error::Effort(_) => StatusCode::CONFLICT,
        super::Error::Storage(_) => StatusCode::SERVICE_UNAVAILABLE,
    };
    fail(status, &error.message())
}

pub(super) fn random_key() -> io::Result<String> {
    let mut bytes = [0u8; 12];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The calling thread starts a child in its own sandbox; Core tells the parent when each child turn ends.
async fn spawn(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(mut input): Json<SpawnBody>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread spawn")?;
    let bad = |message: &str| fail(StatusCode::CONFLICT, message);
    let harness = check_start(
        &input.prompt,
        input.title.as_deref(),
        input.model.as_deref(),
        input.reasoning.as_deref(),
        input.provider.as_deref(),
    )?;
    // The website and the app read Core's name: `acp-cursor` goes on as `cursor`.
    input.provider = harness.and_then(|k| json!(k).as_str().map(str::to_owned));
    if input
        .service_tier
        .as_deref()
        .is_some_and(|t| t != "default" && t != "fast")
    {
        return Err(bad("Use --service-tier default or fast"));
    }
    pi_model(&m, &parent, harness, input.model.as_deref())?;
    let key = request_key(input.request_id.clone())?;
    if input.top_level {
        if input.shared {
            return Err(bad(
                "A top-level thread gets a sandbox of its own. Omit --shared-sandbox.",
            ));
        }
        return launch(&m, &parent, key, input).await;
    }
    if !input.shared {
        return own_child(&m, &parent, key, harness, input).await;
    }
    let spawn = super::Spawn {
        harness,
        model: input.model,
        reasoning: input.reasoning,
        title: input.title.map(|t| t.trim().to_owned()),
        prompt: input.prompt,
        service_tier: input.service_tier,
        pin: input.pin,
    };
    let (id, receipt) = m
        .spawn_child(&parent, &key, spawn)
        .await
        .map_err(session_failure)?;
    Ok(Json(
        json!({"id":id,"harness":receipt.input["harness"],"model":receipt.model,"note":SPAWN_NOTE}),
    ))
}

/// Asks the website to start a top-level thread (ADR 0267), so it works while the Mac is off. It runs as a task of
/// its own, so an agent that stops waiting never cuts a start in half, and a retry with the same request ID
/// continues the same start instead of making a second thread.
async fn launch(
    m: &Arc<Manager>,
    session: &str,
    key: String,
    input: SpawnBody,
) -> Result<Json<Value>, Failure> {
    let Some(api) = m.history.api.clone() else {
        return Err(fail(
            StatusCode::CONFLICT,
            "Run room-cli thread spawn --top-level from a Cloudroom cloud thread",
        ));
    };
    let mut body = json!({"request_id":key,"session":session,"prompt":input.prompt,"title":input.title,"harness":input.provider,"model":input.model,"reasoning":input.reasoning,"service_tier":input.service_tier});
    if input.pin {
        body["pin"] = json!(true);
    }
    let started = Instant::now();
    let task = tokio::spawn(async move {
        let mut wait = Duration::from_secs(10);
        loop {
            match api.post_waking("launch", &body).await {
                // The website's time ran out, or the new sandbox is still busy with the last try's wake.
                Err(super::history::ApiError::Network(_))
                | Err(super::history::ApiError::Status(500..=599, _))
                    if started.elapsed() < LAUNCH_RETRY => {}
                Err(super::history::ApiError::Status(409, message))
                    if message.starts_with("This sandbox is busy")
                        && started.elapsed() < LAUNCH_RETRY => {}
                other => return other,
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(60));
        }
    });
    match task.await {
        Ok(Ok(answer)) => Ok(Json(json!({"id":answer["id"],"note":TOP_NOTE}))),
        Ok(Err(super::history::ApiError::Status(status, message))) => Err(fail(
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            &message,
        )),
        Ok(Err(error)) => Err(fail(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!(
                "The top-level thread may not have started: {error}. Run the same command with --request-id {key}; it never starts twice."
            ),
        )),
        Err(error) => Err(fail(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())),
    }
}

/// Asks the website to start the child in a sandbox of its own with a copy of this thread's code (ADR
/// 20261104-015709), so it never needs the user's app. The request is saved first, and a worker (relay.rs) repeats it
/// until the child's first prompt is in, so a restart or a lost answer never loses or doubles it. This waits for the
/// child's thread ID.
async fn own_child(
    m: &Arc<Manager>,
    parent: &str,
    key: String,
    harness: Option<crate::runtime::Kind>,
    input: SpawnBody,
) -> Result<Json<Value>, Failure> {
    if m.history.api.is_none() {
        return Err(fail(
            StatusCode::CONFLICT,
            "Only Cloudroom cloud threads start children in sandboxes of their own. Add --shared-sandbox to start it here.",
        ));
    }
    let known = || {
        let local = m.local.lock().unwrap();
        local
            .sessions
            .get(parent)
            .and_then(|s| s.child_starts.get(&key).cloned())
    };
    let mut changed = m.subscribe();
    if known().is_none() {
        let title = input.title.as_ref().map(|t| t.trim().to_owned());
        // With no effort given, the website picks medium or the parent's level; a Claude model without effort gets
        // none, and a level its own row lacks is refused before the website starts a sandbox (#1059).
        let claude = match input.reasoning.as_deref() {
            Some("none") => None,
            _ => {
                m.child_claude_levels(parent, harness, input.model.as_deref())
                    .await
            }
        };
        let mut reasoning = input.reasoning.clone();
        if reasoning.is_none() && claude.as_ref().is_some_and(|(_, l)| *l == ["none"]) {
            reasoning = Some("none".into());
        }
        let refusal = super::children::claude_effort_refusal(claude.as_ref(), reasoning.as_deref());
        if let Some(error) = refusal {
            return Err(fail(StatusCode::CONFLICT, &error.message()));
        }
        let mut body = json!({"request_id":key,"session":parent,"prompt":input.prompt,"title":title,"harness":input.provider,"model":input.model,"reasoning":reasoning,"service_tier":input.service_tier});
        if input.pin {
            body["pin"] = json!(true);
        }
        let _ = record(
            m,
            parent,
            "child_start",
            json!({"request_id":key,"body":body}),
        )?;
    }
    // While this waits, a refusal comes back here; once it stops, the parent gets a notice instead (relay.rs).
    struct Waiting(String);
    impl Drop for Waiting {
        fn drop(&mut self) {
            relay::WAITING.lock().unwrap().remove(&self.0);
        }
    }
    let slot = format!("{parent}/{key}");
    relay::WAITING.lock().unwrap().insert(slot.clone());
    let _waiting = Waiting(slot.clone());
    // Under the lock the worker records a refusal with: this either answers with it, or has stopped waiting before
    // it lands, so the worker sends the notice instead. Never both, never neither.
    let settle = |done: bool| {
        let mut waiting = relay::WAITING.lock().unwrap();
        let start = known();
        let answer = match start.as_ref().and_then(|s| s.error.clone()) {
            Some(error) => Some(Err(fail(
                StatusCode::CONFLICT,
                &format!("The child could not be started: {error}"),
            ))),
            // Named but not started yet: the website still starts it (#2562).
            None => start.and_then(|s| {
                let note = match s.done {
                    true => OWN_NOTE.to_owned(),
                    false => format!("{STARTING_NOTE} {OWN_NOTE}"),
                };
                Some(Ok(Json(json!({"id":s.child?,"note":note}))))
            }),
        };
        if answer.is_some() || done {
            waiting.remove(&slot);
        }
        answer
    };
    let deadline = tokio::time::Instant::now() + SPAWN_WAIT;
    loop {
        if let Some(answer) = settle(false) {
            return answer;
        }
        if !matches!(
            tokio::time::timeout_at(deadline, changed.changed()).await,
            Ok(Ok(()))
        ) {
            if let Some(answer) = settle(true) {
                return answer;
            }
            // Why it waits, so a setup failing on every try isn't only "still starting" (#2643).
            let last = relay::last_try(&slot).map(|why| format!(" (last try: {why})"));
            let last = last.unwrap_or_default();
            return Err(fail(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!(
                    "The child is still starting{last}, and Cloudroom keeps starting it. Run the same command with --request-id {key} to get its ID; it never starts twice."
                ),
            ));
        }
    }
}

/// Only a Pi parent passes its own model on; Cloud's default Pi model may not work with the user's logins.
fn pi_model(
    m: &Manager,
    parent: &str,
    harness: Option<crate::runtime::Kind>,
    model: Option<&str>,
) -> Result<(), Failure> {
    let pi_parent = m
        .local
        .lock()
        .unwrap()
        .sessions
        .get(parent)
        .map(|p| p.harness)
        == Some(crate::runtime::Kind::Pi);
    if harness == Some(crate::runtime::Kind::Pi)
        && !pi_parent
        && !model
            .and_then(|m| m.split_once('/'))
            .is_some_and(|(p, n)| !p.is_empty() && !n.is_empty())
    {
        return Err(fail(
            StatusCode::CONFLICT,
            "Select a Pi provider and model: add --model provider/model, for example anthropic/claude-haiku-5-5",
        ));
    }
    Ok(())
}

/// A spawn's or fork's checks; for a provider, its harness.
fn check_start(
    prompt: &str,
    title: Option<&str>,
    model: Option<&str>,
    reasoning: Option<&str>,
    provider: Option<&str>,
) -> Result<Option<crate::runtime::Kind>, Failure> {
    let bad = |message: &str| fail(StatusCode::CONFLICT, message);
    if prompt.trim().is_empty() || prompt.len() > super::MAX_PROMPT {
        return Err(bad("Use a prompt of 1-262144 bytes"));
    }
    if title.is_some_and(|t| !valid(t.trim())) {
        return Err(bad("Use a title of 1-200 characters"));
    }
    if model.is_some_and(|m| m.is_empty() || m.len() > 256 || m.chars().any(char::is_control)) {
        return Err(bad("invalid model"));
    }
    if reasoning
        .is_some_and(|r| r.is_empty() || r.len() > 64 || !r.bytes().all(|b| b.is_ascii_lowercase()))
    {
        return Err(bad("invalid reasoning level"));
    }
    provider
        .map(|p| {
            crate::runtime::Kind::named(p).ok_or_else(|| {
                bad("Use --provider codex, claude-code, cursor, pi, opencode, hermes, devin, droid, kimi, antigravity, fx, openclaw or agent-zero")
            })
        })
        .transpose()
}

fn request_key(key: Option<String>) -> Result<String, Failure> {
    let key = match key {
        Some(key) => key,
        None => random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?,
    };
    if key.is_empty()
        || key.len() > 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(fail(
            StatusCode::CONFLICT,
            "request_id must be 1-64 ASCII letters, digits, underscores or hyphens",
        ));
    }
    Ok(key)
}

enum Asked {
    Started(String),
    Refused(String),
    /// No answer: the app is closed or too old.
    Missed,
}

/// Records a request for the app (`data.id` names it) and waits for its answer: a child to start in a sandbox of
/// its own, or a fork. A late start after a miss is cancelled.
async fn ask_app(
    m: &Manager,
    parent: &str,
    kind: &str,
    data: Value,
    wait: Duration,
) -> Result<Asked, Failure> {
    let slot = format!("{parent}/{}", data["id"].as_str().unwrap_or_default());
    let (reply, answer) = oneshot::channel();
    {
        let mut children = CHILDREN.lock().unwrap();
        children.retain(|_, outcome| match outcome {
            Outcome::Started(_, at) | Outcome::Here(at) => at.elapsed() < OUTCOME_KEPT,
            Outcome::Waiting(_) => true,
        });
        match children.get(&slot) {
            Some(Outcome::Started(thread, _)) => return Ok(Asked::Started(thread.clone())),
            Some(Outcome::Here(_)) => return Ok(Asked::Missed),
            Some(Outcome::Waiting(_)) => {
                return Err(fail(
                    StatusCode::CONFLICT,
                    "A request with this request_id is already starting",
                ));
            }
            None => {}
        }
        children.insert(slot.clone(), Outcome::Waiting(reply));
    }
    // If the agent stops waiting before the app answers, nothing starts and a late start is cancelled.
    struct Pending(String);
    impl Drop for Pending {
        fn drop(&mut self) {
            let mut children = CHILDREN.lock().unwrap();
            if let Some(outcome @ Outcome::Waiting(_)) = children.get_mut(&self.0) {
                *outcome = Outcome::Here(Instant::now());
            }
        }
    }
    let _pending = Pending(slot.clone());
    let _ = record(m, parent, kind, data)?;
    let answer = tokio::time::timeout(wait, answer).await;
    match answer {
        Ok(Ok(Ok(thread))) => Ok(Asked::Started(thread)),
        Ok(Ok(Err(error))) => Ok(Asked::Refused(error)),
        // No answer in time: decide under the lock, since the app may be answering right now.
        _ => {
            let mut children = CHILDREN.lock().unwrap();
            match children.get_mut(&slot) {
                Some(Outcome::Started(thread, _)) => Ok(Asked::Started(thread.clone())),
                Some(outcome) => {
                    *outcome = Outcome::Here(Instant::now());
                    Ok(Asked::Missed)
                }
                None => Ok(Asked::Missed),
            }
        }
    }
}

/// `thread fork`: the app forks the calling thread at its last finished turn into a new Cloud thread, optionally into
/// another harness. Only the app can make it, so without an answer there is no fork.
async fn fork(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(mut input): Json<ForkBody>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread fork")?;
    let harness = check_start(
        &input.prompt,
        input.title.as_deref(),
        input.model.as_deref(),
        input.reasoning.as_deref(),
        input.provider.as_deref(),
    )?;
    // The website and the app read Core's name: `acp-cursor` goes on as `cursor`.
    input.provider = harness.and_then(|k| json!(k).as_str().map(str::to_owned));
    pi_model(&m, &parent, harness, input.model.as_deref())?;
    let key = request_key(input.request_id)?;
    let mut data = json!({"id":format!("fork_{key}"),"prompt":input.prompt});
    for (name, value) in [
        ("provider", input.provider),
        ("model", input.model),
        ("reasoning", input.reasoning),
        ("title", input.title.map(|t| t.trim().to_owned())),
    ] {
        if let Some(value) = value {
            data[name] = json!(value);
        }
    }
    match ask_app(&m, &parent, "fork_request", data, FORK_WAIT).await? {
        Asked::Started(thread) => Ok(Json(json!({"id":thread,"note":FORK_NOTE}))),
        Asked::Refused(error) => Err(fail(
            StatusCode::CONFLICT,
            &format!("The fork could not start: {error}"),
        )),
        Asked::Missed => Err(fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "The user's Cloudroom app didn't answer, so no fork was made. Forks need the app open on their Mac; try again later.",
        )),
    }
}

/// The app started the requested child, or says why it could not. A request that already ended the other way
/// (the child runs in the parent's sandbox) or is unknown is refused, so the app cancels its child.
async fn answer_child(
    Path((session, id)): Path<(String, String)>,
    Json(input): Json<ChildAnswer>,
) -> Result<(StatusCode, Json<Value>), Failure> {
    let accepted = Ok((StatusCode::ACCEPTED, Json(json!({"accepted":true}))));
    let slot = format!("{session}/{id}");
    let mut children = CHILDREN.lock().unwrap();
    match children.remove(&slot) {
        None => Err(fail(
            StatusCode::NOT_FOUND,
            "Unknown or expired child request",
        )),
        Some(Outcome::Waiting(reply)) => {
            let result = match input.thread {
                Some(thread) => {
                    children.insert(slot, Outcome::Started(thread.clone(), Instant::now()));
                    Ok(thread)
                }
                None => Err(input.error.unwrap_or_else(|| "unknown error".into())),
            };
            let _ = reply.send(result);
            accepted
        }
        Some(outcome) => {
            // The same answer again (say, after a lost response) is fine; anything else lost the race.
            let same = matches!((&outcome, &input.thread), (Outcome::Started(started, _), Some(thread)) if started == thread);
            children.insert(slot, outcome);
            if same {
                accepted
            } else {
                Err(fail(
                    StatusCode::CONFLICT,
                    "This request already ended another way (Core gave up waiting, or another answer came first)",
                ))
            }
        }
    }
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    include_archived: bool,
}

async fn list(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread list")?;
    let mut answer = m.children(&parent, None, query.include_archived).await;
    // The list is for these children: it waits for the website's own 30-second limit.
    let wait = Duration::MAX;
    relay::own_children(&m, &parent, query.include_archived, &mut answer, wait).await;
    Ok(Json(answer))
}

/// `thread wait`: the caller's open children still at work, from what this Core already knows, so each check costs
/// the website nothing. A child in a sandbox of its own counts from its start or a `tell` until its next turn report.
async fn working(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread wait")?;
    let here = m.children(&parent, None, false).await;
    let here = here["children"].as_array().into_iter().flatten();
    let mut working: Vec<String> = here
        .filter(|child| child["busy"] == true)
        .filter_map(|child| Some(child["id"].as_str()?.to_owned()))
        .collect();
    let local = m.local.lock().unwrap();
    let own = local.sessions.get(&parent).map(|s| s.child_states.iter());
    working.extend(
        own.into_iter()
            .flatten()
            .filter(|(_, state)| matches!(state.as_str(), "starting" | "running"))
            .map(|(child, _)| child.clone()),
    );
    Ok(Json(json!({"working":working})))
}

/// Marks the children `thread wait` saw at work with `"waited": true` and returns how many. Nothing is left out.
fn mark_waited(answer: &mut Value, waited: &[String]) -> usize {
    let list = answer["children"].as_array_mut().into_iter().flatten();
    let mut marked = 0;
    for child in list.filter(|c| {
        c["id"]
            .as_str()
            .is_some_and(|id| waited.iter().any(|w| w == id))
    }) {
        child["waited"] = json!(true);
        marked += 1;
    }
    marked
}

#[derive(Deserialize)]
struct OutputQuery {
    #[serde(default)]
    all: bool,
    /// The rest of one tool input `--all` clipped, from `offset` (#2582).
    input: Option<String>,
    offset: Option<u64>,
}

async fn output(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread output")?;
    if id.starts_with("thr_") {
        // A child in its own sandbox: its saved chat, through the website, which checks this thread started it (ADR 0256).
        let Some(api) = &m.history.api else {
            return Ok(Json(
                json!({"id":id,"note":"This child runs in its own sandbox. Its replies arrive as messages when its turns end."}),
            ));
        };
        // The rest of one clipped tool input: the website's answer as is, a 404 included (#2582).
        if let Some(at) = &query.input {
            let offset = query.offset.unwrap_or(0).to_string();
            let ask = [("thread", id.as_str()), ("input", at), ("offset", &offset)];
            return (api.get("chat", &ask).await.map(Json))
                .map_err(|error| website_failure(error, "read the child's tool input"));
        }
        let all = if query.all { "1" } else { "0" };
        let failed = start_error(&m, &parent, &id);
        return match api.get("chat", &[("thread", &id), ("all", all)]).await {
            // The website may not know a child that just started yet, or has no chat of it yet (#317).
            Err(super::history::ApiError::Status(404, _))
                if starting(&m, &parent, true).contains(&id) =>
            {
                let why = relay::waiting_start(&m, &parent, &id).map(|why| format!("{why} "));
                let why = why.unwrap_or_default();
                let note = format!(
                    "Its sandbox is still starting. {why}Its replies arrive as messages when its turns end."
                );
                Ok(json!({"id":id,"state":"starting","note":note}))
            }
            // Its start was refused: no chat, or only what came before. The same story as `thread list` (#1058).
            Err(super::history::ApiError::Status(404, _)) if failed.is_some() => {
                Ok(json!({"id":id}))
            }
            answer => answer,
        }
        .map(|mut answer| {
            // A chat with a reply or an agent at work started after all: never call it failed (#1058).
            let ran = answer["reply"].is_string()
                || matches!(
                    answer["state"].as_str(),
                    Some("starting" | "starting_turn" | "running" | "resuming")
                );
            if let Some(error) = failed.filter(|_| answer.is_object() && !ran) {
                answer["state"] = json!("error");
                answer["issue"] = json!(error);
                answer["note"] = json!(format!("It could not be started. To clean it up: room-cli thread archive {id}"));
            }
            Json(answer)
        })
        .map_err(|error| website_failure(error, "read the child's chat"));
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    let mut answer = m.children(&parent, Some(&id), true).await["children"][0].clone();
    // Core keeps only the latest reply of a child in this sandbox, so `thread log` and `--all` say so.
    if query.all && answer.is_object() {
        answer["note"] =
            json!("A child in this sandbox keeps only its latest reply, not its whole chat.");
    }
    Ok(Json(answer))
}

async fn tell(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
    Json(input): Json<Tell>,
) -> Result<Json<Value>, Failure> {
    let sender = caller(&m, peer, "thread tell")?;
    if input.text.trim().is_empty() || input.text.len() > super::MAX_PROMPT {
        return Err(fail(
            StatusCode::CONFLICT,
            "Use a message of 1-262144 bytes",
        ));
    }
    let key = tell_key(input.request_id)?;
    let to_parent = id == "parent";
    let queue = input.mode.as_deref() == Some("queue");
    let id = if to_parent {
        // `thread tell --parent`: the thread that started this one, in this sandbox or another. A sandbox's thread
        // that started without one (the user moved it, or its start left it out) asks the website for its saved
        // parent (#994).
        let local = m.local.lock().unwrap();
        let session = local.sessions.get(&sender);
        let up = session.and_then(|s| {
            s.parent_session
                .clone()
                .or_else(|| s.parent_thread().map(str::to_owned))
        });
        match up {
            Some(up) => up,
            None if session.is_some() && m.history.api.is_some() => id,
            None => return Err(fail(StatusCode::CONFLICT, NO_PARENT)),
        }
    } else {
        super::children::local_parent(&m.local.lock().unwrap(), &sender, &id).unwrap_or(id)
    };
    if relay::thread_id(&id) || id == "parent" {
        let text = Some(input.text.as_str());
        let relayed = format!("{key}{}", if queue { relay::QUEUE } else { "" });
        return relay::command(&m, &sender, &id, "tell", text, to_parent, Some(&relayed))
            .await
            .map_err(|failure| resend(failure, &key));
    }
    let under = m.tell_target(&sender, &id).map_err(session_failure)?;
    let text = if under {
        input.text
    } else {
        from_thread(&sender, &input.text)
    };
    let mut prompt = json!({"text":text});
    // A message from a thread above it always gets the child's report, even one that repeats its last (#1395).
    if under {
        prompt["from_parent"] = json!(true);
    }
    let request = format!("tell_{key}");
    if under {
        revive(&m, &id, &request, Some(&sender));
    }
    let told = if to_parent {
        "your parent thread"
    } else {
        "that thread"
    };
    let mut answer = (deliver(&m, &id, &request, prompt, under, Some(&sender), queue).await)
        .map_err(|failure| resend(not_running(failure, told), &key))?;
    answer["request_id"] = json!(key);
    Ok(answer)
}

/// A tell's request ID: the sender's (`--request-id`, one an earlier tell printed) or a new one. Short and without
/// underscores: the relay adds its own `relay_`, `_queue` and `_steer` to it, within the 58 bytes a Core takes.
fn tell_key(key: Option<String>) -> Result<String, Failure> {
    let key = match key {
        Some(key) => key,
        None => random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?,
    };
    if key.is_empty()
        || key.len() > 40
        || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(fail(
            StatusCode::CONFLICT,
            "--request-id takes the request_id an earlier tell printed: 1-40 letters, digits or hyphens",
        ));
    }
    Ok(key)
}

/// A tell that failed where it may still arrive, or may go through later (a 429 or 5xx), says how to send it again
/// without a second copy (F#6799, F#5502). A refusal stays as it is, so nobody retries it in vain.
fn resend((status, Json(mut body)): Failure, key: &str) -> Failure {
    let unsure = status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS;
    if let Some(error) = body["error"].as_str().filter(|_| unsure) {
        body["error"] = json!(format!(
            "{error} To send it again safely, rerun this exact command with --request-id {key}: a message with the same ID is delivered once."
        ));
    }
    (status, Json(body))
}

/// A tell to a thread here whose agent isn't running (lost, say, in a Core restart, and not started again) says so,
/// as a tell through the website does (web/lib/mobile.ts), instead of Core's internal refusal (#2565).
fn not_running(failure: Failure, told: &str) -> Failure {
    if failure.1.0["error"] != super::GONE {
        return failure;
    }
    let error = format!(
        "Not delivered: {told}'s agent isn't running, so it can't take messages, and sending it again won't help. \
         Say what it needed in your reply here instead; the user sees it."
    );
    fail(StatusCode::CONFLICT, &error)
}

/// A tell from a thread that started this one first restarts its lost agent (a crash after its one automatic
/// recovery) from its saved chat, as the app's message does (#154, #1629), or starts again one whose start failed
/// before it existed (#2036). Never one stopped (its queue paused) or archived, and never for a tell already steered
/// or queued. `resume` checks that no agent runs, the chat is intact or none was started, and, with `sender`, the
/// tell's own ancestry, in the step that accepts it; a refusal leaves the tell refused as before.
pub(super) fn revive(m: &Arc<Manager>, id: &str, request: &str, sender: Option<&str>) {
    let local = m.local.lock().unwrap();
    let lost = (local.sessions.get(id)).is_some_and(|s| {
        (s.state == SessionState::ProcessLost || s.failed_start().is_some())
            && !s.archived
            && !s.queue_paused
    });
    drop(local);
    let sent = [request.to_owned(), format!("{request}_steer")]
        .iter()
        .any(|r| m.receipt(id, r).is_some());
    if lost && !sent {
        let wake = format!("{request}_wake");
        let _ = m.command_from(id, wake, "resume", json!({}), false, sender);
    }
}

pub(super) const NO_PARENT: &str = "This thread has no parent that `thread tell --parent` can reach. If another thread started it, Cloudroom passes it your reply when this turn ends.";

/// A message to a thread that isn't the sender's subagent says who sent it, as in Local threads, where the app shows
/// it as an agent's message.
fn from_thread(sender: &str, text: &str) -> String {
    format!("[message from thread:{sender}]\n\n{text}")
}

/// Sends a message (`input`, a prompt's) into the session's running turn, or else queues it; `queue` (`tell --mode
/// queue`) always queues it. A request already delivered stays as it is, so a retried relay never sends it twice.
pub(super) async fn deliver(
    m: &Arc<Manager>,
    id: &str,
    request: &str,
    mut input: Value,
    child: bool,
    sender: Option<&str>,
    queue: bool,
) -> Result<Json<Value>, Failure> {
    let notes = if child { CHILD_NOTES } else { OTHER_NOTES };
    let steer_id = format!("{request}_steer");
    if let Some(done) = m.receipt(id, request) {
        return Ok(Json(
            json!({"id":id,"state":done.state,"note":REPEAT_NOTE,"repeat":true}),
        ));
    }
    // A steer that failed falls back to the queue, even on a retry.
    let steered = match m.receipt(id, &steer_id) {
        Some(s) if s.state != "failed" => {
            return Ok(Json(
                json!({"id":id,"state":s.state,"note":REPEAT_NOTE,"repeat":true}),
            ));
        }
        Some(_) => None,
        None if queue => None,
        None => steer(m, id, &steer_id, input.clone(), sender).await,
    };
    match steered.as_deref() {
        Some("completed") => {
            return Ok(Json(json!({"id":id,"state":"steered","note":notes[0]})));
        }
        Some(state) => {
            return Ok(Json(json!({"id":id,"state":state,"note":notes[1]})));
        }
        None => {}
    }
    // When it was sent, so a turn it waits long for says so (prompt::with_sent_time).
    input["sent"] = json!(crate::observability::now_ms());
    let receipt = m
        .command_from(id, request.to_owned(), "prompt", input, true, sender)
        .map_err(|error| never_started(m, id, error))?;
    let local = m.local.lock().unwrap();
    if local.sessions.get(id).is_some_and(|s| s.queue_paused) {
        return Ok(Json(
            json!({"id":id,"state":receipt.state,"note":PAUSED_NOTE,"paused":true}),
        ));
    }
    Ok(Json(json!({"id":id,"state":receipt.state,"note":notes[2]})))
}

/// A tell refused because its agent never started (a stopped or archived one isn't started again) says why, with its
/// own code: the website otherwise calls Core's refusals busy, and its sender retries in vain (#2036).
fn never_started(m: &Manager, id: &str, error: super::Error) -> Failure {
    match (&error, m.failed_start_reason(id)) {
        (super::Error::Conflict(super::GONE), Some(why)) => {
            let error = format!("its agent never started: {why}");
            (
                StatusCode::CONFLICT,
                Json(json!({"error":error,"code":"never_started"})),
            )
        }
        _ => session_failure(error),
    }
}

/// A website call failed: its own refusal as is, or why it could not be reached.
pub(super) fn website_failure(error: super::history::ApiError, what: &str) -> Failure {
    match error {
        super::history::ApiError::Status(status, message) => fail(
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            &message,
        ),
        error => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!("Could not {what}: {error}. Retry."),
        ),
    }
}

/// Sends a busy child the message in its running turn, as in Local threads, so it never waits
/// behind older messages. None means it was not delivered, so it can safely queue instead.
async fn steer(
    m: &Arc<Manager>,
    id: &str,
    request: &str,
    mut input: Value,
    sender: Option<&str>,
) -> Option<String> {
    let target = m
        .local
        .lock()
        .unwrap()
        .sessions
        .get(id)?
        .current_request
        .clone()?;
    let mut changed = m.subscribe();
    input["target_request_id"] = json!(target);
    m.command_from(id, request.to_owned(), "steer", input, false, sender)
        .ok()?;
    let settled = async {
        loop {
            let state = m.receipt(id, request).map(|r| r.state).unwrap_or_default();
            if state != "accepted" || changed.changed().await.is_err() {
                return state;
            }
        }
    };
    let state = tokio::time::timeout(Duration::from_secs(10), settled)
        .await
        .unwrap_or_else(|_| "accepted".into());
    (state != "failed").then_some(state)
}

/// Stops the child's running turn and pauses its queue, like the app's stop button. Then its agent, unless Codex
/// (#605), exits with everything it started (#607); its next message resumes it.
async fn stop_child(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread stop")?;
    if relay::thread_id(&id) {
        return relay::command(&m, &parent, &id, "stop", None, false, None).await;
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    let key = || random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()));
    let receipt = m
        .command(&id, key()?, "stop", json!({}))
        .map_err(session_failure)?;
    if m.stop_sleeps(&id) {
        let _ = m.command(&id, key()?, "sleep", json!({"end_jobs":true}));
    }
    Ok(Json(json!({"id":id,"state":receipt.state})))
}

/// Stops the child and every thread under it now; the app archives them whenever it next reads the thread.
async fn archive_child(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread archive")?;
    if relay::thread_id(&id) {
        return relay::command(&m, &parent, &id, "archive", None, false, None).await;
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    // A child that already ended has nothing to stop. Stop it first, so it starts no new children.
    retire(&m, &id)?;
    let kept = archive_under(&m, &id)?;
    record(
        &m,
        &id,
        "archive",
        json!({"id":id,"archived":true,"kept_live":kept}),
    )
}

/// `room-cli thread compact --self`: compacts this thread once its turn ends, then sends `then`.
async fn compact_self(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Compact>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "thread compact")?;
    compact(&m, &session, input.then.as_deref())
}

/// `room-cli thread compact CHILD_ID`: a child in its own sandbox goes through the website, like `thread stop`.
async fn compact_child(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
    Json(input): Json<Compact>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread compact")?;
    if relay::thread_id(&id) {
        return relay::compact(&m, &parent, &id, input.then.as_deref()).await;
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    compact(&m, &id, input.then.as_deref())
}

fn compact(m: &Arc<Manager>, id: &str, then: Option<&str>) -> Result<Json<Value>, Failure> {
    if then.is_some_and(|text| text.len() > super::MAX_PROMPT) {
        return Err(fail(
            StatusCode::CONFLICT,
            "Use a --then message of up to 262144 bytes",
        ));
    }
    let request =
        random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?;
    let receipt = m.compact_then(id, request, then).map_err(session_failure)?;
    Ok(Json(
        json!({"id":id,"state":receipt.state,"note":compact_note(&receipt)}),
    ))
}

/// What `thread compact` tells the agent, here and through the relay.
pub(super) fn compact_note(receipt: &super::Receipt) -> String {
    let when = if receipt.input["waiting"] == true {
        "Compacts once the agent is free (its running turn ends, or it wakes). If this is your own thread, end your turn now."
    } else {
        "Compacting now."
    };
    let then = if receipt.input["then"].is_string() {
        " Then it gets the --then message, saying whether compaction worked."
    } else {
        ""
    };
    format!("{when}{then}")
}

/// Flag value after `name`, for `room-cli thread spawn`.
fn flag<'a>(words: &[&'a str], name: &str) -> Option<&'a str> {
    words
        .iter()
        .position(|w| *w == name)
        .and_then(|i| words.get(i + 1).copied())
}

/// Flags `room-cli thread spawn` takes with a value. `--project` (this thread's own, from the agent instructions)
/// and `--base-branch` (a Local habit: children copy this thread's code) are accepted and ignored.
const SPAWN_VALUES: [&str; 12] = [
    "--provider",
    "--model",
    "--reasoning-level",
    "--service-tier",
    "--title",
    "--request-id",
    "--prompt",
    "--prompt-file",
    "--machine",
    "--host",
    "--project",
    "--base-branch",
];

/// Flags `room-cli thread fork` takes with a value.
const FORK_VALUES: [&str; 8] = [
    "--machine",
    "--provider",
    "--model",
    "--reasoning-level",
    "--title",
    "--request-id",
    "--prompt",
    "--prompt-file",
];

/// A flag that needs a value and has none, or has another option right after it: `--title --self`.
fn missing_value<'a>(words: &[&'a str]) -> Option<&'a str> {
    let option = |word: &str| word.starts_with("--") && !word.contains(' ');
    let takes_value = |word: &str| {
        SPAWN_VALUES.contains(&word)
            || matches!(
                word,
                "--message-file" | "--mode" | "--then" | "--input" | "--offset"
            )
    };
    (0..words.len())
        .find(|&i| takes_value(words[i]) && words.get(i + 1).is_none_or(|next| option(next)))
        .map(|i| words[i])
}

/// `thread show` of a child this thread last heard failed, while its saved chat says it is at work (#2047). Nothing
/// orders that chat after the failure: it may be newer work, or the failed turn not saved yet. So the failure stays
/// as reported, and the item only adds what the chat says.
fn resumed(child: &mut Value, chat: &Value) {
    if let Some(state @ ("starting_turn" | "running" | "resuming")) = chat["state"].as_str() {
        child["chatState"] = json!(state);
        child["note"] = json!(format!(
            "Its saved chat says {state}: it may be at work again after this failure, or the failed turn isn't saved yet. Its next turn report settles it."
        ));
    }
}

/// A Core session ID: `cr_` and up to 80 ASCII letters, digits, underscores or hyphens, as the app checks them.
fn session_id(id: &str) -> bool {
    id.strip_prefix("cr_").is_some_and(|key| {
        !key.is_empty()
            && key.len() <= 80
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    })
}

/// A thread ID without the `@thread:` prefix agents write in chat. The Local CLI accepts both too.
fn mention(word: &str) -> &str {
    let id = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    match word.strip_prefix("@thread:") {
        Some(rest)
            if (rest.starts_with("thr_") || rest.starts_with("cr_")) && rest.bytes().all(id) =>
        {
            rest
        }
        _ => word,
    }
}

/// The first word a command would otherwise ignore, so nothing the agent asked for is silently dropped.
fn unknown_word<'a>(words: &[&'a str], values: &[&str], switches: &[&str]) -> Option<&'a str> {
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        if values.contains(word) {
            rest.next();
        } else if !switches.contains(word) {
            return Some(word);
        }
    }
    None
}

async fn spawn_cli(words: &[&str]) -> io::Result<i32> {
    if let Some(word) = unknown_word(
        words,
        &SPAWN_VALUES,
        &["--shared-sandbox", "--parent-self", "--top-level", "--pin"],
    ) {
        eprintln!(
            "Unknown option {word}. Cloud threads take only the options in `room-cli thread --help`."
        );
        return Ok(2);
    }
    // A child starts in this thread's project. Another project's ID would be silently ignored, so it is refused.
    let own = std::env::var("ROOM_PROJECT_ID").unwrap_or_default();
    if flag(words, "--project").is_some_and(|p| !p.is_empty() && p != own) {
        eprintln!("Cloud children start in this thread's project. Omit --project.");
        return Ok(2);
    }
    // A child gets a sandbox of its own unless --shared-sandbox (ADR 0229); `--machine cloud` is a harmless Local habit.
    if flag(words, "--machine")
        .or(flag(words, "--host"))
        .is_some_and(|m| m != "cloud")
    {
        eprintln!(
            "Cloud threads start cloud children only. Omit --machine; add --shared-sandbox to share this sandbox."
        );
        return Ok(2);
    }
    let prompt = match (flag(words, "--prompt"), flag(words, "--prompt-file")) {
        (Some(text), None) => text.to_owned(),
        (None, Some(path)) => std::fs::read_to_string(path)?,
        _ => {
            println!("{USAGE}");
            return Ok(2);
        }
    };
    let top = words.contains(&"--top-level");
    if top && words.contains(&"--parent-self") {
        eprintln!("A top-level thread has no parent. Omit --parent-self.");
        return Ok(2);
    }
    let mut body = json!({
        "prompt": prompt,
        "shared": words.contains(&"--shared-sandbox"),
        "top_level": top,
        "pin": words.contains(&"--pin"),
    });
    // A top-level start or a child in a sandbox of its own can outlast the agent's command timeout, so its request ID
    // comes first: rerunning the command with it continues that start instead of making a second thread (#1668).
    if let Some(key) = first_key(words)? {
        let what = if top {
            "a top-level thread"
        } else {
            "a child in a sandbox of its own"
        };
        eprintln!(
            "Starting {what}. If this command times out or prints no ID, rerun it with --request-id {key}; it never starts twice."
        );
        body["request_id"] = json!(key);
    }
    for (name, key) in [
        ("--provider", "provider"),
        ("--model", "model"),
        ("--reasoning-level", "reasoning"),
        ("--service-tier", "service_tier"),
        ("--title", "title"),
        ("--request-id", "request_id"),
    ] {
        if let Some(value) = flag(words, name) {
            body[key] = json!(value);
        }
    }
    // Every start has its ID, so one Core answers too late for can be checked and continued, never doubled (#1977).
    if body["request_id"].is_null() {
        body["request_id"] = json!(random_key()?);
    }
    let key = body["request_id"].as_str().unwrap_or_default().to_owned();
    let limit = Some(SPAWN_ANSWER);
    let answer = crate::mac::request_within(crate::mac::SOCKET, "POST", "/children", Some(body), limit)
        .await
        .map_err(|error| match error.kind() {
            io::ErrorKind::TimedOut => io::Error::other(format!(
                "{error} The thread may have started: rerun this exact command with --request-id {key} to get its ID; it never starts twice."
            )),
            _ => error,
        })?;
    println!("{answer}");
    Ok(0)
}

/// The request ID a spawn shows before it starts, unless the agent gave one or it shares this sandbox (a quick start).
fn first_key(words: &[&str]) -> io::Result<Option<String>> {
    if words.contains(&"--shared-sandbox") || flag(words, "--request-id").is_some() {
        return Ok(None);
    }
    random_key().map(Some)
}

async fn fork_cli(words: &[&str]) -> io::Result<i32> {
    // Only this thread can be forked from here, so a thread ID other than `--self` is refused rather than ignored,
    // like any option the command doesn't take.
    if let Some(word) = unknown_word(words, &FORK_VALUES, &["--self"]) {
        if word.starts_with('-') {
            eprintln!(
                "Unknown option {word}. Cloud threads take only the options in `room-cli thread --help`."
            );
        } else {
            eprintln!(
                "A Cloud thread can fork only itself; {word} is not needed. Omit it (or use --self)."
            );
        }
        return Ok(2);
    }
    // Agents fork only to Cloud (David, 2026-10-19); `--machine cloud` is a harmless Local habit.
    if flag(words, "--machine").is_some_and(|m| m != "cloud") {
        eprintln!(
            "Cloud agents fork only to Cloud. Omit --machine; only the user can fork to their Mac, from the Cloudroom app."
        );
        return Ok(2);
    }
    let prompt = match (flag(words, "--prompt"), flag(words, "--prompt-file")) {
        (Some(text), None) => text.to_owned(),
        (None, Some(path)) => std::fs::read_to_string(path)?,
        _ => {
            println!("{USAGE}");
            return Ok(2);
        }
    };
    let mut body = json!({"prompt":prompt});
    for (name, key) in [
        ("--provider", "provider"),
        ("--model", "model"),
        ("--reasoning-level", "reasoning"),
        ("--title", "title"),
        ("--request-id", "request_id"),
    ] {
        if let Some(value) = flag(words, name) {
            body[key] = json!(value);
        }
    }
    let answer = crate::mac::request(crate::mac::SOCKET, "POST", "/fork", Some(body)).await?;
    println!("{answer}");
    Ok(0)
}

/// A command's plain words, in order, with its flags taken out: flags go in any order, as in Local threads
/// (ADR 20261110-235800). Err: an option the command doesn't take, so nothing the agent asked for is silently
/// dropped. Text with a space in it is never an option.
fn plain<'a>(
    words: &[&'a str],
    values: &[&str],
    switches: &[&str],
) -> Result<Vec<&'a str>, &'a str> {
    let mut plain = Vec::new();
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        if values.contains(word) {
            rest.next();
        } else if word.starts_with("--") && !word.contains(' ') {
            if !switches.contains(word) {
                return Err(word);
            }
        } else {
            plain.push(*word);
        }
    }
    Ok(plain)
}

async fn call(method: &str, path: &str, body: Option<Value>) -> io::Result<Value> {
    // Reads never hang on a stalled Core (#1977); changes keep waiting for Core's own limits.
    let limit = match (method, path) {
        ("GET", "/thread" | "/working") => Some(crate::mac::QUICK),
        ("GET", _) => Some(crate::mac::READ),
        _ => None,
    };
    crate::mac::request_within(crate::mac::SOCKET, method, path, body, limit).await
}

/// The same `room-cli thread` commands Local threads use, with flags in any order (ADR 20261110-235800). `--json`
/// is accepted and ignored because the answer is always JSON.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let words: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|word| *word != "--json")
        .map(mention)
        .collect();
    if words.iter().any(|word| matches!(*word, "--help" | "-h")) {
        println!("{USAGE}");
        return Ok(0);
    }
    if let Some(flag) = missing_value(&words) {
        eprintln!("{flag} needs a value.");
        return Ok(2);
    }
    let Some((command, rest)) = words.split_first() else {
        println!("{USAGE}\n{ABOUT}");
        return Ok(0);
    };
    let usage = || {
        println!("{USAGE}\n{ABOUT}");
        Ok(2)
    };
    // The command's own words, or the option it doesn't take here.
    let own = |values: &[&str], switches: &[&str]| {
        plain(rest, values, switches).map_err(|word| {
            eprintln!(
                "Unknown option {word}. Cloud threads take only the options in `room-cli thread --help`."
            );
            2
        })
    };
    let answer = match *command {
        "spawn" => return spawn_cli(rest).await,
        "fork" => return fork_cli(rest).await,
        "list" => {
            // It lists only this thread's children, so a filter like --project is refused: an ignored one made an
            // empty list read as "the project has no open threads".
            if let Some(word) = unknown_word(rest, &[], &["--include-archived"]) {
                eprintln!(
                    "Unknown option {word}. Cloud `thread list` shows only this thread's subagents, not the project's threads, and takes only --include-archived. In a loop, past runs are in the Loop notes in your prompt and `room-cli loop runs ID`."
                );
                return Ok(2);
            }
            let path = if rest.contains(&"--include-archived") {
                "/children?include_archived=true"
            } else {
                "/children"
            };
            call("GET", path, None).await?
        }
        // One blocking call instead of a wake-up per child. It prints the same list as `thread list`, marked.
        "wait" => {
            if !matches!(own(&[], &["--children"]).as_deref(), Ok([])) {
                eprintln!(
                    "Cloud `thread wait` waits for this thread's own children: room-cli thread wait --children"
                );
                return Ok(2);
            }
            let end = Instant::now() + CHILD_WAIT;
            // Children in sandboxes of their own that stopped without telling Core: it would count them forever.
            let mut gone: Vec<String> = Vec::new();
            // Every child this wait saw at work, marked in the list it prints (#1752).
            let mut waited: Vec<String> = Vec::new();
            let mut tick = 0;
            // Each check may take what is left of the wait: a slow Core is ordinary (storage checks, restores), so
            // only a Core that never answered in the whole wait is an error (#1977).
            let check = |path: &'static str| {
                let left = end.saturating_duration_since(Instant::now());
                let limit = Some(left.max(crate::mac::QUICK));
                crate::mac::request_within(crate::mac::SOCKET, "GET", path, None, limit)
            };
            // Children at work at the last answer.
            let mut still = 0;
            let working = loop {
                let answer = match check("/working").await {
                    Ok(answer) => answer,
                    Err(error) if error.kind() == io::ErrorKind::TimedOut && tick > 0 => {
                        break still;
                    }
                    Err(error) => return Err(error),
                };
                let ids = answer["working"].as_array().into_iter().flatten();
                let mut ids: Vec<&str> = ids.filter_map(Value::as_str).collect();
                for id in &ids {
                    if !waited.iter().any(|w| w == id) {
                        waited.push(id.to_string());
                    }
                }
                ids.retain(|id| !gone.iter().any(|g| g == id));
                tick += 1;
                // Every 20 seconds the website has the last word: its sandbox died, sleeps, or the user archived it.
                if tick % 10 == 0 && ids.iter().any(|id| id.starts_with("thr_")) {
                    let list = match check("/children?include_archived=true").await {
                        Ok(list) => Some(list),
                        Err(error) if error.kind() == io::ErrorKind::TimedOut => None,
                        Err(error) => return Err(error),
                    };
                    // A list without the website's part, or none in time, says nothing about them.
                    if let Some(list) = list.filter(|list| !list["note"].is_string()) {
                        let active = |id: &str| {
                            let mut children = list["children"].as_array().into_iter().flatten();
                            children.any(|c| c["id"] == id && c["status"] == "active")
                        };
                        ids.retain(|id| {
                            let stopped = id.starts_with("thr_") && !active(id);
                            if stopped {
                                gone.push(id.to_string());
                            }
                            !stopped
                        });
                    }
                }
                if ids.is_empty() || Instant::now() >= end {
                    break ids.len();
                }
                still = ids.len();
                tokio::time::sleep(Duration::from_secs(2)).await;
            };
            let mut answer = call("GET", "/children", None).await?;
            // The list holds every open child, also idle ones from earlier sessions: say which it waited on.
            let marked = mark_waited(&mut answer, &waited);
            if marked > 0 {
                let total = answer["children"].as_array().map_or(0, Vec::len);
                answer["summary"] = json!(format!(
                    "Waited on {marked} child threads (\"waited\": true); {} others were not seen working.",
                    total - marked
                ));
            }
            if working > 0 {
                answer["wait"] = json!(format!(
                    "{working} child threads are still working. Run the command again to keep waiting."
                ));
            }
            println!("{answer}");
            return Ok(if working > 0 { 2 } else { 0 });
        }
        // This thread, or one child as `thread list` shows it. Nothing here looks up a pull request, so the Local
        // `--no-pr` is accepted and changes nothing, like `--json`.
        "show" => match own(&[], &["--self", "--no-pr"]) {
            Ok(ids) if ids.is_empty() => call("GET", "/thread", None).await?["thread"].take(),
            Ok(ids) if ids.len() == 1 && !rest.contains(&"--self") => {
                let mut list = call("GET", "/children?include_archived=true", None).await?;
                let children = list["children"].as_array_mut();
                let child = children
                    .into_iter()
                    .flatten()
                    .find(|child| child["id"] == ids[0]);
                let Some(child) = child else {
                    // This thread's own ID, as `status` prints it (#1803).
                    let thread = call("GET", "/thread", None).await?["thread"].take();
                    if thread["id"] == ids[0] {
                        println!("{thread}");
                        return Ok(0);
                    }
                    // A child moved to the top level says so, as `output` does (#2271).
                    // Only a well-formed session ID goes into the request, which waits 3 s at most; anything else,
                    // a timeout or another error gets the old answer.
                    let read = if session_id(ids[0]) {
                        let path = format!("/children/{}", ids[0]);
                        let limit = Some(std::time::Duration::from_secs(3));
                        crate::mac::request_within(crate::mac::SOCKET, "GET", &path, None, limit)
                            .await
                    } else {
                        Ok(Value::Null)
                    };
                    if let Err(error) = read
                        && error.to_string() == super::children::MOVED_OUT
                    {
                        eprintln!("{}: {error}.", ids[0]);
                        return Ok(1);
                    }
                    eprintln!(
                        "{} is not a child thread of this thread. See room-cli thread list.",
                        ids[0]
                    );
                    return Ok(1);
                };
                let mut child = child.take();
                // The list keeps a failed turn's report until the next one, but the child may be at work again, say
                // after a usage limit reset (#2047): what its chat says, as `output` reads it, is added. One read of
                // 5 s at most; a failure adds nothing.
                if child["sandbox"] == "own"
                    && child["state"] == "error"
                    && relay::thread_id(ids[0])
                {
                    let path = format!("/children/{}", ids[0]);
                    let limit = Some(Duration::from_secs(5));
                    let read =
                        crate::mac::request_within(crate::mac::SOCKET, "GET", &path, None, limit);
                    if let Ok(chat) = read.await {
                        resumed(&mut child, &chat);
                    }
                }
                child
            }
            Ok(_) => return usage(),
            Err(code) => return Ok(code),
        },
        // `log` is the child's whole chat: `output --all`.
        "output" | "log" => match own(&["--input", "--offset"], &["--all", "--self"]) {
            Ok(ids) if ids.len() == 1 && !rest.contains(&"--self") => {
                let offset = flag(rest, "--offset").unwrap_or("0");
                let all = match flag(rest, "--input") {
                    // `withInputs` names the record with letters, digits, `_` and `-` only (#2582).
                    Some(at)
                        if offset.parse::<u64>().is_ok()
                            && *command == "output"
                            && !rest.contains(&"--all")
                            && !at.is_empty()
                            && at
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)) =>
                    {
                        format!("?input={at}&offset={offset}")
                    }
                    Some(_) => return usage(),
                    // `--offset` only reads on from a clipped input's `--input`.
                    None if flag(rest, "--offset").is_some() => return usage(),
                    None if *command == "log" || rest.contains(&"--all") => "?all=true".into(),
                    None => String::new(),
                };
                call("GET", &format!("/children/{}{all}", ids[0]), None).await?
            }
            Ok(_) => {
                eprintln!(
                    "Name a child: room-cli thread {command} CHILD_ID. Your own chat is already in your context."
                );
                return Ok(2);
            }
            Err(code) => return Ok(code),
        },
        "tell" => {
            let values = ["--prompt", "--message-file", "--mode", "--request-id"];
            let Ok(ids) = own(&values, &["--parent"]) else {
                return Ok(2);
            };
            // The Local CLI's modes and their long names (#1517). Steer and auto are what Core always did, so only
            // queue is sent: a plain tell still works while an older Core runs.
            let given = flag(rest, "--mode");
            let queue = match given.map(|m| m.trim().to_ascii_lowercase()).as_deref() {
                None | Some("auto" | "steer" | "steer-if-active") => false,
                Some("queue" | "queue-if-active") => true,
                Some(_) => {
                    let given = given.unwrap_or_default();
                    eprintln!(
                        "Invalid message mode '{given}'. Expected 'queue', 'steer', or 'auto'."
                    );
                    return Ok(2);
                }
            };
            // `--parent` names the thread that started this one.
            let (id, said) = match (rest.contains(&"--parent"), ids.as_slice()) {
                (true, said) if said.len() <= 1 => ("parent", said.first().copied()),
                (false, [id, said @ ..]) if said.len() <= 1 => (*id, said.first().copied()),
                _ => return usage(),
            };
            let file = flag(rest, "--message-file");
            let text = match (said, flag(rest, "--prompt"), file) {
                (Some(text), None, None) | (None, Some(text), None) => text.to_owned(),
                (None, None, Some("-")) => io::read_to_string(io::stdin())?.trim_end().to_owned(),
                (None, None, Some(path)) => std::fs::read_to_string(path)?.trim_end().to_owned(),
                _ => return usage(),
            };
            let path = format!("/children/{id}/messages");
            let mut body = if queue {
                json!({"text":text,"mode":"queue"})
            } else {
                json!({"text":text})
            };
            // The ID an earlier tell printed: the same message sent again is delivered once.
            if let Some(key) = flag(rest, "--request-id") {
                body["request_id"] = json!(key);
            }
            call("POST", &path, Some(body)).await?
        }
        "update" => {
            let ids = match own(&["--title", "--reasoning-level"], &["--self"]) {
                Ok(ids) => ids,
                Err(code) => return Ok(code),
            };
            if let Some(id) = ids.first() {
                eprintln!(
                    "A Cloud thread updates only itself; {id} is not needed. Omit it (or use --self)."
                );
                return Ok(2);
            }
            let changes = [
                ("/title", "title", flag(rest, "--title")),
                ("/reasoning", "reasoning", flag(rest, "--reasoning-level")),
            ];
            if changes.iter().all(|(_, _, value)| value.is_none()) {
                return usage();
            }
            let mut answer = json!({});
            for (path, key, value) in changes {
                if let Some(value) = value {
                    let changed = call("POST", path, Some(json!({key:value}))).await?;
                    answer[key] = changed[key].clone();
                }
            }
            answer
        }
        "pin" => match (rest.contains(&"--self"), own(&[], &["--self"])) {
            (_, Err(code)) => return Ok(code),
            (true, Ok(ids)) if ids.is_empty() => call("POST", "/pin", None).await?,
            (false, Ok(ids)) if ids.len() == 1 => {
                call("POST", &format!("/children/{}/pin", ids[0]), None).await?
            }
            _ => return usage(),
        },
        "archive" => match (rest.contains(&"--self"), own(&[], &["--self"])) {
            (_, Err(code)) => return Ok(code),
            (true, Ok(ids)) if ids.is_empty() => call("POST", "/archive", None).await?,
            (false, Ok(ids)) if ids.len() == 1 => {
                call("POST", &format!("/children/{}/archive", ids[0]), None).await?
            }
            // Several children: one failure does not stop the rest.
            (false, Ok(ids)) if ids.len() > 1 => {
                let (mut archived, mut failed) = (Vec::new(), Vec::new());
                for id in ids {
                    match call("POST", &format!("/children/{id}/archive"), None).await {
                        Ok(answer) => archived.push(answer),
                        Err(error) => failed.push(json!({"id":id,"error":error.to_string()})),
                    }
                }
                let code = if failed.is_empty() { 0 } else { 1 };
                println!("{}", json!({"archived":archived,"failed":failed}));
                return Ok(code);
            }
            _ => return usage(),
        },
        "move" => match (flag(rest, "--project"), own(&["--project"], &["--self"])) {
            (_, Err(code)) => return Ok(code),
            (Some(project), Ok(ids)) if ids.is_empty() => {
                call("POST", "/move", Some(json!({"project":project}))).await?
            }
            _ => return usage(),
        },
        "compact" => {
            let ids = match own(&["--then"], &["--self", "--no-then"]) {
                Ok(ids) => ids,
                Err(code) => return Ok(code),
            };
            let then = match (flag(rest, "--then"), rest.contains(&"--no-then")) {
                (Some(_), true) => return usage(),
                (then, false) => Some(then.unwrap_or(COMPACT_THEN)),
                (None, true) => None,
            };
            let path = match (rest.contains(&"--self"), ids.as_slice()) {
                (true, []) => "/compact".to_owned(),
                (false, [id]) => format!("/children/{id}/compact"),
                _ => return usage(),
            };
            call("POST", &path, Some(json!({"then":then}))).await?
        }
        "stop" => match (rest.contains(&"--self"), own(&[], &["--self"])) {
            (_, Err(code)) => return Ok(code),
            (true, Ok(ids)) if ids.is_empty() => {
                json!({"stopped":true,"note":"Archiving a cloud thread stops it; nothing else to do."})
            }
            (false, Ok(ids)) if ids.len() == 1 => {
                call("POST", &format!("/children/{}/stop", ids[0]), None).await?
            }
            _ => return usage(),
        },
        // #2242: the generic redirect led an agent that wanted a thread's messages to mark it read on the Mac.
        "read" | "unread" => {
            eprintln!("{}", mark_note(command));
            return Ok(2);
        }
        other if LOCAL_ONLY.contains(&other) => {
            eprintln!("{}", super::info::on_computer(&format!("thread {other}")));
            return Ok(2);
        }
        _ => return usage(),
    };
    println!("{answer}");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::{
        first_key, mark_note, mark_waited, mention, missing_value, not_running, plain, resumed,
        session_id,
    };
    use serde_json::json;

    // #2047: a failed child whose saved chat says running keeps its error, since that chat may be the failed turn
    // not saved yet; it only adds what the chat says.
    #[test]
    fn a_failed_child_keeps_its_error_whatever_its_chat_says() {
        let failed =
            json!({"id":"thr_a","state":"error","status":"error","sandbox":"own","issue":"x"});
        let mut child = failed.clone();
        resumed(&mut child, &json!({"state":"running","reply":"Working"}));
        assert_eq!(child["chatState"], "running");
        child
            .as_object_mut()
            .unwrap()
            .retain(|k, _| k != "chatState" && k != "note");
        assert_eq!(child, failed);
        for chat in [json!({"state":"idle"}), json!({}), json!(null)] {
            let mut child = failed.clone();
            resumed(&mut child, &chat);
            assert_eq!(child, failed);
        }
    }

    // #2565: a child's tell to a parent that lost its agent printed Core's internal refusal.
    #[test]
    fn a_tell_to_an_agent_that_isnt_running_says_so() {
        use axum::http::StatusCode;
        let gone = super::fail(StatusCode::CONFLICT, super::super::GONE);
        let (status, said) = not_running(gone, "your parent thread");
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(
            said["error"]
                .as_str()
                .unwrap()
                .starts_with("Not delivered: your parent thread's agent isn't running")
        );
        let other = super::fail(
            StatusCode::CONFLICT,
            "storage unsafe; new execution is blocked",
        );
        assert_eq!(not_running(other.clone(), "that thread").1.0, other.1.0);
    }

    // #2271: `thread show`'s moved-child check puts the ID in a request path, so only a whole session ID gets there.
    #[test]
    fn only_a_whole_session_id_reaches_the_moved_child_check() {
        assert!(session_id("cr_child_ab12-CD_3"));
        assert!(session_id(&format!("cr_{}", "a".repeat(80))));
        for bad in [
            "",
            "cr_",
            "kid",
            "thr_abc",
            "cr_a b",
            "cr_a/../stop",
            "cr_a?x=1",
            "cr_a\r\nX: y",
            "cr_é",
        ] {
            assert!(!session_id(bad), "{bad:?}");
        }
        assert!(!session_id(&format!("cr_{}", "a".repeat(81))));
    }

    // #2242: the Mac commands it prints must run as printed: the caller's verb, no shell pipe, and --write.
    #[test]
    fn a_mark_note_prints_runnable_mac_commands() {
        for verb in ["read", "unread"] {
            let note = mark_note(verb);
            assert!(note.contains(&format!("room-cli thread {verb} THREAD_ID'")));
            assert!(!note.contains('|'));
            assert_eq!(
                note.matches("mac run").count(),
                note.matches("mac run --write '").count()
            );
        }
    }

    // #1668: an own-sandbox spawn printed nothing while it waited, and its request ID stayed inside Core, so a retry
    // after the agent's command gave up started a second child. Its ID now comes first, like a top-level start's.
    #[test]
    fn a_slow_spawn_shows_its_request_id_first() {
        for (words, shown) in [
            (&["--prompt", "x"][..], true),
            (&["--prompt", "x", "--top-level"], true),
            (&["--prompt", "x", "--shared-sandbox"], false),
            (&["--prompt", "x", "--request-id", "mine"], false),
        ] {
            let key = first_key(words).unwrap();
            assert_eq!(key.is_some(), shown, "{words:?}");
            assert!(key.is_none_or(|k| k.len() == 24), "{words:?}");
        }
    }

    #[test]
    fn flags_go_in_any_order_and_need_their_values() {
        // Words that are not options stay, in order, wherever the flags sit.
        let words = ["--self", "a", "--title", "New name", "b"];
        assert_eq!(plain(&words, &["--title"], &["--self"]), Ok(vec!["a", "b"]));
        // An option the command does not take is named, not dropped.
        assert_eq!(plain(&["a", "--bogus"], &[], &["--self"]), Err("--bogus"));
        // A value with a space is text, even when it starts with dashes.
        assert_eq!(plain(&["--not a flag"], &[], &[]), Ok(vec!["--not a flag"]));
        // `--title --self` must not rename the thread to "--self".
        assert_eq!(
            missing_value(&["update", "--title", "--self"]),
            Some("--title")
        );
        assert_eq!(
            missing_value(&["tell", "thr_a", "--message-file"]),
            Some("--message-file")
        );
        assert_eq!(
            missing_value(&["tell", "thr_a", "--message-file", "-"]),
            None
        );
        // An unset `--offset $next` or `--input --all` is refused, never read as offset 0 or plain output (#2582).
        assert_eq!(
            missing_value(&["output", "thr_a", "--input", "2_cr_a", "--offset"]),
            Some("--offset")
        );
        assert_eq!(
            missing_value(&["output", "thr_a", "--input", "--all"]),
            Some("--input")
        );
        // Thread IDs as agents write them in chat.
        assert_eq!(mention("@thread:thr_ab-1"), "thr_ab-1");
        assert_eq!(mention("@thread:cr_child_9"), "cr_child_9");
        assert_eq!(mention("@thread:thr_a b"), "@thread:thr_a b");
        assert_eq!(mention("thr_ab"), "thr_ab");
    }

    // #1752: `thread wait` prints every open child, also idle ones from the thread's earlier sessions, so it marks the
    // ones it saw at work. Nothing is left out.
    #[test]
    fn thread_wait_marks_the_children_it_waited_on() {
        let list = || json!({"children":[{"id":"cr_child_a"},{"id":"thr_old"},{"id":"thr_new"}]});
        for (waited, marked) in [
            (&["cr_child_a", "thr_new"][..], &[true, false, true][..]),
            (&["thr_gone"], &[false, false, false]),
            (&[], &[false, false, false]),
        ] {
            let mut answer = list();
            let waited: Vec<String> = waited.iter().map(|w| w.to_string()).collect();
            let count = marked.iter().filter(|m| **m).count();
            assert_eq!(mark_waited(&mut answer, &waited), count);
            let children = answer["children"].as_array().unwrap();
            let shown: Vec<bool> = children.iter().map(|c| c["waited"] == true).collect();
            assert_eq!((children.len(), &shown[..]), (3, marked));
        }
    }
}
