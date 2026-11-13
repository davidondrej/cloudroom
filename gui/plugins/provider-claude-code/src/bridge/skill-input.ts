import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { resolveClaudeNativeRoots } from "../native-roots.js";
import type { SdkSessionOptions } from "./sdk-session.js";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const NATIVE_FIELDS =
  /(?:^|\n)\s*["']?(?:allowed-tools|disallowed-tools|model|effort|context|agent|background|hooks|shell|arguments|user-invocable)["']?\s*:/u;
const NATIVE_BODY = /!`|\$\{CLAUDE_/u;

type Skill = { name: string; origin: "user" | "project" | "builtin" };
type Root = {
  path: string;
  prefix: string;
  origin?: Skill["origin"];
  file?: boolean;
  name?: string;
  spare?: boolean;
  /** How errors name the root. Failed-turn telemetry exports them, so never a path outside home. */
  label: string;
};

const posix = (path: string) => path.replaceAll("\\", "/");

function homeLabel(path: string, home: string): string {
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel)
    ? `~/${posix(rel)}`
    : "a folder outside your home folder";
}

async function projectRoots(cwd: string): Promise<Root[]> {
  const roots: Root[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const path = join(dir, ".claude", "skills");
    roots.push({
      path,
      prefix: "",
      origin: "project",
      label: `the project's ${posix(relative(resolve(cwd), path))}`,
    });
    if (await stat(join(dir, ".git")).catch(() => null)) return roots;
    if (dirname(dir) === dir) return roots.slice(0, 1);
  }
}

async function skillRoots(options: SdkSessionOptions): Promise<Root[]> {
  const env = options.env ?? process.env;
  const home = env.HOME ?? homedir();
  const native = await resolveClaudeNativeRoots({
    cwd: options.cwd,
    homeDir: home,
    env,
  });
  const roots: Root[] = await projectRoots(options.cwd);
  for (const root of native.skills) {
    if (root.shape === "commands" || root.shape === "command-file") continue;
    roots.push({
      path: root.shape === "skill" ? join(root.path, "SKILL.md") : root.path,
      prefix: root.namePrefix ?? "",
      origin: root.origin,
      file: root.shape === "skill" || root.shape === "skill-file",
      name: root.fallbackName,
      label: homeLabel(root.path, home),
    });
  }
  for (const plugin of options.plugins ?? []) {
    const path = join(plugin.path, "skills");
    roots.push({ path, prefix: "", label: homeLabel(path, home) });
  }
  // The picker always lists ~/.claude/skills, even when CLAUDE_CONFIG_DIR (an account folder) lacks them.
  roots.push({
    path: join(home, ".claude", "skills"),
    prefix: "",
    origin: "user",
    spare: true,
    label: "~/.claude/skills",
  });
  return roots;
}

async function readSkill(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_INPUT_BYTES)
      throw new Error(
        "Skill is not a regular file within the Claude input limit",
      );
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_INPUT_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size)
      throw new Error("Skill changed while reading; retry the message");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    await handle.close();
  }
}

