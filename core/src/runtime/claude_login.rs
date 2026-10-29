//! Native Claude sign-in. Auth frames never enter conversations or diagnostics.
use super::{Adapter, Event, Kind, Progress, auth::Status, claude, process::Process};
use crate::config::Config;
use serde_json::{Value, json};
use std::{
    fs, io,
    path::Path,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, watch};

const LIFETIME: Duration = Duration::from_secs(10 * 60);
fn save_private(path: &Path, contents: &str) -> io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let temporary = path.with_extension("tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    fs::rename(temporary, path)
}
fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}
/// Subscription and API key replace each other, so Claude only ever sees one.
fn save_token(config: &Config, token: &str, plan: Option<&str>) -> io::Result<()> {
    let contents = format!("{token}\n{}\n", plan.unwrap_or_default());
    save_private(&claude::token_path(config), &contents)?;
    remove(&claude::key_path(config))
}
/// Console API keys come in several prefixes (`sk-ant-api…`, `sk-ant-usr…`), so only
/// subscription, refresh and admin tokens are refused here. `save_key` proves the rest.
pub(crate) fn is_api_key(value: &str) -> bool {
    value.len() <= 1024
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        && value.strip_prefix("sk-ant-").is_some_and(|rest| {
            !rest.is_empty() && !["oat", "ort", "admin"].iter().any(|p| rest.starts_with(p))
        })
}
/// `auth status` accepts any key, so one tiny request proves it works before
/// the subscription token is dropped. A rejected key leaves the old login intact.
async fn save_key(config: &Config, key: &str) -> Result<(), &'static str> {
    let path = claude::key_path(config);
    save_private(&path, &format!("{key}\n")).map_err(|_| "Could not save the API key.")?;
    if claude::probe(config, "haiku", None).await.is_err() {
        let _ = remove(&path);
        return Err("Anthropic did not accept this API key. Check the key and its credits.");
    }
    remove(&claude::token_path(config)).map_err(|_| "Could not remove the old Claude token.")
}
struct Protocol;
impl Adapter for Protocol {
    fn encode(&mut self, id: u64, method: &str, mut params: Value, _: Option<&str>) -> Value {
        params["subtype"] = json!(method);
        json!({"type":"control_request","request_id":id.to_string(),"request":params})
    }
    fn receive(&mut self, _: &Value, _: String, _: &mut Progress) -> io::Result<Vec<Event>> {
        Ok(vec![])
    }
    fn capture(&mut self) -> io::Result<Vec<Event>> {
        Ok(vec![])
    }
    fn response(&self, value: &Value) -> Option<(u64, io::Result<Value>)> {
        if value["type"] != "control_response" {
            return None;
        }
        let r = &value["response"];
        Some((
            r["request_id"].as_str()?.parse().ok()?,
            if r["subtype"] == "success" {
                Ok(r["response"].clone())
            } else {
                Err(io::Error::other("Claude could not complete sign-in"))
            },
        ))
    }
}
struct Login {
    id: String,
    process: Process,
    done: watch::Receiver<Option<bool>>,
    started: Instant,
}
impl Drop for Login {
    fn drop(&mut self) {
        self.process.request_shutdown();
    }
}
struct State {
    login: Option<Login>,
    status: Status,
    checked: Option<Instant>,
}
pub(crate) struct ClaudeLogin(Mutex<State>);
impl Default for ClaudeLogin {
    fn default() -> Self {
        Self(Mutex::new(State {
            login: None,
            status: Status::new("missing", None),
            checked: None,
        }))
    }
}
impl ClaudeLogin {
    async fn inspect(state: &mut State, config: &Config) -> Status {
        if let Some(login) = &state.login {
            let done = *login.done.borrow();
            if let Some(success) = done {
                state.status = if success && claude::auth_ready(config).await.unwrap_or(false) {
                    Status::new("connected", None)
                } else {
                    Status::new("error", Some("Claude sign-in did not complete. Try again."))
                };
                state.login = None;
                state.checked = Some(Instant::now());
            } else if login.started.elapsed() >= LIFETIME {
                state.login = None;
                state.status = Status::new("expired", Some("Sign-in expired. Try again."));
                state.checked = Some(Instant::now());
            }
        } else if state
            .checked
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(15))
        {
            state.status = match claude::auth_ready(config).await {
                Ok(true) => Status::new("connected", None),
                Ok(false) => Status::new(
                    "missing",
                    Some("Connect your Claude subscription on this VM."),
                ),
                Err(_) => Status::new(
                    "unavailable",
                    Some("Could not check Claude Code on this VM."),
                ),
            };
            state.checked = Some(Instant::now());
        }
        state.status.clone()
    }
    pub async fn status(&self, config: &Config) -> Status {
        Self::inspect(&mut *self.0.lock().await, config).await
    }
    pub async fn action(
        &self,
        config: &Config,
        action: &str,
        id: String,
        code: Option<String>,
        oauth_state: Option<String>,
    ) -> Status {
        let mut state = self.0.lock().await;
        let current = Self::inspect(&mut state, config).await;
        if action == "token" {
            let saved = code
                .is_some_and(|token| save_token(config, &token, oauth_state.as_deref()).is_ok());
            state.login = None;
            state.checked = None;
            if !saved {
                return Status::new("error", Some("Could not save the Claude token."));
            }
            return Self::inspect(&mut state, config).await;
        }
        if action == "key" {
            state.login = None;
            state.checked = None;
            let Some(key) = code else {
                return Status::new("error", Some("Paste an Anthropic API key."));
            };
            if let Err(message) = save_key(config, &key).await {
                return Status::new("error", Some(message));
            }
            return Self::inspect(&mut state, config).await;
        }
        if action == "cancel" {
            if state.login.as_ref().is_some_and(|l| l.id == id) {
                state.login = None;
                state.checked = None;
                return Self::inspect(&mut state, config).await;
            }
            return current;
        }
        if action == "complete" {
            let Some(login) = state.login.as_ref().filter(|l| l.id == id) else {
                return current;
            };
            let result = login
                .process
                .call_timeout(
                    "claude_oauth_callback",
                    json!({"authorizationCode":code,"state":oauth_state}),
                    None,
                    Duration::from_secs(10),
                )
                .await;
            let current = Self::inspect(&mut state, config).await;
            if current.state == "waiting"
                && result
                    .as_ref()
                    .is_err_and(|e| e.kind() != io::ErrorKind::TimedOut)
            {
                return Status {
                    message: Some(
                        "Claude could not accept that code. Check it or restart sign-in.",
                    ),
                    ..current
                };
            }
            return current;
        }
        if state.login.is_some() || current.state == "connected" || current.state == "unavailable" {
            return current;
        }
        let attempt = async {
            let profile = config
                .harnesses
                .get(&Kind::Claude)
                .ok_or_else(|| io::Error::other("Claude is not configured"))?;
            let mut command = super::command(&profile.binary, config);
            command.current_dir(&config.account_home).args([
                "-p",
                "--no-session-persistence",
                "--tools",
                "",
                "--no-chrome",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--setting-sources",
                "user",
                "--settings",
                r#"{"disableAllHooks":true}"#,
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
            ]);
            claude::profile_env(&mut command, config, profile);
            let (process, mut events) = Process::spawn(config, command, Box::new(Protocol))?;
            tokio::spawn(async move { while events.recv().await.is_some() {} });
            let result = async {
                process
                    .call_timeout("initialize", json!({}), None, Duration::from_secs(10))
                    .await?;
                process
                    .call_timeout(
                        "claude_authenticate",
                        json!({"loginWithClaudeAi":true}),
                        None,
                        Duration::from_secs(10),
                    )
                    .await
            }
            .await;
            let info = match result {
                Ok(info) => info,
                Err(error) => {
                    process.request_shutdown();
                    return Err(error);
                }
            };
            let url = info["manualUrl"].as_str().filter(|s| {
                s.len() <= 8192
                    && [
                        "https://claude.ai/oauth/authorize?",
                        "https://claude.com/cai/oauth/authorize?",
                        "https://platform.claude.com/oauth/authorize?",
                    ]
                    .iter()
                    .any(|p| s.starts_with(p))
            });
            let Some(url) = url else {
                process.request_shutdown();
                return Err(io::Error::other("Unexpected Claude sign-in URL"));
            };
            Ok::<_, io::Error>((process, url.to_owned()))
        }
        .await;
        match attempt {
            Ok((process, url)) => {
                let (done, received) = watch::channel(None);
                let waiting = process.clone();
                tokio::spawn(async move {
                    let ok = waiting
                        .call_timeout(
                            "claude_oauth_wait_for_completion",
                            json!({}),
                            None,
                            LIFETIME,
                        )
                        .await
                        .is_ok();
                    done.send_replace(Some(ok));
                    waiting.request_shutdown();
                });
                state.status = Status {
                    verification_url: Some(url),
                    login_id: Some(id.clone()),
                    ..Status::new("waiting", None)
                };
                state.login = Some(Login {
                    id,
                    process,
                    done: received,
                    started: Instant::now(),
                });
            }
            Err(_) => {
                state.status = Status::new(
                    "error",
                    Some("Could not start Claude sign-in. Check the CLI version and try again."),
                )
            }
        }
        state.status.clone()
    }
    pub async fn shutdown(&self) {
        self.0.lock().await.login = None;
    }
}
