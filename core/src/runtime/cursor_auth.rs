use super::{Kind, auth::Status, command as child_command, files};
use crate::{config::Config, workspace::storage::Guard};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Child,
    sync::Mutex as AsyncMutex,
};

const LOGIN_LIFETIME: Duration = Duration::from_secs(10 * 60);
const KEY_FILE: &str = "cloudroom-api-key";

pub(super) fn apply_key(
    command: &mut tokio::process::Command,
    config: &Config,
) -> io::Result<bool> {
    let profile = config
        .harnesses
        .get(&Kind::Cursor)
        .ok_or_else(|| io::Error::other("Cursor is not configured"))?;
    match files::open(
        &profile.home,
        &profile.home.join(KEY_FILE),
        config.storage.as_ref().map(|p| (p.agent_uid, p.agent_gid)),
    ) {
        Ok(file) => {
            let mut key = String::new();
            file.take(4097).read_to_string(&mut key)?;
            if !valid_key(&key) {
                return Err(io::Error::other("Saved Cursor API key is invalid"));
            }
            command.env("CURSOR_API_KEY", key);
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    }
    Ok(true)
}
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 4096 && key.bytes().all(|byte| byte.is_ascii_graphic())
}
fn command(config: &Config) -> io::Result<tokio::process::Command> {
    let profile = config
        .harnesses
        .get(&Kind::Cursor)
        .ok_or_else(|| io::Error::other("Cursor is not configured"))?;
    let mut command = child_command(&profile.binary, config);
    command
        .current_dir(&config.account_home)
        .arg("--disable-auto-update");
    Ok(command)
}
async fn probe(config: &Config, storage: &Guard, key: Option<&str>) -> Status {
    let result = async {
        let mut command = command(config)?;
        let api_key = if let Some(key) = key { command.env("CURSOR_API_KEY", key); true } else { apply_key(&mut command, config)? };
        // `status` ignores API keys. Listing models verifies the supplied key without inference.
        if api_key { command.arg("--list-models"); } else { command.args(["status", "--format", "json"]); }
        command.stderr(std::process::Stdio::null());
        let (mut child, _workload) = storage.spawn_writer(&mut command)?;
        drop(child.stdin.take());
        let mut output = child.stdout.take().ok_or_else(|| io::Error::other("Cursor stdout unavailable"))?;
        let mut bytes = Vec::new();
        let check = tokio::time::timeout(Duration::from_secs(30), async {
            (&mut output).take(65537).read_to_end(&mut bytes).await?;
            if bytes.len() > 65536 { return Err(io::Error::other("Cursor status too large")); }
            let status = child.wait().await?;
            if api_key { return Ok(Status::new(if status.success() { "connected" } else { "error" }, if status.success() { None } else { Some("Could not verify this Cursor API key. Check the key and connection, then try again.") })); }
            let value: Value = serde_json::from_slice(&bytes)?;
            let mut result = Status::new(if status.success() && value["isAuthenticated"] == true { "connected" } else { "missing" }, None);
            result.email = value["userInfo"]["email"].as_str().map(str::to_owned);
            Ok::<_, io::Error>(result)
        }).await;
        let _ = child.kill().await;
        check.map_err(|_| io::Error::other("Cursor account check timed out"))?
    }.await;
    result.unwrap_or_else(|_| Status::new("unavailable", Some("Could not verify Cursor on the cloud machine. Check its installation, connection and disk space.")))
}

