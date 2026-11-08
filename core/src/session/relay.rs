//! A Cloud parent and its children in sandboxes of their own reach each other through the website, so `tell`,
//! `stop`, `archive` and turn reports work while the user's Mac is off (ADR 0259). The website checks the link in its
//! own records, wakes the other sandbox and calls its `/relay`. This Core keeps each turn report until the website
//! takes it, and stays awake for it.
use super::{
    Local, Manager,
    children::{FINISHED, NOTICE_REPLY_CHARS, notice, notice_ids},
    history::ApiError,
    thread::{
        Failure, NO_PARENT, archive_under, deliver, fail, random_key, record, retire,
        session_failure, start_error, starting, website_failure,
    },
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

/// Since when reports have failed. After `GIVE_UP_AWAKE`, the sandbox may sleep; the next wake retries them.
static FAILING_SINCE: Mutex<Option<Instant>> = Mutex::new(None);
const GIVE_UP_AWAKE: Duration = Duration::from_secs(30 * 60);
/// The child starts a task drives right now, by session and request ID, so each has one.
static DRIVING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);
/// The spawns still waiting for their child's ID, by session and request ID: a refusal reaches the agent through one,
/// and through a notice once none waits (thread.rs).
pub(super) static WAITING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);
const APP_NOTE: &str = "Passed to the user's Cloudroom app, which applies it while it is open.";
/// Core can't tell whether the app counts this thread as the caller's child: the user may have moved it there.
const MAYBE_NOTE: &str = "Not linked to this thread, so it went to the user's Cloudroom app. The app applies it only to a thread this one started (such as one the user moved here), while it is open; otherwise nothing happens.";
/// The website's answer when the parent's Core refused the message (web/lib/mobile.ts).
const PARENT_BUSY: &str = "The other thread's Cloudroom is busy or updating. Try again shortly.";
fn unconfirmed(why: &str) -> String {
    format!(
        "Could not confirm your parent got it ({why}). It may have, so sending it again may deliver it twice."
    )
}
/// The website's answer for a thread that moved to the Mac (web/lib/mobile.ts, `threadCore`).
const MOVED: &str = "This thread moved to the Mac.";
const PARENT_MOVED: &str = "Not delivered: your parent moved to the user's Mac, and Cloud children can't message a Local parent yet. The app can still forward your completed-turn reply to your current Local parent while it is open.";
const STARTING: &str = "This child is still starting in its own sandbox. Retry in a few seconds.";

/// The website delivers here, with this Core's token.
pub fn routes() -> Router<Arc<Manager>> {
    Router::new().route("/v1/sessions/{id}/relay", post(receive))
}

/// An app thread ID, which `room-cli thread tell|stop|archive` take for a child in a sandbox of its own.
pub(crate) fn thread_id(id: &str) -> bool {
    id.strip_prefix("thr_").is_some_and(|key| {
        !key.is_empty()
            && key.len() <= 60
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    })
}

/// What the parent last knew of a child in its own sandbox, for `thread list`.
fn note_child(m: &Manager, parent: &str, child: &str, state: &str) {
    let _ = m.note(parent, "child_state", json!({"child":child,"state":state}));
}

/// Notes a start's outcome for `child` only while the parent knows it as starting, checked and written under one lock:
/// a late start answer never undoes a reply, stop or archive it heard since (#1058). False when it heard one.
fn note_start(m: &Manager, parent: &str, child: &str, state: &str) -> bool {
    let mut local = m.local.lock().unwrap();
    let known = local.sessions.get(parent).map(|s| &s.child_states);
    if known
        .and_then(|s| s.get(child))
        .is_some_and(|s| s != "starting")
    {
        return false;
    }
    let _ = local.append(
        parent,
        "child_state",
        json!({"child":child,"state":state}),
        None,
    );
    true
}

