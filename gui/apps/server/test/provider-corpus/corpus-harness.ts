import {
  createConnection,
  createProject,
  getLatestThreadSequence,
  getThread,
  migrate,
  noopNotifier,
  threads,
  upsertHost,
} from "@cloudroom/db";
import type { DbConnection } from "@cloudroom/db";
import { defaultFeatureFlags } from "@cloudroom/domain";
import type { Thread } from "@cloudroom/domain";
import type { ThreadTimelineResponse } from "@cloudroom/server-contract";
import type { CorpusThread } from "@cloudroom/test-helpers";
import { sql } from "drizzle-orm";
import {
  THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
  buildThreadTimelineWithProfile,
  type ThreadTimelineBuildProfile,
} from "../../src/services/threads/timeline.js";
import type { ThreadTimelinePageRequest } from "../../src/services/threads/timeline-pagination.js";
import { resolveProviderPlanCommand } from "../../src/services/providers/provider-plan-command.js";
import type { ProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { previewTimelineResponseOutputs } from "../../src/services/threads/timeline-output-preview.js";
import { clearStoredEventDecodeCache } from "../../src/services/threads/stored-event-decode-cache.js";
import { clearTimelineSelectionMemo } from "../../src/services/threads/timeline-selection-memo.js";
import {
  DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  truncateTimelineResponseOutputs,
} from "../../src/services/threads/timeline-output-truncation.js";

export const SNAPSHOT_MODE_ENV = "BB_PROVIDER_CORPUS_SNAPSHOT";

export type SnapshotMode = "write" | "compare";

export function resolveSnapshotMode(
  env: NodeJS.ProcessEnv = process.env,
): SnapshotMode {
  const value = env[SNAPSHOT_MODE_ENV];
  if (value === undefined || value === "" || value === "compare") {
    return "compare";
  }
  if (value === "write") {
    return "write";
  }
  throw new Error(
    `${SNAPSHOT_MODE_ENV} must be "write" or "compare" (got ${JSON.stringify(value)})`,
  );
}

export interface LoadedCorpusThread {
  db: DbConnection;
  thread: Thread;
  close(): void;
}

export function loadCorpusThreadIntoDb(
  corpusThread: CorpusThread,
  connection?: DbConnection,
): LoadedCorpusThread {
  const db = connection ?? createConnection(":memory:");
  if (connection === undefined) migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "provider-corpus-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "provider-corpus",
    source: { type: "local_path", hostId: host.id, path: "/provider-corpus" },
  });
  const row = corpusThread.thread;
  db.transaction(
    (tx) => {
      tx.insert(threads)
        .values({
          id: row.id,
          projectId: project.id,
          environmentId: null,
          providerId: row.providerId,
          modelOverride: row.modelOverride,
          reasoningLevelOverride: row.reasoningLevelOverride,
          title: row.title,
          titleFallback: null,
          sectionId: null,
          status: row.status,
          parentThreadId: null,
          sourceThreadId: null,
          originKind: row.originKind,
          originPluginId: null,
          visibility: row.visibility,
          archivedAt: row.archivedAt,
          pinnedAt: null,
          pinSortKey: null,
          deletedAt: row.deletedAt,
          lastReadAt: null,
          latestAttentionAt: row.updatedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        .run();
      for (const event of corpusThread.eventRows) {
        tx.run(
          sql`INSERT INTO events (id, thread_id, environment_id, scope_kind, turn_id, provider_thread_id, sequence, type, item_id, item_kind, parent_tool_call_id, data, created_at)
              VALUES (${event.id}, ${event.threadId}, ${null}, ${event.scopeKind}, ${event.turnId}, ${event.providerThreadId}, ${event.sequence}, ${event.type}, ${event.itemId}, ${event.itemKind}, ${event.parentToolCallId}, ${event.data}, ${event.createdAt})`,
        );
      }
    },
    { behavior: "immediate" },
  );
  const thread = getThread(db, row.id);
  if (!thread) {
    throw new Error(`Corpus thread ${row.id} did not load`);
  }
  return {
    db,
    thread,
    close: () => {
      db.$client.close();
    },
  };
}

export type TimelineVariant = "default" | "nested";

export const TIMELINE_VARIANTS: readonly TimelineVariant[] = [
  "default",
  "nested",
];

export interface BuiltTimelinePage {
  profile: ThreadTimelineBuildProfile;
  response: ThreadTimelineResponse;
}

export interface BuildRouteTimelinePageArgs {
  db: DbConnection;
  eventBudget?: number;
  includeDiagnosticOperations?: boolean;
  maxSeq?: number;
  page: ThreadTimelinePageRequest;
  registry: ProviderRegistryService;
  thread: Thread;
  variant: TimelineVariant;
}

export function buildRouteTimelinePage(
  args: BuildRouteTimelinePageArgs,
): BuiltTimelinePage {
  const includeNestedRows = args.variant === "nested";
  const { profile, response } = buildThreadTimelineWithProfile(
    args.db,
    args.thread,
    {
      completedTurnDisplay: "collapse",
      eventBudget:
        args.eventBudget ?? defaultFeatureFlags.timelineWindowEventBudget,
      includeDiagnosticOperations: args.includeDiagnosticOperations ?? true,
      includeNestedRows,
      maxInlineOutputChars: DEFAULT_MAX_INLINE_OUTPUT_CHARS,
      maxSeq:
        args.maxSeq ??
        getLatestThreadSequence(args.db, { threadId: args.thread.id }),
      page: args.page,
      providerDisplayName: args.registry.get(args.thread.providerId)?.info
        .displayName,
      planCommand: resolveProviderPlanCommand(
        args.registry,
        args.thread.providerId,
      ),
      summaryOnly: false,
    },
  );
  const truncated = truncateTimelineResponseOutputs(
    response,
    DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  );
  return {
    profile,
    response: includeNestedRows
      ? truncated
      : previewTimelineResponseOutputs(truncated),
  };
}

export function clearCrossBuildTimelineCaches(db: DbConnection): void {
  clearStoredEventDecodeCache(db);
  clearTimelineSelectionMemo(db);
}

export function selectionWasReused(
  profile: ThreadTimelineBuildProfile,
): boolean {
  const stages = new Set(profile.stageTimings.map((timing) => timing.stage));
  return (
    stages.has("selection-memo-lookup") &&
    !stages.has("group-context-query") &&
    !stages.has("ordering-context-query")
  );
}

export function latestTimelinePage(): ThreadTimelinePageRequest {
  return {
    kind: "latest",
    segmentLimit: THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
  };
}

export function buildAllRouteTimelinePages(
  args: Omit<BuildRouteTimelinePageArgs, "page">,
): BuiltTimelinePage[] {
  const pages: BuiltTimelinePage[] = [];
  const seenCursors = new Set<string>();
  let page = latestTimelinePage();
  for (;;) {
    const built = buildRouteTimelinePage({ ...args, page });
    pages.push(built);
    const { hasOlderRows, olderCursor } = built.response.timelinePage;
    if (!hasOlderRows || olderCursor === null) {
      return pages;
    }
    const cursorKey = `${olderCursor.anchorId}\0${olderCursor.anchorSeq}`;
    if (seenCursors.has(cursorKey)) {
      throw new Error(
        `Timeline pagination for ${args.thread.id} repeated cursor ${cursorKey}`,
      );
    }
    seenCursors.add(cursorKey);
    page = {
      kind: "older",
      segmentLimit: THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
      beforeCursor: olderCursor,
    };
  }
}

export function percentile(
  values: readonly number[],
  fraction: number,
): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("percentile index out of range");
  }
  return value;
}

export function formatMarkdownTable(
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(String).join(" | ")} |`),
  ];
  return lines.join("\n");
}
