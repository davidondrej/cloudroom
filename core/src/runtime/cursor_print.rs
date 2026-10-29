//! Speak the ACP subset Core's Cursor adapter uses, running one `cursor-agent -p` per prompt.
//!
//! Cursor's ACP mode only runs each model at its default reasoning; print mode honors every variant.
//! Core starts this as `cloudroom --cursor-driver CURSOR_BINARY` under the agent account.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::process::{CommandExt, ExitStatusExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;

struct State {
    binary: String,
    session: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    models: Vec<String>,
    fast: bool,
    turn: Option<Arc<Turn>>,
}

static STATE: Mutex<State> = Mutex::new(State {
    binary: String::new(),
    session: None,
    cwd: None,
    model: None,
    models: Vec::new(),
    fast: false,
    turn: None,
});

impl State {
    /// The selected model, or its `-fast` twin while Fast is on and Cursor offers one.
    fn variant(&self) -> Option<String> {
        let model = self.model.clone()?;
        let fast = format!("{model}-fast");
        Some(if self.fast && self.models.contains(&fast) {
            fast
        } else {
            model
        })
    }
}

pub fn run(binary: &str) -> io::Result<()> {
    STATE.lock().unwrap().binary = binary.to_owned();
    let _ = KEY_AT_START.set(saved_key());
    // Tools that detach from Cursor become this driver's children, so Stop can still find them.
    #[cfg(target_os = "linux")]
    unsafe {
        prctl(PR_SET_CHILD_SUBREAPER, 1_u64)
    };
    for line in io::stdin().lock().lines() {
        if let Ok(message @ Value::Object(_)) = serde_json::from_str(&line?) {
            handle(&message);
        }
    }
    let turn = STATE.lock().unwrap().turn.clone();
    if let Some(turn) = turn {
        turn.cancel();
        turn.wait();
    }
    Ok(())
}

fn send(value: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn reply(request: &Value, outcome: Result<Value, Value>) {
    send(match outcome {
        Ok(result) => json!({"jsonrpc":"2.0","id":request,"result":result}),
        Err(error) => json!({"jsonrpc":"2.0","id":request,"error":error}),
    });
}

fn update(kind: &str, mut fields: Value) {
    fields["sessionUpdate"] = kind.into();
    let session = STATE.lock().unwrap().session.clone();
    send(json!({"jsonrpc":"2.0","method":"session/update",
        "params":{"sessionId":session,"update":fields}}));
}

fn cursor(cwd: &str) -> Command {
    let mut command = Command::new(&STATE.lock().unwrap().binary);
    command.arg("--disable-auto-update").current_dir(cwd);
    // A login can change while this driver runs, so every Cursor process reads the saved key.
    match saved_key() {
        Some(key) => {
            command.env("CURSOR_API_KEY", key);
        }
        // The key Core passed at start was the saved one, which is gone: use the browser login.
        None if KEY_AT_START
            .get()
            .is_some_and(|key| key.is_some() && std::env::var("CURSOR_API_KEY").ok() == *key) =>
        {
            command.env_remove("CURSOR_API_KEY");
        }
        None => {}
    }
    command
}

static KEY_AT_START: OnceLock<Option<String>> = OnceLock::new();

/// The API key Core saves for Cursor (cursor_auth.rs), if any.
fn saved_key() -> Option<String> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let key = std::fs::read_to_string(home.join(".cursor/cloudroom-api-key")).ok()?;
    (!key.is_empty() && key.len() <= 4096 && key.bytes().all(|byte| byte.is_ascii_graphic()))
        .then_some(key)
}

fn cli(args: &[&str], cwd: &str) -> io::Result<String> {
    let child = cursor(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid = child.id() as i32;
    let (done, result) = mpsc::channel();
    thread::spawn(move || done.send(child.wait_with_output()));
    let Ok(output) = result.recv_timeout(Duration::from_secs(60)) else {
        unsafe { kill(pid, SIGKILL) };
        return Err(io::Error::other("Cursor CLI timed out"));
    };
    let output = output?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail: &str = if stderr.is_empty() { &stdout } else { &stderr };
        let detail = tail(detail.trim(), 300);
        return Err(io::Error::other(if detail.is_empty() {
            "Cursor CLI failed"
        } else {
            detail
        }));
    }
    Ok(stdout)
}

