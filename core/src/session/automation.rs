//! Cloud agents schedule work for their own thread (ADR 0212). `room-cli loop` is the same command: Automations are
//! called Loops in the app (ADR 0259). Core passes each command to the website (ADR 0234),
//! like feedback, so it works while the user's Mac is offline. The website's every-minute cron wakes the sandbox and
//! sends the prompt; it also computes the next run, so Core never parses cron.
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
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io, sync::Arc};

const USAGE: &str = "room-cli loop create --name NAME --prompt TEXT|--prompt-file PATH (--cron 'MIN HOUR DAY MONTH WEEKDAY' [--timezone ZONE] | --at ISO_TIME | --in 30m | --webhook) [--new-thread|--same-thread] [--script TEXT|--script-file PATH] [--provider P] [--model M] [--reasoning LEVEL] [--priority 1-4]
room-cli loop list
room-cli loop update ID [--name NAME] [--priority 1-4] [--prompt TEXT] [--cron EXPR [--timezone ZONE] | --at ISO_TIME | --in 30m] [--script TEXT|--script-file PATH] [--provider P] [--model M] [--reasoning LEVEL]
room-cli loop pause|resume|run|delete|hook ID
room-cli loop report --outcome done|acted|needs-you|failed --confidence high|medium|low --reason TEXT [--action TEXT]...
A loop runs on a schedule even while the user's Mac is off (`room-cli automation` is the same command): every minute with a script, else at most every 15 minutes. A --webhook loop runs when its secret URL gets a POST instead: create prints the URL once, `hook ID` replaces it, and each run gets the requests that arrived as data. Each --cron run starts a fresh Cloud thread in its own sandbox, from this thread's project and agent; --same-thread re-prompts this thread instead. A one-time --at/--in run re-prompts this thread; --new-thread gives it a fresh one. A fresh-thread automation saves this thread's settings, so it keeps running after this thread is archived. Its runs use this thread's agent unless --provider, --model, or --reasoning picks another (fresh-thread loops only); `list` shows each loop's agent, and `update` changes it. --priority is P1 (essential) to P4 (niche); loops start at P3. A script runs first (60 s), in the automation's own sandbox with fresh threads, else in this one: no output skips the run (exit 0 or 1; other exit codes fail it, and 3 failures in a row pause it), and its output is added to the prompt. Cloudroom fills in the next run within a minute; check `list` for it or an error. Inside a loop run, `report` records what the run did, why, and how sure it was (ADR 0298): one --action per change, like --action \"merged #419\".";
const MAX_PROMPT: usize = 32_000;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Body {
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cron: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delay: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_thread: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    script: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    webhook: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    harness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<u8>,
    // `report` (ADR 0298): the website checks the values; Core keeps out the oversized and malformed.
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actions: Option<Vec<String>>,
}

/// Served on the agent-only socket that `room-cli mac` also uses.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new().route("/automation", post(automation))
}

async fn automation(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Body>,
) -> Result<Json<Value>, Failure> {
    let session = caller(&m, peer, "automation")?;
    check(&input)?;
    let Some(api) = &m.history.api else {
        return Err(fail(
            StatusCode::CONFLICT,
            "Run room-cli loop from a Cloudroom cloud thread",
        ));
    };
    // The website finds the thread from this Core's own sign-in; the session is the agent asking.
    let mut body =
        serde_json::to_value(&input).map_err(|e| fail(StatusCode::BAD_REQUEST, &e.to_string()))?;
    body["session"] = json!(session);
    api.post("automation", &body)
        .await
        .map(Json)
        .map_err(|error| match error {
            super::history::ApiError::Status(status, message) => fail(
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                &message,
            ),
            error => fail(
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("Could not save the automation: {error}"),
            ),
        })
}

/// Clear errors before the website, which checks the cron itself.
fn check(input: &Body) -> Result<(), Failure> {
    let bad = |message: &str| Err(fail(StatusCode::BAD_REQUEST, message));
    if let Some(id) = &input.id
        && (id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
    {
        return bad("Invalid automation ID");
    }
    if input
        .name
        .as_ref()
        .is_some_and(|n| n.trim().is_empty() || n.chars().count() > 200)
    {
        return bad("Use a name of 1-200 characters");
    }
    if input
        .prompt
        .as_ref()
        .is_some_and(|p| p.trim().is_empty() || p.len() > MAX_PROMPT)
    {
        return bad("Use a prompt of 1-32000 bytes");
    }
    if input
        .script
        .as_ref()
        .is_some_and(|s| s.trim().is_empty() || s.len() > MAX_PROMPT)
    {
        return bad("Use a script of 1-32000 bytes");
    }
    if input
        .cron
        .as_ref()
        .is_some_and(|c| c.split_whitespace().count() != 5)
    {
        return bad("Use a 5-field cron: minute hour day month weekday");
    }
    // As `thread spawn` checks them; the website checks the harness.
    if input
        .model
        .as_ref()
        .is_some_and(|m| m.is_empty() || m.len() > 256 || m.chars().any(char::is_control))
    {
        return bad("invalid model");
    }
    if input
        .reasoning
        .as_ref()
        .is_some_and(|r| r.is_empty() || r.len() > 64 || !r.bytes().all(|b| b.is_ascii_lowercase()))
    {
        return bad("invalid reasoning level");
    }
    if input.webhook.is_some() && input.script.is_some() {
        return bad("A webhook loop has no script yet");
    }
    if input.priority.is_some_and(|p| !(1..=4).contains(&p)) {
        return bad("Use --priority 1, 2, 3, or 4");
    }
    if input.action == "report" {
        let text = |t: &Option<String>, max: usize| {
            t.as_ref()
                .is_some_and(|t| !t.trim().is_empty() && t.chars().count() <= max)
        };
        let actions = input.actions.as_deref().unwrap_or_default();
        if !text(&input.outcome, 20) || !text(&input.confidence, 20) || !text(&input.reason, 2000) {
            return bad("Give --outcome, --confidence, and --reason");
        }
        if actions.len() > 10
            || actions
                .iter()
                .any(|a| a.trim().is_empty() || a.chars().count() > 500)
        {
            return bad("Give up to 10 --action values of 1-500 characters");
        }
        return Ok(());
    }
    let schedules = [
        input.cron.is_some(),
        input.at.is_some(),
        input.delay.is_some(),
        input.webhook == Some(true),
    ]
    .iter()
    .filter(|s| **s)
    .count();
    if schedules > 1
        || (input.action == "create"
            && (schedules == 0 || input.name.is_none() || input.prompt.is_none()))
    {
        return bad("Give a name, a prompt, and one trigger: --cron, --at, --in, or --webhook");
    }
    Ok(())
}

fn flag<'a>(words: &[&'a str], name: &str) -> Option<&'a str> {
    words
        .iter()
        .position(|w| *w == name)
        .and_then(|i| words.get(i + 1).copied())
}

