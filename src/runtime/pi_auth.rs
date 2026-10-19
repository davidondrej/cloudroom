//! Pi setup on the VM. The Mac helper copies logins the VM lacks, custom providers, and packages (ADR 0130); users can also set one key.
use super::{Kind, command as child_command};
use crate::{config::Config, workspace::storage::Guard};
use serde_json::{Map, Value, json};
use std::{io, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

const MAX_ENTRY_BYTES: usize = 16 * 1024;
const MAX_PROVIDER_BYTES: usize = 256 * 1024;

fn name(value: &str, extra: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || extra.contains(&b))
}
fn secret(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
}

/// A secret the VM can use as written. `!command` runs a Mac-only secret manager, and `$VAR` names a Mac shell
/// variable; both are resolved on the Mac or not at all (docs/harnesses.md), so neither is copied.
fn literal(value: &Value) -> bool {
    secret(value) && !value.as_str().is_some_and(|s| s.starts_with(['!', '$']))
}

/// Every string inside a value, at any depth, is literal (see `literal`).
fn literal_tree(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.starts_with(['!', '$']),
        Value::Array(items) => items.iter().all(literal_tree),
        Value::Object(fields) => fields.values().all(literal_tree),
        _ => true,
    }
}

/// A well-formed Pi credential, or None. `!command` keys run Mac-only secret managers, so they stay behind.
fn entry(value: &Value) -> Option<Value> {
    if serde_json::to_vec(value).ok()?.len() > MAX_ENTRY_BYTES {
        return None;
    }
    match value["type"].as_str()? {
        "api_key" if literal(&value["key"]) => {
            let mut entry = json!({"type":"api_key","key":value["key"]});
            if let Some(env) = value.get("env") {
                let env = env.as_object()?;
                if !env.iter().all(|(k, v)| name(k, &[]) && literal(v)) {
                    return None;
                }
                entry["env"] = json!(env);
            }
            Some(entry)
        }
        // OAuth fields vary by provider, so keep the entry as Pi wrote it, unless any string in it is a command or variable.
        "oauth"
            if literal(&value["access"])
                && literal(&value["refresh"])
                && literal_tree(value)
                && value["expires"].is_number() =>
        {
            Some(value.clone())
        }
        _ => None,
    }
}

/// The error a Pi call carries when the configuration has no Pi harness. Typed, because std also reports
/// `Unsupported` for unrelated failures such as `ENOSYS`.
#[derive(Debug)]
pub(crate) struct NotConfigured;

impl std::fmt::Display for NotConfigured {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pi is not configured")
    }
}

impl std::error::Error for NotConfigured {}

fn profile(config: &Config) -> io::Result<&crate::config::HarnessConfig> {
    config
        .harnesses
        .get(&Kind::Pi)
        .ok_or_else(|| io::Error::other(NotConfigured))
}

/// Runs one private-file operation in `sync/files.py` on a file in Pi's home.
async fn helper(
    config: &Config,
    storage: &Guard,
    filename: &str,
    mut request: Value,
) -> io::Result<Value> {
    request["tree"] = json!({"root":profile(config)?.home,"kind":"auth","filename":filename});
    let mut command = Command::new("python3");
    command
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .args(["-I", "-c", include_str!("../sync/files.py")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let (mut child, _workload) = storage.spawn_writer(&mut command)?;
    let mut stdin = child.stdin.take().unwrap();
    // Keys travel only over private stdin, never process arguments or diagnostic records.
    stdin.write_all(&serde_json::to_vec(&request)?).await?;
    stdin.write_all(b"\n").await?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await??;
    let result: Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    if !output.status.success() || result["ok"] != true {
        return Err(io::Error::other(format!(
            "Pi file update failed ({})",
            result["error"].as_str().unwrap_or("no helper result")
        )));
    }
    Ok(result)
}

async fn update(
    config: &Config,
    storage: &Guard,
    credentials: Map<String, Value>,
    replace: bool,
) -> io::Result<Value> {
    let request = json!({"op":"pi_auth","credentials":credentials,"replace":replace});
    let result = helper(config, storage, "auth.json", request).await?;
    Ok(json!({"providers":result["providers"],"added":result["added"]}))
}

/// Provider names with a saved login. Never returns secrets.
pub(crate) async fn providers(config: &Config, storage: &Guard) -> io::Result<Value> {
    let result = update(config, storage, Map::new(), false).await?;
    Ok(json!({"providers":result["providers"]}))
}

/// Adds valid providers the VM lacks. An existing VM login always wins.
pub(crate) async fn import(config: &Config, storage: &Guard, value: Value) -> io::Result<Value> {
    let credentials = value
        .as_object()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid Pi logins"))?
        .iter()
        .filter(|(provider, _)| name(provider, b"-."))
        .filter_map(|(provider, value)| Some((provider.clone(), entry(value)?)))
        .collect();
    update(config, storage, credentials, false).await
}

/// Saves or replaces one provider's API key, as the user asked.
pub(crate) async fn set_key(
    config: &Config,
    storage: &Guard,
    provider: String,
    key: String,
) -> io::Result<Value> {
    let value = json!({"type":"api_key","key":key});
    if !name(&provider, b"-.") || entry(&value).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid Pi provider key",
        ));
    }
    update(config, storage, Map::from_iter([(provider, value)]), true).await
}