/** The skill's instructions, or null when only Claude Code can run it (tool, model, hook or shell settings). */
function instructionBody(content: string, name: string): string | null {
  const normalized = content.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const lines = normalized.split("\n");
    const end = lines.indexOf("---", 1);
    if (end < 0) throw new Error(`Skill /${name} has invalid frontmatter`);
    const header = lines.slice(1, end).join("\n");
    if (NATIVE_FIELDS.test(header) || /^[\s]*[\[{]/u.test(header)) return null;
    body = lines
      .slice(end + 1)
      .join("\n")
      .trimStart();
  }
  if (NATIVE_BODY.test(body)) return null;
  if (!body.trim()) throw new Error(`Skill /${name} is empty`);
  return body;
}

function withArguments(body: string, args: string): string {
  const words = [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  );
  return body.replace(
    /\$ARGUMENTS(?:\[(\d+)\]|\b)/gu,
    (_, index?: string) =>
      index === undefined ? args : (words[Number(index)] ?? ""),
  );
}

async function loadSkill(
  skill: Skill,
  roots: readonly Root[],
): Promise<{ file: string; body: string | null; native: boolean }> {
  if (!/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/u.test(skill.name))
    throw new Error(`Unsupported skill name: ${skill.name}`);
  // Each match's real file, and the label of the root it was found in.
  const injected = new Map<string, string>();
  const native = new Map<string, string>();
  const spare = new Map<string, string>();
  const checked = new Set<string>();
  for (const root of roots) {
    if (root.origin !== undefined && root.origin !== skill.origin) continue;
    if (!skill.name.startsWith(root.prefix)) continue;
    const name = skill.name.slice(root.prefix.length);
    if (!/^[a-zA-Z0-9_-]+$/u.test(name)) continue;
    if (root.file && name !== (root.name ?? basename(dirname(root.path))))
      continue;
    const file = root.file ? root.path : join(root.path, name, "SKILL.md");
    checked.add(root.label);
    try {
      (root.origin === undefined ? injected : root.spare ? spare : native).set(
        await realpath(file),
        root.label,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // The skill picker keeps Cloudroom's injected copy over a same-named native skill.
  const candidates = injected.size ? injected : native.size ? native : spare;
  if (candidates.size !== 1)
    throw new Error(
      `Skill /${skill.name} (${skill.origin}) is ${candidates.size ? `ambiguous, in ${[...new Set(candidates.values())].join(", ")}` : `missing on this machine. Checked: ${[...checked].join(", ") || "no folders"}`}. Check its installation and select it again.`,
    );
  const file = [...candidates.keys()][0]!;
  const body = instructionBody(await readSkill(file), skill.name);
  // Claude Code reads only $CLAUDE_CONFIG_DIR/skills, so it cannot run a settings skill found only in ~/.claude/skills.
  if (body === null && candidates === spare)
    throw new Error(
      `Skill /${skill.name} is in ~/.claude/skills but not in this Claude account's skills folder ($CLAUDE_CONFIG_DIR/skills). Link the account's skills folder to ~/.claude/skills, or select the skill again.`,
    );
  return { file, body, native: !injected.size };
}

export async function expandClaudeSkillInput(
  input: readonly PromptInput[],
  options: SdkSessionOptions,
): Promise<PromptInput[]> {
  const selected = input.flatMap((part) =>
    part.type === "text"
      ? part.mentions.filter(
          (mention) =>
            mention.resource.kind === "command" &&
            mention.resource.source === "skill",
        )
      : [],
  );
  if (selected.length === 0) return [...input];
  const roots = await skillRoots(options);
  const loaded = new Map<string, string>();
  const resolved = new Map<string, Awaited<ReturnType<typeof loadSkill>>>();
  // A leading skill with Claude Code settings goes to Claude Code as typed, so it runs with them.
  const [first] = input;
  const lead =
    first?.type === "text"
      ? first.mentions.find(({ start }) => start === 0)?.resource
      : undefined;
  if (
    lead?.kind === "command" &&
    lead.source === "skill" &&
    first?.type === "text" &&
    first.text.startsWith(`/${lead.name}`)
  ) {
    const skill = await loadSkill(lead, roots);
    if (skill.body === null && skill.native)
      return input.map((part) =>
        part.type === "text" ? { ...part, mentions: [] } : part,
      );
    resolved.set(`${lead.origin}:${lead.name}`, skill);
  }
  let remaining = MAX_INPUT_BYTES - Buffer.byteLength(JSON.stringify(input));
  const output: PromptInput[] = [];
  for (const part of input) {
    if (part.type !== "text") {
      output.push(part);
      continue;
    }
    let text = "";
    let cursor = 0;
    const mentions = part.mentions
      .filter(
        ({ resource }) =>
          resource.kind === "command" && resource.source === "skill",
      )
      .sort((a, b) => a.start - b.start);
    for (const [index, mention] of mentions.entries()) {
      const skill = mention.resource;
      if (skill.kind !== "command" || skill.source !== "skill") continue;
      if (
        mention.start < cursor ||
        mention.end <= mention.start ||
        mention.end > part.text.length ||
        part.text.slice(mention.start, mention.end) !== `/${skill.name}`
      )
        throw new Error(
          "Invalid selected skill tag; remove it and select the skill again",
        );
      const key = `${skill.origin}:${skill.name}`;
      if (!resolved.has(key)) resolved.set(key, await loadSkill(skill, roots));
      const { file, body } = resolved.get(key)!;
      if (body === null)
        throw new Error(
          `/${skill.name} uses Claude Code settings, so it only runs when /${skill.name} starts your message.`,
        );
      if (!loaded.has(file)) {
        const args = part.text
          .slice(mention.end, mentions[index + 1]?.start)
          .trim();
        const block = `Skill: /${skill.name}\nBase directory: ${dirname(file)}\n\n${withArguments(body, args)}`;
        remaining -= Buffer.byteLength(block);
        if (remaining < 0)
          throw new Error(
            "Selected skills exceed the Claude input limit; select fewer skills",
          );
        loaded.set(file, block);
      }
      text += part.text.slice(cursor, mention.start) + skill.name;
      cursor = mention.end;
    }
    output.push({
      ...part,
      text: text + part.text.slice(cursor),
      mentions: [],
    });
  }
  output.unshift({
    type: "text",
    text: `The user explicitly selected these skills. Their instructions are already loaded below; do not invoke them again with the Skill tool. Resolve relative paths from each skill's base directory.\n\n${[...loaded.values()].join("\n\n")}\n\nUser request:`,
    mentions: [],
    visibility: "agent-only",
  });
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_INPUT_BYTES)
    throw new Error(
      "Selected skills exceed the Claude input limit; select fewer skills",
    );
  return output;
}
