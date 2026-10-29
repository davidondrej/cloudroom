//! Cloud agents rename or archive their own thread, change its effort, and start, stop and archive child threads in their own sandbox. Each request
//! is a session record, so the app applies it whenever it next reads the thread, including after it was offline.
//! A child gets a sandbox of its own by default (ADR 0229). The app starts it, so Core records the request and
//! waits briefly for the app's answer; without one, the child starts in this sandbox instead. Once started, the
//! website carries its `tell`, `stop`, `archive` and turn reports, even while the app is closed (relay.rs).
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

const USAGE: &str = "room-cli thread update --self --title TITLE
room-cli thread update --self --reasoning-level LEVEL
room-cli thread archive --self
room-cli thread move --self --project PROJECT
room-cli thread stop --self
room-cli thread spawn --provider codex|claude-code|pi|opencode|hermes|devin|fx|openclaw [--model MODEL] [--reasoning-level LEVEL] [--service-tier default|fast] [--title TITLE] [--shared-sandbox|--top-level] --prompt TEXT|--prompt-file PATH
room-cli thread fork [--provider codex|claude-code|pi|opencode|hermes|devin|fx|openclaw] [--model MODEL] [--reasoning-level LEVEL] [--title TITLE] --prompt TEXT|--prompt-file PATH
room-cli thread list [--include-archived]
room-cli thread output CHILD_ID [--all]
room-cli thread tell CHILD_ID TEXT
room-cli thread stop CHILD_ID
room-cli thread archive CHILD_ID";
const SPAWN_NOTE: &str = "Started in this sandbox and folder. Keep working: Cloudroom sends you a message each time it finishes a turn.";
const OWN_NOTE: &str = "Started in its own sandbox with a copy of your code (commits and uncommitted changes), on its own branch. It doesn't see your later edits; share work through Git. Use this ID with tell, stop and archive. Keep working: Cloudroom sends you a message each time it finishes a turn.";
const FALLBACK_NOTE: &str = " The user's Cloudroom app didn't start it in its own sandbox (it's probably closed), so it runs here.";
const FORK_NOTE: &str = "Forked this thread at its last finished turn: a new thread with this conversation and your code (commits and uncommitted changes), on its own branch where the project uses Git. It runs on its own and doesn't report back to you; it doesn't see your later edits.";
const TOP_NOTE: &str = "Started as a top-level thread in its own sandbox, from the project's GitHub repo (push your work first) and .env files. It is not your child: it doesn't report back, and you can't tell, stop or read it. It shows in the user's sidebar within a minute.";
/// How long `spawn --top-level` keeps retrying a start the website could not finish (say, a slow wake).
const LAUNCH_RETRY: Duration = Duration::from_secs(240);
/// How long a spawn waits for the app to start the child in its own sandbox, and how long after a miss spawns
/// share this sandbox right away, so a closed app costs one wait, not one per child.
const APP_WAIT: Duration = Duration::from_secs(60);
const APP_MISSED_FOR: Duration = Duration::from_secs(300);
/// How long a fork waits for the app. It stays under Claude Code's 2-minute command limit, so the agent always
/// sees the outcome instead of a killed command it might retry. The app ignores older requests (AGENT_FORK_WAIT).
const FORK_WAIT: Duration = Duration::from_secs(90);
/// How long a child request's outcome is remembered, so a retried spawn or a repeated app answer gets the same one.
const OUTCOME_KEPT: Duration = Duration::from_secs(3600);
/// Each child request's outcome, by parent session and request ID. It is decided once, under this lock, so a
/// child never runs both in its own sandbox and here.
static CHILDREN: LazyLock<Mutex<HashMap<String, Outcome>>> = LazyLock::new(Mutex::default);
static APP_MISSED: Mutex<Option<Instant>> = Mutex::new(None);

