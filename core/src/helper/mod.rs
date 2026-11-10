//! The Mac helper (`cloudroom helper`): localhost previews of cloud dev servers and Mac access for cloud agents
//! (ADR 0113, 0186). A Rust port of `src/preview/client.py` for macOS. While both ship, they read and write the
//! same files under the same LaunchAgent label, so the app can switch between them, and they must behave the same.

mod jobs;
mod net;
#[cfg(test)]
mod tests;
mod tunnel;

use net::{Core, Error, Result, Shared};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tunnel::Tunnel;

const USAGE: &str = "Usage: cloudroom helper configure|run|status|stop|pause DIRECTORY [--connection FILE] [--no-start] \
[--allow-private-ssh] [--mac-access off|read-only|ask|full|on] [--launcher PATH] [--restart] [--own-threads]";
// Each core gets a check every 10 s: about one new HTTPS connection a second on metered networks at 2 s.
// Core trusts a report for 15 s, and an agent's `room-cli preview` waits 30 s for this Mac.
const POLL: Duration = Duration::from_secs(10);
// Pairing gives the same answer until a sandbox wakes with a new token, so it repeats once a minute or after a failure.
const PAIR: Duration = Duration::from_secs(60);
// Show only problems that outlast the next minute's sandbox list (net::AWAKE + 15 s).
const PROBLEM: Duration = Duration::from_secs(75);
const LOGIN_ITEMS: &str =
    "Wait a minute, or allow Cloudroom in System Settings > General > Login Items";
// Runs the helper under the signed Cloudroom app, so macOS applies Cloudroom's Desktop/Documents/Downloads permission.
const LAUNCHER: &str = "const e={...process.env};delete e.ELECTRON_RUN_AS_NODE;\
const c=require('child_process').spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit',env:e});\
for(const s of['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>c.kill(s));c.on('exit',code=>process.exit(code??1))";

pub async fn cli(args: &[String]) -> std::result::Result<(), String> {
    let (command, rest) = args.split_first().ok_or(USAGE)?;
    let (directory, flags) = rest.split_first().ok_or(USAGE)?;
    let folder = absolute(&expand(directory)).map_err(|error| error.to_string())?;
    let mut options = HashMap::new();
    let mut flags = flags.iter();
    while let Some(flag) = flags.next() {
        let value = match flag.as_str() {
            "--no-start" | "--allow-private-ssh" | "--restart" | "--own-threads" => String::new(),
            "--connection" | "--mac-access" | "--launcher" => flags.next().ok_or(USAGE)?.clone(),
            _ => return Err(USAGE.into()),
        };
        options.insert(flag.as_str(), value);
    }
    let result = match command.as_str() {
        "configure" => {
            let connection = options
                .get("--connection")
                .ok_or("--connection is required")?;
            let connection =
                fs::canonicalize(expand(connection)).map_err(|error| error.to_string())?;
            let level = match options.get("--mac-access").map(String::as_str) {
                Some("on") => Some("full".to_owned()),
                Some(level) if jobs::LEVELS.contains(&level) => Some(level.to_owned()),
                Some(_) => return Err(USAGE.into()),
                None => None,
            };
            let launcher = match options.get("--launcher") {
                Some(path) => {
                    Some(fs::canonicalize(expand(path)).map_err(|error| error.to_string())?)
                }
                None => None,
            };
            let setup = Setup {
                activate: !options.contains_key("--no-start"),
                allow_private: options.contains_key("--allow-private-ssh").then_some(true),
                level,
                launcher,
                restart: options.contains_key("--restart"),
                own: options.contains_key("--own-threads"),
            };
            configure(&folder, &connection, setup).map(|()| println!("{{\"enabled\":true}}"))
        }
        "run" => run(folder).await,
        "stop" | "pause" => stop(&folder, command == "pause").await,
        "status" => private_json(&folder.join("status.json")).map(|status| println!("{status}")),
        _ => return Err(USAGE.into()),
    };
    result.map_err(|error| error.to_string().chars().take(300).collect())
}

fn expand(path: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            home().join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(path),
    }
}

/// Python's `Path.resolve()`: absolute, with links resolved as far as the path exists.
fn absolute(path: &Path) -> io::Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(jobs::realpath(&path))
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn uid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    unsafe { getuid() }
}

