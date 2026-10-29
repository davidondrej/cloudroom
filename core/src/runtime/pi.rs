use super::{
    Adapter, Event, Handle, Progress, Resume, command as child_command, process::MAX_LINE,
};
use crate::config::{Config, HarnessConfig};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::process::Command;

const CONTEXT: &str = include_str!("pi-context.ts");
// Oldest tested Pi; sandboxes on older images keep running it while new images ship newer releases.
const PI_MINIMUM: &str = "0.85.1";
fn unique() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

pub(super) fn command(
    config: &Config,
    profile: &HarnessConfig,
    saved: Option<&Resume>,
    command_guard_enabled: bool,
    system_prompt: Option<&str>,
) -> io::Result<(Command, PathBuf, PathBuf)> {
    let directory = profile.home.join("sessions/cloudroom");
    let path = saved
        .map(|s| s.path.clone())
        .unwrap_or_else(|| directory.join(format!("{}.jsonl", unique())));
    if let Some(saved) = saved {
        validate(
            profile,
            &path,
            Some(&saved.id),
            config.storage.as_ref().map(|p| (p.agent_uid, p.agent_gid)),
        )?;
    }
    // The wrapper runs after Runtime drops identity. Pi itself initializes the empty
    // exclusively-created file, making even a pre-first-prompt session resumable.
    let mut command = child_command(Path::new("/bin/sh"), config);
    let helper = directory.join(format!("{}.context.ts", unique()));
    let create = if saved.is_some() { "" } else { ": > \"$2\"; " };
    let script = format!(
        "set -eu; v=$(\"$5\" --version); [ \"$(printf '%s\\n' {PI_MINIMUM} \"$v\" | sort -V | head -n 1)\" = {PI_MINIMUM} ] || {{ echo \"unsupported Pi version $v: require {PI_MINIMUM} or newer\" >&2; exit 1; }}; umask 077; mkdir -p \"$1\"; set -C; {create}printf '%s' \"$4\" > \"$3\"; shift 4; exec \"$@\""
    );
    command
        .env("PI_CODING_AGENT_DIR", &profile.home)
        .env("PI_OFFLINE", "1")
        .env("PI_TELEMETRY", "0")
        .arg("-c")
        .arg(script)
        .arg("cloudroom-pi")
        .arg(&directory)
        .arg(&path)
        .arg(&helper)
        .arg(format!(
            "{}\nconst commandGuardEnabled = {command_guard_enabled};\n{CONTEXT}",
            super::command_guard::SOURCE
        ))
        .arg(&profile.binary)
        .args(["--mode", "rpc", "--session"])
        .arg(&path)
        .arg("--session-dir")
        .arg(&directory)
        .arg("--provider")
        .arg(
            profile
                .provider
                .as_deref()
                .ok_or_else(|| io::Error::other("Pi provider required"))?,
        )
        .arg("--model")
        .arg(&profile.model)
        .arg("-e")
        .arg(&helper);
    if let Some(system_prompt) = system_prompt {
        command.arg("--append-system-prompt").arg(system_prompt);
    }
    Ok((command, path, helper))
}

