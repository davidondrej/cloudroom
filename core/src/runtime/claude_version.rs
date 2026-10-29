//! Keep cloud Claude Code on the same version as the user's Mac (ADR 0133).
use super::claude;
use crate::config::Config;
use serde_json::{Value, json};
use std::{
    io,
    sync::{Arc, Mutex as StdMutex, OnceLock},
};
use tokio::sync::Mutex;

static INSTALL: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
static LAST_ERROR: StdMutex<Option<String>> = StdMutex::new(None);

pub fn valid(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 6 && part.bytes().all(|b| b.is_ascii_digit())
        })
}

async fn installed(config: &Config) -> io::Result<String> {
    let (_, out) = claude::run_output(config, &["--version"], 20).await?;
    String::from_utf8_lossy(&out)
        .split_whitespace()
        .next()
        .filter(|version| valid(version))
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("Claude did not report its version"))
}

/// Switch to `target` in the background. Switching while Claude runs can delete a live
/// binary, so a `busy` VM waits; idle sessions sleep after 30 minutes and free it.
pub async fn ensure(config: Config, target: String, busy: bool) -> Value {
    let lock = INSTALL.get_or_init(Default::default).clone();
    let current = match installed(&config).await {
        Err(error) => return json!({"state":"failed","target":target,"error":error.to_string()}),
        Ok(version) if version == target => {
            *LAST_ERROR.lock().unwrap() = None;
            return json!({"state":"current","installed":version,"target":target});
        }
        Ok(version) => version,
    };
    let Ok(guard) = lock.try_lock_owned() else {
        return json!({"state":"updating","installed":current,"target":target});
    };
    if busy {
        return json!({"state":"waiting","installed":current,"target":target,"error":LAST_ERROR.lock().unwrap().clone()});
    }
    let version = target.clone();
    tokio::spawn(async move {
        let _guard = guard;
        // Downgrades need --force; the installer keeps newer versions otherwise.
        let result = claude::run_output(&config, &["install", &version, "--force"], 300).await;
        let error = match result {
            Ok((Some(0), _)) => match installed(&config).await {
                Ok(now) if now == version => None,
                Ok(now) => Some(format!(
                    "Claude install finished but reports {now}, not {version}"
                )),
                Err(error) => Some(error.to_string()),
            },
            Ok((code, _)) => Some(format!("claude install {version} failed (exit {code:?})")),
            Err(error) => Some(format!("claude install {version} failed: {error}")),
        };
        *LAST_ERROR.lock().unwrap() = error;
    });
    json!({"state":"updating","installed":current,"target":target})
}