/// Cursor prints the new chat's ID, then may never exit; take the ID and end it.
fn create_chat(cwd: &str) -> io::Result<String> {
    let mut command = cursor(cwd);
    command
        .arg("create-chat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| match setsid() {
            -1 => Err(io::Error::last_os_error()),
            _ => Ok(()),
        });
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let (found, id) = mpsc::channel();
    thread::spawn(move || {
        let id = (BufReader::new(stdout).lines().map_while(Result::ok))
            .map(|line| line.trim().to_owned())
            .find(|line| super::cursor::valid_id(line));
        let _ = found.send(id);
    });
    let id = id.recv_timeout(Duration::from_secs(60));
    stop(&mut child, &[], false, &|| false);
    match id {
        Ok(Some(id)) => Ok(id),
        Ok(None) => Err(io::Error::other("Cursor did not create a chat")),
        Err(_) => Err(io::Error::other("Cursor CLI timed out")),
    }
}

fn open_session(request: &Value, session: &str, cwd: &str) -> io::Result<()> {
    if !super::cursor::valid_id(session) {
        return Err(io::Error::other("invalid Cursor chat ID"));
    }
    let models: Vec<Value> = cli(&["--list-models"], cwd)?
        .lines()
        .filter_map(|line| {
            let (id, name) = line.split_once(' ')?;
            let name = name.strip_prefix("- ")?;
            (!id.is_empty() && !id.contains(char::is_whitespace) && !name.is_empty())
                .then(|| json!({"modelId":id,"name":name}))
        })
        .collect();
    let mut state = STATE.lock().unwrap();
    state.session = Some(session.to_owned());
    state.cwd = Some(cwd.to_owned());
    state.models = (models.iter())
        .filter_map(|model| model["modelId"].as_str().map(str::to_owned))
        .collect();
    drop(state);
    // Cursor stores print-mode chats under chats/<md5 of the working folder>/<chat ID>.
    let store = PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join(".cursor/chats")
        .join(md5_hex(cwd.as_bytes()))
        .join(session)
        .join("meta.json");
    reply(
        request,
        Ok(json!({"sessionId":session,"path":store,"models":{"availableModels":models}})),
    );
    Ok(())
}

/// Every process's (pid, parent pid).
fn processes() -> Vec<(i32, i32)> {
    let table = Command::new("ps")
        .args(["-A", "-o", "pid=", "-o", "ppid="])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    (table.lines())
        .filter_map(|row| {
            let mut ids = row.split_whitespace().filter_map(|id| id.parse().ok());
            Some((ids.next()?, ids.next()?))
        })
        .collect()
}

fn descendants(pid: i32) -> Vec<i32> {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (child, parent) in processes() {
        children.entry(parent).or_default().push(child);
    }
    let (mut found, mut stack) = (Vec::new(), vec![pid]);
    while let Some(parent) = stack.pop() {
        for &child in children.get(&parent).into_iter().flatten() {
            found.push(child);
            stack.push(child);
        }
    }
    found
}

/// Collects detached tools that exited; as their subreaper, this driver must. `keep` is Cursor itself,
/// which its `Child` collects.
fn reap(keep: i32) {
    let me = std::process::id() as i32;
    for (pid, parent) in processes() {
        if parent == me && pid != keep && !running(pid) {
            unsafe { waitpid(pid, std::ptr::null_mut(), WNOHANG) };
        }
    }
}

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
    fn setsid() -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}
const WNOHANG: i32 = 1;

#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn prctl(option: i32, ...) -> i32;
}
#[cfg(target_os = "linux")]
const PR_SET_CHILD_SUBREAPER: i32 = 36;

/// Whether a process still runs. A zombie has already stopped.
fn running(pid: i32) -> bool {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    let zombie = (stat.rsplit(')').next()).is_some_and(|rest| rest.trim_start().starts_with('Z'));
    let alive = unsafe { kill(pid, 0) } == 0;
    alive && !zombie
}

