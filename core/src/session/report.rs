//! Cloud agents send Cloudroom feedback straight to David by themselves (ADR 0158), and read their account's Cloud
//! Credits (#610). Core asks the website itself (ADR 0234), so both work even while the user's Mac is offline.
use super::{
    Manager,
    thread::{Failure, caller, fail},
};
use crate::preview::Peer;
use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::StatusCode,
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io, sync::Arc};

const USAGE: &str = "room-cli feedback MESSAGE
Sends David, Cloudroom's founder, a bug, friction, or idea: what you did, what happened, and the exact error. Never include secrets, personal data, or the user's code.";
const CREDITS: &str = "room-cli usage [--json]
The account's Cloud Credits: how many of the plan's credits the last 30 days used, and extra credits left. Cloud
sandboxes stop when none are left. Check before a big Cloud fan-out.";

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
) -> Result<Json<Value>, Failure> {
    caller(&m, peer, "usage")?;
    let Some(api) = &m.history.api else {
        return Err(fail(
            StatusCode::CONFLICT,
            "Cloud Credits apply only to Cloudroom cloud threads",
        ));
    };
    api.get("usage", &[]).await.map(Json).map_err(|error| {
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
    let json = match args {
        [] => false,
        [flag] if flag == "--json" => true,
        _ => {
            println!("{CREDITS}");
            return Ok(if args[0] == "--help" { 0 } else { 2 });
        }
    };
    let usage = crate::mac::request(crate::mac::SOCKET, "POST", "/usage", None).await?;
    if json {
        println!("{usage}");
        return Ok(0);
    }
    println!("{}", credits(&usage));
    Ok(0)
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