/// `tell`, `stop` or `archive` from the calling session to a child in a sandbox of its own. `to_parent`: a
/// `tell --parent`, which the website sends to the parent it saved now, not `id`, this session's first one (#968).
pub(super) async fn command(
    m: &Manager,
    caller: &str,
    id: &str,
    action: &str,
    text: Option<&str>,
    to_parent: bool,
) -> Result<Json<Value>, Failure> {
    // A caller sharing another thread's sandbox has no link of its own on the website: its children in sandboxes of
    // their own are linked to this sandbox's thread (ADR 20261104-015709), so commands for them go through the
    // website as that thread. Its `tell` to another thread does too, which reaches the same tree; `label` has the
    // website name that thread as the sender, since this caller's session ID means nothing in another sandbox
    // (#177). The app passes on its other commands, and what the website doesn't link, as before: it knows a child
    // the user moved under this caller, or one an older Core had the app start.
    let (shared, mine, up) = {
        let local = m.local.lock().unwrap();
        let session = local.sessions.get(caller);
        let mine = session.is_some_and(|s| s.child_states.contains_key(id));
        let up = to_parent || session.and_then(|s| s.parent_thread()) == Some(id);
        (
            session.is_some_and(|s| s.parent_session.is_some()),
            mine,
            up,
        )
    };
    let other = shared && !mine;
    let Some(api) = m
        .history
        .api
        .as_ref()
        .filter(|_| !other || action == "tell")
    else {
        return via_app(
            m,
            caller,
            id,
            action,
            text,
            if other { MAYBE_NOTE } else { APP_NOTE },
        );
    };
    let key = random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?;
    let body = json!({"action":action,"thread":id,"text":text,"request_id":format!("relay_{key}"),"label":other,"parent":to_parent});
    let failed = start_error(m, caller, id).filter(|_| action != "archive");
    let mut answer = match api.post_waking("relay", &body).await {
        // The website may not know a child that just started yet (#317).
        Err(ApiError::Status(404, _)) if starting(m, caller).iter().any(|c| c == id) => {
            return Err(fail(StatusCode::SERVICE_UNAVAILABLE, STARTING));
        }
        // Its start was refused, so no agent runs there to message or stop. A stop of one that never woke gets the
        // website's 409 "it may still start" instead, which a final refusal makes untrue (#1058).
        Err(ApiError::Status(status, _))
            if failed.is_some() && (status == 404 || (status == 409 && action == "stop")) =>
        {
            let why = failed.unwrap_or_default();
            return Err(fail(
                StatusCode::CONFLICT,
                &format!(
                    "This child could not be started ({why}), so nothing runs there. To clean it up: room-cli thread archive {id}"
                ),
            ));
        }
        Err(ApiError::Status(403 | 404, _)) if shared && !up => {
            return via_app(
                m,
                caller,
                id,
                action,
                text,
                if other { MAYBE_NOTE } else { APP_NOTE },
            );
        }
        // Core had no parent, and the website has none it can reach: as before (#994).
        Err(ApiError::Status(404, _)) if id == "parent" => {
            return Err(fail(StatusCode::CONFLICT, NO_PARENT));
        }
        // The parent may have it already, and a resend gets a new request ID, so never ask for one. Only the
        // website's own "parent busy" 503 means the parent refused it.
        Err(ApiError::Status(status, ref message))
            if id == "parent" && status >= 500 && !(status == 503 && message == PARENT_BUSY) =>
        {
            return Err(fail(
                StatusCode::BAD_GATEWAY,
                &unconfirmed(&format!("HTTP {status}")),
            ));
        }
        Err(ApiError::Network(_)) if id == "parent" => {
            return Err(fail(StatusCode::BAD_GATEWAY, &unconfirmed("network error")));
        }
        // Its parent moved to the Mac (#1015): the website refuses that closed Cloud session and never wakes it, and
        // nothing here reaches a Local parent yet. The same 410, in words the agent can act on.
        Err(ApiError::Status(410, message))
            if action == "tell" && up && !other && message == MOVED =>
        {
            return Err(fail(StatusCode::GONE, PARENT_MOVED));
        }
        answer => answer.map_err(|error| website_failure(error, "reach the child"))?,
    };
    let state = match action {
        "tell" => "running",
        "stop" => "stopped",
        _ => "archived",
    };
    if !other && id != "parent" {
        note_child(m, caller, id, state);
    }
    answer["id"] = json!(id);
    Ok(Json(answer))
}