/// TERM first; KILL whatever still runs after this.
const TERM_GRACE: Duration = Duration::from_millis(1500);
/// Stop gives up after this, within Core's 4 s shutdown grace.
const STOP_LIMIT: Duration = Duration::from_secs(3);

/// Ends Cursor and, with `tools` (or once `escalate` says so), every process started since
/// `baseline` was taken. It rescans until none is left: tools fork while being stopped, and detached
/// ones stay this driver's descendants. Returns whether everything stopped.
fn stop(child: &mut Child, baseline: &[i32], mut tools: bool, escalate: &dyn Fn() -> bool) -> bool {
    let cursor = child.id() as i32;
    let me = std::process::id() as i32;
    let (mut start, mut signalled) = (Instant::now(), Vec::new());
    loop {
        let _ = child.try_wait();
        if !tools && escalate() {
            (tools, start) = (true, Instant::now());
        }
        let mut targets = if tools {
            descendants(me)
        } else {
            descendants(cursor)
        };
        targets.retain(|pid| !baseline.contains(pid));
        targets.push(cursor);
        targets.retain(|&pid| running(pid));
        if targets.is_empty() {
            reap(cursor);
            return true;
        }
        if start.elapsed() > STOP_LIMIT {
            return false;
        }
        let late = start.elapsed() > TERM_GRACE;
        for pid in targets {
            if late || !signalled.contains(&pid) {
                unsafe { kill(pid, if late { SIGKILL } else { SIGTERM }) };
                signalled.push(pid);
            }
        }
        reap(cursor);
        thread::sleep(Duration::from_millis(50));
    }
}

/// Calls `each` with every output line, skipping lines too long to hold, until `each` returns false.
fn lines(mut reader: impl BufRead, mut each: impl FnMut(&[u8]) -> bool) {
    const LIMIT: u64 = 16 << 20;
    let mut line = Vec::new();
    let mut whole = true;
    loop {
        line.clear();
        match reader.by_ref().take(LIMIT).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let ended = line.ends_with(b"\n") || (line.len() as u64) < LIMIT;
                if whole && ended && !each(&line) {
                    return;
                }
                whole = ended;
            }
        }
    }
}

/// The first 64 KB of what Cursor writes to stderr, where its error is. The rest is read and dropped.
fn head_of(mut reader: impl Read) -> String {
    let mut kept = Vec::new();
    let _ = reader.by_ref().take(64 << 10).read_to_end(&mut kept);
    let _ = io::copy(&mut reader, &mut io::sink());
    String::from_utf8_lossy(&kept).into_owned()
}

/// How long Cursor gets to exit after its final result, or after it closes its output.
const EXIT_GRACE: Duration = Duration::from_secs(5);
/// Silence with no tool running means Cursor is stuck, not thinking.
const SILENCE: Duration = Duration::from_secs(600);
/// How long to wait for Cursor's last output once it has exited; shorter after a stop.
const DRAIN: Duration = Duration::from_secs(2);
const STOPPED_DRAIN: Duration = Duration::from_millis(400);

struct Turn {
    request: Value,
    cancelled: AtomicBool,
    supervisor: Mutex<Option<thread::JoinHandle<()>>>,
    /// Processes that ran before this turn, such as a server an earlier turn left running.
    baseline: Vec<i32>,
}

