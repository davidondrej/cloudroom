import { createHash } from "node:crypto";

/** Best-effort accident prevention for catastrophic shell commands, not a sandbox. Never block logins or credential copies. */
export function checkCommand(command) {
  if (typeof command !== "string") throw new Error("Invalid shell command");
  const start = String.raw`(?:^|[;&|()\n])\s*(?:(?:sudo|command|exec)(?:\s+-(?![vV]\s)[^\s]+)*\s+)*(?:/(?:[^\s/]+/)*|)(?:`;
  const end = String.raw`)(?=\s|$)`;
  const home = String.raw`(?:/+(?:\*)?|~/?(?:\*)?|\$(?:HOME|\{HOME\})/?(?:\*)?|/(?:Users|home)(?:/[^/\s"']+)?/?(?:\*)?|/root/?(?:\*)?)`;
  const rules = [
    ["deleting the root or a home directory", new RegExp(start + String.raw`rm` + end + String.raw`[^;&|\n]*\s+["']?` + home + String.raw`["']?(?=\s|[;&|]|$)`, "m")],
    ["disabling root-deletion protection", new RegExp(start + String.raw`rm` + end + String.raw`[^;&|\n]*--no-preserve-root`, "m")],
    ["formatting a disk", new RegExp(start + String.raw`(?:mkfs(?:\.[\w]+)?|mke2fs)` + end, "m")],
    ["erasing or repartitioning a disk", new RegExp(start + String.raw`diskutil` + end + String.raw`\s+(?:erase\w*|partitionDisk|zeroDisk|secureErase|apfs\s+(?:delete|erase)\w*)\b`, "m")],
    ["writing directly to a disk", new RegExp(start + String.raw`dd` + end + String.raw`[^;&|\n]*\bof=["']?/dev/(?:r?disk|sd[a-z]|xvd[a-z]|nvme|vd[a-z]|hd[a-z]|mmcblk[0-9]+)`, "m")],
    ["writing directly to a disk", />\s*["']?\/dev\/(?:r?disk|sd[a-z]|xvd[a-z]|nvme|vd[a-z]|hd[a-z]|mmcblk[0-9]+)/m],
    ["deleting a hosted repository", new RegExp(start + String.raw`gh` + end + String.raw`\s+repo\s+delete(?=\s|$)`, "m")],
    ["starting a fork bomb", /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/m],
  ];
  for (const [reason, pattern] of rules) {
    if (pattern.test(command)) {
      return `Blocked by Cloudroom Command Guard: ${reason}. Do not retry or work around this block. Explain it to the user. The user can disable Cloudroom Command Guard in Settings for a new session; personal guards remain separate.`;
    }
  }
  return null;
}

export function codexHookSource() {
  return `import { readFileSync } from "node:fs";
const inspectCloudroomCommand = (${checkCommand.toString()});
let reason;
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  reason = inspectCloudroomCommand(input.tool_input.command);
} catch {}
if (reason) console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:reason}}));
`;
}

export function codexGuardConfig(command) {
  const hook = { async: false, command, timeout: 10, type: "command" };
  const identity = { event_name: "pre_tool_use", hooks: [hook], matcher: "Bash" };
  const hash = "sha256:" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return {
    "hooks.PreToolUse": [{ matcher: "Bash", hooks: [hook] }],
    "hooks.state": {
      "/<session-flags>/config.toml:pre_tool_use:0:0": {
        enabled: true,
        trusted_hash: hash,
      },
    },
  };
}

export function commandGuardBlockReason(params) {
  if (params?.run?.status !== "blocked" || !Array.isArray(params.run.entries)) return null;
  const reasons = params.run.entries
    .map(entry => entry?.text)
    .filter(text => typeof text === "string" &&
      (text.startsWith("Blocked by Cloudroom Command Guard:") || text.startsWith("Cloudroom Command Guard ")));
  return reasons.length ? reasons.join("\n") : null;
}

export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
