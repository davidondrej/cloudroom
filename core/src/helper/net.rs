//! HTTPS to the website and to cores: the sandbox list, pairing keys, and why a failure happened (#109, ADR 0201).

use super::{account, base64, private_json, text, uuid};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Proxies such as Cloudflare refuse unnamed clients, so the helper names itself on every request.
const USER_AGENT: &str = "Cloudroom-Helper";
const WEBSITE: &str = "https://www.cloudroom.dev";
// Every Mac asks the website once a minute; the app touches `woke` after a wake, so new sandboxes show up at once.
const AWAKE: Duration = Duration::from_secs(60);
// While something fails, the helper rereads the Mac's proxy setting this often.
const NETWORK: Duration = Duration::from_secs(30);
const LIMIT: usize = 256 * 1024;
const TOKEN_CHARS: std::ops::RangeInclusive<char> = '!'..='~';
const GATE_CHARS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-";

#[derive(Debug)]
pub(super) enum Error {
    /// Setup or validation the user can read (client.py's ValueError).
    Value(String),
    /// Our side answered with this HTTP status.
    Http(u16),
    /// A network failure, and whether it surely never reached our servers.
    Net { unsent: Unsent, text: String },
    /// A local failure.
    Io(io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Unsent {
    No,
    Certificate,
    Dns,
    Refused,
}

pub(super) type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub(super) fn value(text: impl Into<String>) -> Self {
        Error::Value(text.into())
    }

    /// True only when the request surely never reached our servers: a refused certificate, no DNS answer, or a
    /// refused connection or proxy tunnel. A timeout or reset may have reached them.
    pub(super) fn unsent(&self) -> bool {
        matches!(self, Error::Net { unsent, .. } if *unsent != Unsent::No)
    }

    /// The kind of failure, to describe a problem again only when it changes.
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Error::Value(_) => "value",
            Error::Http(_) => "http",
            Error::Net {
                unsent: Unsent::Certificate,
                ..
            } => "certificate",
            Error::Net {
                unsent: Unsent::Dns,
                ..
            } => "dns",
            Error::Net {
                unsent: Unsent::Refused,
                ..
            } => "refused",
            Error::Net { .. } => "network",
            Error::Io(_) => "io",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Value(text) | Error::Net { text, .. } => f.write_str(text),
            Error::Http(code) => write!(f, "Preview control returned HTTP {code}"),
            Error::Io(error) => write!(f, "{error}"),
        }
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error::Io(error)
    }
}

/// A reqwest failure with the reason underneath, sorted like client.py's `unsent()`.
pub(super) fn network_error(error: reqwest::Error) -> Error {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(inner) = source {
        text = format!("{text}: {inner}");
        source = inner.source();
    }
    let lower = text.to_lowercase();
    let unsent = if lower.contains("certificate") {
        Unsent::Certificate
    } else if lower.contains("dns error") || lower.contains("failed to lookup address") {
        Unsent::Dns
    } else if lower.contains("connection refused") || lower.contains("tunnel") {
        Unsent::Refused
    } else {
        Unsent::No
    };
    Error::Net { unsent, text }
}

/// HTTPS settings. reqwest reads the macOS proxy setting only when a client is built, so the helper rebuilds it while
/// it can't connect: turning off a VPN or proxy then needs no restart (#109). Certificates are Mozilla's list (as
/// client.py's cacert.pem), never the Keychain.
pub(super) struct Net {
    pub client: reqwest::Client,
    route: &'static str,
    at: Instant,
}

fn network() -> Net {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();
    // Diagnostics only: whether macOS sends HTTPS through a proxy, which the app's Node code ignores.
    let proxied = std::process::Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains("HTTPSEnable : 1"));
    Net {
        client,
        route: if proxied {
            "via system proxy"
        } else {
            "direct"
        },
        at: Instant::now(),
    }
}

pub(super) type Entry = (String, String, Option<String>);

/// The website's list of awake sandboxes, asked at most once a minute.
pub(super) struct Awake {
    next: Instant,
    checked: SystemTime,
    key: Option<(String, String)>,
    list: Vec<Entry>,
    pub blocked: u32,
}

