import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { HostDaemonLogger } from "./logger.js";
import {
  currentProcessTable,
  isInstalledApp,
  stopThreadProcesses,
  type ProcessRow,
  type ProcessTable,
} from "./thread-processes.js";

/**
 * Kills a Local thread whose processes eat the Mac's memory.
 *
 * macOS has no out-of-memory killer. A runaway agent command fills the memory
 * compressor and the whole machine freezes until the kernel watchdog restarts
 * it (2026-11-02: one thread's `git grep` reached 667 GB on a 128 GB Mac).
 * Every 5 s a cheap `vm_stat` read checks how much memory sits compressed. Only
 * when that passes half of RAM does `top` measure real footprints (it counts
 * compressed memory, `ps` does not). A thread using over half of RAM is told
 * to the server, which stops it like the Stop button, then killed outright.
 */

const CHECK_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;
const REPORT_TIMEOUT_MS = 2_000;
const REPORT_RETRY_FOR_MS = 10 * 60_000;
const REPEAT_KILL_AFTER_MS = 60_000;
const THREAD_ID_TAG = /^ROOM_THREAD_ID=(thr_[a-z0-9]+)$/u;
const TOP_ROW = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])[+-]?\s*$/u;
const UNIT = { B: 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 } as const;

export function parseCompressedBytes(vmStat: string): number | null {
  const pageSize = /page size of (\d+) bytes/u.exec(vmStat);
  const stored = /Pages stored in compressor:\s+(\d+)/u.exec(vmStat);
  return pageSize && stored ? Number(pageSize[1]) * Number(stored[1]) : null;
}

/** Footprint per PID from `top -l 1 -stats pid,mem` ("862M", "12G+"). */
export function parseTopFootprints(top: string): Map<number, number> {
  const footprints = new Map<number, number>();
  for (const line of top.split("\n")) {
    const match = TOP_ROW.exec(line);
    if (match) {
      const unit = UNIT[match[3] as keyof typeof UNIT];
      footprints.set(Number(match[1]), Number(match[2]) * unit);
    }
  }
  return footprints;
}

/**
 * The thread whose killable processes use the most memory over the limit.
 * Installed apps are never killed, so they never count, and threads in
 * `skipThreadIds` (just killed) never hide another offender.
 */
export function threadOverLimit(args: {
  rows: readonly ProcessRow[];
  footprints: ReadonlyMap<number, number>;
  serverUrl: string;
  limitBytes: number;
  skipThreadIds?: ReadonlySet<string>;
}): { threadId: string; usedBytes: number } | null {
  const serverTag = `ROOM_SERVER_URL=${args.serverUrl}`;
  const used = new Map<string, number>();
  for (const row of args.rows) {
    if (!row.env.includes(serverTag) || isInstalledApp(row)) continue;
    const threadId = row.env
      .map((entry) => THREAD_ID_TAG.exec(entry)?.[1])
      .find((id) => id !== undefined);
    if (threadId === undefined || args.skipThreadIds?.has(threadId)) continue;
    const bytes = args.footprints.get(row.pid) ?? 0;
    used.set(threadId, (used.get(threadId) ?? 0) + bytes);
  }
  let worst: { threadId: string; usedBytes: number } | null = null;
  for (const [threadId, usedBytes] of used) {
    if (usedBytes > args.limitBytes && usedBytes > (worst?.usedBytes ?? 0)) {
      worst = { threadId, usedBytes };
    }
  }
  return worst;
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(command, args, {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: PROBE_TIMEOUT_MS,
  });
  return stdout;
}

/** Rejects when `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface MemoryGuardOptions {
  logger: Pick<HostDaemonLogger, "warn">;
  serverUrl: () => string | undefined;
  reportThread: (args: {
    threadId: string;
    usedBytes: number;
    totalBytes: number;
  }) => Promise<unknown>;
}

export function startMemoryGuard(options: MemoryGuardOptions): {
  stop(): void;
} {
  const table: ProcessTable | undefined = currentProcessTable;
  if (process.platform !== "darwin" || !table) return { stop() {} };
  const processes: ProcessTable = table;
  const totalBytes = os.totalmem();
  // Test-only: a small limit, checked on every tick, so a 3 GB script trips it.
  const testLimitMb = Number(process.env.ROOM_MEMORY_GUARD_TEST_LIMIT_MB);
  const testing = Number.isFinite(testLimitMb) && testLimitMb > 0;
  const limitBytes = testing ? testLimitMb * 2 ** 20 : totalBytes / 2;
  const killedAt = new Map<string, number>();
  // Reports the server has not accepted yet. A kill never waits for one, and
  // each tick resends them, so a busy server still learns why the thread
  // stopped and never auto-resumes it.
  const unreported = new Map<string, { usedBytes: number; since: number }>();
  let checking = false;

  async function sendReport(threadId: string): Promise<void> {
    const report = unreported.get(threadId);
    if (!report) return;
    if (Date.now() - report.since > REPORT_RETRY_FOR_MS) {
      unreported.delete(threadId);
      options.logger.warn(
        { threadId },
        "Gave up reporting a thread stopped for memory",
      );
      return;
    }
    try {
      await withTimeout(
        options.reportThread({
          threadId,
          usedBytes: report.usedBytes,
          totalBytes,
        }),
        REPORT_TIMEOUT_MS,
      );
      unreported.delete(threadId);
    } catch (error) {
      options.logger.warn(
        { err: error, threadId },
        "Could not report a thread stopped for memory; will retry",
      );
    }
  }

  async function check(): Promise<void> {
    for (const threadId of [...unreported.keys()]) await sendReport(threadId);
    if (!testing) {
      const compressed = parseCompressedBytes(await run("vm_stat", []));
      if (compressed === null || compressed <= totalBytes / 2) return;
    }
    const serverUrl = options.serverUrl();
    if (!serverUrl) return;
    const [rows, top] = await Promise.all([
      processes.list(),
      run("top", ["-l", "1", "-stats", "pid,mem"]),
    ]);
    const now = Date.now();
    const hit = threadOverLimit({
      rows,
      footprints: parseTopFootprints(top),
      serverUrl,
      limitBytes,
      skipThreadIds: new Set(
        [...killedAt].flatMap(([threadId, at]) =>
          now - at < REPEAT_KILL_AFTER_MS ? [threadId] : [],
        ),
      ),
    });
    if (!hit) return;
    killedAt.set(hit.threadId, now);
    options.logger.warn(
      { ...hit, totalBytes, limitBytes },
      "Stopping a thread that is using too much memory",
    );
    // Tell the server first, so it records a stop instead of a failure.
    unreported.set(hit.threadId, { usedBytes: hit.usedBytes, since: now });
    await sendReport(hit.threadId);
    await stopThreadProcesses(hit.threadId, serverUrl, processes, {
      includeLive: true,
      graceMs: 0,
    });
  }

  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    check()
      .catch((error: unknown) => {
        options.logger.warn({ err: error }, "Memory guard check failed");
      })
      .finally(() => {
        checking = false;
      });
  }, CHECK_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