impl Turn {
    fn start(request: &Value, text: String) -> io::Result<()> {
        let (session, cwd, model) = {
            let state = STATE.lock().unwrap();
            (state.session.clone(), state.cwd.clone(), state.variant())
        };
        let (Some(session), Some(cwd)) = (session, cwd) else {
            return Err(io::Error::other("Cursor turn has no session"));
        };
        reap(0);
        let baseline = descendants(std::process::id() as i32);
        let mut command = cursor(&cwd);
        command
            .args(["-p", "--trust", "--force", "--output-format", "stream-json"])
            .args(["--stream-partial-output", "--resume", &session])
            .args(model.iter().flat_map(|model| ["--model", model.as_str()]))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unsafe {
            command.pre_exec(|| match setsid() {
                -1 => Err(io::Error::last_os_error()),
                _ => Ok(()),
            });
        }
        let mut child = command.spawn()?;
        let turn = Arc::new(Turn {
            request: request.clone(),
            cancelled: AtomicBool::new(false),
            supervisor: Mutex::new(None),
            baseline,
        });
        STATE.lock().unwrap().turn = Some(turn.clone());
        let mut stdin = child.stdin.take().unwrap();
        thread::spawn(move || stdin.write_all(text.as_bytes()));
        let stderr = child.stderr.take().unwrap();
        let (stderr_tx, stderr_rx) = mpsc::channel();
        thread::spawn(move || stderr_tx.send(head_of(stderr)));
        let stdout = child.stdout.take().unwrap();
        let (output_tx, output_rx) = mpsc::channel();
        // Only the supervisor forwards events; once the turn ends, sends fail and reading stops.
        thread::spawn(move || {
            lines(BufReader::new(stdout), |line| {
                // One unreadable event must not end the turn.
                match serde_json::from_slice::<Value>(line) {
                    Ok(event @ Value::Object(_)) => output_tx.send(event).is_ok(),
                    _ => true,
                }
            })
        });
        let supervisor = turn.clone();
        let handle = thread::spawn(move || supervisor.supervise(child, output_rx, stderr_rx));
        *turn.supervisor.lock().unwrap() = Some(handle);
        Ok(())
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Owns Cursor's process: ends the turn when Cursor exits, when it hangs after its result or
    /// goes silent, or when the user stops it. Only then does the next turn start.
    fn supervise(&self, mut child: Child, output: Receiver<Value>, stderr: Receiver<String>) {
        let mut outcome = None;
        let mut events = Events::default();
        let (mut ended, mut heard, mut silent) = (false, Instant::now(), false);
        // Set once, at the final result or the end of output; later events never extend it.
        let mut finish_by: Option<Instant> = None;
        let tick = Duration::from_millis(200);
        loop {
            if ended {
                thread::sleep(tick);
            } else {
                match output.recv_timeout(tick) {
                    Ok(event) => {
                        heard = Instant::now();
                        if events.forward(&event) {
                            outcome = Some(event);
                            finish_by.get_or_insert(heard + EXIT_GRACE);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        ended = true;
                        finish_by.get_or_insert(Instant::now() + EXIT_GRACE);
                    }
                }
            }
            if self.cancelled() || matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
                break;
            }
            if finish_by.is_some_and(|at| Instant::now() >= at) {
                // Cursor never exited: end it, and its tools too if the user stops meanwhile.
                stop(&mut child, &self.baseline, false, &|| self.cancelled());
                break;
            }
            if events.tools == 0 && heard.elapsed() > SILENCE {
                silent = true;
                stop(&mut child, &self.baseline, true, &|| false);
                break;
            }
        }
        let mut stopped = self.cancelled();
        if stopped {
            stop(&mut child, &self.baseline, true, &|| false);
        }
        // One deadline for Cursor's last output and its stderr; a stop arriving meanwhile cuts it short.
        let deadline = Instant::now() + if stopped { STOPPED_DRAIN } else { DRAIN };
        let left = || {
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(100))
        };
        while !ended && Instant::now() < deadline && (stopped || !self.cancelled()) {
            match output.recv_timeout(left()) {
                Ok(event) => {
                    if events.forward(&event) {
                        outcome = Some(event);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => ended = true,
            }
        }
        drop(output);
        let mut stderr_text = String::new();
        while Instant::now() < deadline && (stopped || !self.cancelled()) {
            if let Ok(text) = stderr.recv_timeout(left()) {
                stderr_text = text;
                break;
            }
        }
        // A stop that arrived while the turn was finishing still ends every tool before the reply.
        if self.cancelled() && !stopped {
            stop(&mut child, &self.baseline, true, &|| false);
            stopped = true;
        }
        let status = child.try_wait().ok().flatten();
        STATE.lock().unwrap().turn = None;
        let verdict = if stopped {
            Ok(json!({"stopReason":"cancelled"}))
        } else {
            verdict(outcome, status, &stderr_text, silent)
        };
        reply(&self.request, verdict);
    }

    /// Stops the turn. The supervisor ends Cursor and its tools before it reports the stop.
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn wait(&self) {
        if let Some(supervisor) = self.supervisor.lock().unwrap().take() {
            let _ = supervisor.join();
        }
    }
}

/// Forwards one turn's events as ACP updates and counts running tools.
#[derive(Default)]
struct Events {
    segment: String,
    tools: usize,
}

impl Events {
    /// Forwards `event`; returns whether it is the turn's final result.
    fn forward(&mut self, event: &Value) -> bool {
        self.segment = translate(event, std::mem::take(&mut self.segment));
        match (event["type"].as_str(), event["subtype"].as_str()) {
            (Some("tool_call"), Some("started")) => self.tools += 1,
            (Some("tool_call"), Some("completed")) => self.tools = self.tools.saturating_sub(1),
            (Some("result"), _) => return true,
            _ => {}
        }
        false
    }
}

/// Drops terminal color codes such as `\x1b[33m`.
fn without_colors(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            chars.by_ref().find(|c| c.is_ascii_alphabetic());
        } else {
            plain.push(c);
        }
    }
    plain
}

