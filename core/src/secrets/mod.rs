//! Secure secret requests from cloud agents. The agent asks through the agent socket, the app shows
//! its secrets form from a session record, and the CLI writes the answer to a dotenv file.
use crate::{preview::Peer, session::Manager};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path as RoutePath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{self, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::oneshot;

pub const SKILL: &str = include_str!("cloud-secrets/SKILL.md");
const USAGE: &str =
    "room-cli secret request NAME... --write-env PATH [--purpose TEXT] [--describe NAME TEXT]...";
const VALUE_LIMIT: usize = 16 * 1024;
type Values = BTreeMap<String, String>;

struct Pending {
    session: String,
    names: Vec<String>,
    reply: oneshot::Sender<Answer>,
}
#[derive(Default)]
pub struct Secrets {
    pending: Mutex<HashMap<String, Pending>>,
    next: AtomicU64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    names: Vec<String>,
    #[serde(default)]
    descriptions: BTreeMap<String, String>,
    purpose: Option<String>,
    path: String,
}
/// The app's answer. No values means the request was cancelled, and `reason` says why.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    values: Option<Values>,
    reason: Option<String>,
}

pub struct Failure(StatusCode, String);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}

fn valid_name(name: &str) -> bool {
    name.len() <= 128
        && name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn valid_text(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= 4096 && !text.contains('\0')
}
fn check(r: &Request) -> Result<(), &'static str> {
    let unique: HashSet<_> = r.names.iter().collect();
    if r.names.is_empty() || r.names.len() > 50 || unique.len() != r.names.len() {
        return Err("Request 1-50 unique variable names");
    }
    if !r.names.iter().all(|n| valid_name(n)) {
        return Err(
            "Variable names must start with a letter or underscore and contain only letters, digits, and underscores",
        );
    }
    if !valid_text(&r.path)
        || r.purpose.as_deref().is_some_and(|p| !valid_text(p))
        || r.descriptions
            .iter()
            .any(|(n, d)| !r.names.contains(n) || !valid_text(d))
    {
        return Err("Invalid path, purpose, or description for the requested variables");
    }
    Ok(())
}

pub fn routes() -> Router<Arc<Manager>> {
    Router::new().route(
        "/v1/sessions/{id}/secrets/{request}",
        post(answer).layer(DefaultBodyLimit::max(1024 * 1024)),
    )
}
/// Served on the agent-only socket that `room-cli mac` also uses.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new().route("/secrets", post(ask))
}

/// The caller and its parents, so a command run by a harness maps to that harness's session.
pub(crate) fn ancestors(mut pid: i32) -> Vec<u32> {
    let mut found = Vec::new();
    while pid > 1 && found.len() < 64 {
        found.push(pid as u32);
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            break;
        };
        // The process name may contain spaces; the parent follows its closing parenthesis and state.
        pid = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(1)?.parse().ok())
            .unwrap_or(0);
    }
    found
}

/// Closes the form when the request ends, including when the waiting command disappears.
struct Open {
    manager: Arc<Manager>,
    session: String,
    id: String,
}
impl Drop for Open {
    fn drop(&mut self) {
        self.manager
            .secrets
            .pending
            .lock()
            .unwrap()
            .remove(&self.id);
        let closed = json!({"id":self.id,"state":"closed"});
        let _ = self.manager.note(&self.session, "secret_request", closed);
    }
}

async fn ask(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(request): Json<Request>,
) -> Result<Json<Value>, Failure> {
    if peer.0.is_none() || m.previews.agent().map(|(_, uid)| uid) != peer.0 {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "Only the VM agent account may request secrets".into(),
        ));
    }
    check(&request).map_err(|e| Failure(StatusCode::CONFLICT, e.into()))?;
    let session = peer
        .1
        .and_then(|pid| m.harness_session(&ancestors(pid)))
        .ok_or(Failure(
            StatusCode::CONFLICT,
            "Run room-cli secret from a Cloudroom cloud thread".into(),
        ))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let id = format!(
        "secret-{}-{}",
        now.as_millis(),
        m.secrets.next.fetch_add(1, Ordering::Relaxed)
    );
    let (reply, answer) = oneshot::channel();
    let names = request.names;
    m.secrets.pending.lock().unwrap().insert(
        id.clone(),
        Pending {
            session: session.clone(),
            names: names.clone(),
            reply,
        },
    );
    let _open = Open {
        manager: m.clone(),
        session: session.clone(),
        id: id.clone(),
    };
    let fields: Vec<_> = names
        .iter()
        .map(|n| json!({"name":n,"description":request.descriptions.get(n)}))
        .collect();
    let open = json!({"id":id,"state":"open","purpose":request.purpose,"path":request.path,"fields":fields});
    m.note(&session, "secret_request", open).map_err(|error| {
        Failure(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Could not record the secret request: {error}"),
        )
    })?;
    match answer.await {
        Ok(Answer {
            values: Some(values),
            ..
        }) => Ok(Json(json!({"values":values}))),
        answer => {
            let reason: String = answer
                .ok()
                .and_then(|a| a.reason)
                .unwrap_or_default()
                .chars()
                .filter(|c| !c.is_control())
                .take(300)
                .collect();
            let message = match reason.trim() {
                "" => "Secret request cancelled".into(),
                reason => format!("Secret request cancelled ({reason})"),
            };
            Err(Failure(StatusCode::CONFLICT, message))
        }
    }
}

