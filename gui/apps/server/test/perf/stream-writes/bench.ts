// #1248: how many bytes SQLite writes while agents stream. Replays one fixed trace, on a fixed clock, through the
// real write paths against a disposable seeded database. Run it with run.sh; it is not part of the normal suite.
//
//   local: the real host-daemon event sink -> the real POST /internal/session/events route.
//   cloud: Codex-shaped Core records -> the real recordSaving and projectRecords, as the stream loop calls them.
//
// Bytes are exact, not sampled: every WAL frame SQLite writes, plus every page a checkpoint copies into the main
// file, at the app's setting of one checkpoint per 1000 frames. They do not depend on the machine or on timing.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { it, vi } from "vitest";

vi.mock("@cloudroom/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudroom/db")>();
  return {
    ...actual,
    // The test harness opens a migrated in-memory template. Open the disposable file instead, with the production
    // pragmas from createConnection. Nothing about the database is faked.
    createConnection: (...args: Parameters<typeof actual.createConnection>) =>
      Buffer.isBuffer(args[0]) && process.env.BENCH_DB
        ? actual.createConnection(process.env.BENCH_DB, args[1])
        : actual.createConnection(...args),
  };
});

import { cloudroomThreads } from "@cloudroom/db";
import { threadScope, turnScope, type ThreadEvent } from "@cloudroom/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@cloudroom/host-daemon-contract";
import { createEventSink } from "../../../../host-daemon/src/event-sink.js";
import type { SessionRecord } from "../../../src/services/cloudroom/client.js";
import * as cloudEvents from "../../../src/services/cloudroom/events.js";
import { internalAuthHeaders } from "../../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import { createTestAppHarness } from "../../helpers/test-app.js";

// This file also runs on commits from before the fix, to measure "before": there the stream loop let only streamed
// tokens wait, for 100 ms, and saved every other record alone.
const { isStreamDelta, projectRecords } = cloudEvents;
const before = cloudEvents as Partial<typeof cloudEvents>;
const STREAM_BATCH_MS = before.STREAM_BATCH_MS ?? 100;
const recordSaving =
  before.recordSaving ??
  ((record: SessionRecord) => (isStreamDelta(record) ? "wait" : "alone"));

const env = process.env;
const DB_PATH = env.BENCH_DB ?? "";
const SCENARIO = (env.BENCH_SCENARIO ?? "local") as "local" | "cloud";
const AGENTS = Number(env.BENCH_AGENTS ?? 1);
const SECONDS = Number(env.BENCH_SECONDS ?? 60);
const DELTA_HZ = Number(env.BENCH_DELTA_HZ ?? 30);
// Cloud only: how long records that can wait do wait. 0 is the old behavior, one commit per record.
const CLOUD_BATCH_MS = Number(env.BENCH_CLOUD_BATCH_MS ?? STREAM_BATCH_MS);
// Local only: how long a POST from the daemon takes on the fake clock. Events that arrive meanwhile go out in the
// next POST, straight after it.
const POST_MS = Number(env.BENCH_POST_MS ?? 5);
const AUTOCHECKPOINT_FRAMES = 1000;
const OUT = env.BENCH_OUT ?? "";
const LABEL = env.BENCH_LABEL ?? `${SCENARIO}-${AGENTS}`;

// ---------- the trace: fixed content at fixed times ----------

interface Step {
  at: number;
  agent: number;
  local: Omit<ThreadEvent, "threadId"> | null;
  cloud: { kind: string; data: Record<string, unknown>; native?: string } | null;
}