enum Outcome {
    /// Waiting for the app: its thread ID, or why it could not start the child.
    Waiting(oneshot::Sender<Result<String, String>>),
    /// The app started the child in its own sandbox.
    Started(String, Instant),
    /// The app did not answer in time (or the agent gave up): the child runs here, and a late start is cancelled.
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
        .route("/fork", post(fork))
        .route("/children/{id}", get(output))
        .route("/children/{id}/messages", post(tell))
        .route("/children/{id}/stop", post(stop_child))
        .route("/children/{id}/archive", post(archive_child))
}

/// The session whose harness process sent this `cloudroom <command>` request.
pub(crate) fn caller(m: &Manager, peer: Peer, command: &str) -> Result<String, Failure> {
    if peer.0.is_none() || m.previews.agent().map(|(_, uid)| uid) != peer.0 {
        return Err(fail(
            StatusCode::FORBIDDEN,
            &format!("Only the VM agent account may run cloudroom {command}"),
        ));
    }
    peer.1
        .and_then(|pid| m.harness_session(&crate::secrets::ancestors(pid)))
        .ok_or(fail(
            StatusCode::CONFLICT,
            &format!("Run cloudroom {command} from a Cloudroom cloud thread"),
        ))
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
    record(&m, &session, "title", json!({"title":title}))
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
        json!({"reasoning":input.reasoning}),
    )
}

/// The app archives the thread and its children, which also stops this session.
async fn archive(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "thread")?;
    archive_under(&m, &session)?;
    record(&m, &session, "archive", json!({"archived":true}))
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
/// and it may be offline. An archived thread is stopped again, in case it still runs.
pub(super) fn archive_under(m: &Arc<Manager>, id: &str) -> Result<(), Failure> {
    for (child, archived) in m.descendants(id) {
        retire(m, &child)?;
        if !archived {
            let _ = record(m, &child, "archive", json!({"id":child,"archived":true}))?;
        }
    }
    Ok(())
}

/// Stops an archived thread's turn, and its agent exits once that turn settles. It frees its memory now, not after
/// 30 idle minutes (feedback #614). A later message still resumes it.
pub(super) fn retire(m: &Arc<Manager>, id: &str) -> Result<(), Failure> {
    for command in ["stop", "sleep"] {
        let request =
            random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?;
        let _ = m.command(id, request, command, json!({}));
    }
    Ok(())
}

