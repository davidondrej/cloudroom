//! Cloud agents rename or archive their own thread, change its effort, and start, stop and archive child threads in their own sandbox. Each request
//! is a session record, so the app applies it whenever it next reads the thread, including after it was offline.
//! A child gets a sandbox of its own by default (ADR 0229). The website starts it, so it never needs the user's
//! app (ADR 20261104-015709); only `--shared-sandbox` runs it here. Once started, the website carries its `tell`,
//! `stop`, `archive` and turn reports, even while the app is closed (relay.rs).
//! `thread fork` asks the app the same way to fork this thread into a new Cloud thread; without an answer there is no
//! fork. Only the user forks to their Mac, from the app.
//! `spawn --top-level` asks the website to start a top-level thread instead, with no link back (ADR 0267).
use super::{Manager, relay};
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
room-cli thread archive --self
room-cli thread move --self --project PROJECT
room-cli thread stop --self
room-cli thread spawn --provider codex|claude-code|cursor|pi|opencode|hermes|devin|droid|kimi|fx|openclaw [--model MODEL] [--reasoning-level LEVEL] [--service-tier default|fast] [--title TITLE] [--shared-sandbox|--top-level] --prompt TEXT|--prompt-file PATH
room-cli thread fork [--provider codex|claude-code|cursor|pi|opencode|hermes|devin|droid|kimi|fx|openclaw] [--model MODEL] [--reasoning-level LEVEL] [--title TITLE] --prompt TEXT|--prompt-file PATH
room-cli thread list [--include-archived] [--include-hidden]
room-cli thread wait --children
room-cli thread output CHILD_ID [--all]
room-cli thread log CHILD_ID
room-cli thread tell THREAD_ID|--parent [--mode queue|steer|auto] TEXT|--message-file PATH
room-cli thread stop CHILD_ID
room-cli thread archive CHILD_ID...
Flags go in any order.";
const ABOUT: &str = "Shows, renames, archives, moves or changes the effort of this cloud thread, or starts, checks, stops and archives its child threads. --top-level starts a top-level thread instead of a child, only when the user asks for one. `thread list --include-hidden` changes nothing here: it lists every child of this thread already.";
/// `room-cli thread` commands only the app on the user's computer has.
const LOCAL_ONLY: [&str; 28] = [
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
    "pin",
    "unpin",
    "delete",
    "edit-message",
    "retry",
    "compact",
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
const SPAWN_NOTE: &str = "Started in this sandbox and folder. Keep working: Cloudroom sends you a message each time it finishes a turn.";
const OWN_NOTE: &str = "Started in its own sandbox with a copy of your code (commits and uncommitted changes, without gitignored files or dependencies; nested Git repos arrive empty or without history), on its own branch. It doesn't see your later edits; share work through Git. Use this ID with tell, stop and archive. Keep working: Cloudroom sends you a message each time it finishes a turn.";
/// What `thread tell` answers once its message is steered, unconfirmed or queued: for a subagent, which reports back,
/// or for another thread, which doesn't (#177). The website words its own relayed tells the same.
const CHILD_NOTES: [&str; 3] = [
    "Sent into the child's running turn. Cloudroom tells you when that turn finishes.",
    "Could not confirm the child's running turn got it. Check thread output before sending it again.",
    "Queued. Cloudroom tells you when the child finishes it.",
];
const OTHER_NOTES: [&str; 3] = [
    "Sent into its running turn. It isn't your subagent, so Cloudroom won't tell you when it finishes.",
    "Could not confirm its running turn got it. Sending it again may deliver it twice.",
    "Queued. It isn't your subagent, so Cloudroom won't tell you when it finishes.",
];
const PAUSED_NOTE: &str = "Queued, paused by a Stop. It sends when that thread is resumed.";
const FORK_NOTE: &str = "Forked this thread at its last finished turn: a new thread with this conversation and your code (commits and uncommitted changes, without gitignored files or dependencies; nested Git repos arrive empty or without history), on its own branch where the project uses Git. It runs on its own and doesn't report back to you; it doesn't see your later edits.";
const TOP_NOTE: &str = "Started as a top-level thread in its own sandbox, from the project's GitHub repo (push your work first) and .env files. It is not your child: it doesn't report back, and you can't tell, stop or read it. It shows in the user's sidebar within a minute.";
/// How long `spawn --top-level` keeps retrying a start the website could not finish (say, a slow wake).
const LAUNCH_RETRY: Duration = Duration::from_secs(240);
/// How long a spawn waits for the website to name a child it starts in a sandbox of its own. It stays under Claude
/// Code's 2-minute command limit; the start goes on after that (relay.rs).
const SPAWN_WAIT: Duration = Duration::from_secs(75);
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
pub struct Tell {
    text: String,
    /// `--mode queue`: wait for a running turn to end instead of joining it.
    #[serde(default)]
    mode: Option<String>,
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
        .route("/archive", post(archive))
        .route("/move", post(move_project))
        .route("/children", get(list).post(spawn))
        .route("/working", get(working))
        .route("/fork", post(fork))
        .route("/children/{id}", get(output))
        .route("/children/{id}/messages", post(tell))
        .route("/children/{id}/stop", post(stop_child))
        .route("/children/{id}/archive", post(archive_child))
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

/// The app archives the thread and its children, which also stops this session.
async fn archive(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "thread")?;
    let kept = archive_under(&m, &session)?;
    record(
        &m,
        &session,
        "archive",
        json!({"archived":true,"kept_live":kept,"self":true,"wake":m.wake_id()}),
    )
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
        super::Error::Conflict(_) | super::Error::Effort(_) => StatusCode::CONFLICT,
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
    let body = json!({"request_id":key,"session":session,"prompt":input.prompt,"title":input.title,"harness":input.provider,"model":input.model,"reasoning":input.reasoning,"service_tier":input.service_tier});
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
        let body = json!({"request_id":key,"session":parent,"prompt":input.prompt,"title":title,"harness":input.provider,"model":input.model,"reasoning":reasoning,"service_tier":input.service_tier});
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
            None => start
                .and_then(|s| s.child)
                .map(|child| Ok(Json(json!({"id":child,"note":OWN_NOTE})))),
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
            return Err(fail(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!(
                    "The child is still starting, and Cloudroom keeps starting it. Run the same command with --request-id {key} to get its ID; it never starts twice."
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
                bad("Use --provider codex, claude-code, cursor, pi, opencode, hermes, devin, droid, kimi, fx or openclaw")
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
    relay::own_children(&m, &parent, query.include_archived, &mut answer).await;
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

#[derive(Deserialize)]
struct OutputQuery {
    #[serde(default)]
    all: bool,
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
        let all = if query.all { "1" } else { "0" };
        let failed = start_error(&m, &parent, &id);
        let known = relay::started_here(&m, &parent, &id);
        return match api.get("chat", &[("thread", &id), ("all", all)]).await {
            // The website may not know a child that just started yet, or has no chat of it yet (#317).
            Err(super::history::ApiError::Status(404, _))
                if starting(&m, &parent, true).contains(&id) =>
            {
                Ok(
                    json!({"id":id,"state":"starting","note":"Its sandbox is still starting. Its replies arrive as messages when its turns end."}),
                )
            }
            // Its start was refused: no chat, or only what came before. The same story as `thread list` (#1058).
            Err(super::history::ApiError::Status(404, _)) if failed.is_some() => {
                Ok(json!({"id":id}))
            }
            // The website forgot the link to a child this thread started (#149): what Core knows of it, not an error.
            Err(super::history::ApiError::Status(403 | 404, _)) if known.is_some() => {
                Ok(json!({"id":id,"state":known,"note":relay::UNLINKED}))
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
        id
    };
    if relay::thread_id(&id) || id == "parent" {
        let text = Some(input.text.as_str());
        return relay::command(&m, &sender, &id, "tell", text, to_parent, queue).await;
    }
    let under = m.tell_target(&sender, &id).map_err(session_failure)?;
    let text = if under {
        input.text
    } else {
        from_thread(&sender, &input.text)
    };
    let prompt = json!({"text":text});
    let request =
        random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?;
    deliver(&m, &id, &request, prompt, under, Some(&sender), queue).await
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
    input: Value,
    child: bool,
    sender: Option<&str>,
    queue: bool,
) -> Result<Json<Value>, Failure> {
    let notes = if child { CHILD_NOTES } else { OTHER_NOTES };
    let steer_id = format!("{request}_steer");
    if let Some(done) = m.receipt(id, request) {
        return Ok(Json(json!({"id":id,"state":done.state})));
    }
    // A steer that failed falls back to the queue, even on a retry.
    let steered = match m.receipt(id, &steer_id) {
        Some(s) if s.state != "failed" => return Ok(Json(json!({"id":id,"state":s.state}))),
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
    let receipt = m
        .command_from(id, request.to_owned(), "prompt", input, true, sender)
        .map_err(session_failure)?;
    let local = m.local.lock().unwrap();
    if local.sessions.get(id).is_some_and(|s| s.queue_paused) {
        return Ok(Json(
            json!({"id":id,"state":receipt.state,"note":PAUSED_NOTE,"paused":true}),
        ));
    }
    Ok(Json(json!({"id":id,"state":receipt.state,"note":notes[2]})))
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
        return relay::command(&m, &parent, &id, "stop", None, false, false).await;
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
        return relay::command(&m, &parent, &id, "archive", None, false, false).await;
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
    let takes_value =
        |word: &str| SPAWN_VALUES.contains(&word) || matches!(word, "--message-file" | "--mode");
    (0..words.len())
        .find(|&i| takes_value(words[i]) && words.get(i + 1).is_none_or(|next| option(next)))
        .map(|i| words[i])
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
        &["--shared-sandbox", "--parent-self", "--top-level"],
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
    let mut body =
        json!({"prompt":prompt,"shared":words.contains(&"--shared-sandbox"),"top_level":top});
    // A top-level start can outlast the agent's command timeout, so its request ID comes first: rerunning the
    // command with it continues that start instead of making a second thread.
    if top && flag(words, "--request-id").is_none() {
        let key = random_key()?;
        eprintln!(
            "Starting a top-level thread. If this command times out, rerun it with --request-id {key}; it never starts twice."
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
    let answer = crate::mac::request(crate::mac::SOCKET, "POST", "/children", Some(body)).await?;
    println!("{answer}");
    Ok(0)
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
    crate::mac::request(crate::mac::SOCKET, method, path, body).await
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
            // empty list read as "the project has no open threads". --include-hidden, which Local scripts pass,
            // changes nothing here: every child of this thread shows (#149).
            if let Some(word) = unknown_word(rest, &[], &["--include-archived", "--include-hidden"])
            {
                eprintln!(
                    "Unknown option {word}. Cloud `thread list` shows only this thread's subagents, not the project's threads, and takes only --include-archived (and --include-hidden, which changes nothing here). In a loop, past runs are in the Loop notes in your prompt."
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
        // One blocking call instead of a wake-up per child. It prints the same list as `thread list`.
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
            let mut tick = 0;
            let working = loop {
                let answer = call("GET", "/working", None).await?;
                let ids = answer["working"].as_array().into_iter().flatten();
                let mut ids: Vec<&str> = ids.filter_map(Value::as_str).collect();
                ids.retain(|id| !gone.iter().any(|g| g == id));
                tick += 1;
                // Every 20 seconds the website has the last word: its sandbox died, sleeps, or the user archived it.
                if tick % 10 == 0 && ids.iter().any(|id| id.starts_with("thr_")) {
                    let list = call("GET", "/children?include_archived=true", None).await?;
                    let active = |id: &str| {
                        let mut children = list["children"].as_array().into_iter().flatten();
                        // One the website forgot is only what this thread last heard (#149): it has the last word.
                        children.any(|c| {
                            c["id"] == id && c["status"] == "active" && c["unlinked"] != true
                        })
                    };
                    // A list without the website's part says nothing about them.
                    if !list["note"].is_string() {
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
                tokio::time::sleep(Duration::from_secs(2)).await;
            };
            let mut answer = call("GET", "/children", None).await?;
            if working > 0 {
                answer["wait"] = json!(format!(
                    "{working} child threads are still working. Run the command again to keep waiting."
                ));
            }
            println!("{answer}");
            return Ok(if working > 0 { 2 } else { 0 });
        }
        // This thread, or one child as `thread list` shows it.
        "show" => match own(&[], &["--self"]) {
            Ok(ids) if ids.is_empty() => call("GET", "/thread", None).await?["thread"].take(),
            Ok(ids) if ids.len() == 1 && !rest.contains(&"--self") => {
                let mut list = call("GET", "/children?include_archived=true", None).await?;
                let children = list["children"].as_array_mut();
                let child = children
                    .into_iter()
                    .flatten()
                    .find(|child| child["id"] == ids[0]);
                let Some(child) = child else {
                    eprintln!(
                        "{} is not a child thread of this thread. See room-cli thread list.",
                        ids[0]
                    );
                    return Ok(1);
                };
                child.take()
            }
            Ok(_) => return usage(),
            Err(code) => return Ok(code),
        },
        // `log` is the child's whole chat: `output --all`.
        "output" | "log" => match own(&[], &["--all", "--self"]) {
            Ok(ids) if ids.len() == 1 && !rest.contains(&"--self") => {
                let all = if *command == "log" || rest.contains(&"--all") {
                    "?all=true"
                } else {
                    ""
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
            let Ok(ids) = own(&["--prompt", "--message-file", "--mode"], &["--parent"]) else {
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
            let body = if queue {
                json!({"text":text,"mode":"queue"})
            } else {
                json!({"text":text})
            };
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
    use super::{mention, missing_value, plain};

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
        // Thread IDs as agents write them in chat.
        assert_eq!(mention("@thread:thr_ab-1"), "thr_ab-1");
        assert_eq!(mention("@thread:cr_child_9"), "cr_child_9");
        assert_eq!(mention("@thread:thr_a b"), "@thread:thr_a b");
        assert_eq!(mention("thr_ab"), "thr_ab");
    }
}
