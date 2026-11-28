// Which Cloud threads the 1.5 s delivery tick works on, split out of delivery.ts to keep it under the size cap.
import type { CloudRuntime } from "./runtime.js";
import { sandboxThread } from "./sandboxes.js";
import { openBindings, type OpenBinding } from "./store.js";

const MAX_BACKGROUND_DELIVERIES = 8;
type ReadHistory = (threadId: string) => Promise<unknown>;

function isUrgent(rt: CloudRuntime, row: OpenBinding): boolean {
  return (
    !row.sessionId ||
    Boolean(row.sending) ||
    ["pending", "starting", "active", "stopping"].includes(row.status) ||
    rt.host.watching(row.threadId)
  );
}

/** Prioritizes active, watched, and unsent threads and caps background fan-out so hundreds of open
 *  Cloud threads never storm deliveries at once. */
export function pickDeliveries(rt: CloudRuntime, readHistory: ReadHistory): string[] {
  const rows = openBindings(rt.host.db);
  let inFlight = 0;
  const urgent: string[] = [];
  const background: string[] = [];
  for (const row of rows) {
    if (rt.peek(row.threadId)?.delivery) {
      inFlight += 1;
      continue;
    }
    if (!needsDelivery(rt, readHistory, row)) continue;
    if (isUrgent(rt, row)) urgent.push(row.threadId);
    else background.push(row.threadId);
  }
  inFlight += urgent.length;
  return [...urgent, ...background.slice(0, Math.max(0, MAX_BACKGROUND_DELIVERIES - inFlight))];
}

/** The 1.5 s tick skips threads with nothing to do: a live stream with nothing unsent, or an idle sandbox
 *  absent from the shared awake list. Background idle threads wait for discover() to finish or recover
 *  instead of fanning out failed deliveries during a website blip. */
export function needsDelivery(rt: CloudRuntime, readHistory: ReadHistory, row: OpenBinding): boolean {
  const entry = rt.peek(row.threadId);
  // A fresh side chat stays unstarted until its first message so the user can pick any harness first.
  if (!row.sessionId && row.status === "idle" && !row.sending) return false;
  const running = ["pending", "starting", "active", "stopping"].includes(row.status);
  const live = Boolean(entry?.stream);
  const sandbox = sandboxThread(row.coreUrl);
  const detachedChild = Boolean(sandbox && sandbox !== row.threadId && !row.parentThreadId && entry?.leftParent !== row.sessionId);
  if (!row.sessionId || row.sending || running) {
    return !live || !row.sessionId || Boolean(row.sending) || Boolean(entry?.connectionIssues?.delivery) || detachedChild;
  }
  const watching = rt.host.watching(row.threadId);
  if (entry?.connectionIssues?.delivery) {
    if (!watching && sandbox && rt.sandboxes.hasAwakeIssue()) return false;
    return true;
  }
  // A Cloud thread streams here only while it's open on a screen here, a turn this computer sent runs, or this
  // computer acts for it (home). A computer is home for every thread only it prompts (docs/scopes/cloud-threads.md App 4).
  if (!watching && !rt.isHome(row.threadId)) {
    if (live) rt.detach(row.threadId);
    return false;
  }
  if (!live && sandbox) {
    const awake = rt.sandboxes.isAwake(sandbox);
    const forgotten = rt.sandboxes.isForgotten(sandbox);
    if (!awake && !forgotten) {
      if (!watching && (rt.sandboxes.awakeChecks === 0 || rt.sandboxes.hasAwakeIssue())) return false;
      if (!rt.sandboxes.hasAwakeIssue() && entry?.cutOffTries === undefined) {
        if (sandbox === row.threadId && watching) void readHistory(row.threadId);
        return false;
      }
    }
    if (entry?.sleptAtCheck === rt.sandboxes.awakeChecks && !awake) {
      if (sandbox === row.threadId && watching) void readHistory(row.threadId);
      return false;
    }
  }
  if (sandbox && sandbox !== row.threadId && !row.parentThreadId && entry?.leftParent !== row.sessionId) return true;
  return !live;
}