#[cfg(target_os = "macos")]
const O_NOFOLLOW: i32 = 0x0100;
#[cfg(not(target_os = "macos"))]
const O_NOFOLLOW: i32 = 0o400000;

/// A JSON file only this user can read; links are refused.
fn private_json(path: &Path) -> Result<Value> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW)
        .open(path)?;
    let info = file.metadata()?;
    if info.uid() != uid() || info.mode() & 0o077 != 0 {
        return Err(Error::value(
            "Preview configuration must be private and owned by this user",
        ));
    }
    serde_json::from_reader(io::BufReader::new(file))
        .map_err(|error| Error::value(error.to_string()))
}

/// Writes whole or not at all, private to this user.
fn save(path: &Path, value: &Value) -> io::Result<()> {
    let temporary = path.with_extension("pending");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(O_NOFOLLOW)
        .open(&temporary)?;
    file.write_all(value.to_string().as_bytes())?;
    file.sync_all()?;
    fs::rename(temporary, path)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}

fn status(folder: &Path, mut value: Value) -> io::Result<()> {
    value["checkedAt"] = json!(now_ms());
    save(&folder.join("status.json"), &value)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn account(connection: &Value) -> Option<&str> {
    connection
        .get("account")
        .and_then(|account| text(account, "id"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Python's `bytes.fromhex`, which also skips spaces between bytes.
fn unhex(text: &str) -> Option<Vec<u8>> {
    let digits: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if !digits.len().is_multiple_of(2) {
        return None;
    }
    digits
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}

fn sha256(data: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, data).as_ref())
}

fn random(count: usize) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0; count];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Python's `uuid.uuid4().hex`.
fn uuid4() -> io::Result<String> {
    let mut bytes = random(16)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(hex(&bytes))
}

/// The 32 hex digits of a UUID in any form Python's `uuid.UUID` accepts, or None.
fn uuid(text: &str) -> Option<String> {
    let digits = text.replace("urn:", "").replace("uuid:", "");
    let digits = digits
        .trim_matches(|c| c == '{' || c == '}')
        .replace('-', "");
    (digits.len() == 32 && digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| digits.to_lowercase())
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = chunk.iter().enumerate().fold(0u32, |value, (index, byte)| {
            value | (u32::from(*byte) << (16 - 8 * index))
        });
        for index in 0..4 {
            out.push(if index <= chunk.len() {
                ALPHABET[(value >> (18 - 6 * index) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

fn lock_file(folder: &Path, name: &str) -> io::Result<File> {
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(folder.join(name))
}

/// Whether a helper holds this folder's lock.
fn running(folder: &Path) -> io::Result<bool> {
    match lock_file(folder, "lock")?.try_lock() {
        Ok(()) => Ok(false),
        Err(fs::TryLockError::WouldBlock) => Ok(true),
        Err(fs::TryLockError::Error(error)) => Err(error),
    }
}

/// Takes the folder's lock; a `running()` check may hold it for a moment.
async fn claim(lock: &File, wait: Duration) -> io::Result<()> {
    let deadline = Instant::now() + wait;
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(()),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(fs::TryLockError::WouldBlock) => {
                return Err(io::Error::other(
                    "Previous preview helper is still shutting down",
                ));
            }
            Err(fs::TryLockError::Error(error)) => return Err(error),
        }
    }
}

fn label(folder: &Path) -> String {
    format!(
        "dev.cloudroom.preview.{}",
        &sha256(folder.as_os_str().as_bytes())[..16]
    )
}

fn launchctl(args: &[&str]) -> io::Result<std::process::Output> {
    std::process::Command::new("launchctl")
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
}

fn domain() -> String {
    format!("gui/{}", uid())
}

fn plist_path(folder: &Path) -> PathBuf {
    home()
        .join("Library/LaunchAgents")
        .join(label(folder) + ".plist")
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Starts the helper as a LaunchAgent, or stops it and waits until it let go of its folder.
fn launch(folder: &Path, stop: bool) -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Err(Error::value(
            "The Rust helper runs on macOS only; use client.py elsewhere",
        ));
    }
    let name = label(folder);
    let service = format!("{}/{name}", domain());
    if stop {
        let _ = launchctl(&["bootout", &service]);
        let deadline = Instant::now() + Duration::from_secs(10);
        while launchctl(&["print", &service])?.status.success() {
            if Instant::now() >= deadline {
                return Err(Error::value("Preview helper did not stop"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let lock = lock_file(folder, "lock")?;
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Err(fs::TryLockError::WouldBlock) => {
                    return Err(Error::value(
                        "Previous preview helper is still shutting down",
                    ));
                }
                Err(fs::TryLockError::Error(error)) => return Err(error.into()),
            }
        }
        let _ = fs::remove_file(plist_path(folder));
        return Ok(());
    }
    let config = private_json(&folder.join("config.json"))?;
    let program =
        text(&config, "program").ok_or_else(|| Error::value("Set up the helper first"))?;
    let mut arguments = vec![
        program.to_owned(),
        "helper".into(),
        "run".into(),
        folder.to_string_lossy().into_owned(),
    ];
    // Not ProcessType Background: macOS then throttles the helper's CPU and network, and on a busy Mac it misses
    // Core's Mac job deadlines (30 s to attach, 10 s to answer), so cloud agents see 'Mac unavailable'.
    let mut environment = String::new();
    if let Some(launcher) = text(&config, "launcher") {
        arguments.splice(0..0, [launcher.to_owned(), "-e".into(), LAUNCHER.into()]);
        environment = "\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>\n\t</dict>\n".into();
    }
    let arguments: String = arguments
        .iter()
        .map(|argument| format!("\t\t<string>{}</string>\n", escape_xml(argument)))
        .collect();
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n<dict>\n{environment}\t<key>KeepAlive</key>\n\t<true/>\n\t<key>Label</key>\n\t<string>{name}</string>\n\
\t<key>ProgramArguments</key>\n\t<array>\n{arguments}\t</array>\n\t<key>RunAtLoad</key>\n\t<true/>\n\
\t<key>ThrottleInterval</key>\n\t<integer>5</integer>\n</dict>\n</plist>\n"
    );
    let path = plist_path(folder);
    fs::create_dir_all(path.parent().unwrap_or(Path::new("/")))?;
    fs::write(&path, plist)?;
    let started = launchctl(&["bootstrap", &domain(), &path.to_string_lossy()])?;
    if !started.status.success() {
        let reason: String = String::from_utf8_lossy(&started.stderr)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(150)
            .collect();
        let reason = if reason.is_empty() {
            String::new()
        } else {
            format!(": {reason}")
        };
        let code = started.status.code().unwrap_or(-1);
        return Err(Error::value(format!(
            "launchctl failed (exit code {code}){reason}. {LOGIN_ITEMS}"
        )));
    }
    Ok(())
}

/// Where an account's setup waits while another account is signed in (#109).
fn parked(folder: &Path, account: Option<&str>) -> PathBuf {
    let id = match account.and_then(uuid) {
        Some(id) => format!(
            "{}-{}-{}-{}-{}",
            &id[..8],
            &id[8..12],
            &id[12..16],
            &id[16..20],
            &id[20..]
        ),
        None => "none".into(),
    };
    folder.with_file_name(format!(
        "{}-{id}",
        folder.file_name().unwrap_or_default().to_string_lossy()
    ))
}

fn inode(path: &Path) -> io::Result<u64> {
    Ok(fs::metadata(path)?.ino())
}

struct Setup {
    activate: bool,
    allow_private: Option<bool>,
    level: Option<String>,
    launcher: Option<PathBuf>,
    restart: bool,
    own: bool,
}

fn configure(folder: &Path, connection_file: &Path, setup: Setup) -> Result<()> {
    let connection = private_json(connection_file)?;
    // Sandbox-only accounts have no VM address; their cores come from the website while awake.
    let url = text(&connection, "url")
        .unwrap_or("sandboxes")
        .trim_end_matches('/')
        .to_owned();
    let binding = json!([url, account(&connection)]);
    let read_old = || {
        folder
            .join("config.json")
            .exists()
            .then(|| private_json(&folder.join("config.json")))
            .transpose()
    };
    let mut old = read_old()?;
    // Another account never reuses this setup's key or device: its folder waits beside this one, and an account that
    // signs in again gets its own back, so sandboxes that slept through the switch still know its device (#109).
    if let Some(previous) = &old
        && previous["binding"][1] != binding[1]
    {
        launch(folder, true)?;
        if running(folder)? {
            return Err(Error::value("The previous helper is still running"));
        }
        let aside = parked(folder, previous["binding"][1].as_str());
        let _ = fs::remove_dir_all(&aside); // A stale copy; this folder is newer.
        fs::rename(folder, aside)?;
        old = None;
    }
    let own_parked = parked(folder, account(&connection));
    if old.is_none() && own_parked.is_dir() {
        let _ = fs::remove_dir_all(folder); // No setup in it.
        fs::rename(own_parked, folder)?;
        old = read_old()?;
    }
    fs::create_dir_all(folder)?;
    fs::set_permissions(folder, fs::Permissions::from_mode(0o700))?;
    let old = old.unwrap_or_else(|| json!({}));
    let program = std::env::current_exe()?.canonicalize()?;
    let allow_private = setup
        .allow_private
        .unwrap_or(old["allowPrivateSsh"].as_bool().unwrap_or(false));
    let level = setup.level.unwrap_or_else(|| jobs::level(&old).to_owned());
    let launcher = setup
        .launcher
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    // App updates replace these files; restart so macOS can still name the helper for Desktop/Documents/Downloads.
    let mut binary = Vec::new();
    if let Some(launcher) = &setup.launcher {
        binary.push(inode(launcher)?);
    }
    binary.push(inode(&program)?);
    // A self-hosted website (the app's CLOUDROOM_WEBSITE_URL); launchd starts the helper without the app's environment.
    let website = std::env::var("CLOUDROOM_WEBSITE_URL")
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| url.starts_with("https://"));
    // The PATH the app read from an interactive login shell; a failed lookup keeps the last good one (#338).
    let shell_path = std::env::var("CLOUDROOM_SHELL_PATH")
        .ok()
        .filter(|path| !path.is_empty())
        .or_else(|| text(&old, "shellPath").map(str::to_owned));
    let program_text = program.to_string_lossy().into_owned();
    let unchanged = old["binding"] == binding
        && text(&old, "connectionFile") == connection_file.to_str()
        && old["allowPrivateSsh"].as_bool().unwrap_or(false) == allow_private
        && old["macAccess"].as_str() == Some(level.as_str())
        && old["launcher"].as_str() == launcher.as_deref()
        && old["binary"] == json!(binary)
        && old["ownThreads"].as_bool().unwrap_or(false) == setup.own
        && old["website"].as_str() == website.as_deref()
        && old["shellPath"].as_str() == shell_path.as_deref()
        && old["program"].as_str() == Some(program_text.as_str());
    if setup.activate
        && !setup.restart
        && unchanged
        && launchctl(&["print", &format!("{}/{}", domain(), label(folder))])?
            .status
            .success()
        && running(folder)?
    {
        return Ok(());
    }
    if setup.activate {
        launch(folder, true)?;
    }
    // Without its client.py, the Python helper restarts on its next setup, so switching back never keeps this one.
    let _ = fs::remove_file(folder.join("client.py"));
    let mut config = Map::new();
    let device = match text(&old, "device") {
        Some(device) => device.to_owned(),
        None => uuid4()?,
    };
    config.insert("device".into(), json!(device));
    config.insert("binding".into(), binding);
    config.insert(
        "connectionFile".into(),
        json!(connection_file.to_string_lossy()),
    );
    config.insert("allowPrivateSsh".into(), json!(allow_private));
    config.insert("macAccess".into(), json!(level));
    config.insert("launcher".into(), json!(launcher));
    config.insert("binary".into(), json!(binary));
    config.insert("program".into(), json!(program_text));
    if setup.own {
        config.insert("ownThreads".into(), json!(true));
    }
    if let Some(path) = shell_path {
        config.insert("shellPath".into(), json!(path));
    }
    if let Some(website) = website {
        config.insert("website".into(), json!(website));
    }
    save(&folder.join("config.json"), &Value::Object(config))?;
    net::identity(folder)?;
    if setup.activate {
        launch(folder, false)?;
        // launchd can take the job and never run it, say when macOS blocks Cloudroom's background items (#109).
        let deadline = Instant::now() + Duration::from_secs(10);
        while !running(folder)? {
            if Instant::now() >= deadline {
                return Err(Error::value(format!(
                    "The helper didn't start. {LOGIN_ITEMS}"
                )));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    Ok(())
}

async fn stop(folder: &Path, pause: bool) -> Result<()> {
    launch(folder, true)?;
    if pause {
        status(folder, json!({"state": "offline"}))?;
        println!("{{\"paused\":true}}");
        return Ok(());
    }
    let mut config = private_json(&folder.join("config.json"))?;
    if !config["revoked"].as_bool().unwrap_or(false) {
        // Best effort: a sleeping sandbox or an archived VM must never block sign-out.
        let shared = Shared::new(folder.to_owned());
        let device = text(&config, "device").unwrap_or_default().to_owned();
        for core in net::cores(&shared, &config).await.unwrap_or_default() {
            let _ = core
                .request(&shared, &format!("/device/{device}"), None, Some("DELETE"))
                .await;
        }
        config["revoked"] = json!(true);
        save(&folder.join("config.json"), &config)?;
    }
    status(folder, json!({"state": "offline"}))?;
    println!("{{\"stopped\":true}}");
    Ok(())
}

/// Waits `wait`, or less when the app touches `woke` after waking a sandbox, so it is listed at once.
async fn rest(folder: &Path, wait: Duration) {
    let touched = || {
        fs::metadata(folder.join("woke"))
            .and_then(|info| info.modified())
            .ok()
    };
    let (before, end) = (touched(), Instant::now() + wait);
    while let Some(left) = end
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
    {
        tokio::time::sleep(left.min(Duration::from_secs(1))).await;
        if touched() != before {
            return;
        }
    }
}

type Key = (String, String);

/// The preview loop's memory between checks.
struct Previews {
    shared: Arc<Shared>,
    folder: PathBuf,
    tunnels: HashMap<(Key, u16), Tunnel>,
    ports: Map<String, Value>,
    paired: HashMap<Key, (Value, Instant)>,
    prepare_due: Instant,
    refresh: bool,
    denied: Option<u16>,
    credential: Option<Vec<(String, String)>>,
    authenticated: Option<Instant>,
    troubled: Option<Instant>,
    pairing: Option<&'static str>,
    delay: u64,
}

async fn run(folder: PathBuf) -> Result<()> {
    let lock = lock_file(&folder, "lock")?;
    claim(&lock, Duration::from_secs(5)).await?; // Before Mac jobs, so a second helper never takes any.
    let shared = Arc::new(Shared::new(folder.clone()));
    let ports_file = folder.join("ports.json");
    let ports = if ports_file.exists() {
        private_json(&ports_file)?
    } else {
        json!({})
    };
    let mut previews = Previews {
        shared,
        folder: folder.clone(),
        tunnels: HashMap::new(),
        ports: ports.as_object().cloned().unwrap_or_default(),
        paired: HashMap::new(),
        prepare_due: Instant::now(),
        refresh: true,
        denied: None,
        credential: None,
        authenticated: None,
        troubled: None,
        pairing: None,
        delay: 2,
    };
    // A restart shows a problem it had already shown at once, if it is still there.
    if private_json(&folder.join("status.json"))
        .is_ok_and(|status| text(&status, "detail").is_some())
    {
        previews.troubled = Instant::now().checked_sub(PROBLEM);
    }
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    // After every step that can fail, so the helper never leaves without closing Mac jobs.
    let jobs = Arc::new(jobs::Jobs::new(previews.shared.clone()));
    tokio::spawn(jobs::serve(jobs.clone()));
    tokio::select! {
        _ = async { loop { let wait = previews.pass().await; rest(&folder, wait).await; } } => {}
        _ = terminate.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    jobs.close().await;
    for tunnel in previews.tunnels.values_mut() {
        tunnel.close().await;
    }
    Ok(())
}

impl Previews {
    /// One check; returns how long to rest before the next.
    async fn pass(&mut self) -> Duration {
        match self.check().await {
            Ok(()) => {
                self.delay = 2;
                POLL
            }
            Err(error) => {
                self.refresh = true;
                self.paired.clear();
                self.shared.refresh_network_if_stale();
                let transient = match &error {
                    Error::Net { .. } | Error::Io(_) => true,
                    Error::Http(code) => [429, 500, 502, 503, 504].contains(code),
                    Error::Value(_) => false,
                };
                if !transient
                    || self
                        .authenticated
                        .is_none_or(|at| at.elapsed() >= Duration::from_secs(15))
                {
                    for tunnel in self.tunnels.values_mut() {
                        tunnel.close().await;
                    }
                    self.tunnels.clear();
                }
                let message = match &error {
                    Error::Value(_) | Error::Http(_) => error.to_string(),
                    _ => "Preview connection unavailable; reconnecting automatically".into(),
                };
                let _ = status(
                    &self.folder,
                    json!({"state": "offline", "message": message}),
                );
                self.delay = if self.tunnels.is_empty() {
                    (self.delay * 2).min(30)
                } else {
                    2
                };
                Duration::from_secs(self.delay)
            }
        }
    }

    async fn check(&mut self) -> Result<()> {
        let shared = self.shared.clone();
        let mut config = private_json(&self.folder.join("config.json"))?;
        let listed = net::cores(&shared, &config).await?;
        let vm = listed.iter().find(|core| !core.sandbox).cloned();
        if let Some(vm) = &vm
            && self.credential.as_ref() != Some(&vm.headers)
        {
            (self.credential, self.prepare_due, self.refresh, self.denied) =
                (Some(vm.headers.clone()), Instant::now(), true, None);
        }
        if config
            .as_object_mut()
            .and_then(|object| object.remove("revoked"))
            .is_some_and(|revoked| revoked.as_bool() == Some(true))
        {
            save(&self.folder.join("config.json"), &config)?;
        }
        if let Some(vm) = &vm
            && self.refresh
            && Instant::now() >= self.prepare_due
        {
            self.prepare_due = Instant::now() + Duration::from_secs(60);
            match vm.prepare(&shared).await {
                Ok(()) => (self.refresh, self.denied) = (false, None),
                Err(Error::Http(code @ (401 | 403))) => self.denied = Some(code),
                Err(_) => {}
            }
        }
        if let Some(code) = self.denied {
            return Err(Error::Http(code));
        }
        let device = text(&config, "device")
            .ok_or_else(|| Error::value("Set up the helper first"))?
            .to_owned();
        let mut desired = HashMap::new();
        let mut reached = false;
        let mut failure = None;
        self.paired
            .retain(|key, _| listed.iter().any(|core| &core.key == key));
        // Sandboxes first, so a VM that turns this Mac away can't block their Mac access.
        let mut ordered = listed.clone();
        ordered.sort_by_key(|core| !core.sandbox);
        for core in ordered {
            let result: Result<()> = async {
                let metadata = self.pair(&core, &device).await?;
                reached |= core.sandbox;
                let answer = core.request(&shared, "", None, None).await?;
                for entry in answer["previews"]
                    .as_array()
                    .ok_or_else(|| Error::value("Invalid preview registration"))?
                {
                    let port = entry["port"]
                        .as_u64()
                        .filter(|port| (1024..=65535).contains(port));
                    let (Some(port), Some(generation)) = (port, entry["generation"].as_str())
                    else {
                        return Err(Error::value("Invalid preview registration"));
                    };
                    desired.insert(
                        (core.key.clone(), port as u16),
                        (core.clone(), generation.to_owned(), metadata.clone()),
                    );
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                self.paired.remove(&core.key);
                if !core.sandbox {
                    return Err(error); // A sandbox may fall asleep at any moment; the others keep working.
                }
                // An HTTP answer means this Mac reaches sandboxes and the sandbox side declined. Only a network failure counts.
                match error {
                    Error::Http(_) => reached = true,
                    Error::Net { .. } | Error::Io(_) => failure = Some((error, core.url.clone())),
                    Error::Value(_) => {}
                }
            }
        }
        let kind = failure
            .as_ref()
            .filter(|_| !reached)
            .map(|(error, _)| error.kind());
        match (kind, &failure) {
            (None, _) => {
                shared.problems.lock().unwrap().remove("pairing");
            }
            (Some(kind), Some((error, url))) if Some(kind) != self.pairing => {
                let described = shared.describe("pair", error, url).await;
                shared.problems.lock().unwrap().insert("pairing", described);
            }
            _ => {}
        }
        self.pairing = kind;
        self.authenticated = Some(Instant::now());
        let mut failed = Vec::new();
        for (key, tunnel) in &mut self.tunnels {
            if !tunnel.alive() {
                failed.push(key.clone());
            }
        }
        self.refresh |= !failed.is_empty();
        let stale: Vec<_> = self
            .tunnels
            .iter()
            .filter(|(key, tunnel)| match desired.get(*key) {
                Some((_, generation, metadata)) => {
                    *generation != tunnel.info.generation
                        || failed.contains(key)
                        || tunnel.endpoint != *metadata
                }
                None => true,
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            if let Some(mut tunnel) = self.tunnels.remove(&key) {
                tunnel.close().await;
            }
        }
        let allow_private = config["allowPrivateSsh"].as_bool().unwrap_or(false);
        for (key, (core, generation, metadata)) in desired {
            if self.tunnels.contains_key(&key) {
                continue;
            }
            let port = key.1;
            let name = if core.sandbox {
                format!("{}:{port}", net::hostname(&core.url))
            } else {
                port.to_string()
            };
            let local_port = self
                .ports
                .get(&name)
                .and_then(Value::as_u64)
                .filter(|port| (1024..=65535).contains(port))
                .map_or(port, |port| port as u16);
            let opened = Tunnel::open(
                &shared,
                &self.folder,
                core.clone(),
                port,
                generation.clone(),
                &device,
                metadata,
                allow_private,
                local_port,
            )
            .await;
            match opened {
                Ok(tunnel) => {
                    self.ports.insert(name, json!(tunnel.info.local_port));
                    self.tunnels.insert(key, tunnel);
                    save(
                        &self.folder.join("ports.json"),
                        &Value::Object(self.ports.clone()),
                    )?;
                }
                Err(Error::Io(_)) => {
                    let body = json!({"device": device, "port": port, "generation": generation, "local_port": null, "error": "Local preview port unavailable"});
                    let _ = core.request(&shared, "/report", Some(&body), None).await;
                }
                Err(error) => return Err(error),
            }
        }
        let mut reports = tokio::task::JoinSet::new();
        for tunnel in self.tunnels.values_mut() {
            let (info, alive, shared, device) = (
                tunnel.info.clone(),
                tunnel.alive(),
                shared.clone(),
                device.clone(),
            );
            reports.spawn(async move {
                let ready = alive && info.healthy().await;
                let error = match () {
                    _ if ready => None,
                    _ if !alive => Some(if info.relay { "Tunnel unavailable" } else { "SSH connection unavailable" }),
                    _ if info.reachable() => Some("Cloud HTTP server unavailable"),
                    _ => None,
                };
                let local_port = if ready { json!(info.local_port) } else { Value::Null };
                let body = json!({"device": device, "port": info.port, "generation": info.generation, "local_port": local_port, "error": error});
                let sent = info.core.request(&shared, "/report", Some(&body), None).await;
                (info.core.clone(), ready, sent)
            });
        }
        let mut ready = 0;
        while let Some(Ok((core, healthy, sent))) = reports.join_next().await {
            ready += usize::from(healthy);
            match sent {
                // Core lost this Mac's pairing: pair at the next check.
                Err(Error::Http(409)) => {
                    self.paired.remove(&core.key);
                }
                Err(error) if !core.sandbox => return Err(error),
                _ => {}
            }
        }
        // No awake sandbox reached: say why. A working VM keeps its previews; its own failures take the error path.
        let problem = if vm.is_some() || reached {
            None
        } else {
            let problems = shared.problems.lock().unwrap();
            problems
                .get("sandboxes")
                .or_else(|| problems.get("pairing"))
                .cloned()
        };
        self.troubled = problem
            .as_ref()
            .map(|_| self.troubled.unwrap_or_else(Instant::now));
        // Can't reach Cloudroom at all, twice in a row: no sandbox sleep explains that, so show it now.
        let fast = !reached && shared.awake.lock().await.blocked >= 2;
        match problem {
            Some((message, detail))
                if fast || self.troubled.is_some_and(|at| at.elapsed() >= PROBLEM) =>
            {
                status(
                    &self.folder,
                    json!({"state": "offline", "message": message, "detail": detail}),
                )?;
            }
            _ => status(
                &self.folder,
                json!({"state": "connected", "count": self.tunnels.len(), "ready": ready}),
            )?,
        }
        Ok(())
    }

    async fn pair(&mut self, core: &Core, device: &str) -> Result<Value> {
        if let Some((answer, at)) = self.paired.get(&core.key)
            && at.elapsed() < PAIR
        {
            return Ok(answer.clone());
        }
        let body = json!({"device": device, "public_key": net::identity(&self.folder)?});
        let answer = core
            .request(&self.shared, "/device", Some(&body), None)
            .await?;
        self.paired
            .insert(core.key.clone(), (answer.clone(), Instant::now()));
        Ok(answer)
    }
}