async fn answer(
    State(m): State<Arc<Manager>>,
    RoutePath((session, id)): RoutePath<(String, String)>,
    Json(input): Json<Answer>,
) -> Result<impl IntoResponse, Failure> {
    let mut pending = m.secrets.pending.lock().unwrap();
    let request = pending
        .get(&id)
        .filter(|p| p.session == session)
        .ok_or(Failure(
            StatusCode::NOT_FOUND,
            "Unknown or expired secret request".into(),
        ))?;
    if input.values.as_ref().is_some_and(|values| {
        values.len() != request.names.len()
            || !request.names.iter().all(|n| {
                values.get(n).is_some_and(|v| {
                    !v.is_empty() && v.len() <= VALUE_LIMIT && !v.contains(['\n', '\r', '\0'])
                })
            })
    }) {
        return Err(Failure(
            StatusCode::CONFLICT,
            "Answer every requested variable with one non-empty line".into(),
        ));
    }
    let _ = pending.remove(&id).unwrap().reply.send(input);
    Ok((StatusCode::ACCEPTED, Json(json!({"accepted":true}))))
}

/// `room-cli secret request`: asks the user through the app, then writes the dotenv file itself.
pub async fn cli(args: &[String]) -> io::Result<i32> {
    if args.first().map(String::as_str) != Some("request") {
        println!("{USAGE}");
        return Ok(if args.is_empty() || args[0] == "--help" {
            0
        } else {
            2
        });
    }
    let request = parse(&args[1..])?;
    let path = std::env::current_dir()?.join(&request.path);
    let names = request.names;
    check_file(&read(&path)?, &names)?;
    let body = json!({"names":names,"descriptions":request.descriptions,"purpose":request.purpose,"path":path});
    let answer = crate::mac::request(crate::mac::SOCKET, "POST", "/secrets", Some(body)).await?;
    let values: Values = serde_json::from_value(answer["values"].clone())?;
    if values.len() != names.len() || !names.iter().all(|n| values.contains_key(n)) {
        return Err(io::Error::other(
            "Secret response did not contain exactly the requested variables",
        ));
    }
    let (content, added, updated, unchanged) = reconcile(&read(&path)?, &names, &values)?;
    write(&path, &content)?;
    println!(
        "{}",
        json!({"path":path,"names":names,"added":added,"updated":updated,"unchanged":unchanged})
    );
    Ok(0)
}

fn parse(args: &[String]) -> io::Result<Request> {
    let fail = |message: String| io::Error::other(format!("{message}\nUsage: {USAGE}"));
    let (mut names, mut descriptions, mut purpose, mut path) =
        (Vec::new(), BTreeMap::new(), None, None);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty() && !v.starts_with("--"))
                .ok_or_else(|| fail(format!("{arg} needs a value")))
        };
        match arg.as_str() {
            "--purpose" => purpose = Some(value()?),
            "--write-env" => path = Some(value()?),
            "--describe" => {
                let (name, text) = (value()?, value()?);
                if descriptions.insert(name.clone(), text).is_some() {
                    return Err(fail(format!("Duplicate --describe for {name}")));
                }
            }
            flag if flag.starts_with("--") => return Err(fail(format!("Unknown option {flag}"))),
            name => names.push(name.to_owned()),
        }
    }
    let path = path.ok_or_else(|| fail("--write-env is required".into()))?;
    let request = Request {
        names,
        descriptions,
        purpose,
        path,
    };
    check(&request).map_err(|e| fail(e.into()))?;
    Ok(request)
}

