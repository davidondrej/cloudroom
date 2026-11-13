import type {
  BbPluginApi,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
  PluginTurnFailedEvent,
} from "@get-bb/plugin-sdk";
import {
  STABLE_STEPS_MS,
  createInternetMonitor,
  probeInternet,
  type InternetMonitor,
} from "./src/monitor.js";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The reason on a network retry's queued row; it is how the hook finds its own rows. */
export const NETWORK_RETRY_REASON = "Internet dropped";
export const WAITING_REASON = "Waiting for internet";
export const MAX_WAIT_MS = 6 * 60 * 60 * 1_000;
/** A held thread is re-asked this often, so a missed recheck never strands it. */
export const REASK_MS = 60_000;
export const GAVE_UP_MESSAGE =
  "No internet for 6 hours, so Cloudroom stopped waiting. Press Send now to retry.";
/** The same cap as Provider retry: the original attempt plus four retries. */
const MAX_ATTEMPTS = 5;
/**
 * A retry first waits on the clock for a moment. An attempt made right away is
 * inline, with no queued row yet, so the hook could not tell it is ours.
 */
const RETRY_DELAY_MS = 1_000;
/**
 * Codex can end an outage with these too, but so can a server-side fault. They
 * count as a network failure only when a check right then finds no internet.
 */
const MAYBE_NETWORK = new Set(["stream-disconnected", "too-many-failed-attempts"]);

type QueuedRow = MessageDispatchHookContext["queuedMessages"][number];
type FailureInfo = PluginTurnFailedEvent["errorInfo"];

function isNetworkRetry(row: QueuedRow): boolean {
  return (
    row.payload.kind === "retry" && row.payload.reason === NETWORK_RETRY_REASON
  );
}

/** "connection-failed" is a network drop; the rest only if a check confirms it. */
export function networkFailureKind(info: FailureInfo): "sure" | "maybe" | null {
  if (info === null) return null;
  if (info.category === "connection-failed") return "sure";
  if (MAYBE_NETWORK.has(info.category)) return "maybe";
  // Claude's network errors are `server_error` with no HTTP status. The known
  // wordings are labeled connection-failed upstream; this catches a new one.
  if (
    info.category === "internal" &&
    info.providerCode === "server_error" &&
    info.httpStatusCode === null
  ) {
    return "maybe";
  }
  return null;
}

/**
 * A proxy routes the agents' traffic where this plugin's own checks cannot
 * follow, unless Node is told to use it too (`NODE_USE_ENV_PROXY=1`). Then
 * the checks take the agents' route. Otherwise it never holds a retry it
 * could not release.
 */
export function proxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_USE_ENV_PROXY === "1") return false;
  return ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(
    (key) => (env[key] ?? "") !== "",
  );
}

/** How long the internet must stay up before this retry goes. */
function stableNeededMs(row: QueuedRow): number {
  const attempt = row.payload.kind === "retry" ? row.payload.attempt : 2;
  const index = Math.min(Math.max(attempt - 2, 0), STABLE_STEPS_MS.length - 1);
  return STABLE_STEPS_MS[index] ?? STABLE_STEPS_MS[0]!;
}

/**
 * The dispatch decision for this plugin's own retry rows; every other message
 * proceeds untouched. A row goes once the internet has stayed up long enough
 * for its attempt. Otherwise it waits and is re-asked every minute. After 6
 * hours from the row's creation it gives up, but only on a fresh failed check,
 * so a Mac that just woke from sleep checks before it decides. Stateless, so
 * restarts and repeated asks are safe.
 */
export function createDispatchPolicy(
  monitor: Pick<InternetMonitor, "stableForMs" | "checkedRecently" | "watch">,
  options: { now?: () => number; proxied?: boolean } = {},
) {
  const now = options.now ?? Date.now;
  return (context: MessageDispatchHookContext): MessageDispatchHookDecision => {
    const row = context.queuedMessages.find(isNetworkRetry);
    if (row === undefined || options.proxied) return { action: "proceed" };
    monitor.watch();
    const stable = monitor.stableForMs();
    if (stable >= stableNeededMs(row)) return { action: "proceed" };
    const at = now();
    if (
      at >= row.createdAt + MAX_WAIT_MS &&
      stable === 0 &&
      monitor.checkedRecently()
    ) {
      return { action: "reject", message: GAVE_UP_MESSAGE };
    }
    return { action: "wait", reason: WAITING_REASON, sendAt: at + REASK_MS };
  };
}

export default function plugin(
  room: BbPluginApi,
  options: { probe?: () => Promise<boolean> } = {},
): void {
  const probe = options.probe ?? probeInternet;
  const proxied = proxyConfigured();
  const monitor = createInternetMonitor({
    probe,
    onStable() {
      room.experimental_hooks
        .recheck("message.dispatch")
        .catch((error: unknown) => room.log.debug(`Recheck failed: ${errorText(error)}`));
    },
  });
  room.onDispose(() => monitor.stop());
  room.experimental_hooks.on(
    "message.dispatch",
    createDispatchPolicy(monitor, { proxied }),
  );

  // Retries held before a restart: start checking so they resume promptly.
  if (!proxied) {
    void room.sdk.threads.queue
      .list({})
      .then((rows) => {
        if (rows.some(isNetworkRetry)) monitor.watch();
      })
      .catch((error: unknown) => {
        room.log.debug(`Held retries not restored: ${errorText(error)}`);
      });
  }

  room.events.on("turn.failed", async (event) => {
    const kind = networkFailureKind(event.errorInfo);
    if (kind === null) return;
    if (event.turnStartedBeforeBoot || event.attemptNumber >= MAX_ATTEMPTS) {
      return;
    }
    try {
      const thread = await room.sdk.threads.get({ threadId: event.threadId });
      // A Cloud thread runs on the cloud's internet; a Mac drop never stops it.
      if (thread.executionTarget === "cloud") return;
      if (kind === "maybe" && (proxied || (await probe()))) return;
      if (!proxied) monitor.reportNetworkFailure();
      await room.sdk.threads.retry({
        threadId: event.threadId,
        turnRequestId: event.requestId,
        sendAt: Date.now() + RETRY_DELAY_MS,
        reason: NETWORK_RETRY_REASON,
      });
    } catch (error) {
      room.log.debug(
        `Network retry not scheduled for ${event.threadId}: ${errorText(error)}`,
      );
    }
  });

  room.cli.register({
    name: "internet-watch",
    summary: "Show the internet state and threads waiting for it",
    commands: [
      {
        name: "status",
        summary: "Show the internet state and threads waiting for it",
        usage: "bb internet-watch status [--json]",
      },
    ],
    async run(argv) {
      if (argv[0] !== "status") {
        return {
          exitCode: 2,
          stderr: "Usage: bb internet-watch status [--json]\n",
        };
      }
      const rows = await room.sdk.threads.queue.list({});
      const waiting = rows.filter(isNetworkRetry).map((row) => row.threadId);
      const stable = monitor.stableForMs();
      const internet = !monitor.watching()
        ? "not checking"
        : stable > 0
          ? `up for ${Math.round(stable / 1_000)}s`
          : "down";
      if (argv.includes("--json")) {
        const status = { internet, stableForMs: stable, waitingThreads: waiting };
        return { exitCode: 0, stdout: `${JSON.stringify(status, null, 2)}\n` };
      }
      const waitingText = waiting.length === 0 ? "none" : waiting.join(", ");
      return {
        exitCode: 0,
        stdout: `Internet: ${internet}\nWaiting threads: ${waitingText}\n`,
      };
    },
  });
}