pub(super) async fn apply_thinking(handle: &Handle, reasoning: &str) -> io::Result<()> {
    let level = if reasoning == "none" {
        "off"
    } else {
        reasoning
    };
    let supported = handle
        .call("get_available_thinking_levels", json!({}))
        .await?;
    let levels = supported["levels"].as_array().cloned().unwrap_or_default();
    if !levels.iter().any(|value| value == level) {
        let levels: Vec<&str> = levels.iter().filter_map(Value::as_str).collect();
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "Pi model does not support the selected thinking level; supported: {}",
                levels.join(", ")
            ),
        ));
    }
    handle
        .call("set_thinking_level", json!({"level":level}))
        .await?;
    let state = handle.call("get_state", json!({})).await?;
    if state["thinkingLevel"].as_str() != Some(level) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Pi did not apply the selected thinking level",
        ));
    }
    Ok(())
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    if let Some(reasoning) = handle.reasoning.as_deref() {
        apply_thinking(handle, reasoning).await?;
    }
    let state = handle.call("get_state", json!({})).await?;
    if handle.reasoning.is_none()
        && let Some(level) = state["thinkingLevel"].as_str()
    {
        let stored = if level == "off" { "none" } else { level };
        if super::pi_reasoning_accepted(stored) {
            handle.remember_baseline(stored);
        }
    }
    let id = state["sessionId"]
        .as_str()
        .ok_or_else(|| io::Error::other("missing Pi session ID"))?;
    let path = handle.session_file.as_ref().unwrap();
    if state["sessionFile"].as_str() != path.to_str()
        || state["model"]["id"].as_str() != Some(&handle.profile.model)
        || state["model"]["provider"].as_str() != handle.profile.provider.as_deref()
        || state["isStreaming"] != false
        || state["isCompacting"] != false
    {
        return Err(io::Error::other(
            "Pi startup state does not match configured session/model",
        ));
    }
    if handle.resume.as_ref().is_some_and(|s| s.id != id) {
        return Err(io::Error::other("Pi resumed a different session"));
    }
    let (file, header) = validate(&handle.profile, path, Some(id), handle.file_identity)?;
    if header["cwd"]
        .as_str()
        .map(Path::new)
        .and_then(|p| p.canonicalize().ok())
        != Some(handle.repository.canonicalize()?)
    {
        return Err(io::Error::other(
            "Pi session belongs to a different workspace",
        ));
    }
    file.sync_all()?;
    super::files::open_directory(
        &handle.profile.home.join("sessions"),
        path.parent().unwrap(),
        handle.file_identity,
    )?
    .sync_all()?;
    let commands = handle.call("get_commands", json!({})).await?;
    let found = commands["commands"].as_array().is_some_and(|commands| {
        commands.iter().any(|c| {
            c["name"] == "cloudroom_context"
                && c["description"] == "Cloudroom context-only notice (v1)"
                && c["source"] == "extension"
                && c["sourceInfo"]["path"].as_str()
                    == handle.context_file.as_ref().and_then(|p| p.to_str())
        })
    });
    if !found {
        return Err(io::Error::other(
            "Pi context extension unavailable or conflicting",
        ));
    }
    handle.call("get_fork_messages", json!({})).await?;
    Ok(id.into())
}
fn prompt_text(input: &Value) -> String {
    let mut text = input["text"].as_str().unwrap_or_default().to_owned();
    if let Some(attachments) = input["attachments"].as_array() {
        for attachment in attachments {
            if attachment["kind"] != "image"
                && let Some(path) = attachment["path"].as_str()
            {
                text.push_str(&format!("\n[Attached file: {path}]"));
            }
        }
    }
    text
}

pub(super) async fn send(handle: &Handle, request: &str, input: &Value) -> io::Result<()> {
    let mut params = json!({"message":prompt_text(input)});
    let reader = handle.clone();
    let input = input.clone();
    let envelope = json!({"id":u64::MAX.to_string(),"type":"prompt","message":prompt_text(&input),"images":[]});
    let remaining = MAX_LINE.saturating_sub(serde_json::to_vec(&envelope)?.len() + 1);
    let images =
        tokio::task::spawn_blocking(move || super::files::images(&reader, &input, remaining))
            .await
            .map_err(io::Error::other)
            .and_then(|result| result)
            // No prompt was sent: reject this request and allow queued work to continue.
            .map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("cannot read image attachment: {error}"),
                )
            })?;
    if !images.is_empty() {
        params["images"] = json!(images);
    }
    handle.process.call("prompt", params, Some(request)).await?;
    Ok(())
}

pub(super) async fn steer(handle: &Handle, request: &str, text: &str) -> io::Result<()> {
    handle
        .process
        .control(
            "prompt",
            json!({"message":text,"streamingBehavior":"steer"}),
            request,
        )
        .await?;
    Ok(())
}

