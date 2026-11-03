//! A Cloud parent and its children in sandboxes of their own reach each other through the website, so `tell`,
//! `stop`, `archive` and turn reports work while the user's Mac is off (ADR 0259). The website checks the link in its
//! own records, wakes the other sandbox and calls its `/relay`. This Core keeps each turn report until the website
//! takes it, and stays awake for it.
use super::{
    Local, Manager,
    children::{FINISHED, NOTICE_REPLY_CHARS, notice, notice_ids},
    history::ApiError,
    thread::{
        Failure, archive_under, deliver, fail, random_key, record, retire, session_failure,
        starting, website_failure,
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
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Since when reports have failed. After `GIVE_UP_AWAKE`, the sandbox may sleep; the next wake retries them.
static FAILING_SINCE: Mutex<Option<Instant>> = Mutex::new(None);
const GIVE_UP_AWAKE: Duration = Duration::from_secs(30 * 60);
const APP_NOTE: &str = "Passed to the user's Cloudroom app, which applies it while it is open.";
/// Core can't tell whether the app counts this thread as the caller's child: the user may have moved it there.
const MAYBE_NOTE: &str = "Not linked to this thread, so it went to the user's Cloudroom app. The app applies it only to a thread this one started (such as one the user moved here), while it is open; otherwise nothing happens.";
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

/// `tell`, `stop` or `archive` from the calling session to a child in a sandbox of its own.
pub(super) async fn command(
    m: &Manager,
    caller: &str,
    id: &str,
    action: &str,
    text: Option<&str>,
) -> Result<Json<Value>, Failure> {
    // A caller sharing another thread's sandbox has no link on the website, so the app passes on commands for its own
    // children, as before, and drops any other. Its `tell` to another thread goes through the website as this
    // sandbox's thread, which reaches the same tree. `label` has the website name that thread as the sender, since
    // this caller's session ID means nothing in another sandbox (#177). What the website doesn't link still goes to
    // the app, which knows a child the user moved under this caller.
    let (shared, mine) = {
        let local = m.local.lock().unwrap();
        let session = local.sessions.get(caller);
        let mine = session.is_some_and(|s| s.child_states.contains_key(id));
        (session.is_some_and(|s| s.parent_session.is_some()), mine)
    };
    let other = shared && !mine;
    let Some(api) = m
        .history
        .api
        .as_ref()
        .filter(|_| !shared || (other && action == "tell"))
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
    let body = json!({"action":action,"thread":id,"text":text,"request_id":format!("relay_{key}"),"label":other});
    let mut answer = match api.post_waking("relay", &body).await {
        // The website may not know a child that just started yet (#317).
        Err(ApiError::Status(404, _)) if starting(caller).iter().any(|c| c == id) => {
            return Err(fail(StatusCode::SERVICE_UNAVAILABLE, STARTING));
        }
        Err(ApiError::Status(404, _)) if other => {
            return via_app(m, caller, id, action, text, MAYBE_NOTE);
        }
        answer => answer.map_err(|error| website_failure(error, "reach the child"))?,
    };
    let state = match action {
        "tell" => "running",
        "stop" => "stopped",
        _ => "archived",
    };
    if !other {
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
        "stop" => {
            return m
                .command(&id, request, "stop", json!({}))
                .map(|receipt| Json(json!({"id":id,"state":receipt.state})))
                .map_err(session_failure);
        }
        // Like `thread archive --self`: the app archives it whenever it next reads the thread.
        "archive" => {
            retire(&m, &id)?;
            archive_under(&m, &id)?;
            if !archived {
                let _ = record(&m, &id, "archive", json!({"archived":true}))?;
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
    let (shared, known) = {
        let local = m.local.lock().unwrap();
        let session = local.sessions.get(caller);
        let shared = session.is_some_and(|s| s.parent_session.is_some());
        (
            shared,
            session.map(|s| s.child_states.clone()).unwrap_or_default(),
        )
    };
    let Some(api) = m.history.api.as_ref().filter(|_| !shared) else {
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
    let recent = starting(caller);
    for child in found["children"].as_array().into_iter().flatten() {
        let id = child["id"].as_str().unwrap_or_default();
        let sandbox = child["state"].as_str().unwrap_or("unknown");
        let state = match sandbox {
            "archived" | "deleted" => "archived",
            "new" if recent.iter().any(|c| c == id) => "starting",
            _ => known.get(id).map_or(sandbox, String::as_str),
        };
        let mut item = json!({"id":id,"title":child["title"],"state":state,"parent":child["parent"],"sandbox":"own"});
        // Its sandbox didn't start yet, say after a failed wake.
        if let Some(issue) = child["issue"].as_str() {
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

impl Manager {
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
