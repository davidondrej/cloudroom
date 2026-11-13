import type { ThreadListEntry } from "@cloudroom/domain";
import { CliExitError } from "../../action.js";
import type { createCliRoomSdk } from "../../client.js";
import { truncateCell } from "../../table.js";
import { outputJson } from "../helpers.js";
import { THREAD_WAIT_EXIT_CODE_TIMEOUT } from "./helpers.js";

/** Under the 10-minute shell limit of agent harnesses: the command ends by itself, and the agent runs it again. */
export const DEFAULT_CHILDREN_WAIT_TIMEOUT_SECONDS = 540;
/** One list request covers every child, so a slow tick is enough. */
export const DEFAULT_CHILDREN_WAIT_POLL_INTERVAL_MS = 2_000;

type ChildState = "done" | "failed" | "needs input" | "queued" | "running";

/** States where the child does nothing more until someone acts. */
const SETTLED_STATES: readonly ChildState[] = ["done", "failed", "needs input"];
const MAX_TITLE_WIDTH = 60;
/** A queued message that is paused or scheduled for later never starts by itself, so a queued child gets this long. */
const QUEUED_GRACE_MS = 5_000;

function childState(child: ThreadListEntry): ChildState {
  if (child.hasPendingInteraction) return "needs input";
  if (child.status === "error") return "failed";
  if (child.status !== "idle") return "running";
  // An idle child with a waiting message has not started that work yet.
  if (child.queuedWork === "waiting") return "queued";
  return child.queuedWork === "failed" ? "failed" : "done";
}

interface WaitForChildrenArgs {
  json?: boolean;
  parentThreadId: string;
  pollIntervalMs: number;
  sdk: ReturnType<typeof createCliRoomSdk>;
  timeoutMs: number;
}

/**
 * Blocks until every open child of a thread is done, failed, or needs input,
 * then prints one line per child. One call replaces one wake-up per child.
 */
export async function waitForChildren(
  args: WaitForChildrenArgs,
): Promise<void> {
  const { parentThreadId } = args;
  const deadline = Date.now() + args.timeoutMs;
  const queuedSince = new Map<string, number>();
  for (;;) {
    const threads = await args.sdk.threads.list({
      parentThreadId,
      archived: false,
      includeHidden: true,
    });
    const children = threads.map((child) => ({
      id: child.id,
      state: childState(child),
      title: child.title?.trim() || child.titleFallback?.trim() || "-",
    }));
    const now = Date.now();
    for (const child of children) {
      if (child.state !== "queued") queuedSince.delete(child.id);
      else if (!queuedSince.has(child.id)) queuedSince.set(child.id, now);
    }
    const working = children.filter((child) =>
      child.state === "queued"
        ? now - (queuedSince.get(child.id) ?? now) < QUEUED_GRACE_MS
        : !SETTLED_STATES.includes(child.state),
    );
    const timedOut = working.length > 0 && Date.now() >= deadline;
    if (working.length > 0 && !timedOut) {
      await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
      continue;
    }

    if (!outputJson(args, { parentThreadId, settled: !timedOut, children })) {
      if (children.length === 0) {
        console.log(`Thread ${parentThreadId} has no open child threads.`);
      }
      for (const child of children) {
        console.log(
          `${child.state.padEnd(11)}  @thread:${child.id}  ${truncateCell(child.title, MAX_TITLE_WIDTH)}`,
        );
        if (child.state === "queued") {
          console.log(
            `             Its next message has not started (paused or scheduled): room-cli thread queue list ${child.id}`,
          );
        }
        if (child.state !== "needs input") continue;
        // Name the exact next command: a blocked child otherwise waits for hours.
        const interactions = await args.sdk.threads.interactions.list({
          threadId: child.id,
        });
        for (const interaction of interactions) {
          if (interaction.status !== "pending") continue;
          console.log(
            `             See what it asks and how to answer: room-cli thread interactions show ${interaction.id} ${child.id}`,
          );
        }
      }
    }
    if (timedOut) {
      throw new CliExitError(
        `Timed out: ${working.length} of ${children.length} child threads are still working. Run the command again to keep waiting.`,
        THREAD_WAIT_EXIT_CODE_TIMEOUT,
      );
    }
    return;
  }
}