/// `--in 30m` as `30 minutes`.
fn delay(value: &str) -> Option<String> {
    let split = value.find(|c: char| !c.is_ascii_digit())?;
    let (count, unit) = value.split_at(split);
    let unit = match unit {
        "s" => "seconds",
        "m" => "minutes",
        "h" => "hours",
        "d" => "days",
        _ => return None,
    };
    (count.parse::<u32>().ok()? > 0).then(|| format!("{count} {unit}"))
}

/// `room-cli loop ...` in Cloud threads; on the Mac, `room-cli loop create --cloud` does the same.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let words: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|w| *w != "--json")
        .collect();
    if words.is_empty() || words.iter().any(|w| matches!(*w, "--help" | "-h")) {
        println!("{USAGE}");
        return Ok(0);
    }
    let mut body = json!({"action": words[0]});
    match words.as_slice() {
        ["list"] => {}
        ["report", ..] => {
            for (name, key) in [
                ("--outcome", "outcome"),
                ("--confidence", "confidence"),
                ("--reason", "reason"),
            ] {
                if let Some(value) = flag(&words, name) {
                    body[key] = json!(value);
                }
            }
            let actions: Vec<&str> = words
                .windows(2)
                .filter(|pair| pair[0] == "--action")
                .map(|pair| pair[1])
                .collect();
            if !actions.is_empty() {
                body["actions"] = json!(actions);
            }
        }
        ["pause" | "resume" | "run" | "delete" | "hook", id] => body["id"] = json!(id),
        ["create", ..] | ["update", ..] => {
            if words[0] == "update" {
                let Some(id) = words.get(1).filter(|w| !w.starts_with('-')) else {
                    println!("{USAGE}");
                    return Ok(2);
                };
                body["id"] = json!(id);
            }
            let prompt = match (flag(&words, "--prompt"), flag(&words, "--prompt-file")) {
                (Some(text), None) => Some(text.to_owned()),
                (None, Some(path)) => Some(std::fs::read_to_string(path)?),
                (None, None) => None,
                _ => {
                    println!("{USAGE}");
                    return Ok(2);
                }
            };
            if let Some(prompt) = prompt {
                body["prompt"] = json!(prompt);
            }
            let script = match (flag(&words, "--script"), flag(&words, "--script-file")) {
                (Some(text), None) => Some(text.to_owned()),
                (None, Some(path)) => Some(std::fs::read_to_string(path)?),
                (None, None) => None,
                _ => {
                    println!("{USAGE}");
                    return Ok(2);
                }
            };
            if let Some(script) = script {
                body["script"] = json!(script);
            }
            if words[0] == "create" && words.contains(&"--webhook") {
                body["webhook"] = json!(true);
            }
            if words[0] == "create" && words.contains(&"--new-thread") {
                body["new_thread"] = json!(true);
            } else if words[0] == "create" && words.contains(&"--same-thread") {
                body["new_thread"] = json!(false);
            }
            for (name, key) in [
                ("--name", "name"),
                ("--cron", "cron"),
                ("--timezone", "timezone"),
                ("--at", "at"),
                ("--provider", "harness"),
                ("--model", "model"),
                // `thread spawn` calls it --reasoning-level.
                ("--reasoning-level", "reasoning"),
                ("--reasoning", "reasoning"),
            ] {
                if let Some(value) = flag(&words, name) {
                    body[key] = json!(value);
                }
            }
            if let Some(value) = flag(&words, "--priority") {
                let Some(level) = value
                    .trim_start_matches(['p', 'P'])
                    .parse::<u8>()
                    .ok()
                    .filter(|p| (1..=4).contains(p))
                else {
                    eprintln!("Use --priority 1, 2, 3, or 4.");
                    return Ok(2);
                };
                body["priority"] = json!(level);
            }
            if let Some(value) = flag(&words, "--in") {
                let Some(interval) = delay(value) else {
                    eprintln!("Use --in with a number and s, m, h or d, like 30m.");
                    return Ok(2);
                };
                body["delay"] = json!(interval);
            }
        }
        _ => {
            println!("{USAGE}");
            return Ok(2);
        }
    }
    let answer = crate::mac::request(crate::mac::SOCKET, "POST", "/automation", Some(body)).await?;
    println!("{answer}");
    Ok(0)
}