struct Login {
    id: String,
    status: Arc<Mutex<Status>>,
    task: tokio::task::JoinHandle<()>,
    cancel: tokio::sync::oneshot::Sender<()>,
}
struct State {
    status: Status,
    checked: Option<Instant>,
    login: Option<Login>,
}
pub struct CursorAuth {
    state: AsyncMutex<State>,
}
impl Default for CursorAuth {
    fn default() -> Self {
        Self {
            state: AsyncMutex::new(State {
                status: Status::new("missing", None),
                checked: None,
                login: None,
            }),
        }
    }
}
impl CursorAuth {
    async fn inspect(state: &mut State, config: &Config, storage: &Guard) -> Status {
        if let Some(login) = &state.login {
            state.status = login.status.lock().unwrap().clone();
            if !login.task.is_finished() {
                return state.status.clone();
            }
            state.login = None;
            state.checked = None;
        }
        if state
            .checked
            .is_none_or(|checked| checked.elapsed() > Duration::from_secs(15))
        {
            state.status = probe(config, storage, None).await;
            state.checked = Some(Instant::now());
        }
        state.status.clone()
    }
    pub async fn status(&self, config: &Config, storage: &Guard) -> Status {
        Self::inspect(&mut *self.state.lock().await, config, storage).await
    }
    pub async fn login(&self, config: &Config, storage: &Guard, id: String) -> Status {
        let mut state = self.state.lock().await;
        let current = Self::inspect(&mut state, config, storage).await;
        if state.login.is_some() || current.state == "connected" {
            return current;
        }
        let attempt = (|| {
            let mut command = command(config)?;
            command
                .arg("login")
                .env("NO_OPEN_BROWSER", "1")
                .stderr(std::process::Stdio::null());
            let (mut child, workload) = storage.spawn_writer(&mut command)?;
            drop(child.stdin.take());
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("Cursor stdout unavailable"))?;
            Ok::<_, io::Error>((child, stdout, workload))
        })();
        let Ok((child, stdout, workload)) = attempt else {
            return Status::new(
                "error",
                Some(
                    "Could not start Cursor login. Check the CLI installation and cloud disk space.",
                ),
            );
        };
        let status = Arc::new(Mutex::new(Status {
            login_id: Some(id.clone()),
            ..Status::new("waiting", Some("Waiting for Cursor's sign-in link."))
        }));
        let changed = status.clone();
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _workload = workload;
            let mut child = child;
            let result = tokio::select! {
                result = tokio::time::timeout(LOGIN_LIFETIME, login_output(&mut child, stdout, &changed)) => result.ok().and_then(Result::ok),
                _ = cancelled => None,
            };
            let _ = child.kill().await;
            let mut status = changed.lock().unwrap();
            *status = if result == Some(true) {
                Status::new("connected", None)
            } else {
                Status::new(
                    "expired",
                    Some("Cursor sign-in ended without confirmation. Try again."),
                )
            };
        });
        state.status = status.lock().unwrap().clone();
        state.login = Some(Login {
            id,
            status,
            task,
            cancel,
        });
        state.checked = None;
        state.status.clone()
    }
    pub async fn cancel(&self, id: &str) -> Status {
        let mut state = self.state.lock().await;
        if state.login.as_ref().is_some_and(|login| login.id == id) {
            let login = state.login.take().unwrap();
            let _ = login.cancel.send(());
            let _ = login.task.await;
            state.checked = None;
            state.status = Status::new(
                "missing",
                Some("Cursor sign-in cancelled. Your task is preserved."),
            );
        }
        state.status.clone()
    }
    pub async fn set_key(&self, config: &Config, storage: &Guard, key: String) -> Status {
        let mut state = self.state.lock().await;
        if !valid_key(&key) {
            return Status::new("error", Some("Enter a valid Cursor user API key."));
        }
        if state.login.is_some() {
            return Status::new("error", Some("Finish or cancel browser sign-in first."));
        }
        let checked = probe(config, storage, Some(&key)).await;
        if checked.state != "connected" {
            return checked;
        }
        let saved = async {
            let profile = config.harnesses.get(&Kind::Cursor).ok_or_else(|| io::Error::other("Cursor unavailable"))?;
            let mut command = child_command(std::path::Path::new("python3"), config);
            command.args(["-I", "-c", include_str!("../sync/files.py")]).stderr(std::process::Stdio::null());
            let (mut child, _workload) = storage.spawn_writer(&mut command)?;
            let mut input = child.stdin.take().unwrap();
            input.write_all(&serde_json::to_vec(&json!({"op":"cursor_key","tree":{"root":profile.home,"filename":KEY_FILE,"create":true},"key":key}))?).await?;
            input.write_all(b"\n").await?;
            drop(input);
            let output = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await??;
            if !output.status.success() || serde_json::from_slice::<Value>(&output.stdout)?["ok"] != true { return Err(io::Error::other("Cursor key was not saved")); }
            Ok::<_, io::Error>(())
        }.await;
        if saved.is_err() {
            return Status::new(
                "error",
                Some("Could not confirm saving the Cursor key. Check cloud storage and try again."),
            );
        }
        state.status = checked;
        state.checked = Some(Instant::now());
        state.status.clone()
    }
    pub async fn shutdown(&self) {
        if let Some(login) = self.state.lock().await.login.take() {
            let _ = login.cancel.send(());
            let _ = login.task.await;
        }
    }
}
async fn login_output(
    child: &mut Child,
    mut stdout: tokio::process::ChildStdout,
    status: &Arc<Mutex<Status>>,
) -> io::Result<bool> {
    let mut tail = String::new();
    let mut bytes = [0; 2048];
    loop {
        let count = stdout.read(&mut bytes).await?;
        if count == 0 {
            break;
        }
        tail.push_str(&String::from_utf8_lossy(&bytes[..count]));
        let complete = tail
            .rfind(char::is_whitespace)
            .map_or("", |end| &tail[..end]);
        for token in complete.split_whitespace() {
            if let Some(url) = token.strip_prefix("https://cursor.com/loginDeepControl?")
                && url.len() <= 4096
                && url.is_ascii()
                && !url.contains(['<', '>', '"', '\''])
            {
                status.lock().unwrap().verification_url =
                    Some(format!("https://cursor.com/loginDeepControl?{url}"));
            }
        }
        if tail.len() > 8192 {
            tail = tail
                .chars()
                .rev()
                .take(4096)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
        }
    }
    Ok(child.wait().await?.success())
}