/// The app applies it to a child the caller started, whenever it next reads the caller's thread.
fn via_app(
    m: &Manager,
    caller: &str,
    id: &str,
    action: &str,
    text: Option<&str>,
    note: &str,
) -> Result<Json<Value>, Failure> {
    let mut data = json!({"id":id,"action":action});
    if let Some(text) = text {
        data["text"] = json!(text);
    }
    let _ = record(m, caller, "child_command", data)?;
    Ok(Json(json!({"id":id,"state":"requested","note":note})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Relayed {
    request_id: String,
    action: String,
    #[serde(default)]
    text: Option<String>,
    /// A report: the child's thread ID and title, from the website's records, and how its turn ended.
    #[serde(default)]
    child: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    reply: Option<String>,
}

/// A message for this session from a related thread in another sandbox. A retried request does nothing new.
async fn receive(
    State(m): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(input): Json<Relayed>,
) -> Result<Json<Value>, Failure> {
    let bad = |message: &str| fail(StatusCode::BAD_REQUEST, message);
    let request = input.request_id;
    if request.is_empty()
        || request.len() > 58
        || !request
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(bad("invalid request_id"));
    }
    // A child that a session sharing this sandbox started is linked to this sandbox's thread: its reports and
    // messages go to the session that started it.
    let from = match input.action.as_str() {
        "report" => input.child.clone(),
        "tell" => input.text.as_deref().and_then(|t| {
            let rest = t.strip_prefix("[bb message from thread:")?;
            Some(rest[..rest.find(']')?].to_owned())
        }),
        _ => None,
    };
    let owner = from.as_deref().and_then(|child| starter(&m, child));
    // A report from a child no session here has named yet, while a start is still unnamed, may be that start's:
    // it waits, so it can't land on the wrong session.
    if input.action == "report" && owner.is_none() && unnamed_start(&m.local.lock().unwrap()) {
        return Err(fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "This child's start isn't recorded yet. Retry shortly.",
        ));
    }
    let id = owner.unwrap_or(id);
    let archived = m
        .local
        .lock()
        .unwrap()
        .sessions
        .get(&id)
        .map(|s| s.archived)
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Unknown session"))?;
    let text = match input.action.as_str() {
        "tell" => input
            .text
            .filter(|t| !t.trim().is_empty() && t.len() <= super::MAX_PROMPT)
            .ok_or_else(|| bad("invalid text"))?,
        "report" => {
            let child = input.child.filter(|c| thread_id(c));
            let child = child.ok_or_else(|| bad("invalid child"))?;
            let state = input.state.as_deref().unwrap_or("unknown");
            let known = match state {
                "completed" => "replied",
                "interrupted" => "stopped",
                _ => "error",
            };
            note_child(&m, &id, &child, known);
            notice(&child, input.title, state, input.error, input.reply)
        }
        // Then its agent exits with everything it started, like `thread stop` in one sandbox (#607), Codex aside.
        "stop" => {
            let receipt = m
                .command(&id, request.clone(), "stop", json!({}))
                .map_err(session_failure)?;
            if m.stop_sleeps(&id) {
                let sleep = json!({"end_jobs":true});
                let _ = m.command(&id, format!("{request}_sleep"), "sleep", sleep);
            }
            return Ok(Json(json!({"id":id,"state":receipt.state})));
        }
        // Like `thread archive --self`: the app archives it whenever it next reads the thread.
        "archive" => {
            retire(&m, &id)?;
            let kept = archive_under(&m, &id)?;
            if !archived {
                let _ = record(
                    &m,
                    &id,
                    "archive",
                    json!({"archived":true,"kept_live":kept}),
                )?;
            }
            return Ok(Json(json!({"id":id,"state":"archived"})));
        }
        _ => return Err(bad("unknown action")),
    };
    let answer = deliver(&m, &id, &request, &text, true).await?;
    // A steer not yet confirmed may still fail; the sender retries, and a failed steer is then queued instead.
    let steering = m.receipt(&id, &format!("{request}_steer"));
    if m.receipt(&id, &request).is_none() && steering.is_some_and(|s| s.state == "accepted") {
        return Err(fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Not confirmed yet. Retry.",
        ));
    }
    Ok(answer)
}

