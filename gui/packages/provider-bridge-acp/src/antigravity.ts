import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOOK_NAME = "cloudroom-timers";
const DENY = JSON.stringify({
  decision: "deny",
  reason:
    "Cloudroom cannot see this timer, so your reply would get lost. Run the shell command room-cli wake WHEN PROMPT instead, with a delay like 30s, 5m, 2h, or a time. For recurring work, use room-cli loop.",
});
// agy has no switch for its own `schedule` tool, only hooks, and its hooks file is shared with the Antigravity app.
// So the hook denies only where Cloudroom's thread ID is set, and allows everywhere else.
const HOOK = {
  PreToolUse: [
    {
      matcher: "schedule",
      hooks: [
        {
          type: "command",
          command: `if [ -n "$ROOM_THREAD_ID" ]; then echo '${DENY}'; else echo '{"decision":"allow"}'; fi`,
        },
      ],
    },
  ],
};

type Json = Record<string, unknown>;

/**
 * Rewrites one JSON object file in agy's global config folder. `update` returns the new object, or null to leave the
 * file as it is. Never throws: a file that isn't a JSON object stays untouched.
 */
async function updateAgyConfig(
  env: Record<string, string | undefined>,
  file: string,
  update: (config: Json, home: string) => Promise<Json | null>,
): Promise<void> {
  const home = env.HOME || homedir();
  const path = join(home, ".gemini", "config", file);
  try {
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
      throw error;
    });
    const config: unknown = JSON.parse(text);
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return;
    }
    const next = await update(config as Json, home);
    if (next === null) return;
    await mkdir(dirname(path), { recursive: true });
    // Several threads can start at once: a rename never leaves a half-written file.
    const draft = `${path}.${process.pid}.tmp`;
    await writeFile(draft, `${JSON.stringify(next, null, 2)}\n`);
    await rename(draft, path);
  } catch {
    // The agent still runs without it.
  }
}

/**
 * Blocks agy's `schedule` tool in Cloudroom threads. A timer it sets fires outside a turn, so the reply never reaches
 * the chat; `room-cli wake` replaces it. Adds one entry to agy's global hooks file and keeps everything else in it.
 * Without the hook the agent still has the system prompt's rule.
 */
export async function blockAntigravitySchedule(
  _command: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  // The hook is a POSIX shell line.
  if (process.platform === "win32") return;
  await updateAgyConfig(env, "hooks.json", async (hooks) => {
    const own = hooks[HOOK_NAME] as { enabled?: unknown } | undefined;
    // Someone who turned it off in agy's /hooks keeps it off.
    if (own?.enabled === false) return null;
    if (JSON.stringify(own) === JSON.stringify(HOOK)) return null;
    return { ...hooks, [HOOK_NAME]: HOOK };
  });
}

// agy reads personal skills only from ~/.gemini/config/skills, so the usual folders go in its global skills.json.
const SKILL_FOLDERS = [".agents/skills", ".claude/skills"];

/**
 * Lists ~/.agents/skills and ~/.claude/skills in agy's global skills.json, so it loads and runs them like its own,
 * `/name` included. Paths are absolute: agy ignores `~` there. A missing folder, or a second path to a listed one, is
 * skipped; a listed folder stays as the user set it (an `exclude` on it turns its skills off).
 */
export async function addAntigravitySkillFolders(
  _command: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const real = (folder: string) => realpath(folder).catch(() => null);
  await updateAgyConfig(env, "skills.json", async (config, home) => {
    const entries = config.entries ?? [];
    if (!Array.isArray(entries)) return null;
    const listed = new Set<string>();
    for (const entry of entries as { path?: unknown }[]) {
      if (typeof entry?.path !== "string") continue;
      listed.add((await real(entry.path)) ?? entry.path);
    }
    const added: { path: string }[] = [];
    for (const folder of SKILL_FOLDERS.map((name) => join(home, name))) {
      const target = await real(folder);
      if (target === null || listed.has(target)) continue;
      listed.add(target);
      added.push({ path: folder });
    }
    return added.length === 0 ? null : { ...config, entries: [...entries, ...added] };
  });
}

/** Runs before every `agy acp` launch. */
export async function prepareAntigravityLaunch(
  command: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  await blockAntigravitySchedule(command, env);
  await addAntigravitySkillFolders(command, env);
}
