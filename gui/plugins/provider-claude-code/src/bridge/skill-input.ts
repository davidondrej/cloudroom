import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
};

async function projectRoots(cwd: string): Promise<Root[]> {
  const roots: Root[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    roots.push({
      path: join(dir, ".claude", "skills"),
      prefix: "",
      origin: "project",
    });
    if (await stat(join(dir, ".git")).catch(() => null)) return roots;
    if (dirname(dir) === dir) return roots.slice(0, 1);
  }
}

async function skillRoots(options: SdkSessionOptions): Promise<Root[]> {
  const env = options.env ?? process.env;
  const native = await resolveClaudeNativeRoots({
    cwd: options.cwd,
    homeDir: env.HOME ?? homedir(),
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
    });
  }
  for (const plugin of options.plugins ?? []) {
    roots.push({ path: join(plugin.path, "skills"), prefix: "" });
  }
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

function instructionBody(content: string, name: string): string {
  const normalized = content.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const lines = normalized.split("\n");
    const end = lines.indexOf("---", 1);
    if (end < 0) throw new Error(`Skill /${name} has invalid frontmatter`);
    const header = lines.slice(1, end).join("\n");
    if (NATIVE_FIELDS.test(header) || /^[\s]*[\[{]/u.test(header)) {
      throw new Error(
        `Skill /${name} uses native Claude settings. Run it through Claude's native skill invocation instead of a Cloudroom skill tag.`,
      );
    }
    body = lines
      .slice(end + 1)
      .join("\n")
      .trimStart();
  }
  if (NATIVE_BODY.test(body))
    throw new Error(
      `Skill /${name} requires native Claude expansion; use its native invocation instead of a Cloudroom skill tag.`,
    );
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
): Promise<{ file: string; body: string }> {
  if (!/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/u.test(skill.name))
    throw new Error(`Unsupported skill name: ${skill.name}`);
  const injected = new Set<string>();
  const native = new Set<string>();
  for (const root of roots) {
    if (root.origin !== undefined && root.origin !== skill.origin) continue;
    if (!skill.name.startsWith(root.prefix)) continue;
    const name = skill.name.slice(root.prefix.length);
    if (!/^[a-zA-Z0-9_-]+$/u.test(name)) continue;
    if (root.file && name !== (root.name ?? basename(dirname(root.path))))
      continue;
    const file = root.file ? root.path : join(root.path, name, "SKILL.md");
    try {
      (root.origin === undefined ? injected : native).add(await realpath(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // The skill picker keeps Cloudroom's injected copy over a same-named native skill.
  const candidates = injected.size ? injected : native;
  if (candidates.size !== 1)
    throw new Error(
      `Skill /${skill.name} is ${candidates.size ? "ambiguous" : "missing on this machine"}. Check its installation and select it again.`,
    );
  const file = [...candidates][0]!;
  return { file, body: instructionBody(await readSkill(file), skill.name) };
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
