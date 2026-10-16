//! Speak the ACP subset Core's Cursor adapter uses, running one `cursor-agent -p` per prompt.
//!
//! Cursor's ACP mode only runs each model at its default reasoning; print mode honors every variant.
//! Core starts this as `cloudroom --cursor-driver CURSOR_BINARY` under the agent account.
use serde_json::{Value, json};
#[cfg(unix)]
use std::{
    collections::HashMap,
    os::unix::process::{CommandExt, ExitStatusExt},
};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

#[cfg(unix)]
const SIGKILL: i32 = 9;
#[cfg(unix)]
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
    for line in io::stdin().lock().lines() {
        if let Ok(message @ Value::Object(_)) = serde_json::from_str(&line?) {
            handle(&message);
        }
    }
    let turn = STATE.lock().unwrap().turn.clone();
    if let Some(turn) = turn {
        let _ = turn.cancel().join();
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
    command
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
        #[cfg(unix)]
        unsafe {
            kill(pid, SIGKILL)
        };
        #[cfg(not(unix))]
        terminate_tree(pid, true);
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
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let store = PathBuf::from(home.unwrap_or_default())
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

#[cfg(unix)]
fn descendants(pid: i32) -> Vec<i32> {
    let table = Command::new("ps")
        .args(["-A", "-o", "pid=", "-o", "ppid="])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for row in table.lines() {
        let mut ids = row.split_whitespace().filter_map(|id| id.parse().ok());
        if let (Some(child), Some(parent)) = (ids.next(), ids.next()) {
            children.entry(parent).or_default().push(child);
        }
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

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
    fn getpgid(pid: i32) -> i32;
    fn setsid() -> i32;
}

#[cfg(unix)]
fn signal_groups(pids: &[i32], signal: i32) {
    // Cursor starts shell tools in their own process groups, so stop each group.
    for &pid in pids {
        let group = unsafe { getpgid(pid) };
        // Never signal group 1 or an error result: kill(-1) reaches every process.
        if group > 1 {
            unsafe { kill(-group, signal) };
        }
    }
}

/// Windows: `taskkill /T` ends the whole tree. A polite pass first, then a forced
/// one, mirrors the Unix SIGTERM-then-SIGKILL sequence.
#[cfg(not(unix))]
fn terminate_tree(pid: i32, force: bool) {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        command.arg("/F");
    }
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let _ = command.output();
}

struct Turn {
    request: Value,
    pid: i32,
    cancelled: AtomicBool,
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
        let mut command = cursor(&cwd);
        command
            .args(["-p", "--trust", "--force", "--output-format", "stream-json"])
            .args(["--stream-partial-output", "--resume", &session])
            .args(model.iter().flat_map(|model| ["--model", model.as_str()]))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| match setsid() {
                -1 => Err(io::Error::last_os_error()),
                _ => Ok(()),
            });
        }
        let mut child = command.spawn()?;
        let turn = Arc::new(Turn {
            request: request.clone(),
            pid: child.id() as i32,
            cancelled: AtomicBool::new(false),
        });
        STATE.lock().unwrap().turn = Some(turn.clone());
        let mut stdin = child.stdin.take().unwrap();
        thread::spawn(move || stdin.write_all(text.as_bytes()));
        let mut stderr = child.stderr.take().unwrap();
        let stderr = thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        });
        let stdout = child.stdout.take().unwrap();
        thread::spawn(move || {
            let (mut segment, mut outcome) = (String::new(), None);
            for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
                // One unreadable event must not end the turn.
                let Ok(event @ Value::Object(_)) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                segment = translate(&event, segment);
                if event["type"] == "result" {
                    outcome = Some(event);
                }
            }
            let status = child.wait();
            let stderr = stderr.join().unwrap_or_default();
            STATE.lock().unwrap().turn = None;
            turn.finish(outcome, status, &stderr);
        });
        Ok(())
    }

    fn finish(
        &self,
        outcome: Option<Value>,
        status: io::Result<std::process::ExitStatus>,
        stderr: &str,
    ) {
        if self.cancelled.load(Ordering::SeqCst) {
            return reply(&self.request, Ok(json!({"stopReason":"cancelled"})));
        }
        let outcome = outcome.unwrap_or_default();
        if !outcome.is_null() && !truthy(&outcome["is_error"]) {
            return reply(&self.request, Ok(json!({"stopReason":"end_turn"})));
        }
        #[cfg(unix)]
        let code = status.map_or(-1, |s| s.code().unwrap_or_else(|| -s.signal().unwrap_or(0)));
        #[cfg(not(unix))]
        let code = status.map_or(-1, |s| s.code().unwrap_or(-1));
        let detail = match &outcome["result"] {
            result if truthy(result) => text(result),
            _ if !stderr.trim().is_empty() => tail(stderr.trim(), 500).to_owned(),
            _ => format!("exit code {code}"),
        };
        reply(
            &self.request,
            Err(json!({"code":-32603,"message":format!("Cursor turn failed: {detail}")})),
        );
    }

    fn cancel(&self) -> thread::JoinHandle<()> {
        self.cancelled.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        {
            let mut pids = vec![self.pid];
            pids.extend(descendants(self.pid));
            signal_groups(&pids, SIGTERM);
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(5));
                signal_groups(&pids, SIGKILL);
            })
        }
        #[cfg(not(unix))]
        {
            let pid = self.pid;
            terminate_tree(pid, false);
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(5));
                terminate_tree(pid, true);
            })
        }
    }
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
                let created = cli(&["create-chat"], cwd)?;
                let session = created.trim().lines().last().unwrap_or_default();
                open_session(request, session, cwd)?;
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
