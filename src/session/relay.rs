//! A Cloud parent and its children in sandboxes of their own reach each other through the website, so `tell`,
//! `stop`, `archive` and turn reports work while the user's Mac is off (ADR 0259). The website checks the link in its
//! own records, wakes the other sandbox and calls its `/relay`. This Core keeps each turn report until the website
//! takes it, and stays awake for it.
use super::{
    Local, Manager,
    children::{FINISHED, NOTICE_REPLY_CHARS, derived_id, notice, notice_ids},
    history::ApiError,
    thread::{
        Failure, archive_under, conflict, deliver, fail, random_key, record, session_failure,
        website_failure,
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
    // A caller sharing another thread's sandbox has no link on the website, so the app passes these on, as before.
    let shared = m
        .local
        .lock()
        .unwrap()
        .sessions
        .get(caller)
        .is_some_and(|s| s.parent_session.is_some());
    let Some(api) = m.history.api.as_ref().filter(|_| !shared) else {
        let mut data = json!({"id":id,"action":action});
        if let Some(text) = text {
            data["text"] = json!(text);
        }
        let _ = record(m, caller, "child_command", data)?;
        return Ok(Json(json!({"id":id,"state":"requested","note":APP_NOTE})));
    };
    let key = random_key().map_err(|e| fail(StatusCode::SERVICE_UNAVAILABLE, &e.to_string()))?;
    let body = json!({"action":action,"thread":id,"text":text,"request_id":format!("relay_{key}")});
    let mut answer = api
        .post_waking("relay", &body)
        .await
        .map_err(|error| website_failure(error, "reach the child"))?;
    let state = match action {
        "tell" => "running",
        "stop" => "stopped",
        _ => "archived",
    };
    note_child(m, caller, id, state);
    answer["id"] = json!(id);
    Ok(Json(answer))
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
        || request.len() > 64
        || !request
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(conflict("request_rejected", "invalid request_id"));
    }
    let archived = m
        .local
        .lock()
        .unwrap()
        .sessions
        .get(&id)
        .map(|s| s.archived)
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Unknown session"))?;
    // What the parent learns of a child is recorded only once the report is delivered, not when it is refused.
    let mut heard = None;
    let text = match input.action.as_str() {
        "tell" => input
            .text
            .filter(|t| !t.trim().is_empty() && t.len() <= 32768)
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
            heard = Some((child.clone(), known));
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
            // A repeated request does nothing new. Its own receipt is written last, after every step succeeded, so
            // a step that fails (a journal error answered 503) is retried in full. The steps are idempotent: the
            // stop and sleep IDs are derived and the descendants' archive is recorded only once.
            if m.receipt(&id, &request).is_none() {
                // The cut comes before the stop, so a turn the stop interrupts is not reported to the parent.
                if !archived {
                    let _ = record(&m, &id, "archive", json!({"archived":true,"reports":true}))?;
                }
                let _ = m.command(&id, derived_id(&request, "_stop"), "stop", json!({}));
                let sleep = derived_id(&request, "_sleep");
                let _ = m.command(&id, sleep, "sleep", json!({}));
                archive_under(&m, &id)?;
                record(
                    &m,
                    &id,
                    "receipt",
                    json!({"request_id":request,"command":"archive","state":"completed","input":{}}),
                )
                .map(drop)?;
            }
            return Ok(Json(json!({"id":id,"state":"archived"})));
        }
        _ => return Err(bad("unknown action")),
    };
    // A report's text carries the child's title, which the website may rename. Its request ID is unique per turn.
    let answer = deliver(&m, &id, &request, &text, heard.is_none()).await?;
    // A steer not yet confirmed may still fail; the sender retries, and a failed steer is then queued instead.
    let steering = m.receipt(&id, &derived_id(&request, "_steer"));
    if m.receipt(&id, &request).is_none() && steering.is_some_and(|s| s.state == "accepted") {
        return Err(fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Not confirmed yet. Retry.",
        ));
    }
    if let Some((child, state)) = heard {
        note_child(&m, &id, &child, state);
    }
    Ok(answer)
}

