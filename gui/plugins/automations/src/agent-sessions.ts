import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";

export const DAYS = 91;
const DAY_MS = 24 * 60 * 60_000;
const CACHE_MS = 10 * 60_000;

export const agentSessionsSchema = z
  .object({
    agents: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          sessions: z.number(),
          days: z.array(z.number()),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentSessions = z.output<typeof agentSessionsSchema>;

const home = homedir();
const env = (name: string, fallback: string) =>
  process.env[name]?.trim() || fallback;

async function files(
  root: string,
  keep: (name: string) => boolean,
  startOf?: (name: string) => number | null,
): Promise<number[]> {
  const names = await readdir(root, { recursive: true }).catch(
    () => [] as string[],
  );
  const times = await Promise.all(
    names
      .filter((name) => keep(basename(name)))
      .map(async (name) => {
        const fromName = startOf?.(basename(name));
        if (fromName) return fromName;
        const info = await stat(join(root, name)).catch(() => null);
        return info ? info.birthtimeMs || info.mtimeMs : null;
      }),
  );
  return times.filter((time): time is number => time !== null);
}

async function sqlite(path: string, sql: string): Promise<number[]> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return (db.prepare(sql).all() as { at: number | null }[]).flatMap(
        ({ at }) => (at ? [at < 1e11 ? at * 1000 : at] : []),
      );
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

const codexStart = (name: string) => {
  const match = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(
    name,
  );
  return match
    ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`) || null
    : null;
};

const SOURCES: { id: string; name: string; times: () => Promise<number[]> }[] =
  [
    {
      id: "claude-code",
      name: "Claude Code",
      times: () =>
        files(
          join(env("CLAUDE_CONFIG_DIR", join(home, ".claude")), "projects"),
          (name) => name.endsWith(".jsonl") && !name.startsWith("agent-"),
        ),
    },
    {
      id: "codex",
      name: "Codex",
      times: async () => {
        const root = env("CODEX_HOME", join(home, ".codex"));
        const keep = (name: string) =>
          name.startsWith("rollout-") && name.endsWith(".jsonl");
        return [
          ...(await files(join(root, "sessions"), keep, codexStart)),
          ...(await files(join(root, "archived_sessions"), keep, codexStart)),
        ];
      },
    },
    {
      id: "pi",
      name: "Pi",
      times: () =>
        files(
          join(
            env("PI_CODING_AGENT_DIR", join(home, ".pi", "agent")),
            "sessions",
          ),
          (name) => name.endsWith(".jsonl"),
        ),
    },
    {
      id: "acp-opencode",
      name: "OpenCode",
      times: () =>
        sqlite(
          join(home, ".local", "share", "opencode", "opencode.db"),
          "SELECT time_created AS at FROM session WHERE parent_id IS NULL",
        ),
    },
    {
      id: "acp-hermes-agent",
      name: "Hermes",
      times: () =>
        sqlite(
          join(env("HERMES_HOME", join(home, ".hermes")), "state.db"),
          "SELECT MIN(m.timestamp) AS at FROM sessions s JOIN messages m ON m.session_id = s.id WHERE s.source NOT IN ('acp', 'cron', 'subagent', 'delegate') GROUP BY s.id",
        ),
    },
  ];

let cached: { at: number; value: AgentSessions } | null = null;

export async function agentSessions(now = Date.now()): Promise<AgentSessions> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const first = today.getTime() - (DAYS - 1) * DAY_MS;
  const agents = (
    await Promise.all(
      SOURCES.map(async (source) => {
        const times = await source.times().catch(() => []);
        const days = Array.from({ length: DAYS }, () => 0);
        for (const time of times) {
          const index = Math.floor((time - first) / DAY_MS);
          if (index >= 0 && index < DAYS) days[index] += 1;
        }
        return {
          id: source.id,
          name: source.name,
          sessions: times.length,
          days,
        };
      }),
    )
  )
    .filter((agent) => agent.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions);
  cached = { at: now, value: { agents } };
  return cached.value;
}