fn verdict(
    outcome: Option<Value>,
    status: Option<std::process::ExitStatus>,
    stderr: &str,
    silent: bool,
) -> Result<Value, Value> {
    let outcome = outcome.unwrap_or_default();
    // A finished turn ends with a successful result; the work is done even if Cursor then exits badly.
    if outcome["subtype"] == "success" && !truthy(&outcome["is_error"]) {
        return Ok(json!({"stopReason":"end_turn"}));
    }
    let detail = match &outcome["result"] {
        result if truthy(result) => text(result),
        _ if silent => format!("no output for {} minutes", SILENCE.as_secs() / 60),
        // Cursor's error leads stderr; long ones list every model after it.
        _ if !stderr.trim().is_empty() => {
            let plain = without_colors(stderr);
            let stderr = plain.trim();
            let short: String = stderr.chars().take(300).collect();
            if short.len() < stderr.len() {
                short + "…"
            } else {
                short
            }
        }
        _ => match status.map(|s| s.code().unwrap_or_else(|| -s.signal().unwrap_or(0))) {
            Some(code) if code != 0 => format!("exit code {code}"),
            _ => "no final result".to_owned(),
        },
    };
    Err(json!({"code":-32603,"message":detail}))
}

fn translate(event: &Value, segment: String) -> String {
    match event["type"].as_str() {
        Some("assistant") => {
            let chunk: String = (event["message"]["content"].as_array().into_iter().flatten())
                .filter(|c| c["type"] == "text")
                .filter_map(|c| c["text"].as_str())
                .collect();
            // Partial output repeats each finished segment in full; skip that copy.
            if chunk.is_empty() || chunk == segment {
                return segment;
            }
            update(
                "agent_message_chunk",
                json!({"content":{"type":"text","text":chunk}}),
            );
            return segment + &chunk;
        }
        Some("thinking") if truthy(&event["text"]) => update(
            "agent_thought_chunk",
            json!({"content":{"type":"text","text":event["text"]}}),
        ),
        Some("tool_call") => tool(event),
        _ => {}
    }
    String::new()
}

fn tool(event: &Value) {
    let call = &event["tool_call"];
    let (name, body) = (call.as_object().into_iter().flatten())
        .find(|(key, _)| key.ends_with("ToolCall"))
        .map_or(("toolCall", &Value::Null), |(key, body)| {
            (key.as_str(), body)
        });
    let args = or_empty(&body["args"]);
    let id = [&event["call_id"], &call["toolCallId"]]
        .into_iter()
        .find(|id| truthy(id))
        .map_or_else(|| "None".to_owned(), text)
        .replace('\n', "/");
    let kind = &name[..name.len() - 8];
    match event["subtype"].as_str() {
        Some("started") => {
            let title = [&args["toolName"], &args["name"]]
                .into_iter()
                .find(|title| name == "mcpToolCall" && truthy(title))
                .cloned()
                .unwrap_or_else(|| capitalize(kind).into());
            update(
                "tool_call",
                json!({"toolCallId":id,"title":title,"kind":kind,"status":"in_progress","rawInput":args}),
            );
        }
        Some("completed") => {
            let result = or_empty(&body["result"]);
            let status = if result.get("success").is_some() {
                "completed"
            } else {
                "failed"
            };
            update(
                "tool_call_update",
                json!({"toolCallId":id,"status":status,"rawOutput":result}),
            );
        }
        _ => {}
    }
}