/// A custom provider from the Mac's `models.json`. `!command` values ran on the Mac already, and `$VAR`
/// names a Mac shell variable; any left over would be resolved on the VM against the wrong environment, so they are dropped.
fn provider(value: &Value) -> Option<Value> {
    let mut value = value.clone();
    let provider = value.as_object_mut()?;
    drop_commands(provider);
    // Pi reads each model's own headers and key, so the same rule applies there.
    if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
        for model in models.iter_mut().filter_map(Value::as_object_mut) {
            drop_commands(model);
        }
    }
    (serde_json::to_vec(&value).ok()?.len() <= MAX_PROVIDER_BYTES).then_some(value)
}

fn drop_commands(object: &mut Map<String, Value>) {
    if object
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|key| key.starts_with(['!', '$']))
    {
        object.remove("apiKey");
    }
    if let Some(headers) = object.get_mut("headers").and_then(Value::as_object_mut) {
        headers.retain(|_, value| {
            !value
                .as_str()
                .is_some_and(|value| value.starts_with(['!', '$']))
        });
    }
}

/// Package sources the VM can fetch itself. Local paths only exist on the Mac.
fn remote_package(value: &Value) -> Option<String> {
    let source = value.as_str().or_else(|| value["source"].as_str())?;
    (source.len() <= 1024
        && !source.chars().any(|c| c.is_whitespace() || c.is_control())
        && ["npm:", "git:", "https://", "http://", "ssh://", "git://"]
            .iter()
            .any(|prefix| source.starts_with(prefix)))
    .then(|| source.to_owned())
}

/// The Mac's package entries with resource filters, such as turned-off extensions.
pub(crate) fn filtered(value: &Value) -> Vec<Value> {
    value["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry.is_object() && remote_package(entry).is_some())
        .cloned()
        .collect()
}

/// Saves the Mac's custom providers (Mac wins per provider) and returns packages the VM still needs.
pub(crate) async fn setup(
    config: &Config,
    storage: &Guard,
    value: Value,
) -> io::Result<(Value, Vec<String>)> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "invalid Pi setup");
    let providers: Map<String, Value> = value["providers"]
        .as_object()
        .ok_or_else(invalid)?
        .iter()
        .filter(|(name, _)| self::name(name, b"-."))
        .filter_map(|(name, value)| Some((name.clone(), provider(value)?)))
        .collect();
    let packages: Vec<String> = value["packages"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .filter_map(remote_package)
        .collect();
    let result = helper(
        config,
        storage,
        "models.json",
        json!({"op":"pi_setup","providers":providers}),
    )
    .await?;
    let installed: Vec<&str> = result["packages"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().or_else(|| item["source"].as_str()))
                .collect()
        })
        .unwrap_or_default();
    let missing: Vec<String> = packages
        .into_iter()
        .filter(|source| !installed.contains(&source.as_str()))
        .collect();
    Ok((
        json!({"providers":result["providers"],"installing":missing}),
        missing,
    ))
}