/// State every part of the helper shares, as client.py's module globals.
pub(super) struct Shared {
    pub folder: PathBuf,
    pub net: RwLock<Net>,
    pub awake: tokio::sync::Mutex<Awake>,
    /// Why the helper last failed to list or reach sandboxes: (message for Settings, detail for diagnostics).
    pub problems: Mutex<BTreeMap<&'static str, (String, String)>>,
    issuers: Mutex<HashMap<String, String>>,
    released: Mutex<HashSet<String>>,
    /// Wakes job streams waiting to retry when the app asks to check again.
    pub nudge: tokio::sync::Notify,
    /// New per helper process: when it changes, Core ends jobs the old process was running (#569).
    pub boot: String,
    /// Preview tunnels connect straight to the core, as client.py's raw sockets do.
    pub direct: reqwest::Client,
}

impl Shared {
    pub(super) fn new(folder: PathBuf) -> Shared {
        let direct = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Shared {
            folder,
            net: RwLock::new(network()),
            awake: tokio::sync::Mutex::new(Awake {
                next: Instant::now(),
                checked: UNIX_EPOCH,
                key: None,
                list: Vec::new(),
                blocked: 0,
            }),
            problems: Mutex::default(),
            issuers: Mutex::default(),
            released: Mutex::default(),
            nudge: tokio::sync::Notify::new(),
            boot: super::random(16)
                .map(|bytes| super::hex(&bytes))
                .unwrap_or_default(),
            direct,
        }
    }

    pub(super) fn refresh_network_if_stale(&self) {
        if self.net.read().unwrap().at.elapsed() >= NETWORK {
            *self.net.write().unwrap() = network();
        }
    }

    pub(super) fn client(&self) -> reqwest::Client {
        self.net.read().unwrap().client.clone()
    }

    /// A JSON request to the website or a core. Redirects are refused; answers are capped at 256 KB.
    pub(super) async fn control(
        &self,
        url: &str,
        body: Option<&Value>,
        method: Option<&str>,
        headers: &[(String, String)],
        timeout: Duration,
    ) -> Result<Value> {
        let method = method.unwrap_or(if body.is_some() { "POST" } else { "GET" });
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| Error::value("Invalid method"))?;
        let mut request = self
            .client()
            .request(method, url)
            .timeout(timeout)
            .header("Content-Type", "application/json");
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        let mut response = request.send().await.map_err(network_error)?;
        let status = response.status();
        if status.is_redirection() && response.headers().contains_key("location") {
            return Err(Error::value("Preview control requests cannot redirect"));
        }
        if !status.is_success() {
            return Err(Error::Http(status.as_u16()));
        }
        let mut raw = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            raw.extend_from_slice(&chunk);
            if raw.len() > LIMIT {
                return Err(Error::value("Preview response is too large"));
            }
        }
        serde_json::from_slice(&raw).map_err(|error| Error::value(error.to_string()))
    }

    /// A failed step, twice: the reason Settings shows (only what the user can act on), and the detail the app saves
    /// with the account for debugging (#109, ADR 0201).
    pub(super) async fn describe(&self, step: &str, error: &Error, url: &str) -> (String, String) {
        let mut detail = format!(
            "{step} ({}): {}",
            if step == "list" { "website" } else { "sandbox" },
            error.kind()
        );
        let message = match error {
            Error::Http(code) => {
                detail += &format!(" HTTP {code}");
                if *code == 401 {
                    "Sign out of Cloudroom and sign in again."
                } else {
                    "Cloudroom didn't answer as expected. This is usually temporary."
                }
                .to_owned()
            }
            Error::Net { unsent, text } => {
                detail += &format!(" {}", text.chars().take(100).collect::<String>());
                match unsent {
                    Unsent::Certificate => {
                        if step == "list" {
                            detail += &format!("; {}", self.issuer(url).await);
                        }
                        "A VPN, proxy, or antivirus on this Mac may be intercepting secure connections.".to_owned()
                    }
                    Unsent::Dns => "This Mac can't look up Cloudroom. Check the internet connection or VPN.".to_owned(),
                    Unsent::Refused => "A firewall, VPN, or proxy on this Mac may be blocking Cloudroom.".to_owned(),
                    Unsent::No => "The connection to Cloudroom keeps failing. It may be this Mac's network, or a temporary problem.".to_owned(),
                }
            }
            Error::Io(error) => {
                detail += &format!(
                    " {}",
                    error.to_string().chars().take(100).collect::<String>()
                );
                "The connection to Cloudroom keeps failing. It may be this Mac's network, or a temporary problem.".to_owned()
            }
            Error::Value(text) => {
                detail += &format!(" {}", text.chars().take(100).collect::<String>());
                "Cloudroom didn't answer as expected. This is usually temporary.".to_owned()
            }
        };
        let route = self.net.read().unwrap().route;
        let detail: String = detail.chars().take(220).collect();
        (
            message,
            format!(
                "{detail}; {route}; Rust helper {}, rustls, Mozilla roots",
                crate::VERSION
            ),
        )
    }

    /// Who signed the website's certificate as this Mac gets it directly, such as an antivirus's own root. Once per run.
    async fn issuer(&self, url: &str) -> String {
        let Ok(parsed) = reqwest::Url::parse(url) else {
            return "issuer unknown".into();
        };
        let host = parsed.host_str().unwrap_or_default().to_owned();
        let key = format!("{host}:{}", parsed.port_or_known_default().unwrap_or(443));
        if let Some(known) = self.issuers.lock().unwrap().get(&key) {
            return known.clone();
        }
        self.issuers
            .lock()
            .unwrap()
            .insert(key.clone(), "issuer unknown".into());
        let found = async {
            // Only to read who signed it, never to send data.
            let hello = tokio::process::Command::new("/usr/bin/openssl")
                .args(["s_client", "-connect", &key, "-servername", &host])
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output();
            let hello = tokio::time::timeout(Duration::from_secs(3), hello)
                .await
                .ok()?
                .ok()?;
            let mut issuer = tokio::process::Command::new("/usr/bin/openssl")
                .args(["x509", "-noout", "-issuer"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;
            use tokio::io::AsyncWriteExt;
            issuer.stdin.take()?.write_all(&hello.stdout).await.ok()?;
            let out = tokio::time::timeout(Duration::from_secs(3), issuer.wait_with_output())
                .await
                .ok()?
                .ok()?;
            let out = String::from_utf8_lossy(&out.stdout)
                .trim()
                .chars()
                .take(90)
                .collect::<String>();
            (!out.is_empty()).then(|| format!("direct {out}"))
        }
        .await;
        let found = found.unwrap_or_else(|| "issuer unknown".into());
        self.issuers.lock().unwrap().insert(key, found.clone());
        found
    }
}

/// The website the app signed in to: ours, the app's self-hosted one, or a loopback test server.
pub(super) fn website(config: &Value, connection: &Value) -> Result<String> {
    let base = text(connection, "websiteUrl")
        .unwrap_or(WEBSITE)
        .trim_end_matches('/')
        .to_owned();
    let loopback = reqwest::Url::parse(&base).is_ok_and(|url| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
    });
    if base == WEBSITE || Some(base.as_str()) == text(config, "website") || loopback {
        Ok(base)
    } else {
        Err(Error::value("Invalid managed preview service"))
    }
}

