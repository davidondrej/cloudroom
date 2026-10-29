use crate::runtime::Kind;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, env, io, net::SocketAddr, path::PathBuf, time::Duration};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HarnessConfig {
    pub binary: PathBuf,
    pub home: PathBuf,
    pub model: String,
    pub provider: Option<String>,
}

#[derive(Clone)]
pub struct Config {
    pub listen: SocketAddr,
    pub token: String,
    pub state_dir: PathBuf,
    pub repository: PathBuf,
    /// Where Core saves history, diagnostics, and feedback (ADR 0232): Cloudroom's website or a compatible server.
    /// None keeps history only in this machine's journal (`CLOUDROOM_LOCAL_HISTORY=1`, ADR 0237).
    pub api_url: Option<String>,
    pub store: String,
    /// Optional host label, such as a sandbox name, that prefixes this process's diagnostic run IDs.
    pub instance: Option<String>,
    pub account_home: PathBuf,
    pub default_harness: Kind,
    pub harnesses: BTreeMap<Kind, HarnessConfig>,
    pub storage: Option<crate::workspace::storage::Policy>,
    /// Harness RPC deadline; startup allows four times as long.
    pub rpc_timeout: Duration,
    /// How often diagnostics are uploaded. Long, so hundreds of idle cores cost the website little.
    pub diagnostic_upload: Duration,
}