pub(super) async fn compact(handle: &Handle) -> io::Result<()> {
    handle
        .process
        .call_timeout(
            "compact",
            json!({}),
            None,
            std::time::Duration::from_secs(600),
        )
        .await?;
    Ok(())
}

pub(super) async fn rewind(handle: &Handle, input: &Value) -> io::Result<Value> {
    let mut params = json!({});
    if let Some(id) = input["before"]
        .as_str()
        .or_else(|| input["entry_id"].as_str())
        .or_else(|| input["entryId"].as_str())
    {
        params["entryId"] = json!(id);
    }
    let result = handle.call("fork", params).await?;
    if result["cancelled"] == true {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Pi cancelled the rewind",
        ));
    }
    handle
        .call("prompt", json!({"message":"/cloudroom_snapshot"}))
        .await?;
    handle.call("get_state", json!({})).await
}

pub(super) async fn usage(handle: &Handle) -> io::Result<Option<Value>> {
    let mut stats = handle.call("get_session_stats", json!({})).await?;
    stats["lastUsage"] = handle.process.progress.borrow().last_usage.clone();
    Ok(Some(stats))
}
pub(super) async fn interrupt(handle: &Handle, request: &str) -> io::Result<()> {
    // Pi abort alone can continue its memory-only queue. Cloudroom's durable
    // future requests stay in Session Management and are not cleared here.
    handle
        .process
        .control("clear_queue", json!({}), request)
        .await?;
    handle.process.control("abort", json!({}), request).await?;
    Ok(())
}

pub(super) async fn notice(handle: &Handle, text: &str) -> io::Result<()> {
    handle
        .call(
            "prompt",
            json!({"message":format!("/cloudroom_context {}",json!({"text":text}))}),
        )
        .await?;
    Ok(())
}

pub(super) fn checkpoint(data: &Value, native: Option<&str>) -> io::Result<Value> {
    let entry = data["cursor"]["entry"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| io::Error::other("missing Pi entry cursor"))?;
    Ok(
        json!({"entry":entry,"line":native.ok_or_else(||io::Error::other("missing native record"))?}),
    )
}