pub(super) fn hostname(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| host.trim_matches(['[', ']']).to_owned())
        })
        .unwrap_or_default()
}

/// HTTP Basic for the website: the account and one of its tokens.
pub(super) fn basic(connection: &Value, token: &str) -> Option<Vec<(String, String)>> {
    let account = account(connection)?;
    uuid(account)?;
    let credential = base64(format!("{account}:{token}").as_bytes());
    Some(vec![(
        "Authorization".into(),
        format!("Basic {credential}"),
    )])
}

/// The paired VM's core, or, with `url` and `token`, one awake cloud sandbox's core.
#[derive(Clone, Debug)]
pub(super) struct Core {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub sandbox: bool,
    pub thread: Option<String>,
    /// A sandbox gets a new token on every wake, so its tunnels and streams are rebuilt.
    pub key: (String, String),
    pub config: Value,
    pub connection: Value,
}

impl Core {
    pub(super) fn new(
        config: &Value,
        sandbox: Option<(&str, &str)>,
        thread: Option<String>,
    ) -> Result<Core> {
        let connection_file = text(config, "connectionFile")
            .ok_or_else(|| Error::value("Set up the helper first"))?;
        let connection = private_json(Path::new(connection_file))?;
        let url = sandbox
            .map(|(url, _)| url)
            .or_else(|| text(&connection, "url"))
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_owned();
        let parsed = reqwest::Url::parse(&url).ok();
        let allowed = parsed.as_ref().is_some_and(|parts| {
            let host = parts
                .host_str()
                .unwrap_or_default()
                .trim_matches(['[', ']']);
            (parts.scheme() == "https"
                || parts.scheme() == "http" && ["localhost", "127.0.0.1", "::1"].contains(&host))
                && parts.username().is_empty()
                && parts.password().is_none()
                && parts.query().is_none_or(str::is_empty)
                && parts.fragment().is_none_or(str::is_empty)
        });
        if !allowed {
            return Err(Error::value("Use an authenticated HTTPS core connection"));
        }
        if sandbox.is_none() && config["binding"] != json!([url, account(&connection)]) {
            return Err(Error::value(
                "Preview connection belongs to another account or VM",
            ));
        }
        let token = match sandbox {
            Some((_, token)) => token.to_owned(),
            None => connection["token"].as_str().unwrap_or_default().to_owned(),
        };
        let gate = match sandbox {
            Some(_) => None,
            None => connection
                .get("gateToken")
                .filter(|gate| !gate.is_null())
                .map(|gate| gate.as_str().unwrap_or_default().to_owned()),
        };
        if token.is_empty() || !token.chars().all(|c| TOKEN_CHARS.contains(&c)) {
            return Err(Error::value("Sign in to Cloudroom again"));
        }
        if gate
            .as_ref()
            .is_some_and(|gate| gate.is_empty() || !gate.chars().all(|c| GATE_CHARS.contains(c)))
        {
            return Err(Error::value("Invalid hosting credential"));
        }
        // Some sandbox proxies replace Authorization with their own login, so Core also reads X-Cloudroom-Token.
        let mut headers = vec![
            ("Authorization".to_owned(), format!("Bearer {token}")),
            ("X-Cloudroom-Token".to_owned(), token.clone()),
        ];
        if let Some(gate) = gate {
            headers.push(("Cookie".into(), format!("_port_auth={gate}")));
        }
        Ok(Core {
            key: (url.clone(), token),
            url,
            headers,
            sandbox: sandbox.is_some(),
            thread,
            config: config.clone(),
            connection,
        })
    }

