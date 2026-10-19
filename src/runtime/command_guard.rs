use super::command as child_command;
use crate::config::{Config, HarnessConfig};
use std::path::Path;
use tokio::process::Command;

pub(super) const SOURCE: &str = include_str!("command-guard.mjs");

pub(super) fn codex_command(config: &Config, profile: &HarnessConfig) -> Command {
    let mut command = guarded_command(config, profile, false);
    command.args(["app-server", "--listen", "stdio://"]);
    command
}

pub(super) fn claude_command(config: &Config, profile: &HarnessConfig) -> Command {
    guarded_command(config, profile, true)
}

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

#[cfg(test)]
mod tests {
    use super::SOURCE;

    fn verdict(command: &str) -> String {
        let script = format!(
            "{SOURCE}\nconst reason = checkCommand(process.argv[1]);\nprocess.stdout.write(reason ? \"blocked\" : \"allowed\");"
        );
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", &script, command])
            .output()
            .expect("node runs the guard");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn wrapped_forms_of_a_root_or_home_deletion_are_blocked() {
        for command in [
            "rm -rf /",
            "if true; then rm -rf ~; fi",
            "{ rm -rf ~; }",
            "sudo -E rm -rf /",
            "rm -rf \"$HOME\"/",
        ] {
            assert_eq!(verdict(command), "blocked", "{command}");
        }
    }

    #[test]
    fn every_bypass_form_from_the_review_is_blocked() {
        for command in [
            "if true; then rm -rf ~; fi",
            "for d in x; do rm -rf ~; done",
            "{ rm -rf ~; }",
            "\\rm -rf ~",
            "env rm -rf ~",
            "time rm -rf ~",
            "xargs rm -rf <<< ~",
            "rm -rf /.",
            "rm -rf \"$HOME\"/",
            "nohup rm -rf ~ &",
            "sudo -E rm -rf /",
            "find ~ -delete",
            "sh -c 'rm -rf ~'",
            "bash -c \"rm -rf ~\"",
            "sudo -u root rm -rf /",
            "sudo --user=root rm -rf /",
            "(rm -rf /)",
            "$(rm -rf /)",
            "rm -rf /./",
            "x=1 rm -rf /",
            "nice rm -rf /",
            "nice -n 5 rm -rf /",
            "timeout 5 rm -rf /",
            "doas rm -rf /",
            "bash -lc 'rm -rf ~'",
            "sh -ec 'rm -rf /'",
            "find / -xdev -delete",
            "find ~ -maxdepth 1 -delete",
            "find ~ -delete -name x",
            "find / -delete -name core",
            "find ~ -type f -delete",
            "find ~ -name '*' -delete",
            "find ~ -path ~/keep -prune -o -delete",
            "find ~ -name keep -o -delete",
            "find ~ -not -name keep -delete",
            "find ~ ! -name keep -delete",
            "find ~ -user agent -delete",
            "find ~ -mtime -100000 -delete",
            "find ~ -delete # -name x",
            "find -L ~ -delete",
            "find -P / -delete",
            "find ./build ~ -delete",
            "find ~ -exec rm -rf {} +",
            "bash -l -c 'rm -rf ~'",
            "bash -e -c 'rm -rf ~'",
            "bash --norc -c 'rm -rf ~'",
            "bash -o pipefail -c 'rm -rf ~'",
            "sh -c -- 'rm -rf ~'",
            "bash -c $'rm -rf ~'",
            "rm -rf \"${HOME:?}\"",
            "sudo -uroot rm -rf /",
            "sudo -u root -- rm -rf /",
        ] {
            assert_eq!(verdict(command), "blocked", "{command}");
        }
    }

    #[test]
    fn ordinary_removals_are_allowed() {
        for command in [
            "rm -rf ./build",
            "echo rm -rf ~",
            "ls -la",
            "echo '{ rm -rf ~; }'",
            "find ./build -name '*.o' -delete",
            "find ./build -delete",
            "find ~ -name '*.pyc' -delete",
            "find $HOME -maxdepth 1 -name '*.log' -delete",
            "find / -xdev -name core -delete",
            "sh -c 'ls -la'",
            "bash -lc 'ls -la'",
            "bash -l -c 'ls -la'",
        ] {
            assert_eq!(verdict(command), "allowed", "{command}");
        }
    }

    #[test]
    fn a_long_sudo_option_chain_is_checked_in_linear_time() {
        for option in ["-ua ", "-u -u ", "-- "] {
            let command = format!("sudo {}x", option.repeat(30));
            let elapsed = guard_time_ms(&command);
            assert!(elapsed < 50.0, "{option:?} took {elapsed} ms");
        }
    }

    fn guard_time_ms(command: &str) -> f64 {
        let script = format!(
            "{SOURCE}\nconst start = performance.now();\ncheckCommand(process.argv[1]);\nprocess.stdout.write(String(performance.now() - start));"
        );
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", &script, command])
            .output()
            .expect("node runs the guard");
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .expect("node prints the elapsed time")
    }
}