pub(super) fn session_failure(error: super::Error) -> Failure {
    let status = match error {
        super::Error::NotFound => StatusCode::NOT_FOUND,
        super::Error::Conflict(_) => StatusCode::CONFLICT,
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
    Json(input): Json<SpawnBody>,
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
    let mut note = SPAWN_NOTE.to_owned();
    if !input.shared {
        match own_sandbox_child(&m, &parent, &key, &input).await? {
            Some(thread) => {
                let _ = m.note(
                    &parent,
                    "child_state",
                    json!({"child":thread,"state":"running"}),
                );
                return Ok(Json(json!({"id":thread,"note":OWN_NOTE})));
            }
            None => note.push_str(FALLBACK_NOTE),
        }
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
        json!({"id":id,"harness":receipt.input["harness"],"model":receipt.model,"note":note}),
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

/// Asks the app to start the child in a sandbox of its own with a copy of this thread's code, and waits for
/// its answer. None means no answer: the app is closed or too old, so the child starts in this sandbox.
async fn own_sandbox_child(
    m: &Manager,
    parent: &str,
    key: &str,
    input: &SpawnBody,
) -> Result<Option<String>, Failure> {
    let mut data = json!({"id":format!("own_{key}"),"prompt":input.prompt});
    for (name, value) in [
        ("provider", &input.provider),
        ("model", &input.model),
        ("reasoning", &input.reasoning),
        ("title", &input.title.as_ref().map(|t| t.trim().to_owned())),
        ("service_tier", &input.service_tier),
    ] {
        if let Some(value) = value {
            data[name] = json!(value);
        }
    }
    match ask_app(m, parent, "child_request", data, APP_WAIT).await? {
        Asked::Started(thread) => Ok(Some(thread)),
        Asked::Refused(error) => Err(fail(
            StatusCode::CONFLICT,
            &format!(
                "The child could not start in its own sandbox: {error}. Retry, or add --shared-sandbox to start it here."
            ),
        )),
        Asked::Missed => Ok(None),
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
            serde_json::from_value(json!(p)).map_err(|_| {
                bad("Use --provider codex, claude-code, pi, opencode, hermes, devin, fx or openclaw")
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
        // After a recent miss a spawn shares this sandbox right away; a fork has no such fallback, so it asks.
        if kind == "child_request"
            && APP_MISSED
                .lock()
                .unwrap()
                .is_some_and(|at| at.elapsed() < APP_MISSED_FOR)
        {
            return Ok(Asked::Missed);
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
        Ok(Ok(Ok(thread))) => {
            *APP_MISSED.lock().unwrap() = None;
            Ok(Asked::Started(thread))
        }
        Ok(Ok(Err(error))) => Ok(Asked::Refused(error)),
        // No answer in time: decide under the lock, since the app may be answering right now.
        _ => {
            let mut children = CHILDREN.lock().unwrap();
            match children.get_mut(&slot) {
                Some(Outcome::Started(thread, _)) => Ok(Asked::Started(thread.clone())),
                Some(outcome) => {
                    *outcome = Outcome::Here(Instant::now());
                    // Only a missed spawn moves later spawns into this sandbox; an app may not know forks yet.
                    if kind == "child_request" {
                        *APP_MISSED.lock().unwrap() = Some(Instant::now());
                    }
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
    Json(input): Json<ForkBody>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread fork")?;
    let harness = check_start(
        &input.prompt,
        input.title.as_deref(),
        input.model.as_deref(),
        input.reasoning.as_deref(),
        input.provider.as_deref(),
    )?;
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
        return api
            .get("chat", &[("thread", &id), ("all", all)])
            .await
            .map(Json)
            .map_err(|error| website_failure(error, "read the child's chat"));
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    Ok(Json(
        m.children(&parent, Some(&id), true).await["children"][0].clone(),
    ))
}

async fn tell(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
    Json(input): Json<Tell>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread tell")?;
    if input.text.trim().is_empty() || input.text.len() > super::MAX_PROMPT {
        return Err(fail(
            StatusCode::CONFLICT,
            "Use a message of 1-262144 bytes",
        ));
    }
    if relay::thread_id(&id) {
        return relay::command(&m, &parent, &id, "tell", Some(&input.text)).await;
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    let request =
        random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?;
    deliver(&m, &id, &request, &input.text).await
}

/// Sends a message into the session's running turn, or else queues it. A request already delivered stays as it is,
/// so a retried relay never sends it twice.
pub(super) async fn deliver(
    m: &Arc<Manager>,
    id: &str,
    request: &str,
    text: &str,
) -> Result<Json<Value>, Failure> {
    let steer_id = format!("{request}_steer");
    if let Some(done) = m.receipt(id, request) {
        return Ok(Json(json!({"id":id,"state":done.state})));
    }
    // A steer that failed falls back to the queue, even on a retry.
    let steered = match m.receipt(id, &steer_id) {
        Some(s) if s.state != "failed" => return Ok(Json(json!({"id":id,"state":s.state}))),
        Some(_) => None,
        None => steer(m, id, &steer_id, text).await,
    };
    match steered.as_deref() {
        Some("completed") => {
            return Ok(Json(
                json!({"id":id,"state":"steered","note":"Sent into the child's running turn. Cloudroom tells you when that turn finishes."}),
            ));
        }
        Some(state) => {
            return Ok(Json(
                json!({"id":id,"state":state,"note":"Could not confirm the child's running turn got it. Check thread output before sending it again."}),
            ));
        }
        None => {}
    }
    let receipt = m
        .command(id, request.to_owned(), "prompt", json!({"text":text}))
        .map_err(session_failure)?;
    Ok(Json(
        json!({"id":id,"state":receipt.state,"note":"Queued. Cloudroom tells you when the child finishes it."}),
    ))
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
async fn steer(m: &Arc<Manager>, id: &str, request: &str, text: &str) -> Option<String> {
    let target = m
        .local
        .lock()
        .unwrap()
        .sessions
        .get(id)?
        .current_request
        .clone()?;
    let mut changed = m.subscribe();
    let input = json!({"text":text,"target_request_id":target});
    m.command(id, request.to_owned(), "steer", input).ok()?;
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

/// Stops the child's running turn and pauses its queue, like the app's stop button.
async fn stop_child(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Failure> {
    let parent = caller(&m, peer, "thread stop")?;
    if relay::thread_id(&id) {
        return relay::command(&m, &parent, &id, "stop", None).await;
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    let request =
        random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?;
    let receipt = m
        .command(&id, request, "stop", json!({}))
        .map_err(session_failure)?;
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
        return relay::command(&m, &parent, &id, "archive", None).await;
    }
    m.own_child(&parent, &id).map_err(session_failure)?;
    // A child that already ended has nothing to stop. Stop it first, so it starts no new children.
    retire(&m, &id)?;
    archive_under(&m, &id)?;
    record(&m, &id, "archive", json!({"id":id,"archived":true}))
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

/// The same `room-cli thread ... --self` forms local threads use. `--json` is accepted and
/// ignored because the answer is always JSON.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let words: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|word| *word != "--json")
        .collect();
    let help = words.iter().any(|word| matches!(*word, "--help" | "-h"));
    let (path, body) = match words.as_slice() {
        _ if help => {
            println!("{USAGE}");
            return Ok(0);
        }
        ["spawn", rest @ ..] => return spawn_cli(rest).await,
        ["fork", rest @ ..] => return fork_cli(rest).await,
        ["list", rest @ ..] => {
            let path = if rest.contains(&"--include-archived") {
                "/children?include_archived=true"
            } else {
                "/children"
            };
            let answer = crate::mac::request(crate::mac::SOCKET, "GET", path, None).await?;
            println!("{answer}");
            return Ok(0);
        }
        ["output", id] | ["output", id, "--all"] | ["output", "--all", id] => {
            let all = if words.contains(&"--all") {
                "?all=true"
            } else {
                ""
            };
            let answer = crate::mac::request(
                crate::mac::SOCKET,
                "GET",
                &format!("/children/{id}{all}"),
                None,
            )
            .await?;
            println!("{answer}");
            return Ok(0);
        }
        ["tell", id, text] | ["tell", id, "--prompt", text] => {
            let answer = crate::mac::request(
                crate::mac::SOCKET,
                "POST",
                &format!("/children/{id}/messages"),
                Some(json!({"text":text})),
            )
            .await?;
            println!("{answer}");
            return Ok(0);
        }
        ["update", "--self", "--title", title] | ["update", "--title", title, "--self"] => {
            ("/title", Some(json!({"title":title})))
        }
        ["update", "--self", "--reasoning-level", level]
        | ["update", "--reasoning-level", level, "--self"] => {
            ("/reasoning", Some(json!({"reasoning":level})))
        }
        ["archive", "--self"] => ("/archive", None),
        ["move", "--self", "--project", project] | ["move", "--project", project, "--self"] => {
            ("/move", Some(json!({"project":project})))
        }
        ["stop", "--self"] => {
            println!(
                "{}",
                json!({"stopped":true,"note":"Archiving a cloud thread stops it; nothing else to do."})
            );
            return Ok(0);
        }
        [action @ ("stop" | "archive"), id] if !id.starts_with('-') => {
            let answer = crate::mac::request(
                crate::mac::SOCKET,
                "POST",
                &format!("/children/{id}/{action}"),
                None,
            )
            .await?;
            println!("{answer}");
            return Ok(0);
        }
        _ => {
            println!(
                "{USAGE}\nRenames, archives, moves or changes the effort of this cloud thread, or starts, checks, stops and archives its child threads. --top-level starts a top-level thread instead of a child, only when the user asks for one."
            );
            return Ok(if words.is_empty() { 0 } else { 2 });
        }
    };
    let answer = crate::mac::request(crate::mac::SOCKET, "POST", path, body).await?;
    println!("{answer}");
    Ok(0)
}