/// Installs packages one at a time with the VM's own Pi, the same as `pi install` in a terminal,
/// then puts back the Mac's resource filters, which `pi install` does not save.
pub(crate) async fn install(
    config: &Config,
    storage: &Guard,
    packages: Vec<String>,
    filtered: Vec<Value>,
) {
    static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _running = RUNNING.lock().await;
    let Ok(profile) = profile(config) else { return };
    for source in packages {
        let mut command = child_command(&profile.binary, config);
        command
            .env("PI_CODING_AGENT_DIR", &profile.home)
            .env("PI_TELEMETRY", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .current_dir(&config.account_home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .args(["install", &source]);
        let installed = async {
            let (child, _workload) = storage.spawn_writer(&mut command)?;
            let output = tokio::time::timeout(Duration::from_secs(300), child.wait_with_output())
                .await
                .map_err(|_| io::Error::other("timed out"))??;
            if output.status.success() {
                Ok(())
            } else {
                Err(io::Error::other(output.status.to_string()))
            }
        }
        .await;
        if let Err(error) = installed {
            eprintln!("Pi package install failed for {source}: {error}");
        }
    }
    if !filtered.is_empty() {
        let request = json!({"op":"pi_packages","packages":filtered});
        if let Err(error) = helper(config, storage, "settings.json", request).await {
            eprintln!("Pi package filters failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_drops_command_values_in_models_too() {
        let value = json!({
            "apiKey": "!op read secret",
            "headers": {"X-Top": "!id -u", "X-Plain": "value"},
            "models": [{"id": "m", "headers": {"X-Id": "!id -u", "X-Plain": "value"}}]
        });
        let kept = provider(&value).unwrap();
        let text = kept.to_string();
        assert!(!text.contains("!id -u"), "{text}");
        assert!(!text.contains("!op read"), "{text}");
        assert_eq!(kept["models"][0]["headers"], json!({"X-Plain": "value"}));
        assert_eq!(kept["headers"], json!({"X-Plain": "value"}));
    }

    #[test]
    fn import_copies_only_literal_credentials() {
        assert!(entry(&json!({"type":"api_key","key":"$OPENAI_API_KEY"})).is_none());
        assert!(entry(&json!({"type":"api_key","key":"!id -u"})).is_none());
        assert!(
            entry(&json!({"type":"oauth","access":"!id -u","refresh":"r","expires":1})).is_none()
        );
        assert!(
            entry(&json!({"type":"oauth","access":"a","refresh":"!id -u","expires":1})).is_none()
        );
        assert!(entry(&json!({"type":"api_key","key":"sk-literal"})).is_some());
        assert!(entry(&json!({"type":"oauth","access":"a","refresh":"r","expires":1})).is_some());
    }

    #[test]
    fn import_refuses_command_and_variable_values_in_env_and_oauth_fields() {
        assert!(entry(&json!({"type":"api_key","key":"sk-a","env":{"X":"!id -u"}})).is_none());
        assert!(entry(&json!({"type":"api_key","key":"sk-a","env":{"X":"$VAR"}})).is_none());
        assert!(entry(&json!({"type":"api_key","key":"sk-a","env":{"X":"literal"}})).is_some());
        let oauth =
            json!({"type":"oauth","access":"a","refresh":"r","expires":1,"extra":{"id":"!id -u"}});
        assert!(entry(&oauth).is_none());
        let oauth =
            json!({"type":"oauth","access":"a","refresh":"r","expires":1,"scopes":["$HOME"]});
        assert!(entry(&oauth).is_none());
    }

    #[test]
    fn a_provider_drops_variable_values_as_well_as_commands() {
        let kept = provider(&json!({"apiKey": "$OPENAI_API_KEY", "headers": {"X-Var": "$TOKEN"}}))
            .unwrap();
        assert!(kept.get("apiKey").is_none());
        assert_eq!(kept["headers"], json!({}));
    }

    #[test]
    fn a_typed_key_that_names_a_command_or_variable_is_refused() {
        assert!(entry(&json!({"type":"api_key","key":"$OPENAI_API_KEY"})).is_none());
        assert!(entry(&json!({"type":"api_key","key":"!op read"})).is_none());
    }
}
