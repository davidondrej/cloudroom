//! `room-cli status` and `room-cli provider`, as in Local threads (ADR 20261110-235800): what a Cloud agent reads
//! about its own thread and the agents it can start. Both answer from what this Core already knows.
use super::{
    Manager, relay,
    thread::{Failure, agent, caller, fail, session_failure},
};
use crate::{preview::Peer, runtime};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, State},
    http::StatusCode,
    routing::get,
};
use serde_json::{Value, json};
use std::{io, sync::Arc, time::Duration};

const USAGE: &str = "room-cli status
room-cli provider list
room-cli provider models PROVIDER";

/// How long `status` waits for the website's list of children in sandboxes of their own before it answers without
/// them: the thread's own state must come back fast, even while the website is slow (#1977).
const CHILDREN_WAIT: Duration = Duration::from_secs(5);

/// Served on the agent-only socket, next to the `thread` commands.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new()
        .route("/thread", get(status))
        .route("/providers", get(providers))
        .route("/providers/{id}/models", get(models))
}

/// The calling thread and its open children, under the Local CLI's names.
async fn status(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>, Failure> {
    let id = caller(&m, peer, "status")?;
    let mut children = m.children(&id, None, false).await;
    relay::own_children(&m, &id, false, &mut children, CHILDREN_WAIT).await;
    let mut answer = json!({"thread":m.thread(&id),"childThreads":children["children"]});
    // Children in sandboxes of their own are missing while the website can't be reached.
    if children["note"].is_string() {
        answer["note"] = children["note"].take();
    }
    Ok(Json(answer))
}

/// The agents this sandbox can start, each with its default model.
async fn providers(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>, Failure> {
    agent(&m, peer, "provider list")?;
    let list: Vec<Value> = m
        .config
        .harnesses
        .iter()
        .map(|(kind, profile)| json!({"id":kind,"model":profile.model,"provider":profile.provider}))
        .collect();
    Ok(Json(json!(list)))
}

/// How an agent without a model list names its models.
fn model_format(kind: runtime::Kind) -> &'static str {
    match kind {
        runtime::Kind::Pi | runtime::Kind::OpenCode => {
            "Models are `provider/model`, e.g. `openrouter/deepseek/deepseek-v4-pro` or `opencode-go/kimi-k3`."
        }
        runtime::Kind::Hermes => {
            "Models are `provider:model`, e.g. `openrouter:anthropic/claude-haiku-5.5`."
        }
        runtime::Kind::OpenClaw => {
            "Models are `provider/model` and need the user's own OpenClaw login or API key for that provider, e.g. `openrouter/openai/gpt-6-astra` needs their OpenRouter key in Settings → Cloud environment; for GPT models, use `--provider codex` instead."
        }
        runtime::Kind::Devin => {
            "Models are Devin's own names, e.g. `claude-opus-5-5-medium` or `adaptive`."
        }
        runtime::Kind::Fx => "Models are AI Gateway IDs, e.g. `anthropic/claude-opus-5.5`.",
        _ => "Omit --model to use its default.",
    }
}

/// One agent's models, shaped like the Local `provider models --json`. Codex, Claude Code, Cursor and OpenCode list
/// theirs; the others answer with their default and how they name models.
async fn models(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Failure> {
    agent(&m, peer, "provider models")?;
    let known = runtime::Kind::named(&id);
    let Some((kind, profile)) = known.and_then(|k| Some((k, m.config.harnesses.get(&k)?))) else {
        return Err(fail(
            StatusCode::NOT_FOUND,
            &format!("Unknown provider {id}. See room-cli provider list."),
        ));
    };
    let fallback = || json!({"id":id,"model":profile.model,"note":model_format(kind)});
    if !matches!(
        kind,
        runtime::Kind::Codex
            | runtime::Kind::Claude
            | runtime::Kind::Cursor
            | runtime::Kind::OpenCode
    ) {
        return Ok(Json(fallback()));
    }
    if m.storage.blocks() {
        if kind == runtime::Kind::OpenCode {
            return Ok(Json(fallback()));
        }
        return Err(fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Model lists are unavailable while this sandbox's disk is critically low.",
        ));
    }
    // A saved list answers at once; the first call asks the agent itself.
    let models = match m.catalog(kind, true).await {
        Ok(models) => models,
        Err(_) if kind == runtime::Kind::OpenCode => return Ok(Json(fallback())),
        Err(error) => return Err(session_failure(error)),
    };
    let mut list: Vec<Value> = Vec::with_capacity(models.len() + 1);
    if kind == runtime::Kind::OpenCode && !models.iter().any(|model| model.model == "default") {
        let efforts: Vec<Value> = runtime::OPENCODE_REASONING_LEVELS
            .iter()
            .map(|level| json!({"reasoningEffort":level}))
            .collect();
        list.push(json!({"id":"default","model":"default","supportedReasoningEfforts":efforts,"isDefault":profile.model == "default"}));
    }
    list.extend(models.iter().map(|model| {
        let efforts: Vec<Value> = model
            .reasoning_levels
            .iter()
            .map(|level| json!({"reasoningEffort":level}))
            .collect();
        json!({"id":model.model,"model":model.model,"supportedReasoningEfforts":efforts,"isDefault":model.model == profile.model})
    }));
    Ok(Json(json!(list)))
}

/// Local commands the app on the user's computer has and a sandbox doesn't.
pub const LOCAL_ONLY: [&str; 17] = [
    "cloud",
    "vm",
    "import",
    "browser",
    "settings",
    "project",
    "machine",
    "updates",
    "terminal",
    "environment",
    "file",
    "theme",
    "plugin",
    "marketplace",
    "skill",
    "guide",
    "voice",
];

/// Where a command the Cloud CLI lacks does run.
pub fn on_computer(command: &str) -> String {
    format!(
        "Cloud threads have no `room-cli {command}`. It runs in the Cloudroom app on the user's computer: room-cli mac run '~/.local/bin/room-cli {command} ...' (or plain `room-cli` on Windows; see the room-cli and cloud-mac skills)."
    )
}

async fn print(path: &str, limit: Duration) -> io::Result<i32> {
    let answer = crate::mac::request_within(crate::mac::SOCKET, "GET", path, None, Some(limit));
    let answer = answer.await?;
    println!("{answer}");
    Ok(0)
}

/// `room-cli status`. `--json` is accepted and ignored because the answer is always JSON.
pub async fn status_cli(args: &[String]) -> io::Result<i32> {
    match args.iter().find(|word| *word != "--json") {
        None => print("/thread", crate::mac::QUICK).await,
        Some(word) => {
            println!("{USAGE}");
            Ok(if matches!(word.as_str(), "--help" | "-h") {
                0
            } else {
                2
            })
        }
    }
}

/// `room-cli provider list|models`. The Local flags that pick a machine are refused: there is one sandbox here.
pub async fn provider_cli(args: &[String]) -> io::Result<i32> {
    let words: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|word| *word != "--json")
        .collect();
    match words.as_slice() {
        ["list"] => print("/providers", crate::mac::QUICK).await,
        ["models", id] if !id.starts_with('-') => {
            print(&format!("/providers/{id}/models"), crate::mac::READ).await
        }
        _ => {
            println!("{USAGE}");
            let help = words.iter().any(|word| matches!(*word, "--help" | "-h"));
            Ok(if words.is_empty() || help { 0 } else { 2 })
        }
    }
}