fn read(path: &Path) -> io::Result<String> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| io::Error::other("Dotenv file is not valid UTF-8 text")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error),
    }
}

/// Replaces the file (or its symlink target) in one step, readable only by the agent.
fn write(path: &Path, content: &str) -> io::Result<()> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("Invalid dotenv path"))?;
    fs::create_dir_all(parent)?;
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let temporary = parent.join(format!(".{name}.cloudroom-{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let written = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
        .and_then(|_| fs::rename(&temporary, &target));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

// Dotenv editing matches the local secrets plugin (gui/plugins/secrets/src/dotenv.ts).

/// Splits `[export ]NAME = value` into the text before the value, the name, and the value.
fn assignment(line: &str) -> Option<(&str, &str, &str)> {
    let start = line.trim_start();
    let body = start
        .strip_prefix("export")
        .filter(|rest| rest.starts_with(char::is_whitespace))
        .map_or(start, str::trim_start);
    let end = body
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(body.len());
    let name = &body[..end];
    let value = body[end..].trim_start().strip_prefix('=')?.trim_start();
    (!name.is_empty() && !name.starts_with(|c: char| c.is_ascii_digit()))
        .then(|| (&line[..line.len() - value.len()], name, value))
}

fn closes(value: &str, quote: char) -> bool {
    let mut escaped = false;
    for c in value.chars().skip(1) {
        if escaped {
            escaped = false;
        } else if quote == '"' && c == '\\' {
            escaped = true;
        } else if c == quote {
            return true;
        }
    }
    false
}

fn check_file(content: &str, names: &[String]) -> io::Result<()> {
    let lines: Vec<_> = content.lines().filter_map(assignment).collect();
    if lines.iter().any(|(_, _, value)| {
        value
            .chars()
            .next()
            .is_some_and(|q| matches!(q, '\'' | '"') && !closes(value, q))
    }) {
        return Err(io::Error::other(
            "Dotenv files with multiline quoted values cannot be reconciled safely",
        ));
    }
    for name in names {
        if lines.iter().filter(|(_, n, _)| n == name).count() > 1 {
            return Err(io::Error::other(format!(
                "Dotenv file contains duplicate assignments for {name}"
            )));
        }
    }
    Ok(())
}

fn encode(value: &str) -> io::Result<String> {
    if !value.contains('\'') {
        Ok(format!("'{value}'"))
    } else if !value.contains('"') && !value.contains("\\n") && !value.contains("\\r") {
        Ok(format!("\"{value}\""))
    } else if value == value.trim() && !value.contains('#') {
        Ok(value.into())
    } else {
        Err(io::Error::other(
            "A secret value cannot be represented safely in a single dotenv assignment",
        ))
    }
}

/// An unquoted ` # comment` after the old value, kept with its leading spaces.
fn comment(rest: &str) -> &str {
    let (mut quote, mut escaped, mut previous) = (None, false, None);
    for (index, c) in rest.char_indices() {
        let before: Option<char> = previous.replace(c);
        if escaped {
            escaped = false;
        } else if c == '\\' && quote == Some('"') {
            escaped = true;
        } else if c == '\'' || c == '"' {
            quote = if quote == Some(c) {
                None
            } else {
                quote.or(Some(c))
            };
        } else if c == '#' && quote.is_none() && before.is_some_and(char::is_whitespace) {
            return &rest[rest[..index].trim_end().len()..];
        }
    }
    ""
}

fn reconcile(
    content: &str,
    names: &[String],
    values: &Values,
) -> io::Result<(String, usize, usize, usize)> {
    check_file(content, names)?;
    let ending = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = content.lines().map(str::to_owned).collect();
    let (mut added, mut updated, mut unchanged) = (0, 0, 0);
    let mut missing: Vec<&String> = names.iter().collect();
    for line in &mut lines {
        let Some((prefix, name, rest)) = assignment(line) else {
            continue;
        };
        let Some(value) = values.get(name) else {
            continue;
        };
        let next = format!("{prefix}{}{}", encode(value)?, comment(rest));
        missing.retain(|n| n.as_str() != name);
        if next == *line {
            unchanged += 1;
        } else {
            updated += 1;
        }
        *line = next;
    }
    for name in missing {
        lines.push(format!("{name}={}", encode(&values[name.as_str()])?));
        added += 1;
    }
    let mut joined = lines.join(ending);
    if !joined.is_empty() && (content.ends_with('\n') || added > 0) {
        joined.push_str(ending);
    }
    Ok((joined, added, updated, unchanged))
}