/// The session sharing this sandbox that started `child` through the website. The thread's own sessions take what
/// the website addresses to it: after a model switch, that is the current one, not the one that started it.
fn starter(m: &Manager, child: &str) -> Option<String> {
    let local = m.local.lock().unwrap();
    local
        .sessions
        .values()
        .find(|s| s.parent_session.is_some() && s.started.contains(child))
        .map(|s| s.session_id.clone())
}

/// A child start here the website hasn't named yet.
fn unnamed_start(local: &Local) -> bool {
    local.sessions.values().any(|s| {
        !s.archived
            && s.child_starts
                .values()
                .any(|c| c.child.is_none() && !c.done && c.error.is_none())
    })
}

/// The first finished turn not yet reported, of a session whose parent runs in another sandbox.
fn next_report(local: &Local) -> Option<(String, String, Value)> {
    local
        .sessions
        .values()
        .filter(|s| !s.archived && s.parent_thread().is_some())
        .find_map(|s| {
            let r = s.receipts.values().find(|r| {
                r.command == "prompt"
                    && FINISHED.contains(&r.state.as_str())
                    && !s.reported.contains(&r.request_id)
            })?;
            let reply = s
                .replies
                .iter()
                .find(|(id, _)| *id == r.request_id)
                .map(|(_, text)| text.chars().take(NOTICE_REPLY_CHARS + 1).collect::<String>());
            let (_, queued) = notice_ids(&s.session_id, &r.request_id);
            let error = r.error.as_ref().map(|e| e.chars().take(2000).collect::<String>());
            let body = json!({"action":"report","request_id":queued,"state":r.state,"error":error,"reply":reply});
            Some((s.session_id.clone(), r.request_id.clone(), body))
        })
}

/// `thread list` also shows children in sandboxes of their own, at any depth, from the website's links (ADR 0256):
/// what this thread last heard of each, or else its sandbox's state. Ones started in the last few minutes show as
/// `starting` until their sandbox wakes, linked or not.
pub(super) async fn own_children(m: &Manager, caller: &str, archived: bool, answer: &mut Value) {
    // The website links every child started here to this sandbox's thread: each session lists the ones it started,
    // and the sandbox's thread also those an older app started.
    let (shared, known, mine, others) = {
        let local = m.local.lock().unwrap();
        let session = local.sessions.get(caller);
        // Only sessions sharing the sandbox keep theirs apart: the thread lists what its earlier sessions started.
        let others: HashSet<String> = local
            .sessions
            .values()
            .filter(|s| s.session_id != caller && s.parent_session.is_some())
            .flat_map(|s| s.started.iter().cloned())
            .collect();
        (
            session.is_some_and(|s| s.parent_session.is_some()),
            session.map(|s| s.child_states.clone()).unwrap_or_default(),
            session.map(|s| s.started.clone()).unwrap_or_default(),
            others,
        )
    };
    let Some(api) = m
        .history
        .api
        .as_ref()
        .filter(|_| !shared || !mine.is_empty())
    else {
        return;
    };
    let flag = if archived { "1" } else { "0" };
    // Without the website's list, the children started in the last few minutes still show.
    let found = match api.get("children", &[("archived", flag)]).await {
        Ok(found) => found,
        Err(error) => {
            answer["note"] = json!(format!(
                "Children in sandboxes of their own are missing: {error}. Retry."
            ));
            Value::Null
        }
    };
    let Some(list) = answer["children"].as_array_mut() else {
        return;
    };
    let recent = starting(m, caller);
    for child in found["children"].as_array().into_iter().flatten() {
        let id = child["id"].as_str().unwrap_or_default();
        if if shared {
            !mine.contains(id)
        } else {
            others.contains(id)
        } {
            continue;
        }
        let sandbox = child["state"].as_str().unwrap_or("unknown");
        let state = match sandbox {
            "archived" | "deleted" => "archived",
            "new" if recent.iter().any(|c| c == id) => "starting",
            _ => known.get(id).map_or(sandbox, String::as_str),
        };
        let mut item = json!({"id":id,"title":child["title"],"state":state,"parent":child["parent"],"sandbox":"own"});
        // Its sandbox didn't start yet, say after a failed wake, or its start was refused (#1058).
        let refused = start_error(m, caller, id).filter(|_| state == "error");
        if let Some(issue) = refused.as_deref().or(child["issue"].as_str()) {
            item["issue"] = json!(issue);
        }
        list.push(item);
    }
    // Children the app just started that the website doesn't link to this thread yet (#317).
    for id in recent {
        let archived = known.get(&id).is_some_and(|s| s == "archived");
        if !archived && !list.iter().any(|c| c["id"] == id.as_str()) {
            list.push(json!({"id":id,"title":null,"state":"starting","sandbox":"own"}));
        }
    }
}