function buildTrace(agent: number): Step[] {
  let seed = 0x1248 + agent * 7919;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const int = (min: number, max: number) =>
    min + Math.floor(rand() * (max - min + 1));
  const vocabulary =
    "the a to of and in is for on that with this file test function returns error value update check build run code type state event query index thread turn".split(
      " ",
    );
  const words = (count: number) =>
    Array.from(
      { length: count },
      () => vocabulary[int(0, vocabulary.length - 1)],
    ).join(" ");
  const lines = (count: number) =>
    Array.from({ length: count }, () => words(int(4, 12))).join("\n");

  const steps: Step[] = [];
  const nativeId = `native-${agent}`;
  const end = SECONDS * 1000;
  // Agents start at different times, so their streams overlap like separate chats.
  let at = int(0, 1500);
  const native = (method: string, params: Record<string, unknown>) => {
    const item = params.item as Record<string, unknown> | undefined;
    return {
      kind:
        method === "item/agentMessage/delta"
          ? "text_delta"
          : method === "item/commandExecution/outputDelta"
            ? "tool_delta"
            : method === "item/started"
              ? "item_started"
              : method === "item/completed"
                ? "item_completed"
                : "native_event",
      data: {
        method,
        item_id: params.itemId ?? item?.id ?? null,
        delta: params.delta ?? null,
        text: item?.text ?? null,
      },
      native: JSON.stringify({ method, params }),
    };
  };
  const push = (
    local: Record<string, unknown> | null,
    cloud: Step["cloud"],
  ) => steps.push({ at, agent, local: local as Step["local"], cloud });
  // Core also forwards each line the harness writes to its own chat file. It carries no event, only the cursor.
  const chatFileLine = () =>
    push(null, { kind: "native_record", data: { offset: steps.length } });
  const item = (
    turnId: string,
    method: "item/started" | "item/completed",
    value: Record<string, unknown>,
    nativeValue: Record<string, unknown> = value,
  ) => {
    push(
      {
        type: method,
        scope: turnScope(turnId),
        providerThreadId: nativeId,
        item: value,
      },
      native(method, { threadId: nativeId, turnId, item: nativeValue }),
    );
    if (method === "item/completed") chatFileLine();
  };
  const stream = (
    turnId: string,
    itemId: string,
    type:
      | "item/agentMessage/delta"
      | "item/reasoning/summaryTextDelta"
      | "item/commandExecution/outputDelta",
    count: number,
    hz: number,
  ) => {
    let text = "";
    for (let index = 0; index < count && at < end; index += 1) {
      const piece =
        type === "item/commandExecution/outputDelta"
          ? `${lines(int(1, 4))}\n`
          : `${words(int(1, 3))} `;
      text += piece;
      push(
        {
          type,
          scope: turnScope(turnId),
          providerThreadId: nativeId,
          itemId,
          delta: piece,
        },
        native(type, { threadId: nativeId, turnId, itemId, delta: piece }),
      );
      at += 1000 / hz;
    }
    return text;
  };
  const message = (turnId: string, suffix: string) => {
    const id = `msg_${suffix}_${nativeId}`;
    item(turnId, "item/started", { type: "agentMessage", id, text: "" });
    const text = stream(
      turnId,
      id,
      "item/agentMessage/delta",
      int(40, 160),
      DELTA_HZ,
    );
    item(turnId, "item/completed", { type: "agentMessage", id, text });
  };

  for (let turn = 1; at < end; turn += 1) {
    const turnId = `turn-${nativeId}-${turn}`;
    const scope = turnScope(turnId);
    push(null, {
      kind: "state",
      data: { state: "starting_turn", request_id: turnId },
    });
    push(
      { type: "turn/started", scope, providerThreadId: nativeId },
      native("turn/started", {
        threadId: nativeId,
        turn: { id: turnId, items: [], status: "inProgress" },
      }),
    );
    const modelCalls = int(8, 14);
    for (let call = 0; call < modelCalls && at < end; call += 1) {
      // Every model call streams a reasoning summary first.
      const reasoningId = `rs_${turn}_${call}_${nativeId}`;
      const reasoning = {
        type: "reasoning",
        id: reasoningId,
        summary: [] as string[],
        content: [],
      };
      item(turnId, "item/started", reasoning);
      const summary = stream(
        turnId,
        reasoningId,
        "item/reasoning/summaryTextDelta",
        int(15, 60),
        DELTA_HZ,
      );
      item(turnId, "item/completed", { ...reasoning, summary: [summary] });

      const roll = rand();
      if (roll < 0.6) {
        const id = `call_${turn}_${call}_${nativeId}`;
        const command = `/bin/zsh -lc '${words(int(2, 6))}'`;
        const local = {
          type: "commandExecution",
          id,
          command,
          cwd: "/repo",
          approvalStatus: null,
        };
        const codex = {
          type: "commandExecution",
          id,
          command,
          cwd: "/repo",
          processId: null,
          commandActions: [],
        };
        item(
          turnId,
          "item/started",
          { ...local, status: "pending", aggregatedOutput: "" },
          {
            ...codex,
            status: "inProgress",
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        );
        at += int(200, 1500);
        const output =
          stream(
            turnId,
            id,
            "item/commandExecution/outputDelta",
            int(0, 12),
            10,
          ) + lines(int(20, 120));
        const done = {
          status: "completed",
          aggregatedOutput: output,
          exitCode: 0,
          durationMs: 900,
        };
        item(
          turnId,
          "item/completed",
          { ...local, ...done },
          { ...codex, ...done },
        );
      } else if (roll < 0.8) {
        const id = `patch_${turn}_${call}_${nativeId}`;
        const path = `src/${words(1)}/${words(1)}.ts`;
        const diff = `--- a/${path}\n+++ b/${path}\n${lines(int(10, 60))
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`;
        const local = (text: string, status: string) => ({
          type: "fileChange",
          id,
          changes: [{ path, kind: "update", diff: text }],
          status,
          approvalStatus: null,
        });
        const codex = (text: string, status: string) => ({
          type: "fileChange",
          id,
          changes: [
            { path, kind: { type: "update", move_path: null }, diff: text },
          ],
          status,
        });
        item(
          turnId,
          "item/started",
          local("", "pending"),
          codex("", "inProgress"),
        );
        at += int(100, 400);
        item(
          turnId,
          "item/completed",
          local(diff, "completed"),
          codex(diff, "completed"),
        );
        // Codex sends the whole turn diff again after every patch.
        push(
          {
            type: "turn/diff/updated",
            scope,
            providerThreadId: nativeId,
            diff: `${diff}\n${lines(int(10, 80))}`,
          },
          native("turn/diff/updated", { threadId: nativeId, turnId, diff }),
        );
      } else if (at < end) {
        message(turnId, `${turn}_${call}`);
      }
      // Codex reports token usage after every model call.
      const used = int(20_000, 200_000);
      const usage = {
        totalTokens: used,
        inputTokens: used - 900,
        cachedInputTokens: used - 5000,
        outputTokens: 900,
        reasoningOutputTokens: 300,
      };
      const tokenUsage = {
        total: usage,
        last: usage,
        modelContextWindow: 258_400,
      };
      push(
        {
          type: "thread/tokenUsage/updated",
          scope,
          providerThreadId: nativeId,
          tokenUsage,
        },
        native("thread/tokenUsage/updated", {
          threadId: nativeId,
          turnId,
          tokenUsage,
        }),
      );
      push(
        {
          type: "thread/contextWindowUsage/updated",
          scope: threadScope(),
          providerThreadId: nativeId,
          contextWindowUsage: {
            usedTokens: used,
            modelContextWindow: 258_400,
            estimated: false,
          },
        },
        null,
      );
      chatFileLine();
    }
    message(turnId, `${turn}_final`);
    push(
      {
        type: "turn/completed",
        scope,
        providerThreadId: nativeId,
        status: "completed",
      },
      native("turn/completed", {
        threadId: nativeId,
        turn: { id: turnId, items: [], status: "completed" },
      }),
    );
    push(null, { kind: "state", data: { state: "idle" } });
    at += int(300, 1200);
  }
  return steps;
}

// ---------- exact write accounting ----------

/** Counts the frames in the WAL, then checkpoints it, as SQLite's own autocheckpoint would. */
function createWriteMeter(
  client: ReturnType<typeof import("better-sqlite3")>,
  walPath: string,
) {
  const totals = {
    commits: 0,
    walFrames: 0,
    checkpointPages: 0,
    checkpoints: 0,
  };
  const framesByPage = new Map<number, number>();
  let pageSize = 4096;
  const harvest = () => {
    let wal: Buffer;
    try {
      wal = readFileSync(walPath);
    } catch {
      return;
    }
    if (wal.length < 32) return;
    pageSize = wal.readUInt32BE(8);
    const frameSize = 24 + pageSize;
    const unique = new Set<number>();
    for (let offset = 32; offset + frameSize <= wal.length; offset += frameSize) {
      const page = wal.readUInt32BE(offset);
      totals.walFrames += 1;
      // A commit frame records the database size; other frames record 0.
      if (wal.readUInt32BE(offset + 4) !== 0) totals.commits += 1;
      unique.add(page);
      framesByPage.set(page, (framesByPage.get(page) ?? 0) + 1);
    }
    totals.checkpointPages += unique.size;
    totals.checkpoints += 1;
    client.pragma("wal_checkpoint(TRUNCATE)");
  };
  return {
    totals,
    framesByPage,
    pageSize: () => pageSize,
    /** Call after every commit. */
    afterCommit() {
      let size = 0;
      try {
        size = statSync(walPath).size;
      } catch {
        return;
      }
      if (size >= 32 + AUTOCHECKPOINT_FRAMES * (24 + pageSize)) harvest();
    },
    finish: harvest,
  };
}

const procIo = () =>
  Object.fromEntries(
    readFileSync("/proc/self/io", "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(":");
        return [key!.trim(), Number(value)];
      }),
  ) as Record<string, number>;

