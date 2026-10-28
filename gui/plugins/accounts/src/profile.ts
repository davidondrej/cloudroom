import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Chat history, session state, and the user's own setup are shared. Logins and account caches are not.
const SHARED = [
  "projects",
  "file-history",
  "todos",
  "plans",
  "agent-memory",
  "settings.json",
  "CLAUDE.md",
  "skills",
  "agents",
  "commands",
  "output-styles",
  "hooks",
  "plugins",
  "rules",
  "keybindings.json",
];
const SESSION_DIRS = ["projects", "file-history", "todos", "plans"];
const SHARED_CONFIG = ["mcpServers", "projects"];

const claudeHome = () =>
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const claudeConfig = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
const synced = new Map<string, number>();

export async function prepareProfile(profile: string): Promise<void> {
  const home = claudeHome();
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await Promise.all(
    SESSION_DIRS.map((name) =>
      fs.mkdir(path.join(home, name), { recursive: true }),
    ),
  );
  await Promise.all(
    SHARED.map(async (name) => {
      const target = path.join(home, name);
      if (!(await fs.lstat(target).catch(() => null))) return;
      await fs
        .symlink(target, path.join(profile, name))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
    }),
  );
  const changed = (await fs.stat(claudeConfig()).catch(() => null))?.mtimeMs;
  if (changed === undefined || synced.get(profile) === changed) return;
  const main = JSON.parse(await fs.readFile(claudeConfig(), "utf8")) as Record<
    string,
    unknown
  >;
  const file = path.join(profile, ".claude.json");
  const own = JSON.parse(
    await fs.readFile(file, "utf8").catch(() => "{}"),
  ) as Record<string, unknown>;
  const next = { ...own };
  for (const key of SHARED_CONFIG)
    if (main[key] === undefined) delete next[key];
    else next[key] = main[key];
  if (JSON.stringify(next) !== JSON.stringify(own)) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  }
  synced.set(profile, changed);
}
