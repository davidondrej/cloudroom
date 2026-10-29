//! `room-cli computer-use`: desktop apps on a virtual Linux screen in a Cloud sandbox.
//! The sandbox image installs Xvfb, AT-SPI and a pinned Cua Driver (web/computer-use.sh).
//! Everything here runs as the agent and starts lazily on the first call. The sandbox is the
//! boundary, so apps need no per-app approval here (docs/scopes/computer-use.md).

use crate::observability::Signal;
use crate::preview::Peer;
use crate::session::{
    Manager,
    thread::{Failure, caller, fail},
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::StatusCode,
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const SKILL: &str = include_str!("SKILL.md");

const DRIVER: &str = "/usr/local/lib/cloudroom/cua-driver/cua-driver";
const DISPLAY: &str = ":99";
const X_SOCKET: &str = "/tmp/.X11-unix/X99";
const X_LOCK: &str = "/tmp/.X99-lock";
const STATE: &str = "/tmp/cloudroom-computer-use";
// Cua Driver colors a session ending in "-8" with its lime palette slot, our brand color.
const SESSION: &str = "cloudroom-8";
// Upstream tools that accept a `session` label. One label keeps screenshots valid across calls.
const SESSION_TOOLS: &[&str] = &[
    "browser_click",
    "browser_dialog",
    "browser_download",
    "browser_navigate",
    "browser_pointer",
    "browser_prepare",
    "browser_set_input_files",
    "browser_type",
    "click",
    "clipboard_read",
    "clipboard_write",
    "double_click",
    "drag",
    "end_session",
    "get_agent_cursor_state",
    "get_browser_state",
    "get_cursor_position",
    "get_desktop_state",
    "get_screen_size",
    "get_session",
    "get_window_state",
    "hotkey",
    "invoke_menu",
    "move_cursor",
    "press_key",
    "right_click",
    "scroll",
    "set_agent_cursor_enabled",
    "set_agent_cursor_motion",
    "set_agent_cursor_theme",
    "set_value",
    "set_window_frame",
    "start_recording",
    "start_session",
    "type_text",
    "verify_state",
];
const BLOCKED_TOOLS: &[&str] = &["set_config", "install_extension", "check_for_update"];
const USAGE: &str = "Usage: room-cli computer-use status | start | launch <command> [args...] | tools [<tool>] | call <tool> ['<json-args>']";

type Error = Box<dyn std::error::Error>;

fn bus() -> String {
    format!("unix:path={STATE}/bus")
}

fn desktop_env(command: &mut Command) -> &mut Command {
    // Mesa's software GPU starts a thread per reported CPU, so one animated page could fill the whole box.
    // An agent's own value wins, for a heavy 3D render.
    if std::env::var_os("LP_NUM_THREADS").is_none() {
        command.env("LP_NUM_THREADS", "2");
    }
    command
        // The screen, its helpers and launched apps never keep the sandbox awake (runtime/linux.rs `desktop`).
        .env(crate::runtime::linux::DESKTOP_MARKER, "1")
        .env("DISPLAY", DISPLAY)
        .env("DBUS_SESSION_BUS_ADDRESS", bus())
        .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "false")
        .env("CUA_DRIVER_RS_UPDATE_CHECK", "false")
        .env("QT_ACCESSIBILITY", "1")
        .env("ACCESSIBILITY_ENABLED", "1")
        .env_remove("NO_AT_BRIDGE")
}

fn detach(program: &str, args: &[&str], log: &str) -> Result<u32, Error> {
    let log = std::fs::File::create(format!("{STATE}/{log}.log"))?;
    let child = desktop_env(&mut Command::new(program))
        .args(args)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;
    Ok(child.id())
}

fn wait_for(what: &str, ready: impl Fn() -> bool) -> Result<(), Error> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        if ready() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("{what} did not start; see {STATE}/*.log").into())
}

fn listening(path: &str) -> bool {
    UnixStream::connect(path).is_ok()
}