/// The first finished turn not yet reported, of a session whose parent runs in another sandbox.
fn next_report(local: &Local) -> Option<(String, String, Value)> {
    local
        .sessions
        .values()
        // An archived child still owes its parent the reports of turns that finished before the archive.
        .filter(|s| s.parent_thread().is_some())
        .find_map(|s| {
            // An archived child owes only the turns that finished before its archive (`archive_cut`). An archive
            // without that marker predates it and owes nothing: its old turns would arrive weeks late.
            let cut = match (s.archived, s.archive_cut) {
                (true, Some(cut)) => cut.min(s.finished.len()),
                (true, None) => return None,
                (false, _) => s.finished.len(),
            };
            // In finish order; receipts from before that order was recorded follow in request-ID order.
            let finished = s.finished[..cut].iter().filter_map(|id| s.receipts.get(id));
            let unordered = s.receipts.values().filter(|_| !s.archived);
            let r = finished.chain(unordered).find(|r| {
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
/// what this thread last heard of each, or else its sandbox's state.
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
    let found = match api.get("children", &[("archived", flag)]).await {
        Ok(found) => found,
        Err(error) => {
            answer["note"] = json!(format!(
                "Children in sandboxes of their own are missing: {error}. Retry."
            ));
            return;
        }
    };
    let Some(list) = answer["children"].as_array_mut() else {
        return;
    };
    for child in found["children"].as_array().into_iter().flatten() {
        let id = child["id"].as_str().unwrap_or_default();
        let sandbox = child["state"].as_str().unwrap_or("unknown");
        let state = match sandbox {
            "archived" | "deleted" => "archived",
            _ => known.get(id).map_or(sandbox, String::as_str),
        };
        list.push(json!({"id":id,"title":child["title"],"state":state,"parent":child["parent"],"sandbox":"own"}));
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

/// Taken by the website, or refused with 410 (the parent is gone or archived): such a report is never sent again.
/// Any other failure is kept and retried (api.md), except a 400 or 403 that repeats `MAX_REFUSALS` times in a row.
fn settled<T>(sent: &Result<T, ApiError>) -> bool {
    match sent {
        Ok(_) | Err(ApiError::Status(410, _)) => true,
        Err(_) => false,
    }
}

/// Refusals with 400 or 403 for one report before it is dropped, so one bad report cannot hold back the others.
const MAX_REFUSALS: u32 = 10;

/// Counts the refusals of `turn` in a row. Returns the status once the report has been refused `MAX_REFUSALS` times.
fn refused_for_good<T>(
    refused: &mut Option<(String, u32)>,
    turn: &str,
    sent: &Result<T, ApiError>,
) -> Option<u16> {
    let status = match sent {
        Err(ApiError::Status(status @ (400 | 403), _)) => *status,
        _ => {
            *refused = None;
            return None;
        }
    };
    let count = match refused {
        Some((last, count)) if last == turn => *count + 1,
        _ => 1,
    };
    *refused = Some((turn.to_owned(), count));
    (count >= MAX_REFUSALS).then_some(status)
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
            let mut refused = None;
            while !manager.is_stopping() {
                let due = next_report(&manager.local.lock().unwrap());
                let Some((session, turn, body)) = due else {
                    if changed.changed().await.is_err() {
                        return;
                    }
                    continue;
                };
                let sent = api.post_waking("relay", &body).await;
                // Counted per session and turn: another session's report with the same request ID starts at 1.
                let dropped = refused_for_good(&mut refused, &format!("{session}/{turn}"), &sent);
                let done = match dropped {
                    Some(status) => manager
                        .note(
                            &session,
                            "parent_report",
                            json!({"request_id":turn,"dropped":status}),
                        )
                        .is_ok(),
                    None => {
                        settled(&sent)
                            && manager
                                .note(&session, "parent_report", json!({"request_id":turn}))
                                .is_ok()
                    }
                };
                if dropped.is_some() {
                    refused = None;
                }
                // A drop is not a success: the clock keeps running until a report is taken, or the give-up applies.
                failed(!(done && dropped.is_none()));
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
    use crate::config::Config;

    /// A Core over a scratch state directory, with no website reachable.
    fn manager(name: &str) -> Arc<Manager> {
        let root =
            std::env::temp_dir().join(format!("cloudroom-relay-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        Manager::open(Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            token: String::new(),
            state_dir: root.join("state"),
            repository: root.clone(),
            api_url: Some("http://127.0.0.1:1".into()),
            store: "test".into(),
            instance: None,
            account_home: root.clone(),
            default_harness: crate::runtime::Kind::Claude,
            harnesses: Default::default(),
            storage: None,
            rpc_timeout: Duration::from_secs(30),
            diagnostic_upload: Duration::from_secs(1),
        })
        .unwrap()
    }

    /// A session created by its start receipt, closed when asked.
    fn session(m: &Manager, id: &str, closed: bool) {
        let start = json!({"request_id":"start","command":"start","input":{"harness":"claude-code"},"state":"completed"});
        m.note(id, "receipt", start).unwrap();
        if closed {
            m.note(id, "state", json!({"state":"closed"})).unwrap();
        }
    }

    fn relayed(request: &str, action: &str) -> Relayed {
        Relayed {
            request_id: request.into(),
            action: action.into(),
            text: None,
            child: None,
            title: None,
            state: None,
            error: None,
            reply: None,
        }
    }

    #[tokio::test]
    async fn a_retried_tell_with_other_text_is_refused() {
        let m = manager("retried-tell");
        session(&m, "cr_p", false);
        let tell = |text: &str| Relayed {
            text: Some(text.into()),
            ..relayed("r1", "tell")
        };
        assert!(
            receive(State(m.clone()), Path("cr_p".into()), Json(tell("A")))
                .await
                .is_ok()
        );
        assert!(
            receive(State(m.clone()), Path("cr_p".into()), Json(tell("B")))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_report_retried_after_a_rename_is_not_refused() {
        let m = manager("renamed-report");
        session(&m, "cr_p", false);
        let report = |title: &str| Relayed {
            child: Some("thr_abc".into()),
            title: Some(title.into()),
            state: Some("completed".into()),
            reply: Some("done".into()),
            ..relayed("r1", "report")
        };
        assert!(
            receive(State(m.clone()), Path("cr_p".into()), Json(report("Old")))
                .await
                .is_ok()
        );
        assert!(
            receive(State(m.clone()), Path("cr_p".into()), Json(report("New")))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn a_64_character_request_id_is_accepted() {
        let m = manager("long-request");
        session(&m, "cr_p", false);
        let request = "r".repeat(64);
        let tell = Relayed {
            text: Some("hi".into()),
            ..relayed(&request, "tell")
        };
        assert!(
            receive(State(m.clone()), Path("cr_p".into()), Json(tell))
                .await
                .is_ok()
        );
        let too_long = Relayed {
            text: Some("hi".into()),
            ..relayed(&"r".repeat(65), "tell")
        };
        let (status, Json(body)) = receive(State(m.clone()), Path("cr_p".into()), Json(too_long))
            .await
            .unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "request_rejected");
    }

    #[tokio::test]
    async fn an_archived_child_keeps_its_unsent_report() {
        let m = manager("archived-report");
        let start = json!({"request_id":"start","command":"start","input":{"harness":"claude-code","parent_thread":"thr_p"},"state":"completed"});
        m.note("cr_c", "receipt", start).unwrap();
        let turn =
            json!({"request_id":"t1","command":"prompt","input":{"text":"hi"},"state":"completed"});
        m.note("cr_c", "receipt", turn).unwrap();
        m.note("cr_c", "archive", json!({"archived":true,"reports":true}))
            .unwrap();
        let local = m.local.lock().unwrap();
        let (session, turn, _) = next_report(&local).expect("the report is still owed");
        assert_eq!((session.as_str(), turn.as_str()), ("cr_c", "t1"));
    }

    #[tokio::test]
    async fn an_archive_owes_only_the_turns_finished_before_it() {
        let m = manager("archive-cut");
        let start = json!({"request_id":"start","command":"start","input":{"harness":"claude-code","parent_thread":"thr_p"},"state":"completed"});
        m.note("cr_c", "receipt", start).unwrap();
        let turn =
            json!({"request_id":"t1","command":"prompt","input":{"text":"hi"},"state":"completed"});
        m.note("cr_c", "receipt", turn).unwrap();
        m.note("cr_c", "archive", json!({"archived":true,"reports":true}))
            .unwrap();
        // The turn the archive stops ends after the archive, so it is not reported.
        let stopped = json!({"request_id":"t2","command":"prompt","input":{"text":"hi"},"state":"interrupted"});
        m.note("cr_c", "receipt", stopped).unwrap();
        m.note("cr_c", "parent_report", json!({"request_id":"t1"}))
            .unwrap();
        let local = m.local.lock().unwrap();
        assert!(next_report(&local).is_none());
    }

    #[tokio::test]
    async fn an_archive_without_the_marker_owes_nothing() {
        let m = manager("archive-legacy");
        let start = json!({"request_id":"start","command":"start","input":{"harness":"claude-code","parent_thread":"thr_p"},"state":"completed"});
        m.note("cr_c", "receipt", start).unwrap();
        let turn =
            json!({"request_id":"t1","command":"prompt","input":{"text":"hi"},"state":"completed"});
        m.note("cr_c", "receipt", turn).unwrap();
        m.note("cr_c", "archive", json!({"archived":true})).unwrap();
        let local = m.local.lock().unwrap();
        assert!(next_report(&local).is_none());
    }

    #[tokio::test]
    async fn a_child_reports_its_turns_in_finish_order() {
        let m = manager("finish-order");
        let start = json!({"request_id":"start","command":"start","input":{"harness":"claude-code","parent_thread":"thr_p"},"state":"completed"});
        m.note("cr_c", "receipt", start).unwrap();
        for request in ["z1", "a2"] {
            let turn = json!({"request_id":request,"command":"prompt","input":{"text":"hi"},"state":"completed"});
            m.note("cr_c", "receipt", turn).unwrap();
        }
        let local = m.local.lock().unwrap();
        let (_, turn, _) = next_report(&local).expect("two reports are owed");
        assert_eq!(turn, "z1");
    }

    #[test]
    fn only_a_410_refusal_ends_a_report_retry() {
        assert!(settled::<()>(&Ok(())));
        assert!(settled::<()>(&Err(ApiError::Status(410, String::new()))));
        assert!(!settled::<()>(&Err(ApiError::Status(400, String::new()))));
        assert!(!settled::<()>(&Err(ApiError::Status(403, String::new()))));
        assert!(!settled::<()>(&Err(ApiError::Network(String::new()))));
    }

    #[test]
    fn a_report_refused_for_good_is_dropped_after_a_bound() {
        let refusal: Result<(), ApiError> = Err(ApiError::Status(400, String::new()));
        let mut refused = None;
        for _ in 1..MAX_REFUSALS {
            assert_eq!(refused_for_good(&mut refused, "t1", &refusal), None);
        }
        assert_eq!(refused_for_good(&mut refused, "t1", &refusal), Some(400));
        let mut refused = None;
        assert_eq!(refused_for_good(&mut refused, "t1", &refusal), None);
        let server: Result<(), ApiError> = Err(ApiError::Status(500, String::new()));
        assert_eq!(refused_for_good(&mut refused, "t1", &server), None);
        assert!(refused.is_none());
        assert_eq!(refused_for_good(&mut refused, "t1", &refusal), None);
        assert_eq!(refused_for_good(&mut refused, "t2", &refusal), None);
    }

    #[test]
    fn another_sessions_refusal_with_the_same_turn_starts_its_own_count() {
        let refusal: Result<(), ApiError> = Err(ApiError::Status(403, String::new()));
        let mut refused = None;
        for _ in 1..MAX_REFUSALS {
            assert_eq!(refused_for_good(&mut refused, "cr_a/t1", &refusal), None);
        }
        assert_eq!(refused_for_good(&mut refused, "cr_b/t1", &refusal), None);
        assert_eq!(refused_for_good(&mut refused, "cr_a/t1", &refusal), None);
    }

    #[tokio::test]
    async fn a_relay_stop_refused_for_a_pending_close_carries_its_code() {
        let m = manager("relay-stop-close");
        session(&m, "cr_p", false);
        let close = json!({"request_id":"c1","command":"close","input":{},"state":"accepted"});
        m.note("cr_p", "receipt", close).unwrap();
        let refused = receive(
            State(m.clone()),
            Path("cr_p".into()),
            Json(relayed("s1", "stop")),
        )
        .await;
        let Err((status, Json(body))) = refused else {
            panic!("a stop during a pending close is refused");
        };
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "session_busy");
    }

    #[test]
    fn a_refused_relay_stop_carries_a_code() {
        let (status, Json(body)) = session_failure(crate::session::Error::Conflict(
            "wait for the pending close or interrupt",
        ));
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "session_busy");
        let (_, Json(body)) = session_failure(crate::session::Error::Conflict(
            "request_id already has different content",
        ));
        assert_eq!(body["code"], "request_conflict");
    }

    #[tokio::test]
    async fn a_repeated_archive_request_does_nothing_new() {
        let m = manager("repeated-archive");
        session(&m, "cr_p", false);
        for _ in 0..2 {
            let archive = receive(
                State(m.clone()),
                Path("cr_p".into()),
                Json(relayed("a1", "archive")),
            );
            assert!(archive.await.is_ok());
        }
        let local = m.local.lock().unwrap();
        let commands: Vec<&str> = local.sessions["cr_p"]
            .receipts
            .values()
            .map(|r| r.command.as_str())
            .collect();
        assert_eq!(commands.iter().filter(|c| **c == "stop").count(), 1);
        assert_eq!(commands.iter().filter(|c| **c == "sleep").count(), 1);
    }

    #[tokio::test]
    async fn a_repeated_archive_is_marked_when_the_session_refuses_its_stop() {
        let m = manager("archive-refused");
        session(&m, "cr_p", true);
        let start = json!({"request_id":"start","command":"start","state":"completed","input":{"harness":"claude-code","parent_session":"cr_p"}});
        m.note("cr_c", "receipt", start).unwrap();
        for _ in 0..2 {
            let archive = receive(
                State(m.clone()),
                Path("cr_p".into()),
                Json(relayed("a1", "archive")),
            );
            assert!(archive.await.is_ok());
        }
        let local = m.local.lock().unwrap();
        let stops = local.sessions["cr_c"]
            .receipts
            .values()
            .filter(|r| r.command == "stop")
            .count();
        assert_eq!(stops, 1);
    }

    #[tokio::test]
    async fn the_archive_receipt_is_written_after_the_archive_record() {
        let m = manager("archive-order");
        session(&m, "cr_p", false);
        let archive = receive(
            State(m.clone()),
            Path("cr_p".into()),
            Json(relayed("a1", "archive")),
        );
        assert!(archive.await.is_ok());
        let local = m.local.lock().unwrap();
        let (mut record_at, mut stop_at, mut marker_at) = (None, None, None);
        for sequence in 1..=local.journal.last() {
            let record: Value =
                serde_json::from_slice(&local.journal.read(sequence).unwrap()).unwrap();
            if record["kind"] == "archive" && record["data"]["reports"] == true {
                record_at = Some(sequence);
            }
            if record["kind"] == "receipt" && record["data"]["command"] == "stop" {
                stop_at = Some(sequence);
            }
            if record["kind"] == "receipt" && record["data"]["request_id"] == "a1" {
                marker_at = Some(sequence);
            }
        }
        assert!(record_at.is_some() && stop_at.is_some() && marker_at.is_some());
        assert!(record_at < stop_at, "the cut is recorded before the stop");
        assert!(stop_at < marker_at, "the marker is written after the steps");
    }

    #[tokio::test]
    async fn a_refused_report_does_not_record_the_child_state() {
        let m = manager("refused-report");
        session(&m, "cr_p", true);
        let report = Relayed {
            child: Some("thr_abc".into()),
            state: Some("completed".into()),
            reply: Some("done".into()),
            ..relayed("r1", "report")
        };
        assert!(
            receive(State(m.clone()), Path("cr_p".into()), Json(report))
                .await
                .is_err()
        );
        assert!(
            m.local.lock().unwrap().sessions["cr_p"]
                .child_states
                .is_empty()
        );
    }
}
