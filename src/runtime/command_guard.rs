use super::command as child_command;
use crate::config::{Config, HarnessConfig};
#[cfg(unix)]
use std::path::Path;
use tokio::process::Command;

pub(super) const SOURCE: &str = include_str!("command-guard.mjs");

/// Windows has no `/bin/sh` wrapper or process-group `exec` yet, so the harness runs
/// unguarded there: tool calls work, but Command Guard's disaster rules do not apply.
#[cfg(windows)]
pub(super) fn codex_command(config: &Config, profile: &HarnessConfig) -> Command {
    let mut command = child_command(&profile.binary, config);
    command.env("CODEX_HOME", &profile.home);
    command.args(["app-server", "--listen", "stdio://"]);
    command
}

#[cfg(windows)]
pub(super) fn claude_command(config: &Config, profile: &HarnessConfig) -> Command {
    child_command(&profile.binary, config)
}

#[cfg(unix)]
pub(super) fn codex_command(config: &Config, profile: &HarnessConfig) -> Command {
    let mut command = guarded_command(config, profile, false);
    command.args(["app-server", "--listen", "stdio://"]);
    command
}

#[cfg(unix)]
pub(super) fn claude_command(config: &Config, profile: &HarnessConfig) -> Command {
    guarded_command(config, profile, true)
}

#[cfg(unix)]
fn guarded_command(config: &Config, profile: &HarnessConfig, claude: bool) -> Command {
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
console.log(process.argv[2] === "claude"
  ? JSON.stringify({ fastMode: false, enableWorkflows: false, hooks: { PreToolUse: config["hooks.PreToolUse"] } })
  : "hooks=" + toml({ PreToolUse: config["hooks.PreToolUse"], state: config["hooks.state"] }));
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
        .args(["-c", "set -eu; guard=$(\"$3\" --input-type=module -e \"$1\" \"$2\" \"$4\"); flag=$5; shift 5; exec \"$@\" \"$flag\" \"$guard\"", "cloudroom-command-guard"])
        .arg(prepare)
        .arg(profile.home.join("cloudroom-command-guard"))
        .arg(node)
        .arg(if claude { "claude" } else { "codex" })
        .arg(if claude { "--settings" } else { "-c" })
        .arg(&profile.binary);
    command
}
