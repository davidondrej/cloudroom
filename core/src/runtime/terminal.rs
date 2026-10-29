//! Interactive terminals for the app: a shell on a PTY in a session's workspace that keeps running while the
//! app reconnects. After `101 Switching Protocols` both sides send frames: a kind byte, a big-endian u32
//! length, then the data. To the app: OUTPUT bytes, EXIT `{"code"}`, HELLO `{"offset","cwd","shell"}` (first,
//! and again after skipped output), PING. From the app: INPUT bytes, RESIZE (cols, rows as u16), PING.
use super::{Kind, linux};
use crate::{config::Config, session::Manager};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path as RoutePath, Query, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    ffi::{CStr, c_char},
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{fs::OpenOptionsExt, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, unix::AsyncFd},
    sync::watch,
};

/// Output kept for a reconnecting app. The app keeps the long scrollback; this covers dropped connections.
const REPLAY: usize = 1024 * 1024;
const MAX_FRAME: usize = 1024 * 1024;
/// Keeps sandbox proxies from closing a quiet connection, and finds dead ones.
const PING: Duration = Duration::from_secs(25);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT: u8 = 0;
const EXIT: u8 = 1;
const HELLO: u8 = 2;
const PING_FRAME: u8 = 3;
const INPUT: u8 = 0;
const RESIZE: u8 = 1;

#[cfg(all(target_os = "linux", target_env = "musl"))]
type IoctlRequest = i32;
#[cfg(not(all(target_os = "linux", target_env = "musl")))]
type IoctlRequest = std::ffi::c_ulong;
#[cfg(target_os = "linux")]
mod sys {
    pub const TIOCSCTTY: super::IoctlRequest = 0x540E;
    pub const TIOCSWINSZ: super::IoctlRequest = 0x5414;
    pub const O_NOCTTY: i32 = 0o400;
    pub const O_NONBLOCK: i32 = 0o4000;
}
#[cfg(not(target_os = "linux"))]
mod sys {
    pub const TIOCSCTTY: super::IoctlRequest = 0x2000_7461;
    pub const TIOCSWINSZ: super::IoctlRequest = 0x8008_7467;
    pub const O_NOCTTY: i32 = 0x20000;
    pub const O_NONBLOCK: i32 = 0x4;
}
unsafe extern "C" {
    fn grantpt(fd: i32) -> i32;
    fn unlockpt(fd: i32) -> i32;
    fn ptsname_r(fd: i32, buf: *mut c_char, len: usize) -> i32;
    fn ioctl(fd: i32, request: IoctlRequest, ...) -> i32;
    fn fcntl(fd: i32, command: i32, argument: i32) -> i32;
    fn setsid() -> i32;
    fn geteuid() -> u32;
    fn kill(pid: i32, signal: i32) -> i32;
}

