//! Cloud agents send Cloudroom feedback straight to David by themselves (ADR 0158), and read their account's Cloud
//! Credits (#610). Core asks the website itself (ADR 0234), so both work even while the user's Mac is offline.
use super::{
    Manager,
    thread::{Failure, caller, fail},
};
use crate::preview::Peer;
use axum::{
    Json, Router,
    extract::{ConnectInfo, Query, State},
    http::StatusCode,
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io, sync::Arc};

const USAGE: &str = "room-cli feedback MESSAGE
Sends David, Cloudroom's founder, a bug, friction, or idea: what you did, what happened, and the exact error. Never include secrets, personal data, or the user's code.";
const CREDITS: &str = "room-cli usage [--days | --threads | THREAD_ID] [--json]
The account's Cloud Credits: how many of the plan's credits the last 30 days used, and extra credits left. Cloud
sandboxes stop when none are left. Check before a big Cloud fan-out.
  --days      credits per UTC day, last 7 days, and the 7 days before
  --threads   the threads that used the most, last 7 days
  THREAD_ID   one thread and its subagents, hour by hour";

/// `room-cli usage --days | --threads | THREAD_ID`: the website writes that history, so it changes without a Core release.
#[derive(Deserialize)]
pub struct UsageView {
    view: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    message: String,
}

/// Served on the agent-only socket that `room-cli mac` also uses.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new()
        .route("/report", post(report))
        .route("/usage", post(usage))
}

/// One website read per call, never polled.
async fn usage(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Query(input): Query<UsageView>,
) -> Result<Json<Value>, Failure> {
    caller(&m, peer, "usage")?;
    let Some(api) = &m.history.api else {
        return Err(fail(
            StatusCode::CONFLICT,
            "Cloud Credits apply only to Cloudroom cloud threads",
        ));
    };
    let view = input.view.as_deref().map(|view| ("view", view));
    api.get("usage", view.as_slice())
        .await
        .map(Json)
        .map_err(|error| {
            fail(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("Could not read Cloud Credits: {error}"),
            )
        })
}

async fn report(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Report>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "report")?;
    let message = input.message.trim();
    if message.is_empty() || message.chars().count() > 4000 {
        return Err(fail(
            StatusCode::CONFLICT,
            "Use a message of 1-4000 characters",
        ));
    }
    let harness = m
        .local
        .lock()
        .unwrap()
        .sessions
        .get(&session)
        .map(|s| s.harness);
    let context = json!({"core":crate::VERSION,"instance":m.config.instance,"session":session,"harness":harness});
    m.history
        .report(message, &context)
        .await
        .map_err(|error| match error {
            super::history::ApiError::Status(429, _) => fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "Too many bug reports. Try again later.",
            ),
            error => fail(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("Could not save the bug report: {error}"),
            ),
        })?;
    Ok(Json(json!({"sent":true})))
}

/// `room-cli feedback MESSAGE` (old name: `report`) in Cloud threads; the Mac's `room-cli feedback` does the same there.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let [message] = args else {
        println!("{USAGE}");
        return Ok(if args.is_empty() { 0 } else { 2 });
    };
    if message == "--help" {
        println!("{USAGE}");
        return Ok(0);
    }
    let answer = crate::mac::request(
        crate::mac::SOCKET,
        "POST",
        "/report",
        Some(json!({"message":message})),
    )
    .await?;
    println!("{answer}");
    Ok(0)
}

/// `room-cli usage` in Cloud threads.
pub async fn usage_cli(args: &[String]) -> io::Result<i32> {
    let json = args.iter().any(|arg| arg == "--json");
    let rest: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|arg| *arg != "--json")
        .collect();
    let view = match rest.as_slice() {
        [] => None,
        ["--days"] => Some("days"),
        ["--threads"] => Some("threads"),
        [thread] if thread_id(thread) => Some(*thread),
        _ => {
            println!("{CREDITS}");
            return Ok(if rest == ["--help"] { 0 } else { 2 });
        }
    };
    let path = view.map_or("/usage".into(), |view| format!("/usage?view={view}"));
    let usage = crate::mac::request(crate::mac::SOCKET, "POST", &path, None).await?;
    if json {
        println!("{usage}");
        return Ok(0);
    }
    println!("{}", credits(&usage));
    match usage["text"].as_str() {
        Some(text) => println!("\n{text}"),
        None if view.is_none() => {
            println!("History: room-cli usage --days, --threads, or THREAD_ID.")
        }
        None => {}
    }
    Ok(0)
}

/// A thread ID is safe in the request line as is: letters, digits, `_` and `-`, like the website checks.
fn thread_id(arg: &str) -> bool {
    !arg.starts_with('-')
        && (1..=64).contains(&arg.len())
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The website's answer in one line.
fn credits(usage: &Value) -> String {
    let (Some(plan), Some(limit)) = (usage["plan"].as_str(), usage["credits_limit"].as_f64())
    else {
        return "This account's Cloud Credits aren't metered.".into();
    };
    let Some(used) = usage["credits"].as_f64() else {
        return format!(
            "Cloud Credits ({plan} plan) are being counted. Try again in a few minutes."
        );
    };
    let extra = usage["extra_credits"].as_f64().unwrap_or(0.0);
    let percent = if limit > 0.0 {
        used / limit * 100.0
    } else {
        100.0
    };
    format!(
        "Cloud Credits ({plan} plan): {used:.0} of {limit:.0} used in the last 30 days ({percent:.0}%), {extra:.0} extra credits left. Cloud sandboxes stop when none are left."
    )
}