    pub(super) fn website(&self) -> Result<String> {
        website(&self.config, &self.connection)
    }

    /// Prepares the VM's managed SSH metadata through the website.
    pub(super) async fn prepare(&self, shared: &Shared) -> Result<()> {
        if account(&self.connection).is_none() {
            return Ok(());
        }
        let token = self.connection["token"].as_str().unwrap_or_default();
        let headers =
            basic(&self.connection, token).ok_or_else(|| Error::value("Invalid account"))?;
        shared
            .control(
                &format!("{}/api/desktop/previews", self.website()?),
                Some(&json!({})),
                None,
                &headers,
                Duration::from_secs(5),
            )
            .await?;
        Ok(())
    }

    pub(super) async fn request(
        &self,
        shared: &Shared,
        path: &str,
        body: Option<&Value>,
        method: Option<&str>,
    ) -> Result<Value> {
        shared
            .control(
                &format!("{}/v1/previews{path}", self.url),
                body,
                method,
                &self.headers,
                Duration::from_secs(5),
            )
            .await
    }
}

/// The paired VM's core, if any, then every awake cloud sandbox's core (docs/scopes/sandboxes.md).
pub(super) async fn cores(shared: &Shared, config: &Value) -> Result<Vec<Core>> {
    let connection_file =
        text(config, "connectionFile").ok_or_else(|| Error::value("Set up the helper first"))?;
    let connection = private_json(Path::new(connection_file))?;
    // Another account signed in while this setup still runs (its stop failed): this device never pairs with its cores.
    if account(&connection) != config["binding"][1].as_str() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    if text(&connection, "url").is_some() {
        found.push(Core::new(config, None, None)?);
    }
    let (Some(account), Some(token)) = (account(&connection), text(&connection, "sandboxToken"))
    else {
        shared.problems.lock().unwrap().remove("sandboxes");
        return Ok(found);
    };
    let woke = Path::new(connection_file)
        .with_file_name("cloudroom-preview")
        .join("woke");
    let modified = std::fs::metadata(&woke)
        .and_then(|info| info.modified())
        .ok();
    let key = (account.to_owned(), token.to_owned());
    let (awake, nudged) = {
        let mut awake = shared.awake.lock().await;
        let nudged = modified.is_some_and(|modified| modified > awake.checked);
        let due = awake.key.as_ref() != Some(&key) || nudged || Instant::now() >= awake.next;
        // While something fails, reread the proxy setting every 30 s and before each new list.
        if !shared.problems.lock().unwrap().is_empty()
            && (due || shared.net.read().unwrap().at.elapsed() >= NETWORK)
        {
            *shared.net.write().unwrap() = network();
        }
        if due {
            (awake.next, awake.checked, awake.key) =
                (Instant::now() + AWAKE, SystemTime::now(), Some(key));
            let listed = async {
                let headers =
                    basic(&connection, token).ok_or_else(|| Error::value("Invalid account"))?;
                let url = format!("{}/api/desktop/sandboxes", website(config, &connection)?);
                let answer = shared
                    .control(
                        &url,
                        Some(&json!({"action": "awake"})),
                        Some("POST"),
                        &headers,
                        Duration::from_secs(5),
                    )
                    .await?;
                answer["sandboxes"]
                    .as_array()
                    .ok_or_else(|| Error::value("Invalid sandbox list"))?
                    .iter()
                    .map(
                        |entry| match (entry["origin"].as_str(), entry["token"].as_str()) {
                            (Some(origin), Some(token)) => Ok((
                                origin.to_owned(),
                                token.to_owned(),
                                entry["thread"].as_str().map(str::to_owned),
                            )),
                            _ => Err(Error::value("Invalid sandbox list")),
                        },
                    )
                    .collect::<Result<Vec<_>>>()
            }
            .await;
            match listed {
                Ok(list) => {
                    (awake.list, awake.blocked) = (list, 0);
                    shared.problems.lock().unwrap().remove("sandboxes");
                }
                Err(error) => {
                    // Keep the last list. A request that never reached our servers is retried in 10-20 s, at random so
                    // Macs never line up after an outage; that costs our servers nothing (db-load-budget). Others wait.
                    awake.blocked = if error.unsent() { awake.blocked + 1 } else { 0 };
                    if awake.blocked > 0 {
                        let jitter = super::random(1)
                            .map(|byte| u64::from(byte[0]) * 10_000 / 255)
                            .unwrap_or(5_000);
                        awake.next = Instant::now() + Duration::from_millis(10_000 + jitter);
                    }
                    // Under the lock, so a status written meanwhile never misses it.
                    let described = shared
                        .describe(
                            "list",
                            &error,
                            text(&connection, "websiteUrl").unwrap_or(WEBSITE),
                        )
                        .await;
                    shared
                        .problems
                        .lock()
                        .unwrap()
                        .insert("sandboxes", described);
                }
            }
        }
        (awake.list.clone(), nudged)
    };
    if nudged {
        shared.nudge.notify_waiters();
    }
    let awake = if config["ownThreads"].as_bool().unwrap_or(false) {
        own_threads(shared, config, connection_file, awake).await
    } else {
        awake
    };
    for (origin, secret, thread) in awake {
        if let Ok(core) = Core::new(config, Some((&origin, &secret)), thread) {
            found.push(core);
        }
    }
    Ok(found)
}