/// Keeps when reports started failing, until one goes through.
fn failed(now: bool) {
    let mut since = FAILING_SINCE.lock().unwrap();
    *since = if now {
        since.or(Some(Instant::now()))
    } else {
        None
    };
}

/// A report still waits for the website, so the sandbox must not sleep yet, unless it has failed for a long time.
pub(super) fn report_pending(local: &Local) -> bool {
    let failing = FAILING_SINCE.lock().unwrap();
    next_report(local).is_some() && failing.is_none_or(|since| since.elapsed() < GIVE_UP_AWAKE)
}

/// Child starts the website hasn't finished, by session, request ID and the request to repeat. An archived thread's
/// stay unstarted.
fn pending_starts(local: &Local) -> Vec<(String, String, Value)> {
    local
        .sessions
        .values()
        .filter(|s| !s.archived)
        .flat_map(|s| {
            s.child_starts
                .iter()
                .filter(|(_, start)| !start.done && start.error.is_none())
                .map(|(request, start)| (s.session_id.clone(), request.clone(), start.body.clone()))
        })
        .collect()
}

/// Since when child starts have failed, until one call goes through.
static STARTS_FAILING: Mutex<Option<Instant>> = Mutex::new(None);

/// A child start still waits for the website, so the sandbox must not sleep yet, unless calls have failed for a
/// long time. It stays saved either way: the next wake goes on with it.
pub(super) fn start_pending(local: &Local) -> bool {
    let failing = *STARTS_FAILING.lock().unwrap();
    !pending_starts(local).is_empty() && failing.is_none_or(|since| since.elapsed() < GIVE_UP_AWAKE)
}

/// Whether this start still waits: not settled, not cancelled, and its thread not archived.
fn still_pending(m: &Manager, session: &str, request: &str) -> bool {
    let local = m.local.lock().unwrap();
    local.sessions.get(session).is_some_and(|s| {
        !s.archived
            && s.child_starts
                .get(request)
                .is_some_and(|c| !c.done && c.error.is_none())
    })
}

