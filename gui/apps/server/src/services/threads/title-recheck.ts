import { events, getThread, type DbConnection } from "@cloudroom/db";
import type { PromptInput } from "@cloudroom/domain";
import { and, eq } from "drizzle-orm";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import type { SandboxDirectory } from "../cloudroom/sandboxes.js";
import { INFERENCE_POLICY } from "../ai/inference.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { readUiPreferences } from "../system/ui-preferences.js";
import { syncGeneratedTitleToProvider } from "./thread-commands.js";
import { getLastThreadOutput } from "./thread-data.js";
import {
  applyGeneratedThreadTitle,
  cleanPromptText,
  generateThreadMetadataWithOutcome,
} from "./title-generation.js";

// A generated title is judged once, after the first reply, when the thread says more than its first message did.
// The website asks Jev how vague it is; a vague title is renamed with the reply as context. Titles that people or
// agents changed are left alone. Pending checks live in memory, so a restart skips them.
const MAX_CONTEXT_LENGTH = 2_000;

interface PendingTitle {
  checking?: boolean;
  input: PromptInput[];
  title: string;
}

interface Tracker {
  deps: CommandResultSideEffectsDeps;
  pending: Map<string, PendingTitle>;
  website: Pick<SandboxDirectory, "titleTooVague">;
}

let tracker: Tracker | null = null;

export function installTitleRecheck(
  deps: CommandResultSideEffectsDeps,
  website: Tracker["website"],
): () => void {
  const current: Tracker = { deps, pending: new Map(), website };
  tracker = current;
  const unsubscribe = deps.hub.onChangedMessage((message) => {
    if (message.entity === "thread" && current.pending.has(message.id)) {
      checkWhenReplied(current, message.id);
    }
  });
  return () => {
    unsubscribe();
    current.pending.clear();
    if (tracker === current) tracker = null;
  };
}

/** Remembers a freshly generated title, so it can be judged once the first reply is in. */
export function noteGeneratedTitle(
  threadId: string,
  title: string,
  input: PromptInput[],
): void {
  if (!tracker) return;
  tracker.pending.set(threadId, { input, title });
  checkWhenReplied(tracker, threadId);
}

export function cancelTitleRecheck(threadId: string): void {
  tracker?.pending.delete(threadId);
}

function checkWhenReplied(current: Tracker, threadId: string): void {
  const thread = getThread(current.deps.db, threadId);
  const gone = !thread || thread.archivedAt !== null;
  if (
    !gone &&
    (thread.status !== "idle" || !hasCompletedTurn(current.deps.db, threadId))
  ) {
    return;
  }
  const pending = current.pending.get(threadId);
  if (gone) current.pending.delete(threadId);
  if (gone || !pending || pending.checking) return;
  pending.checking = true;
  void recheckTitle(current, threadId, pending)
    .catch((error: unknown) => {
      current.deps.logger.debug(
        { threadId, ...runtimeErrorLogFields(current.deps.config, error) },
        "Vague title check failed",
      );
    })
    .finally(() => {
      if (current.pending.get(threadId) === pending)
        current.pending.delete(threadId);
    });
}

async function recheckTitle(
  current: Tracker,
  threadId: string,
  pending: PendingTitle,
): Promise<void> {
  const { deps } = current;
  const sensitivity =
    readUiPreferences(deps)["threadNaming.renameSensitivity"].value;
  const agentReply = getLastThreadOutput(deps.db, threadId)?.slice(
    0,
    MAX_CONTEXT_LENGTH,
  );
  const unchanged = () =>
    current.pending.get(threadId) === pending &&
    getThread(deps.db, threadId)?.title === pending.title;
  if (sensitivity <= 1 || !agentReply || !unchanged()) return;

  const vague = await current.website.titleTooVague({
    agentReply,
    firstMessage: cleanPromptText(pending.input).slice(0, MAX_CONTEXT_LENGTH),
    sensitivity,
    title: pending.title,
  });
  if (!vague || !unchanged()) return;

  const outcome = await generateThreadMetadataWithOutcome(deps, {
    agentReply,
    input: pending.input,
    threadId,
    timeoutMaxAttempts: INFERENCE_POLICY.threadMetadata.maxAttempts,
  });
  const title = outcome.metadata?.title;
  if (
    title &&
    unchanged() &&
    applyGeneratedThreadTitle(deps, {
      replaces: pending.title,
      threadId,
      title,
    })
  ) {
    syncGeneratedTitleToProvider(deps, threadId, title);
  }
}

function hasCompletedTurn(db: DbConnection, threadId: string): boolean {
  return (
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(eq(events.threadId, threadId), eq(events.type, "turn/completed")),
      )
      .limit(1)
      .get() !== undefined
  );
}