/// Whether `pid_file` names a live process started as `program`. A resume keeps /tmp but not processes, so a saved
/// PID can belong to another process by then; a zombie's command line is empty.
fn alive(pid_file: &str, program: &str) -> bool {
    std::fs::read_to_string(pid_file)
        .ok()
        .and_then(|pid| pid.trim().parse::<u32>().ok())
        .and_then(|pid| std::fs::read(format!("/proc/{pid}/cmdline")).ok())
        .is_some_and(|cmdline| cmdline.split(|&byte| byte == 0).next() == Some(program.as_bytes()))
}

/// Starts the virtual screen, the accessibility bus and the driver, once.
fn ensure_desktop() -> Result<String, Error> {
    if !Path::new(DRIVER).exists() {
        return Err("Computer use is not installed on this machine (no Cua Driver).".into());
    }
    std::fs::create_dir_all(STATE)?;
    std::fs::set_permissions(STATE, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    // One command at a time: a second one waits here, then finds everything running.
    let lock = std::fs::File::create(format!("{STATE}/desktop.lock"))?;
    lock.lock()?;
    if !listening(X_SOCKET) {
        // Xvfb won't start while its old lock names a live process.
        if !alive(X_LOCK, "Xvfb") {
            let _ = std::fs::remove_file(X_LOCK);
            let _ = std::fs::remove_file(X_SOCKET);
        }
        detach(
            "Xvfb",
            &[DISPLAY, "-screen", "0", "1440x900x24", "-nolisten", "tcp"],
            "xvfb",
        )?;
        wait_for("The virtual screen (Xvfb)", || listening(X_SOCKET))?;
    }
    let bus_socket = format!("{STATE}/bus");
    if !listening(&bus_socket) {
        let address = bus();
        detach(
            "dbus-daemon",
            &[
                "--session",
                "--nofork",
                "--nopidfile",
                &format!("--address={address}"),
            ],
            "dbus",
        )?;
        wait_for("The session bus", || listening(&bus_socket))?;
    }
    // A window manager gives windows focus, so keyboard input reaches them (web/computer-use.sh installs it).
    let wm = format!("{STATE}/wm.pid");
    if Path::new("/usr/bin/openbox").exists() && !alive(&wm, "openbox") {
        std::fs::write(&wm, detach("openbox", &[], "wm")?.to_string())?;
    }
    let atspi = format!("{STATE}/atspi.pid");
    let launcher = "/usr/libexec/at-spi-bus-launcher";
    if !alive(&atspi, launcher) {
        let pid = detach(launcher, &["--launch-immediately"], "atspi")?;
        std::fs::write(&atspi, pid.to_string())?;
    }
    let socket = format!("{STATE}/driver.sock");
    if !listening(&socket) {
        let _ = std::fs::remove_file(&socket);
        detach(DRIVER, &["serve", "--socket", &socket], "driver")?;
        wait_for("Cua Driver", || listening(&socket))?;
    }
    Ok(socket)
}

/// One `room-cli computer-use call`, for product diagnostics. Never screen content or typed text.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Event {
    tool: String,
    app: Option<String>,
    outcome: String,
    effect: Option<String>,
    ms: u64,
}

/// Served on the agent-only socket that `room-cli mac` also uses.
pub(crate) fn agent_routes() -> Router<Arc<Manager>> {
    Router::new().route("/computer-use/event", post(event))
}

async fn event(
    State(m): State<Arc<Manager>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Event>,
) -> Result<Json<Value>, Failure> {
    let session_id = caller(&m, peer, "computer-use")?;
    let short = |value: String| value.chars().take(120).collect::<String>();
    if input.tool.is_empty() || input.outcome.is_empty() {
        return Err(fail(StatusCode::CONFLICT, "tool and outcome are required"));
    }
    m.observability.record(Signal::ComputerUse {
        session_id,
        tool: short(input.tool),
        app: input.app.map(short),
        outcome: short(input.outcome),
        effect: input.effect.map(short),
        duration_ms: input.ms,
    });
    Ok(Json(json!({"recorded":true})))
}