/// Repeats a child start until the website says its first prompt is in (each call continues the same start, keyed by
/// this thread and the request ID), refuses it for good, or its thread is archived. Outages are never final: the
/// request stays saved. The parent hears of a refusal the agent wasn't told.
async fn drive_start(
    m: Arc<Manager>,
    api: super::history::Api,
    session: String,
    request: String,
    body: Value,
) {
    let mut wait = Duration::from_secs(3);
    // The child's ID, for the notice of a failure.
    let mut named = m
        .local
        .lock()
        .unwrap()
        .sessions
        .get(&session)
        .and_then(|s| s.child_starts.get(&request)?.child.clone());
    let error = loop {
        if m.is_stopping() || !still_pending(&m, &session, &request) {
            break None;
        }
        let answer = api.post_waking("child", &body).await;
        {
            let mut failing = STARTS_FAILING.lock().unwrap();
            *failing = match &answer {
                Ok(_) | Err(ApiError::Status(..500, _)) => None,
                Err(_) => failing.or(Some(Instant::now())),
            };
        }
        match answer {
            Ok(answer) => {
                let Some(child) = answer["id"].as_str().filter(|c| thread_id(c)) else {
                    break Some("the website gave no thread ID".to_owned());
                };
                let started = answer["started"] == true;
                note_start(
                    &m,
                    &session,
                    child,
                    if started { "running" } else { "starting" },
                );
                if started {
                    // The app shows it under this thread, Mac on or off (ADR 20261104-015709).
                    let _ = m.note(&session, "own_child", answer.clone());
                }
                if m.note(
                    &session,
                    "child_start_state",
                    json!({"request_id":request,"child":child,"done":started}),
                )
                .is_ok()
                {
                    named = Some(child.to_owned());
                }
                if started {
                    break None;
                }
                // The website keeps starting it meanwhile.
                wait = Duration::from_secs(10);
            }
            // Refused for good: out of credits, a missing login, an archived parent.
            Err(ApiError::Status(status, error)) if status < 500 => break Some(error),
            Err(_) => {}
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(300));
    };
    if let Some(error) = error {
        let error = error.trim().trim_end_matches('.').to_owned();
        // Recorded under the waiting spawns' lock: a spawn still waiting answers with it, and the parent hears it here
        // only once none does, once per request (thread.rs).
        let (recorded, waiting) = {
            let waiting = WAITING.lock().unwrap();
            let recorded = m
                .note(
                    &session,
                    "child_start_state",
                    json!({"request_id":request,"error":error}),
                )
                .is_ok();
            (recorded, waiting.contains(&format!("{session}/{request}")))
        };
        // A named child shows the refusal in `list`, `output` and `tell` even when a waiting spawn answers with it. One
        // the parent has heard of since (say, archived it) keeps that, and gets no late failure notice.
        let fresh = named
            .as_deref()
            .is_none_or(|child| recorded && note_start(&m, &session, child, "error"));
        if recorded && !waiting && fresh {
            let text = match &named {
                Some(child) => {
                    format!("[Cloudroom] Child thread {child} could not be started: {error}.")
                }
                None => format!(
                    "[Cloudroom] The child thread you spawned with request ID {request} could not be started: {error}."
                ),
            };
            let id: String = request.chars().take(40).collect();
            let _ = deliver(&m, &session, &format!("start_{id}"), &text, true).await;
        }
    }
    DRIVING
        .lock()
        .unwrap()
        .remove(&format!("{session}/{request}"));
}

impl Manager {
    /// Drives each child start the website hasn't finished, saved or new, one task per start.
    pub(super) fn watch_child_starts(self: &Arc<Self>, local: &Local) {
        let Some(api) = self.history.api.clone() else {
            return;
        };
        let manager = self.clone();
        let mut changed = local.changed.subscribe();
        tokio::spawn(async move {
            while !manager.is_stopping() {
                let due = pending_starts(&manager.local.lock().unwrap());
                for (session, request, body) in due {
                    if DRIVING
                        .lock()
                        .unwrap()
                        .insert(format!("{session}/{request}"))
                    {
                        tokio::spawn(drive_start(
                            manager.clone(),
                            api.clone(),
                            session,
                            request,
                            body,
                        ));
                    }
                }
                if changed.changed().await.is_err() {
                    return;
                }
            }
        });
    }

    /// Reports each finished turn of a child whose parent runs in another sandbox, until the website takes it.
    /// One task for this Core's life: a report that fails waits and retries, so later ones keep their order.
    pub(super) fn watch_reports(self: &Arc<Self>, local: &Local) {
        let Some(api) = self.history.api.clone() else {
            return;
        };
        let manager = self.clone();
        let mut changed = local.changed.subscribe();
        tokio::spawn(async move {
            let mut wait = Duration::from_secs(5);
            while !manager.is_stopping() {
                let due = next_report(&manager.local.lock().unwrap());
                let Some((session, turn, body)) = due else {
                    if changed.changed().await.is_err() {
                        return;
                    }
                    continue;
                };
                // Taken, or refused for good (410: the parent is gone or archived): never sent again.
                let done = match api.post_waking("relay", &body).await {
                    Ok(_) | Err(ApiError::Status(400 | 403 | 410, _)) => manager
                        .note(&session, "parent_report", json!({"request_id":turn}))
                        .is_ok(),
                    Err(_) => false,
                };
                failed(!done);
                if done {
                    wait = Duration::from_secs(5);
                    continue;
                }
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(300));
            }
        });
    }
}
