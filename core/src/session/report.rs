//! Cloud agents send Cloudroom feedback straight to David by themselves (ADR 0158). Core sends each report to the
//! website itself (ADR 0234), so reports arrive even while the user's Mac is offline.
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    message: String,
}

/// Served on the agent-only socket that `room-cli mac` also uses.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new().route("/report", post(report))
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