/// Cloudroom Dev shares the real app's account, and a sandbox pairs only its first Mac helper. So Dev keeps the
/// sandboxes of threads it woke (the app lists them in `own-threads`) and unpairs once from every other one.
async fn own_threads(
    shared: &Shared,
    config: &Value,
    connection_file: &str,
    awake: Vec<Entry>,
) -> Vec<Entry> {
    let owned: HashSet<String> = std::fs::read_to_string(
        Path::new(connection_file)
            .with_file_name("cloudroom-preview")
            .join("own-threads"),
    )
    .map(|text| text.split_whitespace().map(str::to_owned).collect())
    .unwrap_or_default();
    let device = text(config, "device").unwrap_or_default();
    for (origin, secret, thread) in &awake {
        if !thread.as_ref().is_some_and(|thread| owned.contains(thread))
            && shared.released.lock().unwrap().insert(secret.clone())
            && let Ok(core) = Core::new(config, Some((origin, secret)), None)
        {
            let _ = core
                .request(shared, &format!("/device/{device}"), None, Some("DELETE"))
                .await;
        }
    }
    awake
        .into_iter()
        .filter(|(_, _, thread)| thread.as_ref().is_some_and(|thread| owned.contains(thread)))
        .collect()
}

/// This Mac's preview SSH key, made on first use; returns its public half.
pub(super) fn identity(folder: &Path) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    let key = folder.join("id_ed25519");
    let public = folder.join("id_ed25519.pub");
    if !key.exists() && !public.exists() {
        let made = std::process::Command::new("/usr/bin/ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .output()?;
        if !made.status.success() {
            return Err(Error::value(format!(
                "ssh-keygen failed (exit code {})",
                made.status.code().unwrap_or(-1)
            )));
        }
    }
    let info = std::fs::symlink_metadata(&key)?;
    if info.file_type().is_symlink()
        || info.uid() != super::uid()
        || info.mode() & 0o077 != 0
        || std::fs::symlink_metadata(&public)?.file_type().is_symlink()
    {
        return Err(Error::value("Unsafe preview SSH key"));
    }
    Ok(std::fs::read_to_string(public)?
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" "))
}
