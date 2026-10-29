//! `room-cli gpu` in Cloud threads (ADR 0333). The website runs the whole tool: this passes the agent's words on,
//! prints the answers, copies files, and records approval requests, which the user's app shows as a card. The user's
//! answer goes to the website, never back through this sandbox, so no agent can approve its own GPU.
use crate::{
    preview::Peer,
    session::{
        Manager,
        thread::{Failure, caller, fail},
    },
};
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
    time::Duration,
};

pub const SKILL: &str = include_str!("SKILL.md");
/// Files go straight between this sandbox and the GPU box through signed links.
const UPLOAD: &str = r#"TGZ=$(mktemp) && tar -czf "$TGZ" -C "$(dirname "$SRC")" "$(basename "$SRC")" && curl -sSf -X POST -F "file=@$TGZ" "$URL" >/dev/null; code=$?; rm -f "$TGZ"; exit $code"#;
const DOWNLOAD: &str = r#"mkdir -p "$DIR" && curl -sSf "$URL" | tar -xzf - -C "$DIR""#;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Body {
    argv: Vec<String>,
}

/// Served on the agent-only socket that `room-cli mac` also uses.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new().route("/gpu", post(gpu))
}

async fn gpu(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Body>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "gpu")?;
    if input.argv.len() > 200 {
        return Err(fail(StatusCode::BAD_REQUEST, "Too many words"));
    }
    let Some(api) = &m.history.api else {
        return Err(fail(
            StatusCode::CONFLICT,
            "Run room-cli gpu from a Cloudroom cloud thread",
        ));
    };
    // Copying a large folder on the GPU box can use most of the website's 60 seconds.
    let reply = api
        .post_waking("gpu", &json!({"argv": input.argv}))
        .await
        .map_err(|error| match error {
            crate::session::history::ApiError::Status(status, message) => fail(
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                &message,
            ),
            error => fail(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("Could not reach Cloudroom: {error}"),
            ),
        })?;
    if let Some(approval) = reply.get("approval").filter(|a| a.is_object()) {
        m.note(&session, "gpu_request", approval.clone())
            .map_err(|error| {
                fail(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &format!("Could not ask the user: {error}"),
                )
            })?;
    }
    Ok(Json(reply))
}

fn copy(script: &str, vars: &[(&str, &str)]) -> io::Result<()> {
    let status = std::process::Command::new("sh")
        .args(["-c", script])
        .envs(vars.iter().copied())
        .status()?;
    if status.success() {
        return Ok(());
    }
    Err(io::Error::other(format!("Copying failed ({status})")))
}

/// A signed https link and the local path the website named.
fn link<'a>(value: &'a Value, path: &str) -> io::Result<(&'a str, &'a str)> {
    match (value["url"].as_str(), value[path].as_str()) {
        (Some(url), Some(local)) if url.starts_with("https://") && !local.is_empty() => {
            Ok((url, local))
        }
        _ => Err(io::Error::other("invalid copy request from Cloudroom")),
    }
}

/// Returns the process exit code.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let mut argv = if args.is_empty() {
        vec!["help".to_owned()]
    } else {
        args.to_vec()
    };
    loop {
        let reply = crate::mac::request(
            crate::mac::SOCKET,
            "POST",
            "/gpu",
            Some(json!({"argv": argv})),
        )
        .await?;
        print!("{}", reply["output"].as_str().unwrap_or_default());
        io::stdout().flush()?;
        if let Some(upload) = reply.get("upload").filter(|u| u.is_object()) {
            let (url, path) = link(upload, "path")?;
            copy(UPLOAD, &[("URL", url), ("SRC", path)])?;
        }
        if let Some(download) = reply.get("download").filter(|d| d.is_object()) {
            let (url, dir) = link(download, "dir")?;
            copy(DOWNLOAD, &[("URL", url), ("DIR", dir)])?;
        }
        let Some(next) = reply.get("next").filter(|n| n.is_object()) else {
            return Ok(reply["exit_code"].as_i64().unwrap_or(1) as i32);
        };
        argv = next["argv"]
            .as_array()
            .ok_or_else(|| io::Error::other("invalid reply from Cloudroom"))?
            .iter()
            .filter_map(|word| word.as_str().map(str::to_owned))
            .collect();
        let wait = next["after_ms"].as_u64().unwrap_or(2000).min(60_000);
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
}
