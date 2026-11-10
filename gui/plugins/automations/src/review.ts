import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  addReviewThread,
  listReviewedAt,
  listReviewRuns,
  listReviewThreads,
  type Db,
  type ReviewRunRow,
} from "./data.js";
import {
  reviewResponseSchema,
  type ReviewItem,
  type ReviewItemStatus,
  type ReviewResponse,
} from "./rpc-types.js";
import { errorMessage } from "./run.js";
import { listLiveProjects } from "./sweep.js";

export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60_000;
const REVIEW_LIMIT = 300;
const REPORT_MAX = 400;
const READ_BATCH = 16;
const STARTING_GRACE_MS = 30 * 60_000;
const CLOUD_RUN_TITLES = new Set(["Automation run", "Loop run"]);

const reviewThreadSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string().nullable(),
    titleFallback: z.string().nullable(),
    purpose: z.object({ text: z.string() }).passthrough().nullish(),
    status: z.string(),
    archivedAt: z.number().nullable(),
    deletedAt: z.number().nullable(),
    createdAt: z.number(),
    executionTarget: z.enum(["local", "cloud"]).optional(),
  })
  .passthrough();
type ReviewThread = z.infer<typeof reviewThreadSchema>;

type ReviewApi = Pick<BbPluginApi, "log"> & {
  sdk: {
    threads: Pick<BbPluginApi["sdk"]["threads"], "get">;
    cloudroom?: Pick<BbPluginApi["sdk"]["cloudroom"], "automations">;
    projects: {
      list(input: {
        includePersonal?: boolean;
        hidden?: boolean;
      }): Promise<unknown>;
    };
  };
};

function clip(text: string | null | undefined): string | null {
  const value = text?.trim();
  if (!value) return null;
  return value.length > REPORT_MAX
    ? `${value.slice(0, REPORT_MAX - 1)}…`
    : value;
}

function threadTitle(thread: ReviewThread): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

export function threadReviewStatus(
  thread: Pick<
    ReviewThread,
    "status" | "archivedAt" | "deletedAt" | "createdAt"
  >,
  now: number,
): ReviewItemStatus {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return "done";
  if (thread.status === "error") return "failed";
  if (thread.status === "active" || thread.status === "stopping")
    return "running";
  if (
    (thread.status === "starting" || thread.status === "pending") &&
    now - thread.createdAt < STARTING_GRACE_MS
  ) {
    return "running";
  }
  return "needs-you";
}

function runReviewStatus(run: ReviewRunRow): ReviewItemStatus {
  if (run.status === "running") return "running";
  return run.status === "failed" ? "failed" : "done";
}

function runTitle(run: ReviewRunRow): string {
  if (run.runMode === "agent")
    return run.status === "failed" ? "Agent run failed" : "Agent run";
  return run.status === "failed" ? "Script failed" : "Script output";
}

async function readThreads(
  bb: ReviewApi,
  threadIds: readonly string[],
): Promise<Map<string, ReviewThread | null>> {
  const threads = new Map<string, ReviewThread | null>();
  for (let start = 0; start < threadIds.length; start += READ_BATCH) {
    await Promise.all(
      threadIds.slice(start, start + READ_BATCH).map(async (threadId) => {
        try {
          threads.set(
            threadId,
            reviewThreadSchema.parse(await bb.sdk.threads.get({ threadId })),
          );
        } catch {
          threads.set(threadId, null);
        }
      }),
    );
  }
  return threads;
}

type SavedReport = { status: ReviewItemStatus; report: string | null };
const OUTCOME_STATUS = {
  done: "done",
  acted: "done",
  needs_you: "needs-you",
  failed: "failed",
} as const;
const LOCAL_RUN = /^arun_[A-Za-z0-9_-]{1,40}$/;
export const reportsSchema = z.object({
  reports: z.array(
    z.object({
      request: z.string(),
      thread_id: z.string(),
      outcome: z.enum(["done", "acted", "needs_you", "failed"]),
      reason: z.string().nullable(),
    }),
  ),
});

/** The runs' own reports (ADR 0298), the record `room-cli loop runs` shows: one per run, by Local run ID, or by the
 *  thread a Cloud run started (this app sends the website that run's request). Signed out, an older website, a slow
 *  one (over 3 s), or any unexpected row: none, so Review shows what the threads say. */
async function savedReports(
  bb: ReviewApi,
  runIds: readonly string[],
  cloudThreadIds: readonly string[],
): Promise<{
  runs: Map<string, SavedReport>;
  threads: Map<string, SavedReport>;
}> {
  const runs = new Map<string, SavedReport>();
  const threads = new Map<string, SavedReport>();
  const local = new Set(runIds.filter((id) => LOCAL_RUN.test(id)));
  if (!bb.sdk.cloudroom || local.size + cloudThreadIds.length === 0)
    return { runs, threads };
  try {
    const signal = AbortSignal.timeout(3_000);
    const late = new Promise<null>((resolve) =>
      signal.addEventListener("abort", () => resolve(null)),
    );
    const answer = await Promise.race([
      bb.sdk.cloudroom.automations({
        action: "reports",
        runs: [...local],
        threads: [...cloudThreadIds],
      }),
      late,
    ]);
    if (answer === null) return { runs, threads };
    const cloud = new Set(cloudThreadIds);
    for (const row of reportsSchema.parse(answer).reports) {
      const saved = {
        status: OUTCOME_STATUS[row.outcome],
        report: clip(row.reason),
      };
      if (local.has(row.request)) runs.set(row.request, saved);
      else if (cloud.has(row.thread_id)) threads.set(row.thread_id, saved);
    }
  } catch (error) {
    bb.log.warn(
      `Failed to read loop reports for review: ${errorMessage(error)}`,
    );
  }
  return { runs, threads };
}

