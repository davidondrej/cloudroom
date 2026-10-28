use super::command as child_command;
use crate::config::{Config, HarnessConfig};
use std::path::Path;
use tokio::process::Command;

pub(super) const SOURCE: &str = include_str!("command-guard.mjs");

pub(super) fn codex_command(config: &Config, profile: &HarnessConfig) -> Command {
    let mut command = guarded_command(config, profile, None);
    command.args(["app-server", "--listen", "stdio://"]);
    command
}

/// `settings` is Claude's settings JSON: the guard adds its hooks and passes the result as the one `--settings`.
pub(super) fn claude_command(config: &Config, profile: &HarnessConfig, settings: &str) -> Command {
    guarded_command(config, profile, Some(settings))
}

fn guarded_command(config: &Config, profile: &HarnessConfig, settings: Option<&str>) -> Command {
    let claude = settings.is_some();
    // Prepare as the agent account, then exec the harness: no persistent wrapper process.
    let prepare = format!(
        "{}\n{}",
        SOURCE,
        r#"
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.argv[1];
mkdirSync(directory, { recursive: true, mode: 0o700 });
const source = codexHookSource();
const path = join(directory, createHash("sha256").update(source).digest("hex") + ".mjs");
const temporary = path + "." + process.pid;
writeFileSync(temporary, source, { mode: 0o600 });
renameSync(temporary, path);
const command = shellQuote(process.execPath) + " " + shellQuote(path) + " || true";
const config = codexGuardConfig(command);
function toml(value) {
  if (Array.isArray(value)) return "[" + value.map(toml).join(",") + "]";
  if (typeof value === "object") return "{" + Object.entries(value).map(([key, val]) => JSON.stringify(key) + "=" + toml(val)).join(",") + "}";
  return JSON.stringify(value);
}
if (process.argv[2] === "claude") {
  const settings = JSON.parse(process.argv[3]);
  console.log(JSON.stringify({ ...settings, hooks: { ...settings.hooks, PreToolUse: [...(settings.hooks?.PreToolUse ?? []), ...config["hooks.PreToolUse"]] } }));
} else {
  console.log("hooks=" + toml({ PreToolUse: config["hooks.PreToolUse"], state: config["hooks.state"] }));
}
"#
    );
    let node = if cfg!(target_os = "macos") && Path::new("/opt/homebrew/bin/node").is_file() {
        "/opt/homebrew/bin/node"
    } else {
        "node"
    };
    let mut command = child_command(Path::new("/bin/sh"), config);
    if !claude {
        command.env("CODEX_HOME", &profile.home);
    }
    command
        .args(["-c", "set -eu; guard=$(\"$3\" --input-type=module -e \"$1\" \"$2\" \"$4\" \"$5\"); flag=$6; shift 6; exec \"$@\" \"$flag\" \"$guard\"", "cloudroom-command-guard"])
        .arg(prepare)
        .arg(profile.home.join("cloudroom-command-guard"))
        .arg(node)
        .arg(if claude { "claude" } else { "codex" })
        .arg(settings.unwrap_or(""))
        .arg(if claude { "--settings" } else { "-c" })
        .arg(&profile.binary);
    command
}
