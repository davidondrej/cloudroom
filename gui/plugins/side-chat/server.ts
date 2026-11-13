import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const REPLY_SEED_PREFIX =
  "Replying to this earlier message in the conversation:\n\n";

export const EMPTY_FORK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const EMPTY_FORK_SWEEP_PAGE_SIZE = 100;

const KEPT_FORK_KEY_PREFIX = "kept-fork:";

export interface SideChatTimelineRowLike {
  kind: string;
  text?: string;
  role?: string;
  children?: readonly SideChatTimelineRowLike[] | null;
}

export function resolveReplySeedText(anchorText: string): string | null {
  const anchor = anchorText.trim();
  return anchor.length > 0 ? anchor : null;
}

export function timelineRowsContainUserMessage(
  rows: readonly SideChatTimelineRowLike[],
): boolean {
  const visit = (row: SideChatTimelineRowLike): boolean => {
    if (row.kind === "conversation") {
      return row.role === "user";
    }
    return row.kind === "turn" && row.children != null
      ? row.children.some(visit)
      : false;
  };
  return rows.some(visit);
}

interface SideChatForkCandidate {
  originKind: string | null;
  originPluginId: string | null;
  visibility: string;
  archivedAt: number | null;
  createdAt: number;
}

function isOwnLiveHiddenFork(
  thread: SideChatForkCandidate,
  pluginId: string,
): boolean {
  return (
    thread.originKind === "fork" &&
    thread.originPluginId === pluginId &&
    thread.visibility === "hidden" &&
    thread.archivedAt === null
  );
}

export const sideChatRpcContract = defineRpcContract({
  createSideChat: {
    input: z
      .object({
        sourceThreadId: z.string().trim().min(1),
        anchorText: z.string(),
      })
      .strict(),
    output: z.object({ threadId: z.string() }).strict(),
  },
  sendToMain: {
    input: z
      .object({
        sourceThreadId: z.string().trim().min(1),
        senderThreadId: z.string().trim().min(1),
        text: z.string().trim().min(1),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export default async function plugin(room: BbPluginApi) {
  room.rpc.register(sideChatRpcContract, {
    async createSideChat({ sourceThreadId, anchorText }) {
      const seedText = resolveReplySeedText(anchorText);
      const fork = await room.sdk.threads.fork({
        sourceThreadId,
        fresh: true,
        visibility: "hidden",
        ...(seedText !== null
          ? {
              agentContextSeed: [
                {
                  type: "text" as const,
                  text: `${REPLY_SEED_PREFIX}${seedText}`,
                  mentions: [],
                  visibility: "agent-only" as const,
                },
              ],
            }
          : {}),
      });
      return { threadId: fork.id };
    },
    async sendToMain({ sourceThreadId, senderThreadId, text }) {
      await room.sdk.threads.queuedMessages.create({
        threadId: sourceThreadId,
        input: [{ type: "text", text, mentions: [] }],
        senderThreadId,
      });
      return { ok: true as const };
    },
  });

  room.background.schedule("empty-fork-cleanup", "13 * * * *", async () => {
    const now = Date.now();
    const keptKeys = new Set(await room.storage.kv.list(KEPT_FORK_KEY_PREFIX));
    const stillLive = new Set<string>();
    let offset = 0;
    for (;;) {
      const page = await room.sdk.threads.list({
        includeHidden: true,
        originKind: "fork",
        originPluginId: room.pluginId,
        archived: false,
        limit: EMPTY_FORK_SWEEP_PAGE_SIZE,
        offset,
      });
      if (page.length === 0) break;
      let retained = 0;
      for (const thread of page) {
        if (!isOwnLiveHiddenFork(thread, room.pluginId)) {
          retained += 1;
          continue;
        }
        if (now - thread.createdAt <= EMPTY_FORK_MAX_AGE_MS) {
          retained += 1;
          continue;
        }
        const keptKey = `${KEPT_FORK_KEY_PREFIX}${thread.id}`;
        if (keptKeys.has(keptKey)) {
          stillLive.add(keptKey);
          retained += 1;
          continue;
        }
        const outcome = await sweepEmptyFork(thread.id, thread.createdAt);
        if (outcome === "archived") continue;
        if (outcome === "kept") {
          await room.storage.kv.set(keptKey, true);
          stillLive.add(keptKey);
        }
        retained += 1;
      }
      if (page.length < EMPTY_FORK_SWEEP_PAGE_SIZE) break;
      offset += retained;
    }
    for (const key of keptKeys) {
      if (!stillLive.has(key)) await room.storage.kv.delete(key);
    }
  });

  async function sweepEmptyFork(
    threadId: string,
    createdAt: number,
  ): Promise<"archived" | "kept" | "skipped"> {
    try {
      const timeline = await room.sdk.threads.timeline({
        threadId,
        includeNestedRows: "true",
      });
      if (timelineRowsContainUserMessage(timeline.rows)) return "kept";
    } catch (error) {
      room.log.warn(
        `empty-fork sweep skipped ${threadId} (timeline read failed: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return "skipped";
    }
    try {
      const queued = await room.sdk.threads.queuedMessages.list({ threadId });
      if (queued.length > 0) return "kept";
    } catch (error) {
      room.log.warn(
        `empty-fork sweep skipped ${threadId} (queued-message read failed: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return "skipped";
    }
    try {
      await room.sdk.threads.archive({ threadId });
      room.log.info(
        `empty-fork sweep archived ${threadId} (no user messages, ` +
          `created ${new Date(createdAt).toISOString()})`,
      );
      return "archived";
    } catch (error) {
      room.log.warn(
        `empty-fork sweep failed to archive ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "skipped";
    }
  }
}