/** A run's report wins over its thread's summary, except while the thread is still running. */
function withReport(
  item: SavedReport,
  saved: SavedReport | undefined,
): SavedReport {
  if (!saved) return item;
  return {
    status: item.status === "running" ? item.status : saved.status,
    report: saved.report ?? item.report,
  };
}

async function projectNames(bb: ReviewApi): Promise<Map<string, string>> {
  try {
    return new Map(
      (await listLiveProjects(bb)).map((project) => [
        project.id,
        project.name ?? project.id,
      ]),
    );
  } catch (error) {
    bb.log.warn(
      `Failed to list projects for loop review: ${errorMessage(error)}`,
    );
    return new Map();
  }
}

export async function buildReview(
  bb: ReviewApi,
  db: Db,
  now = Date.now(),
): Promise<ReviewResponse> {
  const since = now - REVIEW_WINDOW_MS;
  const spawned = listReviewThreads(db, { since, limit: REVIEW_LIMIT });
  const runsWithThreads = new Set(
    spawned.flatMap((row) => (row.runId ? [row.runId] : [])),
  );
  const runs = listReviewRuns(db, { since, limit: REVIEW_LIMIT }).filter(
    (run) =>
      run.runMode !== "script" ||
      run.status === "failed" ||
      (!runsWithThreads.has(run.id) && Boolean(run.output?.trim())),
  );
  const newest = [
    ...runs.map((run) => ({ at: run.startedAt, run, row: null })),
    ...spawned.map((row) => ({ at: row.createdAt, run: null, row })),
  ]
    .sort((left, right) => right.at - left.at)
    .slice(0, REVIEW_LIMIT);
  const threadIds = newest.flatMap(({ run, row }) =>
    row !== null ? [row.threadId] : run.threadId ? [run.threadId] : [],
  );
  const [threads, projects, reports] = await Promise.all([
    readThreads(bb, [...new Set(threadIds)]),
    projectNames(bb),
    savedReports(
      bb,
      newest.flatMap(({ run, row }) => run?.id ?? row?.runId ?? []),
      newest.flatMap(({ row }) => (row && !row.runId ? [row.threadId] : [])),
    ),
  ]);
  const reviewed = listReviewedAt(db);
  const projectName = (projectId: string) =>
    projects.get(projectId) ?? projectId;
  const items: ReviewItem[] = [];
  for (const { run, row } of newest) {
    if (row !== null) {
      const thread = threads.get(row.threadId);
      if (!thread || thread.deletedAt !== null) continue;
      items.push({
        id: `thread:${row.threadId}`,
        at: row.createdAt,
        loop: {
          id: row.automationId,
          name: row.loopName,
          projectId: thread.projectId,
          projectName: projectName(thread.projectId),
          cloud: row.automationId === null,
        },
        // A Cloud run's thread is its own; a Local run is found by its ID.
        ...withReport(
          {
            status: threadReviewStatus(thread, now),
            report: clip(thread.purpose?.text),
          },
          row.runId
            ? reports.runs.get(row.runId)
            : reports.threads.get(row.threadId),
        ),
        title: threadTitle(thread),
        threadId: thread.id,
        reviewedAt: reviewed.get(`thread:${row.threadId}`) ?? null,
      });
      continue;
    }
    const thread = run.threadId ? (threads.get(run.threadId) ?? null) : null;
    const own = thread !== null && run.targetThreadId === null;
    items.push({
      id: `run:${run.id}`,
      at: run.startedAt,
      loop: {
        id: run.automationId,
        name: run.name,
        projectId: run.projectId,
        projectName: projectName(run.projectId),
        cloud: false,
      },
      ...withReport(
        {
          status: own ? threadReviewStatus(thread, now) : runReviewStatus(run),
          report: own
            ? (clip(thread.purpose?.text) ?? clip(run.error))
            : clip([run.error, run.output?.trim()].filter(Boolean).join("\n")),
        },
        reports.runs.get(run.id),
      ),
      title: thread ? threadTitle(thread) : runTitle(run),
      threadId: run.threadId,
      reviewedAt: reviewed.get(`run:${run.id}`) ?? null,
    });
  }
  return reviewResponseSchema.parse({
    items,
    toReview: items.filter(
      (item) => item.reviewedAt === null && item.status !== "running",
    ).length,
  });
}

export function recordCloudRun(db: Db, raw: unknown): boolean {
  const parsed = reviewThreadSchema.safeParse(raw);
  if (!parsed.success) return false;
  const thread = parsed.data;
  if (
    thread.executionTarget !== "cloud" ||
    !CLOUD_RUN_TITLES.has(thread.titleFallback ?? "")
  ) {
    return false;
  }
  return addReviewThread(db, {
    threadId: thread.id,
    automationId: null,
    runId: null,
    loopName: thread.title?.split(" · ")[0]?.trim() || "Cloud loop",
    createdAt: thread.createdAt,
  });
}

export async function backfillCloudRuns(
  bb: { sdk: { threads: Pick<BbPluginApi["sdk"]["threads"], "list"> } },
  db: Db,
  now = Date.now(),
): Promise<void> {
  const pages = await Promise.all([
    bb.sdk.threads.list({ limit: 500 }),
    bb.sdk.threads.list({ archived: true, limit: 500 }),
  ]);
  for (const thread of pages.flat()) {
    if (thread.createdAt >= now - REVIEW_WINDOW_MS) recordCloudRun(db, thread);
  }
}