// ---------- the run ----------

it(`measures SQLite writes for ${LABEL}`, async () => {
  if (!DB_PATH.startsWith("/tmp/stream-writes/"))
    throw new Error("BENCH_DB must be a disposable copy under /tmp/stream-writes/");
  const harness = await createTestAppHarness();
  const client = harness.db.$client;
  if (client.name !== DB_PATH)
    throw new Error(`harness opened ${client.name}, expected ${DB_PATH}`);
  const { host, session } = seedHostSession(harness.deps, { name: "bench" });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const threadIds = Array.from({ length: AGENTS }, (_, index) => {
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: SCENARIO === "local" ? environment.id : null,
      providerId: "codex",
      status: SCENARIO === "local" ? "idle" : "active",
    });
    if (SCENARIO === "cloud") {
      harness.db
        .insert(cloudroomThreads)
        .values({
          threadId: thread.id,
          coreUrl: "https://core.bench.invalid",
          startRequestId: `first_${thread.id}`,
          sessionId: `cr_bench_${index}`,
          model: "gpt-5.5",
          reasoning: "medium",
          cursor: 0,
          nativeId: `native-${index}`,
          turnId: null,
        })
        .run();
    }
    return thread.id;
  });

  const steps = Array.from({ length: AGENTS }, (_, agent) => buildTrace(agent))
    .flat()
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.at - b.step.at || a.index - b.index)
    .map(({ step }) => step);
  const side = (step: Step) => (SCENARIO === "local" ? step.local : step.cloud);
  const inputs = steps.filter((step) => side(step) !== null);
  const isDelta = (step: Step) =>
    SCENARIO === "local"
      ? /[dD]elta$/.test(step.local!.type)
      : isStreamDelta(step.cloud as SessionRecord);

  client.pragma("wal_autocheckpoint = 0");
  client.pragma("wal_checkpoint(TRUNCATE)");
  const meter = createWriteMeter(client, `${DB_PATH}-wal`);
  const failures: string[] = [];
  const io0 = procIo();

  if (SCENARIO === "cloud") {
    // The stream loop's rule (recordSaving): some records wait up to the batch window, a plain record is saved at
    // once together with them, and any other record saves them first.
    const sequences = threadIds.map(() => 0);
    const waiting = threadIds.map(() => [] as SessionRecord[]);
    const due = threadIds.map(() => Infinity);
    const save = (agent: number, records: SessionRecord[]) => {
      if (!records.length) return;
      try {
        projectRecords(harness.db, threadIds[agent]!, records);
      } catch (error) {
        failures.push(`${records[0]!.kind}: ${String(error)}`);
      }
      meter.afterCommit();
    };
    const saveDue = (now: number) => {
      for (;;) {
        const agent = due.indexOf(Math.min(...due));
        if (due[agent] === Infinity || due[agent]! > now) return;
        due[agent] = Infinity;
        save(agent, waiting[agent]!.splice(0));
      }
    };
    for (const step of inputs) {
      saveDue(step.at);
      const record = {
        ...step.cloud!,
        sequence: (sequences[step.agent]! += 1),
        session_id: `cr_bench_${step.agent}`,
        timestamp_ms: 1_800_000_000_000 + Math.round(step.at),
      } as SessionRecord;
      const saving = CLOUD_BATCH_MS > 0 ? recordSaving(record) : "alone";
      if (saving === "wait") {
        waiting[step.agent]!.push(record);
        if (due[step.agent] === Infinity)
          due[step.agent] = step.at + CLOUD_BATCH_MS;
        continue;
      }
      due[step.agent] = Infinity;
      if (saving === "now") {
        save(step.agent, [...waiting[step.agent]!.splice(0), record]);
      } else {
        save(step.agent, waiting[step.agent]!.splice(0));
        save(step.agent, [record]);
      }
    }
    saveDue(Infinity);
  } else {
    // The real sink on a fake clock. A POST takes POST_MS on that clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const headers = internalAuthHeaders(harness, { hostId: host.id });
    let posting = 0;
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: {
        debug() {},
        warn() {},
        error: (...args: unknown[]) =>
          failures.push(JSON.stringify(args).slice(0, 300)),
      },
      postEvents: async (events: HostDaemonEventEnvelope[]) => {
        if (POST_MS > 0)
          await new Promise((resolve) => setTimeout(resolve, POST_MS));
        posting += 1;
        try {
          const response = await harness.app.request(
            "/internal/session/events",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                sessionId: session.id,
                eventGroups: groupHostDaemonEvents(events),
              }),
            },
          );
          const body = await response.text();
          if (response.status !== 200)
            throw new Error(`POST ${response.status} ${body.slice(0, 300)}`);
          return JSON.parse(body);
        } finally {
          posting -= 1;
          meter.afterCommit();
        }
      },
    });
    const settle = async () => {
      do await new Promise((resolve) => setImmediate(resolve));
      while (posting > 0);
    };
    let now = 0;
    for (const step of inputs) {
      if (step.at > now) {
        await vi.advanceTimersByTimeAsync(step.at - now);
        await settle();
        now = step.at;
      }
      sink.emit({
        threadId: threadIds[step.agent]!,
        event: {
          ...step.local,
          threadId: threadIds[step.agent]!,
        } as ThreadEvent,
      });
    }
    await vi.advanceTimersByTimeAsync(1000);
    await sink.flush();
    await settle();
    meter.afterCommit();
    vi.useRealTimers();
  }
  meter.finish();
  const io1 = procIo();

  // What the app would show: each item's text and the order of turns and items. A finished item shows the text
  // of its `item/completed`, so pruning its streamed pieces changes nothing; an unfinished one shows its pieces.
  const rowsQuery = client.prepare(
    "SELECT type, item_id AS itemId, data FROM events WHERE thread_id = ? ORDER BY sequence",
  );
  let rowCount = 0;
  let deltaRows = 0;
  const shown = threadIds.map((threadId) => {
    const pieces = new Map<string, string>();
    const finished = new Set<string>();
    const order: string[] = [];
    for (const row of rowsQuery.all(threadId) as {
      type: string;
      itemId: string | null;
      data: string;
    }[]) {
      rowCount += 1;
      if (/[dD]elta$/.test(row.type)) {
        deltaRows += 1;
        const key = `${row.type}|${row.itemId}`;
        const data = JSON.parse(row.data) as { delta: string; reset?: boolean };
        pieces.set(key, (data.reset ? "" : (pieces.get(key) ?? "")) + data.delta);
      } else if (/^(item|turn)\/(started|completed)$/.test(row.type)) {
        const item = (JSON.parse(row.data) as { item?: unknown }).item;
        if (row.type === "item/completed" && row.itemId) finished.add(row.itemId);
        order.push(`${row.type}|${JSON.stringify(item ?? null)}`);
      }
    }
    const unfinished = [...pieces]
      .filter(([key]) => !finished.has(key.slice(key.indexOf("|") + 1)))
      .sort();
    return [order, unfinished];
  });
  const contentHash = createHash("sha256")
    .update(JSON.stringify(shown))
    .digest("hex")
    .slice(0, 16);
  // Every streamed piece the trace sent, per item. Cloud never prunes, so its stored pieces must add up to this.
  const sentHash = createHash("sha256");
  const storedHash = createHash("sha256");
  if (SCENARIO === "cloud") {
    const sent = new Map<string, string>();
    for (const step of inputs) {
      const data = step.cloud!.data as { method?: string; item_id?: string; delta?: string };
      if (!isStreamDelta(step.cloud as SessionRecord)) continue;
      const key = `${step.agent}|${data.method}|${data.item_id}`;
      sent.set(key, (sent.get(key) ?? "") + data.delta);
    }
    sentHash.update(JSON.stringify([...sent].sort()));
    const stored = new Map<string, string>();
    threadIds.forEach((threadId, agent) => {
      for (const row of rowsQuery.all(threadId) as { type: string; itemId: string; data: string }[]) {
        if (!/[dD]elta$/.test(row.type)) continue;
        // Stored item IDs carry the turn in front: "turn:item".
        const key = `${agent}|${row.type}|${row.itemId.slice(row.itemId.indexOf(":") + 1)}`;
        stored.set(key, (stored.get(key) ?? "") + (JSON.parse(row.data) as { delta: string }).delta);
      }
    });
    storedHash.update(JSON.stringify([...stored].sort()));
    if (sentHash.digest("hex") !== storedHash.digest("hex"))
      failures.push("stored streamed text differs from the text that was sent");
  }

  // Which b-tree each written page belongs to.
  const owner = new Map<number, string>();
  for (const row of client
    .prepare("SELECT pageno, name FROM dbstat")
    .iterate() as Iterable<{ pageno: number; name: string }>) {
    if (meter.framesByPage.has(row.pageno)) owner.set(row.pageno, row.name);
  }
  const pageSize = meter.pageSize();
  // auto_vacuum keeps pointer-map pages: page 2, then one every (pageSize / 5 + 1) pages.
  const pointerMapEvery = Math.floor(pageSize / 5) + 1;
  const framesByBtree: Record<string, number> = {};
  for (const [page, frames] of meter.framesByPage) {
    const name =
      owner.get(page) ??
      (page === 1
        ? "page 1"
        : (page - 2) % pointerMapEvery === 0
          ? "pointer map"
          : "freed or moved");
    framesByBtree[name] = (framesByBtree[name] ?? 0) + frames;
  }

  const { commits, walFrames, checkpointPages, checkpoints } = meter.totals;
  const walBytes = walFrames * (24 + pageSize);
  const checkpointBytes = checkpointPages * pageSize;
  const deltas = inputs.filter(isDelta).length;
  const result = {
    label: LABEL,
    scenario: SCENARIO,
    agents: AGENTS,
    seconds: SECONDS,
    deltaHz: DELTA_HZ,
    cloudBatchMs: SCENARIO === "cloud" ? CLOUD_BATCH_MS : null,
    inputs: inputs.length,
    deltas,
    rows: rowCount,
    deltaRows,
    commits,
    walBytes,
    checkpointBytes,
    checkpoints,
    bytes: walBytes + checkpointBytes,
    bytesPerInput: Math.round((walBytes + checkpointBytes) / inputs.length),
    kbPerSecond: Math.round((walBytes + checkpointBytes) / SECONDS / 1024),
    // Cross-check: every byte this process passed to a write call, which includes test-runner output.
    processWriteBytes: io1.wchar! - io0.wchar!,
    contentHash,
    framesByBtree: Object.fromEntries(
      Object.entries(framesByBtree).sort((a, b) => b[1] - a[1]),
    ),
    failures: failures.slice(0, 10),
    failureCount: failures.length,
  };
  if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  const { framesByBtree: _pages, failures: _failures, ...line } = result;
  console.log(`RESULT ${JSON.stringify(line)}`);
  await harness.cleanup();
  if (failures.length)
    throw new Error(`${failures.length} writes failed: ${failures[0]}`);
});