pub(super) struct Protocol {
    capture: Capture,
    expected: Option<String>,
    prompt: Option<u64>,
    compaction: Option<u64>,
    accepted: bool,
    interrupting: bool,
    /// The provider's reason for the last failed assistant message, shown to the user when the turn fails.
    error: Option<String>,
    forking: bool,
    known_users: std::collections::HashSet<String>,
    close_mask: u8,
}
impl Protocol {
    pub fn new(
        profile: &HarnessConfig,
        path: &Path,
        saved: Option<&Resume>,
        file_identity: super::files::Identity,
    ) -> io::Result<Self> {
        Ok(Self {
            capture: Capture::new(
                profile,
                path,
                saved.map(|s| s.cursor.clone()).unwrap_or(Value::Null),
                file_identity,
            )?,
            expected: saved.map(|s| s.id.clone()),
            prompt: None,
            compaction: None,
            accepted: false,
            interrupting: false,
            error: None,
            forking: false,
            known_users: Default::default(),
            close_mask: 0,
        })
    }
    fn probe(&self) -> Value {
        json!({"id":format!("settled-{}",self.prompt.unwrap_or(0)),"type":"get_state"})
    }
}
impl Adapter for Protocol {
    fn encode(&mut self, id: u64, method: &str, mut params: Value, request: Option<&str>) -> Value {
        if request.is_some() {
            self.prompt = Some(id);
            self.accepted = false;
            self.interrupting = false;
            self.error = None;
        }
        if method == "abort" {
            self.interrupting = true;
        }
        if method == "fork" {
            self.forking = true;
        }
        if method == "compact" {
            self.compaction = Some(id);
        }
        params["id"] = json!(id.to_string());
        params["type"] = json!(method);
        params
    }
    fn receive(&mut self, v: &Value, raw: String, s: &mut Progress) -> io::Result<Vec<Event>> {
        let t = v["type"].as_str().unwrap_or("");
        if t == "cloudroom_child_request" {
            let field = |name: &str| {
                v[name]
                    .as_str()
                    .ok_or_else(|| io::Error::other("invalid child request"))
            };
            let id = field("id")?;
            let prompt = field("prompt")?;
            if id.is_empty()
                || id.len() > 48
                || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || prompt.trim().is_empty()
                || prompt.len() > crate::session::MAX_PROMPT
            {
                return Err(io::Error::other("invalid child request"));
            }
            return Ok(vec![Event::ChildRequest(super::ChildRequest {
                request: s
                    .request
                    .clone()
                    .filter(|_| !s.finished)
                    .ok_or_else(|| io::Error::other("child requires an active parent"))?,
                id: id.to_owned(),
                tool_call_id: field("tool_call_id")?.to_owned(),
                prompt: prompt.to_owned(),
            })]);
        }
        let update = &v["assistantMessageEvent"];
        // Tool arguments arrive whole in tool_execution_start; nothing reads the per-token chunks.
        if t == "message_update" && update["type"] == "toolcall_delta" {
            return Ok(vec![]);
        }
        // Usage on every streaming update would add a usage row per chunk; the meter reads completed messages.
        let usage = (t != "message_update").then_some(&v["usage"]);
        let kind = match t {
            "message_update" => match update["type"].as_str() {
                Some("text_delta") => "text_delta",
                Some("thinking_delta") => "thinking_delta",
                _ => "native_event",
            },
            "tool_execution_start" => "item_started",
            "tool_execution_update" => "tool_snapshot",
            "tool_execution_end" => "item_completed",
            _ => "native_event",
        };
        let mut events = vec![Event::Record {
            kind,
            data: json!({"harness":"pi","type":t,"request_id":s.request,"item_id":v["toolCallId"],"tool_name":v["toolName"],"delta":update["delta"],"output":v["partialResult"],"result":v["result"],"message":v["message"],"usage":usage}),
            native: Some(raw),
        }];
        if t == "response"
            && self.compaction.is_some()
            && v["id"].as_str().and_then(|id| id.parse::<u64>().ok()) == self.compaction
        {
            self.compaction = None;
            events.push(Event::Compacted {
                status: if v["success"] == true {
                    "completed"
                } else {
                    "failed"
                }
                .into(),
            });
        }
        if t == "extension_error" && self.forking {
            return Err(io::Error::other(
                "Pi extension failed while preparing the fork",
            ));
        }
        if t == "response" && v["command"] == "get_fork_messages" && v["success"] == true {
            let messages = v["data"]["messages"]
                .as_array()
                .ok_or_else(|| io::Error::other("missing fork messages"))?;
            let mut checkpoint = None;
            for message in messages {
                if let Some(id) = message["entryId"].as_str()
                    && self.known_users.insert(id.to_owned())
                    && checkpoint.is_none()
                {
                    checkpoint = Some(id.to_owned());
                }
            }
            if v["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("checkpoint-"))
                && let (Some(id), Some(request)) = (checkpoint, &s.request)
            {
                events.push(Event::Record {
                    kind: "checkpoint",
                    data: json!({"kind":"entry","id":id,"request_id":request}),
                    native: None,
                });
            }
        }
        if t == "response"
            && v["command"] == "fork"
            && (v["success"] != true || v["data"]["cancelled"] == true)
        {
            self.forking = false;
        }
        if t == "response" && v["command"] == "get_state" && v["success"] == true {
            let data = &v["data"];
            let id = data["sessionId"]
                .as_str()
                .ok_or_else(|| io::Error::other("missing Pi identity"))?;
            if self.expected.as_deref().is_some_and(|old| old != id) && !self.forking
                || !self.forking && data["sessionFile"].as_str() != self.capture.path.to_str()
            {
                return Err(io::Error::other("Pi identity changed"));
            }
            if self.forking {
                let path = PathBuf::from(
                    data["sessionFile"]
                        .as_str()
                        .ok_or_else(|| io::Error::other("missing fork path"))?,
                );
                if self.expected.as_deref() == Some(id) {
                    return Err(io::Error::other("Pi did not replace the session"));
                }
                validate(
                    &self.capture.profile,
                    &path,
                    Some(id),
                    self.capture.file_identity,
                )?;
                loop {
                    let records = self.capture.read()?;
                    if records.is_empty() {
                        break;
                    }
                    events.extend(records);
                }
                self.capture = Capture::new(
                    &self.capture.profile,
                    &path,
                    Value::Null,
                    self.capture.file_identity,
                )?;
                self.expected = Some(id.into());
                self.forking = false;
                self.prompt = None;
                self.accepted = false;
                *s = Progress {
                    native: Some(id.into()),
                    finished: true,
                    ..Progress::default()
                };
                events.push(Event::Record {
                    kind: "rewind_ready",
                    data: json!({"id":id,"path":path,"cursor":null}),
                    native: None,
                });
            } else {
                self.expected = Some(id.into());
                if s.native.is_none() {
                    s.native = Some(id.into());
                    events.push(Event::Record {
                        kind: "native_identity",
                        data: json!({"id":id,"path":self.capture.path}),
                        native: None,
                    });
                }
            }
            if v["id"] == self.probe()["id"]
                && self.accepted
                && data["isStreaming"] == false
                && data["isCompacting"] == false
                && data["pendingMessageCount"] == 0
            {
                let status = if self.interrupting {
                    "interrupted"
                } else if !s.status.is_empty() {
                    &s.status
                } else if !s.started {
                    "completed"
                } else {
                    "unknown"
                }
                .to_owned();
                let error = (status == "failed").then(|| self.error.take()).flatten();
                events.extend(s.finished(&status, error));
            }
        }
        if t == "response"
            && v["id"].as_str().and_then(|id| id.parse::<u64>().ok()) == self.prompt
            && self.prompt.is_some()
        {
            self.accepted = v["success"] == true;
            if !self.accepted {
                s.finished = true;
            }
        }
        match t {
            "agent_start" => events.extend(s.started()),
            "extension_error" if !s.started && v["event"] == "command" => {
                s.status = "failed".into()
            }
            "message_end" if v["message"]["role"] == "assistant" => {
                s.last_usage = v["message"]["usage"].clone();
                let text = v["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    s.last_text = text;
                }
                self.error = (v["message"]["stopReason"] == "error")
                    .then(|| v["message"]["errorMessage"].as_str())
                    .flatten()
                    .map(str::to_owned);
                if v["message"]["stopReason"] == "error"
                    && v["message"]["errorMessage"]
                        .as_str()
                        .is_some_and(|m| m.to_ascii_lowercase().contains("usage limit"))
                {
                    events.push(Event::Record {
                        kind: "usage_limited",
                        data: json!({"harness":"pi"}),
                        native: None,
                    });
                    // Said like Claude's and Codex's, so a loop at the limit waits instead of failing (ADR 0292).
                    self.error = self
                        .error
                        .take()
                        .map(|said| super::plan_limit_error("Pi", None, &said));
                }
                s.status = match v["message"]["stopReason"].as_str() {
                    Some("aborted") => "interrupted",
                    Some("error" | "length") => "failed",
                    Some("stop" | "toolUse") => "completed",
                    _ => "unknown",
                }
                .into();
            }
            "extension_ui_request"
                if matches!(
                    v["method"].as_str(),
                    Some("select" | "confirm" | "input" | "editor")
                ) =>
            {
                events.push(Event::Record {
                    kind: "interaction_cancelled",
                    data: json!({"harness":"pi","id":v["id"],"reason":"interactive dialogs are unsupported; not approved"}),
                    native: None,
                });
            }
            _ => {}
        }
        Ok(events)
    }
    fn response(&self, v: &Value) -> Option<(u64, io::Result<Value>)> {
        if v["type"] != "response" {
            return None;
        }
        let id = v["id"].as_str()?.parse().ok()?;
        Some((
            id,
            if v["success"] == true {
                Ok(v.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "Pi rejected the {} command: {}",
                        v["command"].as_str().unwrap_or("unknown"),
                        v["error"].as_str().unwrap_or("no error message returned")
                    ),
                ))
            },
        ))
    }
    fn respond(&self, v: &Value) -> Vec<Value> {
        if v["type"] == "extension_ui_request"
            && matches!(
                v["method"].as_str(),
                Some("select" | "confirm" | "input" | "editor")
            )
        {
            return vec![json!({"type":"extension_ui_response","id":v["id"],"cancelled":true})];
        }
        if self.prompt.is_some()
            && (v["type"] == "agent_settled"
                || v["type"] == "response"
                    && v["command"] == "prompt"
                    && v["id"].as_str().and_then(|id| id.parse::<u64>().ok()) == self.prompt
                    && v["success"] == true)
        {
            if v["type"] == "agent_settled" {
                return vec![
                    json!({"type":"get_fork_messages","id":format!("checkpoint-{}", self.prompt.unwrap_or_default())}),
                    self.probe(),
                ];
            }
            return vec![self.probe()];
        }
        vec![]
    }
    fn capture(&mut self) -> io::Result<Vec<Event>> {
        self.capture.read()
    }
    fn close(&mut self) -> Vec<Value> {
        self.interrupting = true;
        vec![
            json!({"type":"clear_queue","id":"close-queue"}),
            json!({"type":"abort_bash","id":"close-bash"}),
            json!({"type":"abort","id":"close-agent"}),
        ]
    }
    fn closed(&mut self, v: &Value) -> bool {
        if v["type"] == "response" && v["success"] == true {
            self.close_mask |= match v["id"].as_str() {
                Some("close-queue") => 1,
                Some("close-bash") => 2,
                Some("close-agent") => 4,
                _ => 0,
            };
        }
        self.close_mask == 7
    }
}