#[repr(C)]
struct WindowSize {
    rows: u16,
    cols: u16,
    width: u16,
    height: u16,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The master side and the shell's side. Both close on exec, so no other child keeps the terminal open.
fn open_pty() -> io::Result<(File, File)> {
    let open = |path: &str| {
        OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(sys::O_NOCTTY)
            .open(path)
    };
    let master = open("/dev/ptmx")?;
    let fd = master.as_raw_fd();
    let mut name: [c_char; 128] = [0; 128];
    if unsafe { grantpt(fd) } != 0 || unsafe { unlockpt(fd) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { ptsname_r(fd, name.as_mut_ptr(), name.len()) } != 0 {
        return Err(io::Error::other("the new terminal has no device name"));
    }
    let path = unsafe { CStr::from_ptr(name.as_ptr()) }
        .to_str()
        .map_err(|_| io::Error::other("the new terminal has an invalid device name"))?
        .to_owned();
    Ok((master, open(&path)?))
}

fn set_size(pty: &impl AsRawFd, cols: u16, rows: u16) -> io::Result<()> {
    let size = WindowSize {
        rows: rows.max(1),
        cols: cols.max(1),
        width: 0,
        height: 0,
    };
    if unsafe { ioctl(pty.as_raw_fd(), sys::TIOCSWINSZ, &size) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// `claude`, `codex` and `cursor-agent` start signed in with the logins Core gives its agents, read once when
/// the shell starts. Only this shell's variables change; the agents' own logins are untouched.
fn logins(process: &mut tokio::process::Command, config: &Config) {
    if let Some(profile) = config.harnesses.get(&Kind::Claude) {
        super::claude::profile_env(process, config, profile);
    }
    if let Some(profile) = config.harnesses.get(&Kind::Codex) {
        process.env("CODEX_HOME", &profile.home);
    }
    if config.harnesses.contains_key(&Kind::Cursor) {
        // A missing or unreadable key still opens the shell; Cursor then uses its own login file.
        let _ = super::cursor_auth::apply_key(process, config);
    }
}

struct Output {
    replay: VecDeque<u8>,
    written: u64,
    exit: Option<Option<i32>>,
}
impl Output {
    fn start(&self) -> u64 {
        self.written - self.replay.len() as u64
    }
}

pub struct Terminal {
    pty: AsyncFd<File>,
    pid: u32,
    shell: &'static str,
    cwd: PathBuf,
    /// Dropping it ends every process the shell started.
    group: Mutex<Option<linux::Workload>>,
    output: Mutex<Output>,
    changed: watch::Sender<u64>,
    /// The newest connection wins; older ones leave.
    viewer: AtomicU64,
    /// Last input or output, so an open but quiet terminal lets the sandbox sleep.
    active: AtomicU64,
}

impl Terminal {
    fn spawn(
        config: &Config,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        command: Option<&str>,
    ) -> io::Result<(Self, tokio::process::Child)> {
        let (master, slave) = open_pty()?;
        set_size(&master, cols, rows)?;
        let shell = ["/bin/bash", "/bin/sh"]
            .into_iter()
            .find(|shell| Path::new(shell).exists())
            .unwrap_or("/bin/sh");
        let mut process = super::command(Path::new(shell), config);
        if let Some(command) = command {
            process.arg("-c").arg(command);
        }
        process
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("SHELL", shell)
            .current_dir(&cwd);
        logins(&mut process, config);
        let group = match &config.storage {
            Some(policy) => {
                // The shell owns its terminal, as on any login.
                if unsafe { geteuid() } == 0 {
                    std::os::unix::fs::fchown(&slave, Some(policy.agent_uid), None)?;
                }
                let group = linux::Workload::create(policy)?;
                group.attach(&mut process, policy)?;
                process.env("npm_config_cache", policy.cache_dir.join("npm"));
                Some(group)
            }
            None => None,
        };
        process
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        // Only system calls after fork: the shell leads its own session, with this terminal as its own.
        unsafe {
            process.as_std_mut().pre_exec(|| {
                if setsid() < 0 || ioctl(0, sys::TIOCSCTTY, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = process.spawn()?;
        // Closes this side's copies of the shell's terminal, so reading ends when the shell's processes do.
        drop(process);
        let fd = master.as_raw_fd();
        let flags = unsafe { fcntl(fd, 3, 0) }; // F_GETFL
        if flags < 0 || unsafe { fcntl(fd, 4, flags | sys::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("the shell has no process ID"))?;
        let terminal = Self {
            pty: AsyncFd::new(master)?,
            pid,
            shell,
            cwd,
            group: Mutex::new(group),
            output: Mutex::new(Output {
                replay: VecDeque::new(),
                written: 0,
                exit: None,
            }),
            changed: watch::channel(0).0,
            viewer: AtomicU64::new(0),
            active: AtomicU64::new(now_ms()),
        };
        Ok((terminal, child))
    }

    fn changed(&self) {
        self.changed.send_modify(|n| *n += 1);
    }

    fn append(&self, bytes: &[u8]) {
        let mut output = self.output.lock().unwrap();
        output.replay.extend(bytes);
        let excess = output.replay.len().saturating_sub(REPLAY);
        output.replay.drain(..excess);
        output.written += bytes.len() as u64;
        drop(output);
        self.active.store(now_ms(), Ordering::Relaxed);
        self.changed();
    }

    /// Reads until every process has closed the terminal.
    async fn pump(&self) {
        let mut buffer = vec![0; 64 * 1024];
        loop {
            let Ok(mut ready) = self.pty.readable().await else {
                return;
            };
            match ready.try_io(|pty| pty.get_ref().read(&mut buffer)) {
                Ok(Ok(0)) | Ok(Err(_)) => return, // Linux reports EIO once the shell's side is closed.
                Ok(Ok(n)) => self.append(&buffer[..n]),
                Err(_would_block) => {}
            }
        }
    }

    async fn write(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let mut ready = self.pty.writable().await?;
            match ready.try_io(|pty| pty.get_ref().write(bytes)) {
                Ok(written) => bytes = &bytes[written?..],
                Err(_would_block) => {}
            }
        }
        self.active.store(now_ms(), Ordering::Relaxed);
        Ok(())
    }

    fn kill(&self) {
        match self.group.lock().unwrap().take() {
            Some(group) => drop(group),
            // Unprotected test mode: the shell leads its own process group.
            None => unsafe {
                kill(-(self.pid as i32), 9);
            },
        }
    }

    fn finish(&self, code: Option<i32>) {
        // Background jobs the shell left behind end with it.
        self.group.lock().unwrap().take();
        self.output.lock().unwrap().exit = Some(code);
        self.changed();
    }

    /// One app connection: replay output since `since`, then stream until the shell exits, the app goes
    /// away, or a newer connection takes over.
    pub async fn serve<S>(self: Arc<Self>, stream: S, since: u64)
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let me = self.viewer.fetch_add(1, Ordering::SeqCst) + 1;
        self.changed();
        let (mut from_app, mut to_app) = tokio::io::split(stream);
        let terminal = self.clone();
        let mut input = tokio::spawn(async move { terminal.input(&mut from_app).await });
        tokio::select! {
            _ = &mut input => {}
            _ = self.output(&mut to_app, me, since) => {}
        }
        input.abort();
        let _ = to_app.shutdown().await;
    }

    async fn input<R: AsyncRead + Unpin>(&self, from_app: &mut R) -> io::Result<()> {
        loop {
            let kind = from_app.read_u8().await?;
            let length = from_app.read_u32().await? as usize;
            if length > MAX_FRAME {
                return Err(io::Error::other("terminal frame is too large"));
            }
            let mut data = vec![0; length];
            from_app.read_exact(&mut data).await?;
            match (kind, data.as_slice()) {
                (INPUT, bytes) => self.write(bytes).await?,
                (RESIZE, [c1, c2, r1, r2]) => set_size(
                    self.pty.get_ref(),
                    u16::from_be_bytes([*c1, *c2]),
                    u16::from_be_bytes([*r1, *r2]),
                )?,
                (PING_FRAME, _) => {}
                _ => return Err(io::Error::other("unknown terminal frame")),
            }
        }
    }

    async fn output<W: AsyncWrite + Unpin>(
        &self,
        to_app: &mut W,
        me: u64,
        since: u64,
    ) -> io::Result<()> {
        let mut changed = self.changed.subscribe();
        let mut sent = None;
        let mut ping = tokio::time::interval(PING);
        ping.tick().await;
        loop {
            let (skipped, bytes, exit) = {
                let output = self.output.lock().unwrap();
                if self.viewer.load(Ordering::SeqCst) != me {
                    return Ok(());
                }
                let from = sent.unwrap_or(since).clamp(output.start(), output.written);
                let skip = (from - output.start()) as usize;
                let bytes: Vec<u8> = output.replay.range(skip..).copied().collect();
                let skipped = (sent != Some(from)).then_some(from);
                sent = Some(output.written);
                (skipped, bytes, output.exit)
            };
            if let Some(offset) = skipped {
                let hello = json!({"offset":offset,"cwd":self.cwd,"shell":self.shell});
                frame(to_app, HELLO, &serde_json::to_vec(&hello)?).await?;
            }
            for chunk in bytes.chunks(MAX_FRAME) {
                frame(to_app, OUTPUT, chunk).await?;
            }
            if let Some(code) = exit {
                return frame(to_app, EXIT, &serde_json::to_vec(&json!({"code":code}))?).await;
            }
            tokio::select! {
                result = changed.changed() => if result.is_err() { return Ok(()) },
                _ = ping.tick() => frame(to_app, PING_FRAME, &[]).await?,
            }
        }
    }
}

async fn frame<W: AsyncWrite + Unpin>(to_app: &mut W, kind: u8, data: &[u8]) -> io::Result<()> {
    let mut bytes = Vec::with_capacity(5 + data.len());
    bytes.push(kind);
    bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
    bytes.extend_from_slice(data);
    tokio::time::timeout(WRITE_TIMEOUT, async {
        to_app.write_all(&bytes).await?;
        to_app.flush().await
    })
    .await
    .map_err(|_| io::Error::other("the app stopped reading the terminal"))?
}

/// Every terminal in this sandbox, by the app's terminal ID.
#[derive(Default)]
pub struct Terminals {
    open: Mutex<HashMap<String, Arc<Terminal>>>,
}

impl Terminals {
    pub fn get(&self, id: &str) -> Option<Arc<Terminal>> {
        self.open.lock().unwrap().get(id).cloned()
    }

    /// Starts the shell unless this ID already has one.
    pub fn open(
        &self,
        config: &Config,
        id: &str,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        command: Option<&str>,
    ) -> io::Result<Arc<Terminal>> {
        let mut open = self.open.lock().unwrap();
        if let Some(terminal) = open.get(id) {
            return Ok(terminal.clone());
        }
        let (terminal, mut child) = Terminal::spawn(config, cwd, cols, rows, command)?;
        let terminal = Arc::new(terminal);
        open.insert(id.to_owned(), terminal.clone());
        let owner = terminal.clone();
        tokio::spawn(async move {
            let reading = owner.pump();
            tokio::pin!(reading);
            let (status, read) = tokio::select! {
                status = child.wait() => (status, false),
                () = &mut reading => (child.wait().await, true),
            };
            // Keep what the shell wrote, without waiting on background jobs that still hold the terminal.
            if !read {
                let _ = tokio::time::timeout(Duration::from_millis(250), &mut reading).await;
            }
            owner.finish(status.ok().and_then(|status| status.code()));
        });
        Ok(terminal)
    }

    pub fn close(&self, id: &str) {
        if let Some(terminal) = self.open.lock().unwrap().remove(id) {
            terminal.kill();
        }
    }

    pub fn summary(&self) -> Value {
        let open = self.open.lock().unwrap();
        let running = open
            .values()
            .filter(|t| t.output.lock().unwrap().exit.is_none())
            .count();
        let last = open
            .values()
            .map(|t| t.active.load(Ordering::Relaxed))
            .max();
        json!({"open":running,"lastActivity":last})
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Attach {
    session: Option<String>,
    cols: u16,
    rows: u16,
    #[serde(default)]
    since: u64,
    command: Option<String>,
}

fn refuse(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({"error":message.into()}))).into_response()
}

pub fn routes() -> Router<Arc<Manager>> {
    Router::new().route("/v1/terminals/{id}", get(attach).delete(close))
}

async fn attach(
    State(manager): State<Arc<Manager>>,
    RoutePath(id): RoutePath<String>,
    Query(input): Query<Attach>,
    mut request: Request,
) -> Response {
    if crate::workspace::valid_id(&id).is_err()
        || input
            .session
            .as_deref()
            .is_some_and(|s| crate::workspace::valid_id(s).is_err())
    {
        return refuse(StatusCode::BAD_REQUEST, "Invalid terminal or session ID");
    }
    if input
        .command
        .as_deref()
        .is_some_and(|c| c.is_empty() || c.len() > 32 * 1024 || c.contains('\0'))
    {
        return refuse(StatusCode::BAD_REQUEST, "The command must be 1-32768 bytes");
    }
    // Some sandbox proxies relay bytes only after a WebSocket handshake; no WebSocket frames follow.
    let protocol = match request
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
    {
        Some("cloudroom-tunnel") => "cloudroom-tunnel",
        Some("websocket") => "websocket",
        _ => {
            return refuse(
                StatusCode::BAD_REQUEST,
                "Send Upgrade: websocket or cloudroom-tunnel",
            );
        }
    };
    let terminal = match manager.terminals.get(&id) {
        Some(terminal) => terminal,
        None if input.since > 0 => {
            return refuse(
                StatusCode::GONE,
                "This terminal's shell ended when its cloud sandbox restarted. Open a new terminal.",
            );
        }
        None => {
            let cwd = match &input.session {
                Some(session) => match manager.session(session).await {
                    Ok(session) => session.workspace.map(|w| w.path),
                    Err(_) => {
                        return refuse(StatusCode::NOT_FOUND, "No such session in this sandbox");
                    }
                },
                None => None,
            }
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| manager.config.repository.clone());
            match manager.terminals.open(
                &manager.config,
                &id,
                cwd,
                input.cols,
                input.rows,
                input.command.as_deref(),
            ) {
                Ok(terminal) => terminal,
                Err(error) => {
                    return refuse(
                        StatusCode::SERVICE_UNAVAILABLE,
                        format!("The shell could not start: {error}"),
                    );
                }
            }
        }
    };
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        if let Ok(upgraded) = upgrade.await {
            terminal
                .serve(hyper_util::rt::TokioIo::new(upgraded), input.since)
                .await;
        }
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, protocol)
        .body(Body::empty())
        .unwrap()
}

async fn close(
    State(manager): State<Arc<Manager>>,
    RoutePath(id): RoutePath<String>,
) -> Json<Value> {
    manager.terminals.close(&id);
    Json(json!({"closed":true}))
}
