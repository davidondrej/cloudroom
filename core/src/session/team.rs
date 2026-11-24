//! `room-cli team` in Cloud threads (ADR 20261118-201443): teammates' threads, as far as the user's organization lets
//! them see. The website runs the whole command and answers in text, like the Local app's, so it changes without a
//! Core release. This passes the agent's words on and prints the answer.
use super::{
    Manager,
    thread::{Failure, agent, fail},
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
use std::{
    io::{self, Write},
    sync::Arc,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Body {
    argv: Vec<String>,
}

/// Served on the agent-only socket that `room-cli mac` also uses.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new().route("/team", post(team))
}

/// One website call per command, never polled. `fork` wakes the teammate's sandbox, so it may take the website's
/// whole minute.
async fn team(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Body>,
) -> Result<Json<Value>, Failure> {
    agent(&m, peer, "team")?;
    if input.argv.len() > 50 {
        return Err(fail(StatusCode::BAD_REQUEST, "Too many words"));
    }
    let Some(api) = &m.history.api else {
        return Err(fail(
            StatusCode::CONFLICT,
            "Run room-cli team from a Cloudroom cloud thread",
        ));
    };
    api.post_waking("team", &json!({"argv": input.argv}))
        .await
        .map(Json)
        .map_err(|error| match error {
            super::history::ApiError::Status(status, message) => fail(
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                &message,
            ),
            error => fail(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("Could not reach Cloudroom: {error}"),
            ),
        })
}

/// Returns the process exit code.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let argv = if args.is_empty() {
        vec!["help".to_owned()]
    } else {
        args.to_vec()
    };
    let reply = crate::mac::request(
        crate::mac::SOCKET,
        "POST",
        "/team",
        Some(json!({"argv": argv})),
    )
    .await?;
    print!("{}", reply["output"].as_str().unwrap_or_default());
    io::stdout().flush()?;
    Ok(reply["exit_code"].as_i64().unwrap_or(1) as i32)
}
