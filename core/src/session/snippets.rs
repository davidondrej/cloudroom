//! Agent-only access to the signed-in user's synced snippets. Core keeps the hosting credential.
use super::{
    Manager,
    thread::{Failure, caller, fail},
};
use crate::preview::Peer;
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::StatusCode,
    routing::post,
};
use serde_json::{Value, json};
use std::{
    io::{self, IsTerminal, Read},
    sync::Arc,
};
const LIMIT: u64 = 3 * 1024 * 1024;
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new()
        .route("/snippets", post(command))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
}
async fn command(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(argv): Json<Vec<String>>,
) -> Result<Json<Value>, Failure> {
    caller(&m, peer, "snippets")?;
    let api = m.history.api.as_ref().ok_or_else(|| {
        fail(
            StatusCode::CONFLICT,
            "Account sync requires Cloudroom hosting",
        )
    })?;
    api.post("snippets", &json!({"action":"command","argv":argv}))
        .await
        .map(Json)
        .map_err(|e| fail(StatusCode::BAD_REQUEST, &e.to_string()))
}
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let mut argv = Vec::new();
    let mut command = None;
    let mut input = None;
    let mut json_output = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!(
                    "room-cli snippets list|search|get|create|update|delete|duplicate|pin|unpin|tag|render|import|export|share|sync\nUse --scope organization for team snippets. Import with --file PATH or --data-stdin. Create with --name NAME --text TEXT. Update by ID."
                );
                return Ok(0);
            }
            "--text-stdin" | "--data-stdin" | "--file" => {
                if input.is_some() {
                    return Err(io::Error::other("Choose one snippet input source."));
                }
                let path = if arg == "--file" {
                    Some(
                        iter.next()
                            .ok_or_else(|| io::Error::other("--file needs a path"))?,
                    )
                } else {
                    None
                };
                input = Some((arg.as_str(), path));
            }
            "--json" => {
                json_output = true;
                argv.push(arg.clone());
            }
            arg_name if arg_name.starts_with("--") => {
                argv.push(arg.clone());
                argv.push(
                    iter.next()
                        .ok_or_else(|| io::Error::other(format!("{arg} needs a value")))?
                        .clone(),
                );
            }
            _ => {
                command.get_or_insert(arg.as_str());
                argv.push(arg.clone());
            }
        }
    }
    if let Some((flag, path)) = input {
        let mut reader: Box<dyn Read> = if let Some(path) = path {
            if command != Some("import") {
                return Err(io::Error::other("Use import --file PATH."));
            }
            Box::new(std::fs::File::open(path)?)
        } else {
            if io::stdin().is_terminal() {
                return Err(io::Error::other(format!("Pipe input into {flag}.")));
            }
            Box::new(io::stdin())
        };
        let mut text = String::new();
        reader.by_ref().take(LIMIT + 1).read_to_string(&mut text)?;
        if text.len() as u64 > LIMIT {
            return Err(io::Error::other("Snippet input exceeds 3 MiB"));
        }
        argv.push(
            if flag == "--text-stdin" {
                "--text"
            } else {
                "--data"
            }
            .to_owned(),
        );
        argv.push(text);
    }
    let result =
        crate::mac::request(crate::mac::SOCKET, "POST", "/snippets", Some(json!(argv))).await?;
    if let Some(text) = result.as_str()
        && !json_output
    {
        println!("{text}");
    } else {
        println!("{}", serde_json::to_string_pretty(&result)?);
    }
    Ok(0)
}
