//! A Cloud parent and its children in sandboxes of their own reach each other through the website, so `tell`,
//! `stop`, `archive` and turn reports work while the user's Mac is off (ADR 0259). The website checks the link in its
//! own records, wakes the other sandbox and calls its `/relay`. This Core keeps each turn report until the website
//! takes it, and stays awake for it.
use super::{
    Local, Manager, Session, SessionState,
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
    http::{HeaderMap, StatusCode},
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
/// The same for a thread's own reports to the website (#237).
static THREAD_FAILING_SINCE: Mutex<Option<Instant>> = Mutex::new(None);
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
/// A relayed `tell --mode queue` ends its request ID with this: the website passes on only the ID and text, and an
/// older Core ignores it and steers, as before (#1517).
const QUEUE: &str = "_queue";

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

/// What the parent last knew of a child in its own sandbox, for `thread list`, and the reports it may still send.
fn note_child(m: &Manager, parent: &str, child: &str, state: &str, late: &Value) {
    let data = json!({"child":child,"state":state,"late":late});
    let _ = m.note(parent, "child_state", data);
}

/// Notes a start's outcome for `child` only while the parent knows it as starting, checked and written under one lock:
/// a late start answer never undoes a reply, stop or archive it heard since (#1058). False when it heard one.
fn note_start(m: &Manager, parent: &str, child: &str, state: &str) -> bool {
    note_unless(m, parent, child, state, |s| {
        s.child_states.get(child).is_some_and(|s| s != "starting")
    })
}

/// Notes `state` for `child` unless what the parent knows `kept` it, checked and written under one lock.
fn note_unless(
    m: &Manager,
    parent: &str,
    child: &str,
    state: &str,
    kept: impl FnOnce(&super::Session) -> bool,
) -> bool {
    let mut local = m.local.lock().unwrap();
    if local.sessions.get(parent).is_some_and(kept) {
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
    queue: bool,
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
    let request = format!("relay_{key}{}", if queue { QUEUE } else { "" });
    let body = json!({"action":action,"thread":id,"text":text,"request_id":request,"label":other,"parent":to_parent});
    let failed = start_error(m, caller, id).filter(|_| action != "archive");
    let mut answer = match api.post_waking("relay", &body).await {
        // The website may not know a child that just started yet (#317).
        Err(ApiError::Status(404, _)) if starting(m, caller, true).iter().any(|c| c == id) => {
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
        // An archive its child's Core took names the reports it may still send (#1000); a queued one names none.
        let late = answer["late"].take();
        note_child(m, caller, id, state, &late);
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
    headers: HeaderMap,
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
        "tell" => input.text.as_deref().and_then(tell_sender),
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
            // A report the archived child had in flight never shows it again (#1000). Any other report updates it,
            // say from a session that replaced it after a restore.
            note_unless(&m, &id, &child, known, |s| {
                s.child_states.get(&child).is_some_and(|s| s == "archived")
                    && s.late_reports
                        .get(&child)
                        .is_some_and(|l| l.contains(&request))
            });
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
                    json!({"archived":true,"kept_live":kept,"wake":m.wake_id()}),
                )?;
            }
            // Archived, it sends no new reports, but one may be in flight, and an earlier session of this thread (say,
            // before a harness switch) may still send its own: the parent holds the archive against those.
            let local = m.local.lock().unwrap();
            let sending = local
                .sessions
                .values()
                .filter(|s| s.session_id == id || (!s.archived && s.parent_thread().is_some()));
            let late: Vec<String> = sending
                .flat_map(|s| unreported(s).map(|r| notice_ids(&s.session_id, &r.request_id).1))
                .collect();
            drop(local);
            return Ok(Json(json!({"id":id,"state":"archived","late":late})));
        }
        _ => return Err(bad("unknown action")),
    };
    // The thread that sent a tell, from the website's own records (web/lib/mobile.ts): the app then shows it as that
    // agent's message, as in Local (#1369). A header, since older Cores refuse unknown body fields.
    let sender = headers
        .get("x-cloudroom-sender")
        .and_then(|v| v.to_str().ok());
    let mut prompt = json!({"text":text});
    if let Some(sender) = sender.filter(|s| input.action == "tell" && thread_id(s)) {
        prompt["sender_thread_id"] = json!(sender);
    }
    let queue = input.action == "tell" && request.ends_with(QUEUE);
    let answer = deliver(&m, &id, &request, prompt, true, None, queue).await?;
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

/// The thread a relayed message names as its sender. `[bb message ...]` is what every sender writes today; the plain
/// tag is read too, so senders can drop the "bb" once every Core reads both.
fn tell_sender(text: &str) -> Option<String> {
    let rest = text
        .strip_prefix("[bb message from thread:")
        .or_else(|| text.strip_prefix("[message from thread:"))?;
    Some(rest[..rest.find(']')?].to_owned())
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

/// A session's finished turns not yet reported to its parent in another sandbox.
fn unreported(s: &super::Session) -> impl Iterator<Item = &super::Receipt> {
    s.receipts.values().filter(|r| {
        r.command == "prompt"
            && FINISHED.contains(&r.state.as_str())
            && !s.reported.contains(&r.request_id)
    })
}

/// The first finished turn not yet reported, of a session whose parent runs in another sandbox. An archived one
/// reports only the turn it archived itself in, so its parent hears how its task ended.
fn next_report(local: &Local) -> Option<(String, String, Value)> {
    local
        .sessions
        .values()
        .filter(|s| s.parent_thread().is_some())
        .find_map(|s| {
            let r = unreported(s)
                .find(|r| !s.archived || s.archive_turn.as_ref() == Some(&r.request_id))?;
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
    let (shared, known, mine, others, archiving) = {
        let local = m.local.lock().unwrap();
        let session = local.sessions.get(caller);
        // Archived here in the last 10 minutes: the website tries a queued archive for 2, then says if it failed.
        let since = crate::observability::now_ms().saturating_sub(10 * 60_000);
        let archiving: HashSet<String> = (session.into_iter())
            .flat_map(|s| s.child_archived_at.iter().filter(|(_, at)| **at > since))
            .map(|(child, _)| child.clone())
            .collect();
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
            archiving,
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
    let recent = starting(m, caller, false);
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
        let starting = recent.iter().any(|c| c == id);
        let state = shown(
            sandbox,
            known.get(id).map(String::as_str),
            starting,
            archiving.contains(id),
        );
        // The website may still list a child that was archived a moment ago.
        if state == "archived" && !archived {
            continue;
        }
        let status = super::children::status(state, false);
        let mut item = json!({"id":id,"title":child["title"],"state":state,"status":status,"parent":child["parent"],"sandbox":"own"});
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
            list.push(
                json!({"id":id,"title":null,"state":"starting","status":"active","sandbox":"own"}),
            );
        }
    }
}

/// A child's state in `thread list`: its sandbox's, or what this thread last heard of it. `archiving`: this thread
/// archived it a moment ago.
fn shown<'a>(sandbox: &'a str, known: Option<&'a str>, starting: bool, archiving: bool) -> &'a str {
    match sandbox {
        "archived" | "deleted" => "archived",
        // The website lists it until the archive lands, and an asleep one's waits for a wake (#1430). Later, asleep
        // means it never landed or the user restored it.
        _ if archiving => "archived",
        "new" if starting => "starting",
        // A sandbox that sleeps or failed runs nothing, whatever its last report here said.
        "asleep" | "failed" => sandbox,
        _ => known.unwrap_or(sandbox),
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
    let fresh = |failing: &Mutex<Option<Instant>>| {
        failing
            .lock()
            .unwrap()
            .is_none_or(|since| since.elapsed() < GIVE_UP_AWAKE)
    };
    (next_report(local).is_some() && fresh(&FAILING_SINCE))
        || (next_thread_report(local).is_some() && fresh(&THREAD_FAILING_SINCE))
}

/// The next change a thread owes the website (#237), oldest first. A switch's new session waits until its `continue`
/// landed. An archive waits for the end of its turn and for every other visible thread in the sandbox (a child, a
/// side chat) to be archived too, since the website row is the whole sandbox (docs/scopes/sandboxes.md).
fn next_thread_report(local: &Local) -> Option<(String, Value)> {
    let visible = |s: &Session| {
        !s.archived
            && s.close_request.is_none()
            && !matches!(
                s.state,
                SessionState::Closing
                    | SessionState::Closed
                    | SessionState::Failed
                    | SessionState::ProcessLost
                    | SessionState::SavedHistoryOnly
            )
    };
    local.sessions.values().find_map(|s| {
        let report = s.thread_reports.first()?;
        let waiting = local
            .sessions
            .values()
            .any(|o| o.continuing.as_deref() == Some(&s.session_id));
        let archive = report["kind"] == "archived";
        let others = || {
            local
                .sessions
                .values()
                .any(|o| o.session_id != s.session_id && visible(o))
        };
        (!waiting && s.parent_session.is_none() && !(archive && (s.busy() || others())))
            .then(|| (s.session_id.clone(), report.clone()))
    })
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
            let id = format!("start_{}", request.chars().take(40).collect::<String>());
            let prompt = json!({"text":text});
            let _ = deliver(&m, &session, &id, prompt, true, None, false).await;
        }
    }
    DRIVING
        .lock()
        .unwrap()
        .remove(&format!("{session}/{request}"));
}

impl super::Session {
    /// The agent's own rename or effort, owed to the website (#237). Only the latest of each, and never a session
    /// sharing another's sandbox: the website row belongs to the sandbox's thread.
    /// Only a record that names its wake is owed: older Cores' records, replayed after an upgrade, and the user's own
    /// changes (which the app sent) never are. The website drops a report from an earlier wake.
    pub(super) fn owe(&mut self, kind: &str, data: &Value, sequence: u64) {
        let value = if kind == "archived" {
            Value::Bool(true)
        } else {
            data[kind].clone()
        };
        self.thread_reports.retain(|report| report["kind"] != kind);
        if self.parent_session.is_some()
            || !data["wake"].is_string()
            || data["user"] == true
            || value.is_null()
        {
            return;
        }
        self.thread_reports
            .push(json!({"kind":kind,"value":value,"seq":sequence,"wake":data["wake"]}));
    }
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

    /// Reports this thread's own changes to the website, which every computer follows (#237): its agent's rename and
    /// effort, and its archive. Kept until the website takes or refuses it; one task for this Core's life.
    pub(super) fn watch_thread_reports(self: &Arc<Self>, local: &Local) {
        let Some(api) = self.history.api.clone() else {
            return;
        };
        let manager = self.clone();
        let mut changed = local.changed.subscribe();
        tokio::spawn(async move {
            let mut wait = Duration::from_secs(5);
            while !manager.is_stopping() {
                let due = next_thread_report(&manager.local.lock().unwrap());
                let Some((session, report)) = due else {
                    if changed.changed().await.is_err() {
                        return;
                    }
                    continue;
                };
                let (seq, kind) = (
                    report["seq"].clone(),
                    report["kind"].as_str().unwrap_or_default().to_owned(),
                );
                // The wake the change was made in: one from an earlier wake (the thread may have been archived
                // and restored meanwhile) is dropped by the website.
                let mut body = json!({"request_id":format!("report_{seq}"),"session":session,"wake":report["wake"]});
                body[kind.as_str()] = report["value"].clone();
                // Taken, or refused for good (409: not the thread's session now): never sent again.
                let done = match api.post("thread", &body).await {
                    Ok(_) | Err(ApiError::Status(400 | 403 | 404 | 409 | 410, _)) => manager
                        .note(&session, "thread_report", json!({"seq":seq}))
                        .is_ok(),
                    Err(_) => false,
                };
                // Its own give-up clock, apart from the turn reports' (`failed`).
                {
                    let mut failing = THREAD_FAILING_SINCE.lock().unwrap();
                    *failing = if done {
                        None
                    } else {
                        Some(failing.unwrap_or_else(Instant::now))
                    };
                }
                if done {
                    wait = Duration::from_secs(5);
                    continue;
                }
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(300));
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
                // The parent reads this turn with `thread output`, from saved history: save it first (#1410). The
                // uploader's own upload, 2 s after idle, also takes the harness's last lines, so one covers the turn.
                // While uploads fail, the report goes at once.
                manager.flush_history(Duration::from_secs(5), true).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    struct ChildList {
        m: Arc<Manager>,
        dir: std::path::PathBuf,
        website: Arc<Mutex<[(StatusCode, Value); 2]>>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Drop for ChildList {
        fn drop(&mut self) {
            self.server.abort();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl ChildList {
        async fn open(name: &str) -> Self {
            let website = Arc::new(Mutex::new([
                (StatusCode::OK, json!({"children":[]})),
                (StatusCode::OK, json!({"children":[]})),
            ]));
            let app = Router::new()
                .route(
                    "/children",
                    axum::routing::get(
                        |State(website): State<Arc<Mutex<[(StatusCode, Value); 2]>>>,
                         axum::extract::Query(query): axum::extract::Query<
                            std::collections::HashMap<String, String>,
                        >| async move {
                            let all = query.get("archived").is_some_and(|s| s == "1");
                            let (status, body) = website.lock().unwrap()[usize::from(all)].clone();
                            (status, Json(body))
                        },
                    ),
                )
                .with_state(website.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let api_url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let dir = std::env::temp_dir().join(format!(
                "cloudroom-child-list-{name}-{}",
                std::process::id()
            ));
            let mut local = Local::open(&dir).unwrap();
            for (parent, child) in [("main", "thr_kid"), ("shared", "thr_peer")] {
                for (kind, data) in [
                    ("child_start", json!({"request_id":"r1","body":{}})),
                    (
                        "child_start_state",
                        json!({"request_id":"r1","child":child,"done":true}),
                    ),
                    ("child_state", json!({"child":child,"state":"running"})),
                    // Telling a thread by ID also records a state; it does not make it a child.
                    (
                        "child_state",
                        json!({"child":"thr_stranger","state":"running"}),
                    ),
                ] {
                    local.append(parent, kind, data, None).unwrap();
                }
            }
            local.append("shared", "receipt", json!({"request_id":"s","command":"start","state":"completed","input":{"parent_session":"host"}}), None).unwrap();
            drop(local);
            // Reopen the journal, so every listing uses durable ownership and state.
            let config = crate::config::Config {
                listen: "127.0.0.1:0".parse().unwrap(),
                token: "t".repeat(32),
                state_dir: dir.clone(),
                repository: dir.clone(),
                api_url: Some(api_url),
                store: "test".into(),
                instance: None,
                account_home: dir.clone(),
                default_harness: crate::runtime::Kind::Codex,
                harnesses: [(
                    crate::runtime::Kind::Codex,
                    crate::config::HarnessConfig {
                        binary: "/bin/false".into(),
                        home: dir.clone(),
                        model: "fixture".into(),
                        provider: None,
                    },
                )]
                .into(),
                storage: None,
                rpc_timeout: Duration::from_secs(30),
                diagnostic_upload: Duration::from_secs(3600),
            };
            Self {
                m: Manager::open(config).unwrap(),
                dir,
                website,
                server,
            }
        }

        async fn list(&self, caller: &str, archived: bool) -> Value {
            let mut answer = self.m.children(caller, None, archived).await;
            own_children(&self.m, caller, archived, &mut answer).await;
            answer
        }

        fn found(&self, children: Value) {
            *self.website.lock().unwrap() = [
                (StatusCode::OK, json!({"children":children})),
                (StatusCode::OK, json!({"children":children})),
            ];
        }
    }

    #[tokio::test]
    async fn child_list_keeps_a_durable_running_child_when_the_website_omits_it() {
        let f = ChildList::open("running").await;
        // Control: the same child appears when the website includes it.
        f.found(json!([{"id":"thr_kid","state":"running","title":"Child","parent":"thr_parent"}]));
        let listed = f.list("main", false).await;
        assert_eq!(listed["children"].as_array().unwrap().len(), 1);
        assert_eq!(listed["children"][0]["title"], "Child");
        assert!(listed["children"][0]["note"].is_null());
        f.found(json!([]));
        let missing = f.list("main", false).await;
        assert_eq!(
            missing["children"].as_array().unwrap().len(),
            1,
            "{missing}"
        );
        let child = &missing["children"][0];
        assert_eq!(child["id"], "thr_kid");
        assert_eq!(child["state"], "running");
        assert_eq!(child["sandbox"], "own");
        assert!(child["note"].as_str().unwrap().contains("last known"));
        assert!(child["note"].as_str().unwrap().contains("unconfirmed"));
    }

    #[tokio::test]
    async fn child_list_keeps_started_children_without_guessing_their_state() {
        let f = ChildList::open("unknown").await;
        f.m.local
            .lock()
            .unwrap()
            .sessions
            .get_mut("main")
            .unwrap()
            .child_states
            .remove("thr_kid");
        let answer = f.list("main", false).await;
        assert_eq!(answer["children"].as_array().unwrap().len(), 1, "{answer}");
        assert_eq!(answer["children"][0]["state"], "unknown");
    }

    #[tokio::test]
    async fn child_list_preserves_shared_sandbox_ownership_and_deduplicates_ids() {
        let f = ChildList::open("ownership").await;
        for (caller, id) in [("main", "thr_kid"), ("shared", "thr_peer")] {
            let answer = f.list(caller, false).await;
            assert_eq!(answer["children"].as_array().unwrap().len(), 1, "{answer}");
            assert_eq!(answer["children"][0]["id"], id);
        }
        f.found(json!([
            {"id":"thr_kid","state":"running"},
            {"id":"thr_peer","state":"running"},
            {"id":"thr_kid","state":"running"},
            {"id":"thr_peer","state":"running"}
        ]));
        for (caller, id) in [("main", "thr_kid"), ("shared", "thr_peer")] {
            let answer = f.list(caller, false).await;
            assert_eq!(answer["children"].as_array().unwrap().len(), 1, "{answer}");
            assert_eq!(answer["children"][0]["id"], id);
        }
    }

    #[tokio::test]
    async fn child_list_does_not_restore_archived_children_from_last_known_state() {
        let f = ChildList::open("archived").await;
        note_child(&f.m, "main", "thr_kid", "archived", &Value::Null);
        assert_eq!(f.list("main", false).await["children"], json!([]));
        let answer = f.list("main", true).await;
        assert_eq!(answer["children"].as_array().unwrap().len(), 1, "{answer}");
        assert_eq!(answer["children"][0]["state"], "archived");
        // A stale running report must not resurrect an archive/deletion the website knows about.
        note_child(&f.m, "main", "thr_kid", "running", &Value::Null);
        for state in ["archived", "deleted"] {
            f.website.lock().unwrap()[1].1 = json!({"children":[{"id":"thr_kid","state":state}]});
            assert_eq!(f.list("main", false).await["children"], json!([]));
            let answer = f.list("main", true).await;
            assert_eq!(answer["children"].as_array().unwrap().len(), 1);
            assert_eq!(answer["children"][0]["state"], "archived");
        }
    }

    #[tokio::test]
    async fn child_list_does_not_guess_when_the_archive_check_fails() {
        let f = ChildList::open("unavailable").await;
        f.website.lock().unwrap()[1].0 = StatusCode::SERVICE_UNAVAILABLE;
        assert_eq!(f.list("main", false).await["children"], json!([]));
        f.website.lock().unwrap()[0].0 = StatusCode::SERVICE_UNAVAILABLE;
        let answer = f.list("main", false).await;
        assert_eq!(answer["children"], json!([]));
        assert!(answer["note"].as_str().unwrap().contains("HTTP 503"));
    }

    #[test]
    fn a_relayed_message_names_its_sender_with_or_without_bb() {
        for tag in ["[bb message from thread:", "[message from thread:"] {
            let text = format!("{tag}thr_child]\n\nDone.");
            assert_eq!(tell_sender(&text).as_deref(), Some("thr_child"));
        }
        assert_eq!(tell_sender("Done."), None);
    }

    /// A thread's own rename and archive reach the website once each (#237); a thread sharing its sandbox never
    /// reports, the archive waits for that thread to be archived too, and a user's later prompt cancels it.
    #[test]
    fn a_thread_reports_its_own_changes_once_and_never_for_a_session_sharing_its_sandbox() {
        let dir =
            std::env::temp_dir().join(format!("cloudroom-thread-reports-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut local = Local::open(&dir).unwrap();
        let start = |parent: Option<&str>| json!({"request_id":"s","command":"start","state":"completed","input":{"parent_session":parent}});
        local.append("main", "receipt", start(None), None).unwrap();
        local
            .append("kid", "receipt", start(Some("main")), None)
            .unwrap();
        for id in ["main", "kid"] {
            local
                .append(id, "state", json!({"state":"idle"}), None)
                .unwrap();
            local
                .append(
                    id,
                    "title",
                    json!({"title":format!("{id} title"),"wake":"w1"}),
                    None,
                )
                .unwrap();
        }
        // An older Core's record (no wake, replayed after an upgrade) and a user's own rename are never owed.
        local
            .append("main", "title", json!({"title":"old"}), None)
            .unwrap();
        assert!(next_thread_report(&local).is_none());
        local
            .append(
                "main",
                "title",
                json!({"title":"main title","wake":"w1"}),
                None,
            )
            .unwrap();
        let (session, report) = next_thread_report(&local).unwrap();
        assert_eq!(
            (
                session.as_str(),
                report["kind"].as_str(),
                report["value"].as_str(),
                report["wake"].as_str()
            ),
            ("main", Some("title"), Some("main title"), Some("w1"))
        );
        local
            .append("main", "thread_report", json!({"seq":report["seq"]}), None)
            .unwrap();
        assert!(next_thread_report(&local).is_none());
        // Archived while the child still shows, the thread waits; once the child is archived, it reports.
        local
            .append(
                "main",
                "archive",
                json!({"archived":true,"self":true,"wake":"w1"}),
                None,
            )
            .unwrap();
        assert!(next_thread_report(&local).is_none());
        local
            .append("kid", "archive", json!({"archived":true,"user":true}), None)
            .unwrap();
        // Sent with the wake it was made in, also after a restart: a later wake's report would undo an Undo.
        drop(local);
        let mut local = Local::open(&dir).unwrap();
        let (_, archive) = next_thread_report(&local).unwrap();
        // A user's restore (the website tells a running Core on Undo) drops it; archived again, it's owed again.
        local
            .append("main", "unarchive", json!({"user":true}), None)
            .unwrap();
        assert!(next_thread_report(&local).is_none() && !local.sessions["main"].archived);
        local
            .append(
                "main",
                "archive",
                json!({"archived":true,"self":true,"wake":"w1"}),
                None,
            )
            .unwrap();
        assert_eq!(
            (archive["kind"].as_str(), archive["wake"].as_str()),
            (Some("archived"), Some("w1"))
        );
        // A loop's prompt leaves it owed; the user's own (restored and used again) cancels it, also after a restart.
        let prompt = |id: &str| json!({"request_id":id,"command":"prompt","state":"accepted","input":{"text":"hi"}});
        local
            .append("main", "receipt", prompt("auto_0123_1"), None)
            .unwrap();
        assert!(
            local.sessions["main"]
                .thread_reports
                .iter()
                .any(|r| r["kind"] == "archived")
        );
        local
            .append("main", "receipt", prompt("app_0123456789ab_x"), None)
            .unwrap();
        drop(local);
        let local = Local::open(&dir).unwrap();
        assert!(local.sessions["main"].thread_reports.is_empty());
        assert_eq!(
            local.sessions["main"].last_app_prompt.as_ref().unwrap()["request_id"],
            "app_0123456789ab_x"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A child that archives itself still reports the turn it did that in, and only that one, also after a
    /// restart. One archived by its parent reports nothing more.
    #[test]
    fn an_archived_child_reports_only_the_turn_it_archived_itself_in() {
        let dir = std::env::temp_dir().join(format!("cloudroom-relay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut local = Local::open(&dir).unwrap();
        for id in ["self", "parent"] {
            for receipt in [
                json!({"request_id":"s1","command":"start","state":"completed","input":{"parent_thread":"thr_p"}}),
                json!({"request_id":"p1","command":"prompt","state":"completed","input":{}}),
                json!({"request_id":"p2","command":"prompt","state":"accepted","input":{}}),
            ] {
                local.append(id, "receipt", receipt, None).unwrap();
            }
            let running = json!({"state":"running","request_id":"p2"});
            local.append(id, "state", running, None).unwrap();
            let archive = json!({"archived":true,"self":id == "self"});
            local.append(id, "archive", archive, None).unwrap();
            let p2 = json!({"request_id":"p2","command":"prompt","state":"completed","input":{}});
            local.append(id, "receipt", p2, None).unwrap();
        }
        drop(local);
        let mut local = Local::open(&dir).unwrap();
        let (session, turn, _) = next_report(&local).unwrap();
        assert_eq!((session.as_str(), turn.as_str()), ("self", "p2"));
        local
            .append("self", "parent_report", json!({"request_id":"p2"}), None)
            .unwrap();
        assert!(next_report(&local).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A child this thread archived stays archived while the website still lists it as asleep (#1430), but not once
    /// that archive is old: the user may have restored it.
    #[test]
    fn a_child_archived_here_stays_hidden_while_its_archive_is_queued() {
        assert_eq!(shown("asleep", Some("archived"), false, true), "archived");
        assert_eq!(shown("asleep", Some("archived"), false, false), "asleep");
        assert_eq!(shown("asleep", Some("replied"), false, false), "asleep");
    }
}
