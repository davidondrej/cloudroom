import { Command } from "commander";
import { threadStatusSchema, threadStatusValues } from "@cloudroom/domain";
import {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  type ThreadWaitTarget,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "@cloudroom/sdk";
import { action, CliExitError } from "../../action.js";
import { createCliRoomSdk } from "../../client.js";
import { resolveContextThreadId } from "../../context-env.js";
import { outputJson, requireThreadId } from "../helpers.js";
import {
  DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS,
  parseThreadWaitPollIntervalMs,
  parseThreadWaitTimeoutSeconds,
  THREAD_WAIT_EXIT_CODE_INVALID_REQUEST,
  THREAD_WAIT_EXIT_CODE_TIMEOUT,
  THREAD_WAIT_EXIT_CODE_UNREACHABLE,
} from "./helpers.js";
import {
  DEFAULT_CHILDREN_WAIT_POLL_INTERVAL_MS,
  DEFAULT_CHILDREN_WAIT_TIMEOUT_SECONDS,
  waitForChildren,
} from "./wait-children.js";

interface ThreadWaitCommandOptions {
  children?: boolean;
  status?: string;
  event?: string;
  timeout?: string;
  pollInterval?: string;
  json?: boolean;
}

export function registerWaitCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("wait [id]")
    .description(
      "Wait for a thread status or event (defaults to --status idle), or with --children for all of a thread's children",
    )
    .option(
      "--children",
      `Wait until every open child of the thread (default: this one) is done, failed, or needs input, then print one line per child. Times out after ${DEFAULT_CHILDREN_WAIT_TIMEOUT_SECONDS} seconds by default: run it again to keep waiting`,
    )
    .option("--status <status>", "Wait until the thread reaches this status")
    .option(
      "--event <type>",
      "Wait until the thread log includes this event type; matches past events too, so an earlier turn's turn/completed returns at once",
    )
    .option(
      "--timeout <seconds>",
      `Timeout in seconds (default: ${DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS})`,
    )
    .option(
      "--poll-interval <ms>",
      `Polling interval in milliseconds (default: ${DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS})`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadWaitCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        if (opts.children) {
          await waitForChildren({
            sdk,
            parentThreadId: resolveChildrenParentId(id, opts),
            timeoutMs:
              (opts.timeout === undefined
                ? DEFAULT_CHILDREN_WAIT_TIMEOUT_SECONDS
                : parseThreadWaitTimeoutSeconds(opts.timeout)) * 1000,
            pollIntervalMs:
              opts.pollInterval === undefined
                ? DEFAULT_CHILDREN_WAIT_POLL_INTERVAL_MS
                : parseThreadWaitPollIntervalMs(opts.pollInterval),
            json: opts.json,
          });
          return;
        }
        const threadId = requireThreadId(id);
        const target = parseThreadWaitTarget(opts);
        const timeoutSeconds = parseThreadWaitTimeoutSeconds(opts.timeout);
        const pollIntervalMs = parseThreadWaitPollIntervalMs(opts.pollInterval);
        const waitArgs = {
          threadId,
          timeoutMs: timeoutSeconds * 1000,
          pollIntervalMs,
          ...(target.kind === "status"
            ? { status: target.status }
            : { event: target.eventType }),
        };
        let result: Awaited<ReturnType<typeof sdk.threads.wait>>;
        try {
          result = await sdk.threads.wait(waitArgs);
        } catch (error) {
          if (error instanceof ThreadWaitTimeoutError) {
            throw new CliExitError(
              error.message,
              THREAD_WAIT_EXIT_CODE_TIMEOUT,
            );
          }
          if (error instanceof ThreadWaitUnreachableError) {
            throw new CliExitError(
              error.message,
              THREAD_WAIT_EXIT_CODE_UNREACHABLE,
            );
          }
          throw error;
        }

        if (outputJson(opts, { threadId, matched: true, target })) return;
        if (!("event" in result)) {
          console.log(
            `Thread ${threadId} reached status ${result.target.status}.`,
          );
          return;
        }
        console.log(
          `Thread ${threadId} observed event ${result.target.eventType} at seq ${result.event.seq}.`,
        );
      }),
    );
}

/** The parent whose children to wait for: the given thread, else the one running the command. */
function resolveChildrenParentId(
  id: string | undefined,
  opts: ThreadWaitCommandOptions,
): string {
  if (opts.status || opts.event) {
    throw new CliExitError(
      "--children cannot be combined with --status or --event.",
      THREAD_WAIT_EXIT_CODE_INVALID_REQUEST,
    );
  }
  const parentThreadId = id ? requireThreadId(id) : resolveContextThreadId();
  if (parentThreadId) return parentThreadId;
  throw new CliExitError(
    "Pass the parent thread ID: this shell has no ROOM_THREAD_ID.",
    THREAD_WAIT_EXIT_CODE_INVALID_REQUEST,
  );
}

function parseThreadWaitTarget(
  opts: ThreadWaitCommandOptions,
): ThreadWaitTarget {
  const hasStatus = Boolean(opts.status);
  const hasEvent = Boolean(opts.event);
  if (hasStatus && hasEvent) {
    throw new CliExitError(
      "Provide only one of --status or --event.",
      THREAD_WAIT_EXIT_CODE_INVALID_REQUEST,
    );
  }

  if (!hasEvent) {
    const status = opts.status ?? "idle";
    const parsed = threadStatusSchema.safeParse(status);
    if (parsed.success) {
      return { kind: "status", status: parsed.data };
    }
    throw new CliExitError(
      `Invalid thread status '${status}'. Expected one of ${threadStatusValues.join(", ")}.`,
      THREAD_WAIT_EXIT_CODE_INVALID_REQUEST,
    );
  }

  return {
    kind: "event",
    eventType: opts.event ?? "",
  };
}
