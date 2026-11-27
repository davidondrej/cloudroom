//! Cloud agents schedule work for their own thread (ADR 0212). `room-cli loop` is the same command: Automations are
//! called Loops in the app (ADR 0259). Core passes each command to the website (ADR 0234),
//! like feedback, so it works while the user's Mac is offline. The website's every-minute cron wakes the sandbox and
//! sends the prompt; it also computes the next run, so Core never parses cron.
use super::{
    Manager,
    history::ApiError,
    thread::{Failure, caller, fail},
};
use crate::{preview::Peer, runtime};
use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::StatusCode,
    routing::post,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io, sync::Arc};

const USAGE: &str = "room-cli loop create --name NAME --prompt TEXT|--prompt-file PATH (--cron 'MIN HOUR DAY MONTH WEEKDAY' [--timezone ZONE] | --at ISO_TIME | --in 30m | --webhook) [--new-thread|--same-thread] [--script TEXT|--script-file PATH] [--provider P] [--model M] [--reasoning LEVEL] [--agent P,M[,LEVEL]]... [--priority 1-4] [--secrets KEY,.env|none|all] [--parent THREAD|none]
room-cli wake WHEN \"PROMPT\"   A timer or reminder: wakes this thread once, in 5m/2h/1d or at an ISO time, within about a minute
room-cli loop list
room-cli loop update ID [--name NAME] [--priority 1-4] [--prompt TEXT] [--cron EXPR [--timezone ZONE] | --at ISO_TIME | --in 30m] [--script TEXT|--script-file PATH] [--provider P] [--model M] [--reasoning LEVEL] [--agent P,M[,LEVEL]]... [--secrets KEY,.env|none|all] [--parent THREAD|none]
room-cli loop pause|resume|run|delete|hook ID
room-cli loop report --outcome done|acted|needs-you|failed --confidence high|medium|low --reason TEXT [--action TEXT]...
room-cli loop runs ID [--limit 1-100]   A loop's past runs, newest first (20 by default): each run's thread, start and end, and its loop report. Only loops in this thread's project
A loop runs on a schedule even while the user's Mac is off (`room-cli automation` is the same command): every minute with a script, else at most every 15 minutes. `run ID` makes it due now and turns a paused loop back on; `pause ID` keeps it off until `resume ID`. A --webhook loop runs when its secret URL gets a POST instead: create prints the URL once, `hook ID` replaces it, and each run gets the requests that arrived as data. A URL takes up to 64 KB a request, but a run reads only up to its first 16 KB, less with a long prompt: send bigger reports as a link or in parts. Each --cron run starts a fresh Cloud thread in its own sandbox, from this thread's project and agent; --same-thread re-prompts this thread instead. A one-time --at/--in run re-prompts this thread; --new-thread gives it a fresh one. A fresh-thread automation saves this thread's settings, so it keeps running after this thread is archived. Its runs use this thread's agent unless --provider, --model, or --reasoning picks another (fresh-thread loops only); `list` shows every loop on the account, with each one's project_id and agent, and `update` changes the agent. --agent, given 2 to 8 times, makes agents that take turns: each run gets the next one in order, and one Cloud can't run (a plan limit, a login, a model) is skipped for the next; one --agent ends the turns. --priority is P1 (essential) to P4 (niche); loops start at P3. --secrets picks the only API keys (names from Settings → Cloud environment) a fresh-thread loop's runs and script get, plus .env for the project's .env files: pick just what the prompt and script need, like --secrets SENTRY_TOKEN,.env, or none. Without it a loop gets all of them; `list` shows each loop's secrets (null: all). Any picked list, even .env or none, blocks `room-cli mac` in its runs. A loop that needs the Mac keeps all keys: make or widen it from a Cloud thread with all keys or the desktop CLI, since a thread with picked keys passes them on and can't widen a loop; `update --secrets all` fixes only later runs. --parent picks a manager for a fresh-thread loop: an open Cloud thread in its project that each run starts under, so it can steer and archive them and they can `thread tell --parent` it; `none` clears it. A run whose manager is archived or gone starts top-level. A script runs first (60 s), in the automation's own sandbox with fresh threads, else in this one: no output skips the run (exit 0 or 1; other exit codes fail it, and 3 failures in a row pause it), and its output is added to the prompt. It keeps its state (a cursor, a seen list) in $ROOM_LOOP_STATE, never ~/.cache or /tmp, which a rebuilt sandbox loses; if that is unset, exit 2. Cloudroom fills in the next run within a minute; check `list` for it or an error. Inside a loop run, `report` records what the run did, why, and how sure it was (ADR 0298): a --reason of up to 500 characters and up to 10 --action values of up to 200 characters each, like --action \"merged #419\": group related changes, as the run's transcript keeps the details.";
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
    // Agents that take turns, one per run (docs/scopes/loops.md); the website checks each harness.
    #[serde(skip_serializing_if = "Option::is_none")]
    agents: Option<Vec<LoopAgent>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<u8>,
    // ADR 0342: comma-separated key names and `.env`, or `none` or `all`; the website checks the names.
    #[serde(skip_serializing_if = "Option::is_none")]
    secrets: Option<String>,
    // #1239: a fresh-thread loop's manager thread, or `none`; the website checks it.
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<String>,
    // `report` (ADR 0298): the website checks the values; Core keeps out the oversized and malformed.
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actions: Option<Vec<String>>,
    // `runs` (ADR 20261127-143904): how many of the newest runs, 1-100.
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LoopAgent {
    harness: String,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<String>,
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
    check_agent(&m, &session, &input).await?;
    // The website finds the thread from this Core's own sign-in; the session is the agent asking.
    let mut body =
        serde_json::to_value(&input).map_err(|e| fail(StatusCode::BAD_REQUEST, &e.to_string()))?;
    body["session"] = json!(session);
    let report = input.action == "report";
    // #1926: the loop run whose turn sends this report, so the website fills that run's row, never a newer one's.
    let run = report
        .then(|| {
            m.local
                .lock()
                .unwrap()
                .sessions
                .get(&session)?
                .current_request
                .clone()
        })
        .flatten()
        .filter(|request| super::tokens::loop_run(request));
    if let Some(run) = run {
        body["request"] = json!(run.strip_suffix("_p").unwrap_or(&run));
    }
    let answer = api.post("automation", &body).await;
    // A server error or no answer is an outage, not a refusal: say how to save the report.
    let outage = matches!(
        answer,
        Err(ApiError::Network(_)) | Err(ApiError::Status(500.., _))
    );
    let again = if report && outage {
        "\nRun the same `room-cli loop report` again in a minute: a repeat replaces it."
    } else {
        ""
    };
    answer.map(Json).map_err(|error| match error {
        ApiError::Status(status, message) => fail(
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            &format!("{message}{again}"),
        ),
        error => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!("Could not save the automation: {error}{again}"),
        ),
    })
}