fn handle(message: &Value) {
    let (method, params, request) = (&message["method"], &message["params"], &message["id"]);
    if method == "session/cancel" {
        let turn = STATE.lock().unwrap().turn.clone();
        if let Some(turn) = turn {
            turn.cancel();
        }
        return;
    }
    if request.is_null() {
        return;
    }
    let outcome = (|| -> io::Result<()> {
        let field = |name: &str| {
            params[name]
                .as_str()
                .ok_or_else(|| io::Error::other(format!("missing {name}")))
        };
        match method.as_str().unwrap_or_default() {
            "initialize" => reply(
                request,
                Ok(json!({"protocolVersion":1,"agentCapabilities":{"loadSession":true}})),
            ),
            "session/new" => {
                let cwd = field("cwd")?;
                open_session(request, &create_chat(cwd)?, cwd)?;
            }
            "session/load" => open_session(request, field("sessionId")?, field("cwd")?)?,
            "session/set_config_option" if params["configId"] == "model" => {
                STATE.lock().unwrap().model = Some(field("value")?.to_owned());
                reply(
                    request,
                    Ok(json!({"configOptions":[{"id":"model","currentValue":params["value"]}]})),
                );
            }
            // Cursor's own ACP names Fast the same way: a "fast" option set to "true" or "false".
            "session/set_config_option" if params["configId"] == "fast" => {
                let value = field("value")?;
                STATE.lock().unwrap().fast = value == "true";
                reply(
                    request,
                    Ok(json!({"configOptions":[{"id":"fast","currentValue":value}]})),
                );
            }
            "session/prompt" => {
                let state = STATE.lock().unwrap();
                if state.turn.is_some() || params["sessionId"].as_str() != state.session.as_deref()
                {
                    return Err(io::Error::other(
                        "Cursor turn already running or unknown session",
                    ));
                }
                drop(state);
                let text: String = (params["prompt"].as_array().into_iter().flatten())
                    .filter(|block| block["type"] == "text")
                    .filter_map(|block| block["text"].as_str())
                    .collect();
                Turn::start(request, text)?;
            }
            _ => reply(
                request,
                Err(
                    json!({"code":-32601,"message":format!("Unsupported operation: {}", text(method))}),
                ),
            ),
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        reply(
            request,
            Err(json!({"code":-32602,"message":error.to_string()})),
        );
    }
}

/// Python-style truthiness, matching the stream format's optional fields.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
    }
}

fn or_empty(value: &Value) -> Value {
    if truthy(value) {
        value.clone()
    } else {
        json!({})
    }
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first
            .to_uppercase()
            .chain(chars.flat_map(char::to_lowercase))
            .collect()
    })
}

fn tail(text: &str, count: usize) -> &str {
    let start = text
        .char_indices()
        .rev()
        .nth(count - 1)
        .map_or(0, |(i, _)| i);
    &text[start..]
}

/// Cursor names chat folders after the MD5 of the working folder.
fn md5_hex(data: &[u8]) -> String {
    const SHIFT: [u32; 16] = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    let mut state: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend((data.len() as u64 * 8).to_le_bytes());
    for block in message.chunks(64) {
        let word = |g: usize| u32::from_le_bytes(block[g * 4..g * 4 + 4].try_into().unwrap());
        let [mut a, mut b, mut c, mut d] = state;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let k = ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32;
            let f = f.wrapping_add(a).wrapping_add(k).wrapping_add(word(g));
            (a, d, c) = (d, c, b);
            b = b.wrapping_add(f.rotate_left(SHIFT[i / 16 * 4 + i % 4]));
        }
        for (total, value) in state.iter_mut().zip([a, b, c, d]) {
            *total = total.wrapping_add(value);
        }
    }
    state
        .iter()
        .flat_map(|s| s.to_le_bytes())
        .map(|b| format!("{b:02x}"))
        .collect()
}
