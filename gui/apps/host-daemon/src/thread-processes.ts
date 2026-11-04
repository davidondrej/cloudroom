import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

export interface ProcessRow {
  pid: number;
  ppid: number;
  env: readonly string[];
  started: string;
  exe?: string;
}

export interface ProcessTable {
  list(): Promise<ProcessRow[]>;
  started(pids: readonly number[]): Promise<Map<number, string>>;
}

const THREAD_ID = /^thr_[a-z0-9]+$/u;
const INSTALLED_APP = /^(?:\/System|\/Users\/[^/]+)?\/Applications\/[^/]+\.app\//u;
const STOP_GRACE_MS = 3_000;
const PS_TIMEOUT_MS = 10_000;

/** Installed apps are never killed (the user's own Ollama, Python.app...). */
export function isInstalledApp(row: ProcessRow): boolean {
  return INSTALLED_APP.test(row.exe ?? "");
}

export function pickThreadProcesses(
  rows: readonly ProcessRow[],
  args: {
    threadId: string;
    serverUrl: string | undefined;
    selfPid: number;
    /** Also pick the thread's processes that still run under this daemon. */
    includeLive?: boolean;
  },
): ProcessRow[] {
  if (!THREAD_ID.test(args.threadId) || !args.serverUrl) return [];
  const tags = [
    `ROOM_THREAD_ID=${args.threadId}`,
    `ROOM_SERVER_URL=${args.serverUrl}`,
  ];
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestors = new Set<number>();
  for (
    let pid = args.selfPid;
    pid > 0 && !ancestors.has(pid);
    pid = byPid.get(pid)?.ppid ?? 0
  )
    ancestors.add(pid);
  const children = new Map<number, number[]>();
  for (const row of rows)
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const tree = new Set<number>();
  for (const pending = [args.selfPid]; pending.length > 0;) {
    const pid = pending.pop()!;
    if (tree.has(pid)) continue;
    tree.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return rows.filter(
    (row) =>
      tags.every((tag) => row.env.includes(tag)) &&
      (args.includeLive === true || !tree.has(row.pid)) &&
      !ancestors.has(row.pid) &&
      !isInstalledApp(row),
  );
}

async function linuxStat(pid: number | string) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], ppid: Number(fields[1]), started: fields[19]! };
}

const linux: ProcessTable = {
  async list() {
    const pids = (await readdir("/proc")).filter((name) => /^\d+$/u.test(name));
    const rows = await Promise.all(
      pids.map(async (pid): Promise<ProcessRow | null> => {
        try {
          const [stat, env] = await Promise.all([
            linuxStat(pid),
            readFile(`/proc/${pid}/environ`, "utf8"),
          ]);
          return {
            pid: Number(pid),
            ppid: stat.ppid,
            env: env.split("\0").filter(Boolean),
            started: stat.started,
          };
        } catch {
          return null;
        }
      }),
    );
    return rows.filter((row) => row !== null);
  },
  async started(pids) {
    const entries = await Promise.all(
      pids.map(async (pid) => {
        const stat = await linuxStat(pid).catch(() => null);
        return stat && stat.state !== "Z" ? [[pid, stat.started] as const] : [];
      }),
    );
    return new Map(entries.flat());
  },
};

async function ps(args: string[]): Promise<Map<number, string>> {
  const { stdout } = await promisify(execFile)("ps", ["-ww", ...args], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: PS_TIMEOUT_MS,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
  return new Map(
    stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+) (.*)$/u.exec(line);
      return match ? [[Number(match[1]), match[2]!] as const] : [];
    }),
  );
}

const LSTART = /^\s*(\d+) (\w{3} \w{3} [ \d]\d [\d:]{8} \d{4})\s+(.*)$/u;

export function macRows(
  details: ReadonlyMap<number, string>,
  commands: ReadonlyMap<number, string>,
  withEnv: ReadonlyMap<number, string>,
): ProcessRow[] {
  return [...details].flatMap(([pid, rest]) => {
    const match = LSTART.exec(rest);
    const command = commands.get(pid);
    const full = withEnv.get(pid);
    if (!match || command === undefined || !full?.startsWith(command))
      return [];
    return [
      {
        pid,
        ppid: Number(match[1]),
        env: full.slice(command.length).split(" ").filter(Boolean),
        started: match[2]!,
        exe: match[3]!.trim(),
      },
    ];
  });
}

const mac: ProcessTable = {
  async list() {
    const [details, commands, withEnv] = await Promise.all([
      ps(["-A", "-o", "pid=,ppid=,lstart=,comm="]),
      ps(["-A", "-o", "pid=,command="]),
      ps(["-A", "-E", "-o", "pid=,command="]),
    ]);
    return macRows(details, commands, withEnv);
  },
  async started(pids) {
    if (pids.length === 0) return new Map();
    const rows = await ps(["-o", "pid=,lstart=", "-p", pids.join(",")]);
    return new Map([...rows].map(([pid, started]) => [pid, started.trim()]));
  },
};

const TABLES: Partial<Record<NodeJS.Platform, ProcessTable>> = {
  linux,
  darwin: mac,
};

export const currentProcessTable = TABLES[process.platform];

/**
 * Stops a thread's processes. By default only what escaped its harness, with a
 * grace period. The memory guard passes `includeLive` and `graceMs: 0` to kill
 * everything the thread runs, at once.
 */
export async function stopThreadProcesses(
  threadId: string,
  serverUrl: string | undefined,
  table = TABLES[process.platform],
  options: { includeLive?: boolean; graceMs?: number } = {},
): Promise<number> {
  if (!table) return 0;
  const picked = pickThreadProcesses(await table.list(), {
    threadId,
    serverUrl,
    selfPid: process.pid,
    includeLive: options.includeLive,
  });
  if (picked.length === 0) return 0;
  const same = async () => {
    const now = await table.started(picked.map((row) => row.pid));
    return picked.filter((row) => now.get(row.pid) === row.started);
  };
  const signal = (rows: readonly ProcessRow[], name: NodeJS.Signals) =>
    rows.forEach((row) => {
      try {
        process.kill(row.pid, name);
      } catch {}
    });
  const stopping = await same();
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  if (graceMs <= 0) {
    signal(stopping, "SIGKILL");
    return stopping.length;
  }
  signal(stopping, "SIGTERM");
  for (
    const end = Date.now() + graceMs;
    Date.now() < end && (await same()).length > 0;
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  signal(await same(), "SIGKILL");
  return stopping.length;
}
