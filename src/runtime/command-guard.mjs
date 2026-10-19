import { createHash } from "node:crypto";

/** Best-effort accident prevention for catastrophic shell commands, not a sandbox. Never block logins or credential copies. */
export function checkCommand(command) {
  if (typeof command !== "string") throw new Error("Invalid shell command");
  // A shell that runs a quoted command (sh -c '...'): the quoted text is checked the same way.
  for (const match of command.matchAll(/(?:^|[\s;&|()\n])(?:[\w.\/-]*\/)?(?:ba|z|da|k)?sh(?:\s+(?:[-+]o\s+[^\s-]\S*|-[a-zA-Z]+|--[\w-]+))*?\s+-[a-zA-Z]*c[a-zA-Z]*(?:\s+--)?\s+\$?(?:"([^"]*)"|'([^']*)')/gm)) {
    const inner = checkCommand(match[1] ?? match[2]);
    if (inner) return inner;
  }
  // Wrappers that run the command that follows: a brace group at a command position, NAME=value
  // assignments, sudo with options (some taking an argument), and the usual exec wrappers.
  // Option alternatives are disjoint (a separate argument never starts with a dash), so backtracking stays linear.
  const wrapper = String.raw`(?:sudo(?:\s+(?:-[ugCDhpRTt]\s+[^\s-]\S*|--\w+=\S+|--|--\w[\w-]*|-\w+))*|command|exec|builtin|time|nohup|nice(?:\s+-n\s*-?\d+)?|doas(?:\s+-\S+)*|env(?:\s+-\S+)*|xargs(?:\s+-\S+)*|timeout(?:\s+-\S+)*\s+\S+|then|do|else|elif|if|while|until|!)`;
  const start = String.raw`(?:^|[;&|()\n])\s*(?:\{\s*)?(?:(?:[A-Za-z_]\w*=\S*|${wrapper})\s+)*(?:/(?:[^\s/]+/)*|)(?:`;
  const end = String.raw`)(?=\s|$)`;
  const home = String.raw`(?:/+(?:\.\/?)*(?:\*)?|~/?(?:\*)?|\$(?:HOME|\{HOME\})["']?/?(?:\*)?|\$\{HOME:?[-?=+][^}]*\}["']?/?(?:\*)?|/(?:Users|home)(?:/[^/\s"']+)?/?(?:\*)?|/root/?(?:\*)?)`;
  // find over the root or a home directory: whole-tree deletion unless a name or path filter selects and -delete comes last.
  const homePath = new RegExp("^" + home + "$");
  const findDeletesTree = args => {
    const words = [];
    for (const word of args.trim().split(/\s+/)) {
      if (word.startsWith("#")) break;
      words.push(word.replace(/["']/g, ""));
    }
    let i = 0;
    while (i < words.length && /^-[HLP]$|^-O\d*$|^-D$/.test(words[i])) i += words[i] === "-D" ? 2 : 1;
    const paths = [];
    while (i < words.length && !/^[-(!)]/.test(words[i])) paths.push(words[i++]);
    const expression = words.slice(i);
    if (!paths.some(path => homePath.test(path))) return false;
    if (expression.some((word, k) => /^-(exec|execdir|ok)$/.test(word) && /^\\?(?:.*\/)?rm$/.test(expression[k + 1] ?? ""))) return true;
    if (!expression.includes("-delete")) return false;
    const selecting = expression.some((word, k) => /^-i?(name|path)$/.test(word) && expression[k + 1] !== undefined && !/^\*+$/.test(expression[k + 1]));
    const plain = expression.every(word => !/^[(!)]|^-(o|or|not|prune|exec|execdir|ok)$|^,$/.test(word));
    return !(selecting && plain && expression.at(-1) === "-delete");
  };
  for (const match of command.matchAll(new RegExp(start + String.raw`find` + end + String.raw`([^;&|\n]*)`, "gm"))) {
    if (findDeletesTree(match[1])) {
      return `Blocked by Cloudroom Command Guard: deleting a tree from the root or a home directory with find. Do not retry or work around this block. Explain it to the user. The user can disable Cloudroom Command Guard in Settings for a new session; personal guards remain separate.`;
    }
  }
  const rules = [
    ["deleting the root or a home directory", new RegExp(start + String.raw`\\?rm` + end + String.raw`[^;&|\n]*\s+["']?` + home + String.raw`["']?(?=\s|[;&|)]|$)`, "m")],
    ["disabling root-deletion protection", new RegExp(start + String.raw`\\?rm` + end + String.raw`[^;&|\n]*--no-preserve-root`, "m")],
    ["formatting a disk", new RegExp(start + String.raw`mkfs(?:\.[\w]+)?` + end, "m")],
    ["erasing or repartitioning a disk", new RegExp(start + String.raw`diskutil` + end + String.raw`\s+(?:erase\w*|partitionDisk|zeroDisk|secureErase|apfs\s+(?:delete|erase)\w*)\b`, "m")],
    ["writing directly to a disk", new RegExp(start + String.raw`dd` + end + String.raw`[^;&|\n]*\bof=["']?/dev/(?:r?disk|sd[a-z]|nvme|vd[a-z]|hd[a-z])`, "m")],
    ["writing directly to a disk", />\s*["']?\/dev\/(?:r?disk|sd[a-z]|nvme|vd[a-z]|hd[a-z])/m],
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