/// The app a call targets: the process name for a pid, or the name `launch_app` got.
fn target(args: &serde_json::Map<String, Value>) -> Option<String> {
    if let Some(pid) = args.get("pid").and_then(Value::as_u64) {
        return std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .map(|name| name.trim().to_owned());
    }
    args.get("bundle_id")
        .or(args.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Reports one call without ever failing or slowing the command noticeably.
async fn report(tool: &str, app: Option<String>, stdout: &[u8], code: i32, started: Instant) {
    let parsed: Value = serde_json::from_slice(stdout).unwrap_or(Value::Null);
    let field = |key: &str| parsed.get(key).and_then(Value::as_str).map(str::to_owned);
    let outcome = field("error")
        .or(field("code"))
        .unwrap_or_else(|| if code == 0 { "ok" } else { "error" }.into());
    let body = json!({"tool":tool,"app":app,"outcome":outcome,"effect":field("effect"),"ms":started.elapsed().as_millis() as u64});
    let send = crate::mac::request(
        crate::mac::SOCKET,
        "POST",
        "/computer-use/event",
        Some(body),
    );
    let _ = tokio::time::timeout(Duration::from_secs(2), send).await;
}

async fn call(tool: &str, json: Option<&String>) -> Result<i32, Error> {
    let started = Instant::now();
    if BLOCKED_TOOLS.contains(&tool) {
        return Err(
            format!("{tool} changes Cua Driver itself and is not available to agents.").into(),
        );
    }
    let mut args: serde_json::Map<String, serde_json::Value> = match json {
        Some(text) => serde_json::from_str(text)
            .map_err(|_| "Tool arguments must be one JSON object, e.g. '{\"pid\":123}'.")?,
        None => serde_json::Map::new(),
    };
    if SESSION_TOOLS.contains(&tool) && !args.contains_key("session") {
        args.insert("session".into(), SESSION.into());
    }
    let wants_shot = matches!(tool, "get_window_state" | "get_desktop_state")
        && args.get("include_screenshot") != Some(&serde_json::Value::Bool(false));
    if wants_shot && !args.contains_key("screenshot_out_file") {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis();
        std::fs::create_dir_all(format!("{STATE}/shots"))?;
        args.insert(
            "screenshot_out_file".into(),
            format!("{STATE}/shots/{tool}-{stamp}.png").into(),
        );
    }
    let app = target(&args);
    let socket = match ensure_desktop() {
        Ok(socket) => socket,
        Err(error) => {
            let failure = json!({"error":"desktop_unavailable"}).to_string();
            report(tool, app, failure.as_bytes(), 1, started).await;
            return Err(error);
        }
    };
    let output = desktop_env(&mut Command::new(DRIVER))
        .args([
            "call",
            "--socket",
            &socket,
            tool,
            &serde_json::Value::Object(args).to_string(),
        ])
        .stderr(Stdio::inherit())
        .output()?;
    std::io::Write::write_all(&mut std::io::stdout(), &output.stdout)?;
    let code = output.status.code().unwrap_or(1);
    report(tool, app, &output.stdout, code, started).await;
    Ok(code)
}

pub async fn cli(args: &[String]) -> Result<i32, Error> {
    match args.first().map(String::as_str) {
        Some("status") => {
            let installed = Path::new(DRIVER).exists();
            let running = listening(&format!("{STATE}/driver.sock"));
            println!(
                "{}",
                serde_json::json!({ "installed": installed, "running": running, "display": DISPLAY, "screenshots": format!("{STATE}/shots") })
            );
            Ok(0)
        }
        Some("start") => {
            ensure_desktop()?;
            println!(
                "{}",
                serde_json::json!({ "running": true, "display": DISPLAY })
            );
            Ok(0)
        }
        Some("launch") => {
            let program = args.get(1).ok_or(USAGE)?;
            ensure_desktop()?;
            let rest: Vec<&str> = args[2..].iter().map(String::as_str).collect();
            let pid = detach(program, &rest, "launch")?;
            println!("{}", serde_json::json!({ "pid": pid, "display": DISPLAY }));
            Ok(0)
        }
        Some("tools") => {
            let mut command = Command::new(DRIVER);
            match args.get(1) {
                Some(tool) => command.args(["describe", tool]),
                None => command.arg("list-tools"),
            };
            Ok(desktop_env(&mut command).status()?.code().unwrap_or(1))
        }
        Some("call") => call(args.get(1).ok_or(USAGE)?, args.get(2)).await,
        _ => Err(USAGE.into()),
    }
}