fn validate(
    profile: &HarnessConfig,
    path: &Path,
    id: Option<&str>,
    identity: super::files::Identity,
) -> io::Result<(File, Value)> {
    let mut file = super::files::open(&profile.home.join("sessions"), path, identity)?;
    let header = read_header(&mut file, id)?;
    Ok((file, header))
}

fn read_header(file: &mut File, id: Option<&str>) -> io::Result<Value> {
    file.seek(SeekFrom::Start(0))?;
    let mut line = String::new();
    BufReader::new(file)
        .take(MAX_LINE as u64)
        .read_line(&mut line)?;
    let header: Value = serde_json::from_str(&line)?;
    if header["type"] != "session"
        || header["version"] != 3
        || header["id"].as_str().is_none()
        || id.is_some_and(|id| header["id"] != id)
    {
        return Err(io::Error::other(
            "invalid Pi session header; refusing implicit migration",
        ));
    }
    Ok(header)
}

struct Capture {
    profile: HarnessConfig,
    path: PathBuf,
    cursor: Value,
    offset: u64,
    anchor: String,
    initialized: bool,
    identity: Option<String>,
    file_identity: super::files::Identity,
    file: Option<File>,
}
impl Capture {
    fn new(
        profile: &HarnessConfig,
        path: &Path,
        cursor: Value,
        file_identity: super::files::Identity,
    ) -> io::Result<Self> {
        Ok(Self {
            profile: profile.clone(),
            path: path.into(),
            cursor,
            offset: 0,
            anchor: String::new(),
            initialized: false,
            identity: None,
            file_identity,
            file: None,
        })
    }
    fn read(&mut self) -> io::Result<Vec<Event>> {
        let info = match fs::symlink_metadata(&self.path) {
            Ok(info) => info,
            Err(error) if error.kind() == io::ErrorKind::NotFound && self.cursor.is_null() => {
                return Ok(vec![]);
            }
            Err(error) => return Err(error),
        };
        if !info.is_file() {
            return Err(io::Error::other("Pi history must be a regular file"));
        }
        let same_file = self
            .file
            .as_ref()
            .map(|file| file.metadata())
            .transpose()?
            .is_some_and(|saved| (saved.dev(), saved.ino()) == (info.dev(), info.ino()));
        if !same_file {
            self.file = Some(super::files::open(
                &self.profile.home.join("sessions"),
                &self.path,
                self.file_identity,
            )?);
        }
        let file = self.file.as_mut().unwrap();
        if file.metadata()?.len() == 0 {
            if !self.cursor.is_null() {
                return Err(io::Error::other("Pi history disappeared"));
            }
            return Ok(vec![]);
        }
        let header = read_header(file, self.identity.as_deref())?;
        self.identity = header["id"].as_str().map(str::to_owned);
        // Verify the captured boundary on each read. Rewrites are reconciled by native
        // entry ID and exact content, never by blindly reusing a Codex byte offset.
        if self.initialized && self.offset >= self.anchor.len() as u64 && !self.anchor.is_empty() {
            let mut anchor = vec![0; self.anchor.len()];
            file.seek(SeekFrom::Start(self.offset - self.anchor.len() as u64))?;
            if file.read_exact(&mut anchor).is_err() || anchor != self.anchor.as_bytes() {
                self.initialized = false;
                self.offset = 0;
            }
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(file);
        let mut found = self.initialized || self.cursor.is_null();
        let mut events = Vec::new();
        loop {
            let mut raw = String::new();
            let n = (&mut reader)
                .take((MAX_LINE + 1) as u64)
                .read_line(&mut raw)?;
            if n == 0 {
                break;
            }
            if n > MAX_LINE {
                return Err(io::Error::other("Pi history record too large"));
            }
            if !raw.ends_with('\n') {
                break;
            }
            self.offset += n as u64;
            let entry: Value = serde_json::from_str(&raw)?;
            let key = if entry["type"] == "session" {
                format!("session:{}", header["id"].as_str().unwrap())
            } else {
                entry["id"]
                    .as_str()
                    .ok_or_else(|| io::Error::other("Pi entry missing ID"))?
                    .to_owned()
            };
            if !found {
                if self.cursor["entry"] == key {
                    if self.cursor["line"] != raw {
                        return Err(io::Error::other("Pi captured entry changed"));
                    }
                    found = true;
                    self.anchor = raw;
                }
                continue;
            }
            self.anchor = raw.clone();
            self.cursor = json!({"entry":key,"line":raw});
            events.push(Event::Record {
                kind: "native_record",
                data: json!({"harness":"pi","cursor":{"entry":self.cursor["entry"]}}),
                native: Some(self.anchor.clone()),
            });
            if events.len() == 128 {
                break;
            }
        }
        if !found {
            return Err(io::Error::other("Pi history cursor no longer exists"));
        }
        self.initialized = true;
        Ok(events)
    }
}
pub(super) fn recover(
    profile: &HarnessConfig,
    saved: &Resume,
    identity: super::files::Identity,
    mut emit: impl FnMut(Event) -> io::Result<()>,
) -> io::Result<()> {
    let (file, _) = validate(profile, &saved.path, Some(&saved.id), identity)?;
    let mut capture = Capture::new(profile, &saved.path, saved.cursor.clone(), identity)?;
    capture.file = Some(file);
    loop {
        let events = capture.read()?;
        if events.is_empty() {
            return Ok(());
        }
        for event in events {
            emit(event)?;
        }
    }
}