impl Config {
    pub fn from_env() -> io::Result<Self> {
        let token = required("CLOUDROOM_TOKEN")?;
        if token.len() < 32 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(io::Error::other(
                "CLOUDROOM_TOKEN must contain at least 32 visible ASCII characters",
            ));
        }
        let listen: SocketAddr = env::var("CLOUDROOM_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:9840".into())
            .parse()
            .map_err(|_| io::Error::other("invalid CLOUDROOM_LISTEN"))?;
        let unprotected_test_mode =
            env::var("CLOUDROOM_UNPROTECTED_TEST_MODE").as_deref() == Ok("1");
        if !listen.ip().is_loopback() {
            if unprotected_test_mode {
                return Err(io::Error::other(
                    "CLOUDROOM_UNPROTECTED_TEST_MODE requires a loopback listener",
                ));
            }
            if env::var("CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP").as_deref() != Ok("1") {
                return Err(io::Error::other(
                    "Cloudroom serves plaintext HTTP; non-loopback listening requires \
                     CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP=1. Restrict backend access to an HTTPS \
                     proxy over a protected connection; this setting does not enable TLS.",
                ));
            }
        }
        let storage = if unprotected_test_mode {
            None
        } else {
            Some(crate::workspace::storage::Policy::load(&PathBuf::from(
                required("CLOUDROOM_STORAGE_POLICY")?,
            ))?)
        };
        // Unprotected tests shorten harness deadlines instead of waiting out the real ones.
        let rpc_timeout = match env::var("CLOUDROOM_TEST_RPC_TIMEOUT_MS") {
            Ok(ms) if unprotected_test_mode => Duration::from_millis(
                ms.parse()
                    .map_err(|_| io::Error::other("invalid CLOUDROOM_TEST_RPC_TIMEOUT_MS"))?,
            ),
            _ => Duration::from_secs(30),
        };
        let default_harness = match env::var("CLOUDROOM_HARNESS").as_deref().unwrap_or("codex") {
            "codex" => Kind::Codex,
            "pi" => Kind::Pi,
            "cursor" => Kind::Cursor,
            "claude-code" => Kind::Claude,
            "fx" => Kind::Fx,
            "opencode" => Kind::OpenCode,
            "hermes" => Kind::Hermes,
            "devin" => Kind::Devin,
            "openclaw" => Kind::OpenClaw,
            _ => return Err(io::Error::other("unsupported CLOUDROOM_HARNESS")),
        };
        let account_home: PathBuf = required("CLOUDROOM_ACCOUNT_HOME")?.into();
        let mut harnesses = BTreeMap::new();
        for (kind, prefix) in [(Kind::Codex, "CODEX"), (Kind::Pi, "PI")] {
            let binary = format!("CLOUDROOM_{prefix}_BINARY");
            if env::var_os(&binary).is_some() {
                let model = env::var(format!("CLOUDROOM_{prefix}_MODEL"))
                    .ok()
                    .filter(|m| !m.is_empty())
                    .map(Ok)
                    .unwrap_or_else(|| required("CLOUDROOM_MODEL"))?;
                let provider = if kind == Kind::Pi {
                    Some(required("CLOUDROOM_PI_PROVIDER")?)
                } else {
                    None
                };
                harnesses.insert(
                    kind,
                    HarnessConfig {
                        binary: required(&binary)?.into(),
                        home: required(&format!("CLOUDROOM_{prefix}_HOME"))?.into(),
                        model,
                        provider,
                    },
                );
            }
        }
        let claude = [
            account_home.join(".local/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ]
        .into_iter()
        .find(|path| path.is_file());
        if let Some(binary) = claude.filter(|_| account_home.join(".claude").is_dir()) {
            harnesses.insert(
                Kind::Claude,
                HarnessConfig {
                    binary,
                    home: account_home.join(".claude"),
                    model: "sonnet".into(),
                    provider: None,
                },
            );
        }
        let cursor = [
            account_home.join(".local/bin/cursor-agent"),
            PathBuf::from("/usr/local/bin/cursor-agent"),
        ]
        .into_iter()
        .find(|path| path.is_file());
        if let Some(binary) = cursor.filter(|_| account_home.join(".cursor").is_dir()) {
            harnesses.insert(
                Kind::Cursor,
                HarnessConfig {
                    binary,
                    home: account_home.join(".cursor"),
                    model: "default".into(),
                    provider: None,
                },
            );
        }
        // Native ACP agents: Core offers each once its binary and home folder exist.
        for (kind, name, home) in [
            (Kind::Fx, "fx", ".fx"),
            (Kind::OpenCode, "opencode", ".local/share/opencode"),
            (Kind::Hermes, "hermes", ".hermes"),
            (Kind::Devin, "devin", ".local/share/devin"),
        ] {
            let home = account_home.join(home);
            let binary = [
                account_home.join(".local/bin").join(name),
                PathBuf::from("/usr/local/bin").join(name),
            ]
            .into_iter()
            .find(|path| path.is_file());
            if let Some(binary) = binary.filter(|_| home.is_dir()) {
                harnesses.insert(
                    kind,
                    HarnessConfig {
                        binary,
                        home,
                        model: "default".into(),
                        provider: None,
                    },
                );
            }
        }
        // OpenClaw's rootless installer keeps its CLI in ~/.openclaw/bin; npm puts it on the PATH.
        let openclaw = [
            account_home.join(".openclaw/bin/openclaw"),
            account_home.join(".local/bin/openclaw"),
            PathBuf::from("/usr/local/bin/openclaw"),
        ]
        .into_iter()
        .find(|path| path.is_file());
        if let Some(binary) = openclaw.filter(|_| account_home.join(".openclaw").is_dir()) {
            harnesses.insert(
                Kind::OpenClaw,
                HarnessConfig {
                    binary,
                    home: account_home.join(".openclaw"),
                    model: "default".into(),
                    provider: None,
                },
            );
        }
        Ok(Self {
            storage,
            rpc_timeout,
            // Unprotected tests check uploads within seconds.
            diagnostic_upload: Duration::from_secs(if unprotected_test_mode { 1 } else { 300 }),
            default_harness,
            harnesses,
            listen,
            token,
            state_dir: required("CLOUDROOM_STATE_DIR")?.into(),
            repository: env::var_os("CLOUDROOM_REPOSITORY")
                .map(PathBuf::from)
                .unwrap_or_else(|| account_home.clone()),
            api_url: api_url()?,
            store: required("CLOUDROOM_STORE")?,
            instance: match env::var("CLOUDROOM_INSTANCE") {
                Ok(value)
                    if !value.is_empty()
                        && value.len() <= 63
                        && value
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') =>
                {
                    Some(value)
                }
                Ok(value) if !value.is_empty() => {
                    return Err(io::Error::other(
                        "CLOUDROOM_INSTANCE must be lowercase letters, digits and dashes",
                    ));
                }
                _ => None,
            },
            account_home,
        })
    }
}

/// HTTPS only, except a loopback test server. A managed install never silently drops to local-only history.
fn api_url() -> io::Result<Option<String>> {
    let Some(url) = env::var("CLOUDROOM_API_URL").ok().filter(|v| !v.is_empty()) else {
        return if env::var("CLOUDROOM_LOCAL_HISTORY").as_deref() == Ok("1") {
            Ok(None)
        } else {
            Err(io::Error::other(
                "set CLOUDROOM_API_URL, or CLOUDROOM_LOCAL_HISTORY=1 to keep history only on this machine",
            ))
        };
    };
    let loopback = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"];
    let valid = (url.starts_with("https://")
        || loopback.iter().any(|prefix| url.starts_with(prefix)))
        && !url.ends_with('/')
        && !url.contains(['?', '#', '@'])
        && url.bytes().all(|b| b.is_ascii_graphic());
    if !valid {
        return Err(io::Error::other(
            "CLOUDROOM_API_URL must be an https:// URL without a trailing slash",
        ));
    }
    Ok(Some(url))
}

fn required(name: &str) -> io::Result<String> {
    env::var(name)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| io::Error::other(format!("{name} is required")))
}