/// A loop's agent must pass the check a session start runs (#300), so a bad model or effort fails now, while the
/// agent is here, not on every run. Its base is this session on create and the loop's saved agent on update; another
/// harness starts at medium (Pi at its own level), as the website's `withAgent` saves it. What can't be checked here
/// (a harness not set up, no model list) is left to the run.
async fn check_agent(m: &Arc<Manager>, session: &str, input: &Body) -> Result<(), Failure> {
    // Agents that take turns are checked by their runs: one Cloud can't run is skipped for the next.
    let picked = input.harness.is_some() || input.model.is_some() || input.reasoning.is_some();
    if !picked || !matches!(input.action.as_str(), "create" | "update") {
        return Ok(());
    }
    let base = if input.action == "create" {
        let local = m.local.lock().unwrap();
        // As the website's snapshot reads it: the model from the session's start.
        local.sessions.get(session).map(|s| {
            let start = s.receipts.values().find(|r| r.command == "start");
            let model = start.and_then(|r| r.input["model"].as_str().map(str::to_owned));
            (Some(s.harness), model, s.reasoning.clone())
        })
    } else {
        let Some(api) = &m.history.api else {
            return Ok(());
        };
        let list = api.post("automation", &json!({"action":"list"})).await;
        let loops = list
            .ok()
            .and_then(|list| list["automations"].as_array().cloned());
        loops
            .unwrap_or_default()
            .into_iter()
            .find(|l| l["id"].as_str() == input.id.as_deref())
            .filter(|l| l["agent"].is_object())
            .map(|l| {
                let text = |key: &str| l["agent"][key].as_str().map(str::to_owned);
                (
                    text("provider").and_then(|p| runtime::Kind::named(&p)),
                    text("model"),
                    text("reasoning"),
                )
            })
    };
    let Some((base, model, reasoning)) = base else {
        return Ok(());
    };
    let Some(kind) = input
        .harness
        .as_deref()
        .map(runtime::Kind::named)
        .unwrap_or(base)
    else {
        return Ok(());
    };
    let same = Some(kind) == base;
    let model = input.model.clone().or(model.filter(|_| same));
    // As `withAgent`: the same harness keeps its effort, even none (then a start checks nothing either).
    let reasoning = match input.reasoning.clone() {
        Some(reasoning) => Some(reasoning),
        None if same => reasoning,
        None => (kind != runtime::Kind::Pi).then(|| "medium".into()),
    };
    let Some(reasoning) = reasoning else {
        return Ok(());
    };
    if !m.config.harnesses.contains_key(&kind) {
        return Ok(());
    }
    let Err(super::Error::Conflict(error @ ("invalid model" | "invalid reasoning effort"))) = m
        .execution_supported(kind, model.as_ref(), &reasoning)
        .await
    else {
        return Ok(());
    };
    // Codex, Claude and Cursor name what they offer.
    let selected = model.unwrap_or_else(|| m.config.harnesses[&kind].model.clone());
    let detail = if kind == runtime::Kind::OpenCode {
        None
    } else {
        match m.model_catalog(kind).await {
            Ok(models) => runtime::supports(kind, &models, &selected, &reasoning).err(),
            Err(_) => None,
        }
    };
    let detail = detail.unwrap_or_else(|| format!("{error} {reasoning}"));
    Err(fail(
        StatusCode::BAD_REQUEST,
        &format!(
            "Cloud can't run this loop's agent: {detail}. Pick another with --model or --reasoning."
        ),
    ))
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
    let bad_model = |m: &String| m.is_empty() || m.len() > 256 || m.chars().any(char::is_control);
    let bad_reasoning =
        |r: &String| r.is_empty() || r.len() > 64 || !r.bytes().all(|b| b.is_ascii_lowercase());
    if input.model.as_ref().is_some_and(bad_model) {
        return bad("invalid model");
    }
    if input.reasoning.as_ref().is_some_and(bad_reasoning) {
        return bad("invalid reasoning level");
    }
    if let Some(agents) = &input.agents {
        if input.harness.is_some() || input.model.is_some() || input.reasoning.is_some() {
            return bad("Use --agent or --provider/--model/--reasoning, not both");
        }
        if agents.is_empty() || agents.len() > 8 {
            return bad("Give a loop 1 to 8 agents");
        }
        if agents.iter().any(|a| {
            a.harness.is_empty()
                || bad_model(&a.model)
                || a.reasoning.as_ref().is_some_and(bad_reasoning)
        }) {
            return bad("invalid --agent: use PROVIDER,MODEL[,LEVEL]");
        }
    }
    if input.webhook.is_some() && input.script.is_some() {
        return bad("A webhook loop has no script yet");
    }
    if input.limit.is_some_and(|n| !(1..=100).contains(&n)) {
        return bad("Use --limit 1 to 100");
    }
    if input.priority.is_some_and(|p| !(1..=4).contains(&p)) {
        return bad("Use --priority 1, 2, 3, or 4");
    }
    if input.secrets.as_ref().is_some_and(|s| {
        s.len() > 13_000
            || !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_,. ".contains(&b))
    }) {
        return bad(
            "Use --secrets with API key names and .env, separated by commas, or none or all",
        );
    }
    if input.action == "report" {
        let text = |t: Option<&String>, max: usize| {
            t.is_some_and(|t| !t.trim().is_empty() && t.trim().chars().count() <= max)
        };
        let actions = input.actions.as_deref().unwrap_or_default();
        // The website's limits (docs/database/0092): it saves a report whole or refuses it (#918).
        if !text(input.outcome.as_ref(), 20)
            || !text(input.confidence.as_ref(), 20)
            || input.reason.is_none()
        {
            return bad("Give --outcome, --confidence, and --reason");
        }
        if !text(input.reason.as_ref(), 500) {
            return bad("Give a --reason of 1-500 characters");
        }
        if actions.len() > 10 {
            return bad(&format!(
                "Give up to 10 --action values (got {}): group related changes; the run's transcript keeps the details",
                actions.len()
            ));
        }
        if actions.iter().any(|a| !text(Some(a), 200)) {
            return bad("Give --action values of 1-200 characters");
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

/// The desktop's Local-only target flags, read as the request reads `--name` and the rest: a Cloud loop can't move,
/// so update refuses them before any request (#2361).
fn target_flag(words: &[&str]) -> Option<&'static str> {
    ["--target-thread", "--environment", "--new-environment"]
        .into_iter()
        .find(|name| flag(words, name).is_some())
}

/// A `--project` create can't honor, read as `flag` reads the rest: empty, repeated, or not `own`, this thread's
/// `ROOM_PROJECT_ID` (as `thread spawn` refuses it).
fn bad_project(words: &[&str], own: &str) -> bool {
    let named = words.iter().filter(|w| **w == "--project").count();
    named > 1 || (named == 1 && flag(words, "--project").is_none_or(|p| p.is_empty() || p != own))
}

/// `runs ID [--limit N] [--project P]`, the desktop CLI's form, so one loop prompt works in both. The website reads only
/// this thread's project's loops, so `--project` changes nothing, even empty (an unset `$ROOM_PROJECT_ID`).
fn runs(words: &[&str]) -> Result<Value, &'static str> {
    const USE: &str = "Use room-cli loop runs ID [--limit 1-100]";
    let ["runs", id, rest @ ..] = words else {
        return Err(USE);
    };
    if id.starts_with('-') {
        return Err(USE);
    }
    let mut body = json!({"action": "runs", "id": id});
    for pair in rest.chunks(2) {
        match pair {
            ["--limit", n] => match n.parse::<u8>() {
                Ok(n) if (1..=100).contains(&n) => body["limit"] = json!(n),
                _ => return Err("Use --limit 1 to 100"),
            },
            ["--project", _] => {}
            _ => return Err(USE),
        }
    }
    Ok(body)
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

const WAKE_USAGE: &str = "room-cli wake WHEN \"PROMPT\"   Wake this thread once with a prompt: a timer or a reminder. WHEN is a delay like 5m, 2h, 1d, or an ISO time. Cloudroom checks once a minute, so it fires within about a minute of then.";

/// `wake 5m TEXT` as the one-time `create` it stands for, so setting a timer is one short line.
fn wake(args: &[String]) -> Option<Vec<String>> {
    let [when, prompt @ ..] = args else {
        return None;
    };
    let json = prompt.iter().any(|w| w == "--json");
    let prompt: Vec<&str> = prompt
        .iter()
        .map(String::as_str)
        .filter(|w| *w != "--json")
        .collect();
    let prompt = prompt.join(" ");
    if when.starts_with('-') || prompt.trim().is_empty() {
        return None;
    }
    // The website caps a name at 200 bytes, and a character can take 4.
    let name = format!("Wake: {}", prompt.chars().take(40).collect::<String>());
    let timing = if delay(when).is_some() {
        "--in"
    } else {
        "--at"
    };
    let mut create = ["create", "--name", &name, timing, when, "--prompt", &prompt]
        .map(str::to_owned)
        .to_vec();
    if json {
        create.push("--json".to_owned());
    }
    Some(create)
}

/// `room-cli loop ...` in Cloud threads; on the Mac, `room-cli loop create --cloud` does the same.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    let woken;
    let wake_call = args.first().map(String::as_str) == Some("wake");
    let args = if wake_call {
        let Some(create) = wake(&args[1..]) else {
            println!("{WAKE_USAGE}");
            let help = matches!(
                args.get(1).map(String::as_str),
                None | Some("--help" | "-h")
            );
            return Ok(if help { 0 } else { 2 });
        };
        woken = create;
        &woken[..]
    } else {
        args
    };
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
        ["runs", ..] => match runs(&words) {
            Ok(runs) => body = runs,
            Err(message) => {
                eprintln!("{message}");
                return Ok(2);
            }
        },
        ["create", ..] | ["update", ..] => {
            if words[0] == "update" {
                let Some(id) = words.get(1).filter(|w| !w.starts_with('-')) else {
                    println!("{USAGE}");
                    return Ok(2);
                };
                body["id"] = json!(id);
                if let Some(name) = target_flag(&words) {
                    eprintln!(
                        "{name} is for Local loops: a Cloud loop can't move. Create a new loop with --same-thread in the thread it should re-prompt instead."
                    );
                    return Ok(2);
                }
            } else if !wake_call {
                // The website files a Cloud loop under the caller's thread, so another project was silently ignored (#1880).
                let own = std::env::var("ROOM_PROJECT_ID").unwrap_or_default();
                if bad_project(&words, &own) {
                    let own = if own.is_empty() {
                        String::new()
                    } else {
                        format!(", {own}")
                    };
                    eprintln!(
                        "A Cloud thread creates loops only in its own project{own}. Give its ID once or omit --project; for another project, run room-cli loop create --cloud --project ID on the Mac."
                    );
                    return Ok(2);
                }
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
                ("--secrets", "secrets"),
                ("--parent", "parent"),
            ] {
                if let Some(value) = flag(&words, name) {
                    body[key] = json!(value);
                }
            }
            let agents: Vec<&str> = words
                .windows(2)
                .filter(|pair| pair[0] == "--agent")
                .map(|pair| pair[1])
                .collect();
            if !agents.is_empty() {
                let mut list = Vec::new();
                for value in agents {
                    let parts: Vec<&str> = value.split(',').map(str::trim).collect();
                    let [harness, model, rest @ ..] = parts.as_slice() else {
                        eprintln!(
                            "Use --agent PROVIDER,MODEL[,LEVEL], like claude-code,claude-fable-5-2,xhigh."
                        );
                        return Ok(2);
                    };
                    if harness.is_empty() || model.is_empty() || rest.len() > 1 {
                        eprintln!(
                            "Use --agent PROVIDER,MODEL[,LEVEL], like claude-code,claude-fable-5-2,xhigh."
                        );
                        return Ok(2);
                    }
                    let mut agent = json!({"harness": harness, "model": model});
                    if let Some(level) = rest.first().filter(|l| !l.is_empty()) {
                        agent["reasoning"] = json!(level);
                    }
                    list.push(agent);
                }
                body["agents"] = json!(list);
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

#[cfg(test)]
mod tests {
    #[test]
    fn update_refuses_local_target_flags() {
        use super::target_flag;
        assert_eq!(
            target_flag(&["update", "id", "--name", "n", "--target-thread", "t"]),
            Some("--target-thread")
        );
        // `--prompt --json --target-thread t`: room-cli drops --json first.
        assert_eq!(
            target_flag(&["update", "id", "--prompt", "--target-thread", "t"]),
            Some("--target-thread")
        );
        assert_eq!(
            target_flag(&[
                "update",
                "id",
                "--cloud",
                "--prompt",
                "--environment=staging"
            ]),
            None
        );
    }

    #[test]
    fn runs_reads_the_desktop_form() {
        use super::runs;
        let id = "0b6f3c8e-9d7a-4a59-8f8e-1c2d3e4f5a6b";
        assert_eq!(
            runs(&["runs", id, "--project", "a", "--limit", "30"]).unwrap(),
            serde_json::json!({"action": "runs", "id": id, "limit": 30})
        );
        assert!(runs(&["runs", id]).is_ok());
        // An unset $ROOM_PROJECT_ID: the website still reads only this thread's project.
        assert!(runs(&["runs", id, "--project", ""]).is_ok());
        assert!(runs(&["runs", id, "--project"]).is_err());
        assert!(runs(&["runs", id, "--limit", "0"]).is_err());
        assert!(runs(&["runs", id, "--limit"]).is_err());
        assert!(runs(&["runs", "--limit", "5"]).is_err());
    }

    #[test]
    fn create_refuses_another_project() {
        use super::bad_project;
        let create =
            |extra: &[&'static str]| [&["create", "--name", "n", "--in", "5m"], extra].concat();
        assert!(bad_project(&create(&["--project", "b"]), "a"));
        assert!(bad_project(&create(&["--project", "b"]), ""));
        assert!(!bad_project(&create(&["--project", "a"]), "a"));
        assert!(!bad_project(&create(&[]), "a"));
        // Review of #424: a repeat or an empty value is refused, and prompt text isn't an option.
        assert!(bad_project(
            &create(&["--project", "a", "--project", "b"]),
            "a"
        ));
        assert!(bad_project(
            &create(&["--project", "a", "--project", "a"]),
            "a"
        ));
        assert!(bad_project(&create(&["--project"]), "a"));
        assert!(!bad_project(
            &create(&["--prompt", "--project=b is the flag to check"]),
            "a"
        ));
    }
}
