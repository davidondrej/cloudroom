import { Command } from "commander";
import { randomUUID } from "node:crypto";
import {
  threadVisibilitySchema,
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
  type ThreadVisibility,
} from "@cloudroom/domain";
import { CALLER_PROOF_REQUIRED_CODE } from "@cloudroom/config/caller-proof";
import { action } from "../../action.js";
import { CLI_READ_TIMEOUT_MS, createCliRoomSdk } from "../../client.js";
import {
  BbHttpError,
  type ThreadRetryResult,
  type ThreadSendResult,
} from "@cloudroom/sdk";
import {
  BbRequestTimeoutError,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
} from "@cloudroom/sdk/node";
import type { QueuedMessageWaitingOn } from "@cloudroom/domain";
import {
  collectOption,
  confirmDestructiveAction,
  getErrorMessage,
  outputJson,
  parseReasoningLevel,
  prependErrorContext,
  readTextFileOrStdin,
  requireThreadIdOrSelf,
} from "../helpers.js";
import {
  resolveContextThreadId,
  resolveExplicitIdFlag,
} from "../../context-env.js";
import {
  parsePermissionMode,
  parseServiceTier,
  PERMISSION_MODE_HELP,
  PLAN_HELP,
  buildPromptInputs,
  requirePromptContent,
  uploadClientAttachmentInputs,
} from "./helpers.js";
import { SEND_AT_HELP, parseSendAt } from "./send-time.js";
import { archiveMany } from "./archive-many.js";

interface ThreadUpdateCommandOptions {
  self?: boolean;
  json?: boolean;
  title?: string;
  parentThread?: string;
  clearParentThread?: boolean;
  section?: string;
  clearSection?: boolean;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
  visibility?: string;
  resend?: boolean;
}

interface ThreadMoveCommandOptions {
  self?: boolean;
  json?: boolean;
  project: string;
}

interface ThreadArchiveCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadUnarchiveCommandOptions {
  self?: boolean;
  json?: boolean;
  keepParent?: boolean;
  withChildren?: boolean;
}

interface ThreadPinCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadDeleteCommandOptions {
  confirmChildThreads?: boolean;
  yes?: boolean;
  json?: boolean;
}

interface ThreadTellCommandOptions {
  json?: boolean;
  model?: string;
  permissionMode?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  mode?: string;
  plan?: boolean;
  file?: string[];
  image?: string[];
  sendAt?: string;
  requestId?: string;
  messageFile?: string;
  parent?: boolean;
}

interface ThreadActionOptions {
  self?: boolean;
  json?: boolean;
}

/** `room-cli thread compact`'s follow-up unless `--then` or `--no-then`. Cloud's CLI (core/src/session/thread.rs) sends the same. */
const COMPACT_THEN = "Keep going with your task. If it's done, say what we should do next.";

interface ThreadCompactCommandOptions extends ThreadActionOptions {
  then?: string | false;
}

interface ThreadRetryCommandOptions {
  self?: boolean;
  json?: boolean;
  turn?: string;
  sendAt?: string;
  reason?: string;
}

interface ThreadEditMessageCommandOptions {
  expectedRequestSequence?: string;
  json?: boolean;
  message: string;
  self?: boolean;
}

type ThreadTellDeliveryMode = "auto" | "queue" | "steer";

interface PostThreadMessageArgs {
  getUrl: () => string;
  threadId: string;
  message: string;
  mode?: ThreadTellDeliveryMode;
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  senderThreadId?: string;
  plan?: boolean;
  files?: readonly string[];
  images?: readonly string[];
  sendAt?: number;
  requestId?: string;
}

/** The send may have landed. `requestId` is set only where resending with it can't duplicate the turn (Cloud). */
class UnconfirmedSendError extends Error {
  constructor(
    message: string,
    readonly requestId: string | undefined,
  ) {
    super(message);
  }
}

// The server's own answer plus the mode we asked for. `sendAt` used to be
// echoed back here so the outcome line could name the time; the queued arm of
// the response now carries it, along with the reason, so the CLI no longer
// has to reconstruct what happened from the flags it sent.
type PostThreadMessageResult = ThreadSendResult & {
  mode: ThreadTellDeliveryMode;
};

interface ThreadUpdateBody {
  title?: string;
  sectionId?: string | null;
  parentThreadId?: string | null;
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  visibility?: ThreadVisibility;
  resend?: boolean;
}

export function registerActionsCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("update [id]")
    .description("Update a thread")
    .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option("--title <title>", "Set the thread title")
    .option("--parent-thread <id>", "Set the parent thread id")
    .option("--clear-parent-thread", "Clear the parent thread id")
    .option("--section <id>", "Move the thread into a section")
    .option("--clear-section", "Remove the thread from its section")
    .option(
      "--provider <id>",
      "Switch the thread to another agent harness in place; needs --model. The next turn gets the conversation so far",
    )
    .option(
      "--model <model>",
      "Set the model for the thread's next turn. In Cloud, or with --provider, this switches the thread in place",
    )
    .option(
      "--reasoning-level <level>",
      "Set the sticky reasoning level applied on the thread's next turn: low, medium, high, xhigh, max (provider-dependent)",
    )
    .option("--visibility <visibility>", "Thread visibility: visible or hidden")
    .option(
      "--resend",
      "With --provider: the new agent continues the conversation right away, e.g. after a plan limit",
    )
    .action(
      action(
        async (id: string | undefined, opts: ThreadUpdateCommandOptions) => {
          if (opts.parentThread && opts.clearParentThread) {
            throw new Error(
              "Cannot combine --parent-thread with --clear-parent-thread.",
            );
          }
          if (opts.section && opts.clearSection) {
            throw new Error("Cannot combine --section with --clear-section.");
          }
          const reasoningLevel = parseReasoningLevel(opts.reasoningLevel);
          const visibility =
            opts.visibility === undefined
              ? undefined
              : threadVisibilitySchema.parse(opts.visibility);
          if (opts.provider && !opts.model) {
            throw new Error("--provider needs --model.");
          }
          if (opts.resend && !opts.provider) {
            throw new Error("--resend needs --provider.");
          }
          if (
            !opts.parentThread &&
            !opts.clearParentThread &&
            !opts.section &&
            !opts.clearSection &&
            !opts.title &&
            !opts.model &&
            !reasoningLevel &&
            !visibility
          ) {
            throw new Error(
              "No changes requested. Provide --title, --parent-thread, --clear-parent-thread, --section, --clear-section, --model, --reasoning-level, or --visibility.",
            );
          }

          const threadId = requireThreadIdOrSelf(id, opts);
          const parentThreadId = resolveExplicitIdFlag({
            flagName: "--parent-thread",
            value: opts.parentThread,
          });
          const body: ThreadUpdateBody = {};
          if (opts.title) {
            body.title = opts.title;
          }
          if (parentThreadId) {
            body.parentThreadId = parentThreadId;
          } else if (opts.clearParentThread) {
            body.parentThreadId = null;
          }
          if (opts.section) {
            body.sectionId = resolveExplicitIdFlag({
              flagName: "--section",
              value: opts.section,
            });
          } else if (opts.clearSection) {
            body.sectionId = null;
          }
          if (opts.provider) {
            body.providerId = opts.provider;
          }
          if (opts.model) {
            body.model = opts.model;
          }
          if (reasoningLevel) {
            body.reasoningLevel = reasoningLevel;
          }
          if (visibility) {
            body.visibility = visibility;
          }
          if (opts.resend) {
            body.resend = true;
          }

          const sdk = createCliRoomSdk(getUrl());
          const thread = await sdk.threads.update({ threadId, ...body });
          if (outputJson(opts, thread)) return;
          console.log(`Thread ${thread.id} updated`);
          if (opts.title) {
            console.log(`Title: ${thread.title ?? "<untitled>"}`);
          }
          if (opts.parentThread || opts.clearParentThread) {
            console.log(
              thread.parentThreadId
                ? `Parent: ${thread.parentThreadId}`
                : "No parent thread",
            );
          }
          if (opts.section || opts.clearSection) {
            console.log(
              thread.sectionId ? `Section: ${thread.sectionId}` : "No section",
            );
          }
          if (opts.provider) {
            console.log(`Provider: ${thread.providerId}`);
          }
          if (opts.model) {
            console.log(`Model: ${opts.model}`);
          }
          if (reasoningLevel) {
            console.log(`Reasoning level: ${reasoningLevel}`);
          }
          if (visibility) {
            console.log(`Visibility: ${visibility}`);
          }
          if (thread.resend) {
            console.log(
              {
                started: "Resend: the new agent started its first turn.",
                starting: `Resend: sent, but the new agent hasn't confirmed its first turn yet. Check \`room-cli thread show ${thread.id}\`.`,
                queued: `Resend: queued; it starts when the thread can run. See \`room-cli thread queue list ${thread.id}\`.`,
              }[thread.resend],
            );
          }
        },
      ),
    );

  parent
    .command("move [id]")
    .description(
      "Move a thread to another project. It keeps its ID and chat, and continues in a fresh session in that project's folder. The old folder stays as it is",
    )
    .requiredOption("--project <project>", "Target project ID or name")
    .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadMoveCommandOptions) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const sdk = createCliRoomSdk(getUrl());
        const result = await sdk.threads.move({
          threadId,
          projectId: opts.project,
        });
        if (outputJson(opts, result)) return;
        console.log(
          result.moved
            ? `Thread ${threadId} is in ${opts.project}.`
            : `Thread ${threadId} moves to ${opts.project} when its current turn ends. End this turn now; the next one runs there.`,
        );
        if (result.previousPath) {
          console.log(`The old folder stays at ${result.previousPath}.`);
        }
      }),
    );

  parent
    .command("archive [ids...]")
    .description("Archive a thread, or several at once")
    .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        // Several IDs take the bulk path; one ID or --self keeps the old output.
        async (ids: string[], opts: ThreadArchiveCommandOptions) => {
          const sdk = createCliRoomSdk(getUrl());
          if (ids.length > 1) {
            await archiveMany({ sdk, ids, self: opts.self, json: opts.json });
            return;
          }
          const threadId = requireThreadIdOrSelf(ids[0], opts);
          let archivedThreadIds: string[] = [threadId];
          let keptLiveThreadIds: string[] = [];
          try {
            const result = await sdk.threads.archive({ threadId });
            archivedThreadIds = result.archivedThreadIds;
            keptLiveThreadIds = result.keptLiveThreadIds ?? [];
          } catch (err: unknown) {
            throw prependErrorContext(
              `Failed to archive thread ${threadId}`,
              err,
            );
          }
          if (
            outputJson(opts, {
              ok: true,
              threadId,
              archivedThreadIds,
              keptLiveThreadIds,
            })
          ) {
            return;
          }
          if (keptLiveThreadIds.length > 0) {
            console.log(
              `Left ${keptLiveThreadIds.length} live child thread(s) open: ${keptLiveThreadIds.join(", ")}`,
            );
          }
          const cascadedCount = archivedThreadIds.filter(
            (archivedId) => archivedId !== threadId,
          ).length;
          if (cascadedCount === 0) {
            console.log(`Thread ${threadId} archived`);
            return;
          }
          console.log(
            `Thread ${threadId} archived (${cascadedCount} related thread${cascadedCount === 1 ? "" : "s"} also archived)`,
          );
        },
      ),
    );

  parent
    .command("unarchive [id]")
    .description("Unarchive a thread")
    .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
    .option(
      "--keep-parent",
      "Keep the thread under its parent, even an archived one",
    )
    .option(
      "--with-children",
      "Also unarchive the threads under it that were archived with it",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadUnarchiveCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliRoomSdk(getUrl());
          const { unarchivedThreadIds } = await sdk.threads.unarchive({
            threadId,
            keepParent: opts.keepParent,
            withChildren: opts.withChildren,
          });
          if (outputJson(opts, { ok: true, threadId, unarchivedThreadIds }))
            return;
          // An older app's server names none.
          const others = (unarchivedThreadIds?.length ?? 1) - 1;
          console.log(
            others > 0
              ? `Thread ${threadId} unarchived (${others} related thread${others === 1 ? "" : "s"} also unarchived)`
              : `Thread ${threadId} unarchived`,
          );
        },
      ),
    );

  for (const { name, description, done } of [
    { name: "pin", description: "Pin a thread", done: "pinned" },
    { name: "unpin", description: "Unpin a thread", done: "unpinned" },
  ] as const) {
    parent
      .command(`${name} [id]`)
      .description(description)
      .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(
          async (id: string | undefined, opts: ThreadPinCommandOptions) => {
            const threadId = requireThreadIdOrSelf(id, opts);
            const sdk = createCliRoomSdk(getUrl());
            const thread = await sdk.threads[name]({ threadId });
            if (outputJson(opts, thread)) return;
            console.log(`Thread ${thread.id} ${done}`);
          },
        ),
      );
  }

  parent
    .command("delete <id>")
    .description("Delete a thread permanently")
    .option("--yes", "Skip the confirmation prompt")
    .option(
      "--confirm-child-threads",
      "Confirm deleting a thread with child threads",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ThreadDeleteCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        try {
          const thread = await sdk.threads.get({ threadId: id });

          if (!opts.yes) {
            const confirmed = await confirmDestructiveAction(
              `Delete thread "${thread.title ?? thread.titleFallback ?? thread.id}" permanently? This cannot be undone.`,
            );
            if (!confirmed) {
              console.log(`Thread ${id} deletion cancelled`);
              return;
            }
          }

          await sdk.threads.delete({
            threadId: id,
            childThreadsConfirmed: opts.confirmChildThreads === true,
          });
        } catch (err: unknown) {
          throw prependErrorContext(`Failed to delete thread ${id}`, err);
        }
        if (outputJson(opts, { ok: true, threadId: id })) return;
        console.log(`Thread ${id} deleted`);
      }),
    );

  parent
    .command("edit-message [id]")
    .description("Replace an accepted user message and rerun from that point")
    .requiredOption("--message <text>", "Replacement message text")
    .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
    .option(
      "--expected-request-sequence <sequence>",
      "Edit the message at this event sequence (default: the latest editable message)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          id: string | undefined,
          opts: ThreadEditMessageCommandOptions,
        ) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliRoomSdk(getUrl());
          const expectedRequestSequence =
            opts.expectedRequestSequence === undefined
              ? undefined
              : Number(opts.expectedRequestSequence);
          if (
            expectedRequestSequence !== undefined &&
            (!Number.isInteger(expectedRequestSequence) ||
              expectedRequestSequence < 0)
          ) {
            throw new Error(
              "--expected-request-sequence must be a non-negative integer.",
            );
          }
          const senderThreadId = resolveSenderThreadId(threadId);
          const result = await sdk.threads.editMessage({
            threadId,
            operationId: randomUUID(),
            ...(expectedRequestSequence !== undefined
              ? { expectedRequestSequence }
              : {}),
            input: buildPromptInputs({ message: opts.message }),
            ...(senderThreadId !== undefined ? { senderThreadId } : {}),
          });
          if (outputJson(opts, { threadId, ...result })) {
            return;
          }
          console.log(
            `Thread ${threadId} message replaced; workspace changes were kept`,
          );
        },
      ),
    );

  parent
    .command("tell [id] [message]")
    .description(
      "Send a follow-up message to a thread, or with --parent to the thread that started this one",
    )
    .option(
      "--parent",
      "Send to this thread's saved parent instead of <id> (needs ROOM_THREAD_ID)",
    )
    .option(
      "--message-file <path>",
      "Read the message from a UTF-8 file, or - for stdin (use it for long messages)",
    )
    .option("--json", "Print machine-readable JSON output")
    .option(
      "--model <model>",
      "Model ID for this message. Cloud threads keep their model: switch with thread update --model first",
    )
    .option("--service-tier <tier>", "Service tier: fast or default")
    .option(
      "--reasoning-level <level>",
      "Reasoning level: low, medium, high, xhigh, max (provider-dependent)",
    )
    .option("--permission-mode <mode>", PERMISSION_MODE_HELP)
    .option(
      "--mode <mode>",
      "Message mode: steer, queue, or auto. Default: steer for Local, queue for Cloud",
    )
    .option("--send-at <when>", SEND_AT_HELP)
    .option("--plan", PLAN_HELP)
    .option(
      "--file <path>",
      "Upload an absolute path or file: URL from this CLI machine or pass an uploaded attachment path (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--image <path>",
      "Upload an absolute path or file: URL from this CLI machine or pass an uploaded attachment path (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--request-id <id>",
      "Cloud only: resend an unconfirmed message with the request ID it printed, so it isn't added twice",
    )
    .action(
      action(
        async (
          idArgument: string | undefined,
          messageArgument: string | undefined,
          opts: ThreadTellCommandOptions,
        ) => {
          // With --parent the only positional is the message, as in Cloud's CLI (core/src/session/thread.rs).
          if (opts.parent && messageArgument !== undefined) {
            throw new Error("Pass either a thread ID or --parent, not both.");
          }
          const explicitId = opts.parent ? null : idArgument;
          if (explicitId === undefined || explicitId === "") {
            throw new Error("Missing thread ID. Pass <id> or use --parent.");
          }
          const argument = opts.parent ? idArgument : messageArgument;
          const { messageFile } = opts;
          if (argument !== undefined && messageFile !== undefined) {
            throw new Error(
              "Choose only one of a message argument and --message-file.",
            );
          }
          const message =
            messageFile === undefined
              ? argument
              : await readTextFileOrStdin(messageFile).catch(
                  (error: unknown) => {
                    throw new Error(
                      `--message-file ${messageFile}: ${getErrorMessage(error)}`,
                    );
                  },
                );
          if (message === undefined) {
            throw new Error(
              "Missing message: pass it as an argument or with --message-file PATH (- reads stdin).",
            );
          }
          const id = explicitId ?? (await requireParentThreadId(getUrl));
          const response = await postThreadMessage({
            getUrl,
            threadId: id,
            message,
            mode: resolveThreadMessageMode(opts.mode),
            model: opts.model,
            permissionMode: parsePermissionMode(opts.permissionMode),
            reasoningLevel: parseReasoningLevel(opts.reasoningLevel),
            serviceTier: parseServiceTier(opts.serviceTier),
            senderThreadId: resolveSenderThreadId(id),
            plan: opts.plan,
            files: opts.file,
            images: opts.image,
            ...(opts.sendAt === undefined
              ? {}
              : { sendAt: parseSendAt(opts.sendAt) }),
            ...(opts.requestId === undefined
              ? {}
              : { requestId: opts.requestId }),
          }).catch((error: unknown) => {
            if (error instanceof UnconfirmedSendError) {
              outputJson(opts, {
                ok: false,
                unconfirmed: true,
                threadId: id,
                ...(error.requestId ? { requestId: error.requestId } : {}),
                error: error.message,
              });
            }
            // Name the refused thread and why, such as since when it is archived (#1276).
            if (
              error instanceof BbHttpError &&
              error.code === "thread_not_writable"
            ) {
              outputJson(opts, {
                ok: false,
                threadId: id,
                code: error.code,
                error: error.message,
                details: (error.body as { details?: unknown } | null)?.details,
              });
            }
            throw error;
          });
          if (outputJson(opts, { threadId: id, ...response })) return;
          console.log(describeThreadTellOutcome(id, response));
        },
      ),
    );

  parent
    .command("retry [id]")
    .description("Retry the failed turn on a Local thread")
    .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
    .option(
      "--turn <requestId>",
      "Retry this turn request id specifically; fails when it is not the thread's failed turn",
    )
    .option("--send-at <when>", SEND_AT_HELP)
    .option(
      "--reason <text>",
      "Why it is being retried, shown on the queued row",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadRetryCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliRoomSdk(getUrl());
          const response = await sdk.threads.retry({
            threadId,
            ...(opts.turn === undefined ? {} : { turnRequestId: opts.turn }),
            ...(opts.sendAt === undefined
              ? {}
              : { sendAt: parseSendAt(opts.sendAt) }),
            ...(opts.reason === undefined ? {} : { reason: opts.reason }),
          });
          if (outputJson(opts, { threadId, ...response })) return;
          console.log(describeThreadRetryOutcome(threadId, response));
        },
      ),
    );

  parent
    .command("compact [id]")
    .description(
      "Compact a thread's context now, or once its running turn ends, then send a follow-up so the agent keeps going",
    )
    .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
    .option("--then <text>", "Follow-up message after compaction (default: keep going)")
    .option("--no-then", "Send no follow-up message")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThreadCompactCommandOptions, command: Command) => {
        let root = command;
        while (root.parent) root = root.parent;
        const raw = (root as Command & { rawArgs?: string[] }).rawArgs ?? [];
        if (raw.includes("--no-then") && raw.some((word) => word === "--then" || word.startsWith("--then="))) {
          throw new Error("Choose only one of --then and --no-then.");
        }
        if (typeof opts.then === "string" && !opts.then.trim()) {
          throw new Error("--then needs a message. To send none, use --no-then.");
        }
        const threadId = requireThreadIdOrSelf(id, opts);
        const then = opts.then === false ? undefined : (opts.then ?? COMPACT_THEN);
        await createCliRoomSdk(getUrl()).threads.compact({ threadId, ...(then ? { then } : {}) });
        if (outputJson(opts, { ok: true, threadId })) return;
        console.log(
          `Thread ${threadId} compacts now, or once its running turn ends${then ? ". Then it gets the follow-up, saying whether compaction worked" : ""}. If it is your own thread, end your turn now.`,
        );
      }),
    );

  for (const { name, description, method, done } of [
    {
      name: "stop",
      description: "Stop work and release the loaded agent runtime",
      method: "stop",
      done: "stopped",
    },
    {
      name: "clear",
      description: "Clear model context for an idle or failed thread",
      method: "clearContext",
      done: "context cleared",
    },
    {
      name: "cancel-plan",
      description: "Ask the provider to exit the active Plan mode",
      method: "cancelPlan",
      done: "exited Plan mode",
    },
    {
      name: "clear-goal",
      description:
        "Ask the provider to clear the active Goal (Codex threads only)",
      method: "clearGoal",
      done: "cleared its Goal",
    },
  ] as const) {
    parent
      .command(`${name} [id]`)
      .description(description)
      .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (id: string | undefined, opts: ThreadActionOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliRoomSdk(getUrl());
          const result: { ok: true; cancelledRetries?: number } =
            await sdk.threads[method]({
              threadId,
              // Only this explicit stop ends what the agent left running (#607).
              ...(method === "stop" ? { endProcesses: true } : {}),
            }).catch((error: unknown) => {
              // Name the code the room-cli skill tells agents to look for.
              if (
                error instanceof BbHttpError &&
                error.code === "thread_stop_unconfirmed"
              ) {
                throw new Error(`${error.message} (${error.code})`);
              }
              throw error;
            });
          if (outputJson(opts, { ...result, threadId })) return;
          const cancelled = result.cancelledRetries ?? 0;
          console.log(
            cancelled > 0
              ? `Thread ${threadId} ${done}; cancelled ${cancelled} pending automatic ${cancelled === 1 ? "retry" : "retries"}`
              : `Thread ${threadId} ${done}`,
          );
        }),
      );
  }
  // Only the user (or their CLI) may resume a Goal; the agent can only pause or finish it.
  for (const [name, description, status, done] of [
    [
      "pause-goal",
      "Pause the active Goal (Codex threads only)",
      "paused",
      "paused its Goal",
    ],
    [
      "resume-goal",
      "Resume a paused or blocked Goal (Codex threads only)",
      "active",
      "resumed its Goal",
    ],
  ] as const) {
    parent
      .command(`${name} [id]`)
      .description(description)
      .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (id: string | undefined, opts: ThreadActionOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          await createCliRoomSdk(getUrl()).threads.setGoal({ threadId, status });
          if (outputJson(opts, { ok: true, threadId })) return;
          console.log(`Thread ${threadId} ${done}`);
        }),
      );
  }
  parent
    .command("set-goal <objective> [id]")
    .description(
      "Start a Goal, or replace the current Goal's objective (Codex threads only)",
    )
    .option("--self", "Target the current thread (from ROOM_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (objective: string, id: string | undefined, opts: ThreadActionOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          await createCliRoomSdk(getUrl()).threads.setGoal({ threadId, objective });
          if (outputJson(opts, { ok: true, threadId })) return;
          console.log(`Thread ${threadId} set its Goal`);
        },
      ),
    );
}

export async function postThreadMessage(
  args: PostThreadMessageArgs,
): Promise<PostThreadMessageResult> {
  requirePromptContent(args);
  // Bounded like spawn's send, so a server that never answers can't hang the caller (#1832).
  const sdk = createCliRoomSdk(args.getUrl(), DEFAULT_BB_REQUEST_TIMEOUT_MS);
  // A retry's lookup decides whether it may send, so a hung server can't hang it.
  const thread =
    args.mode === undefined || args.requestId !== undefined
      ? await (
          args.requestId === undefined
            ? sdk
            : createCliRoomSdk(args.getUrl(), CLI_READ_TIMEOUT_MS)
        ).threads.get({ threadId: args.threadId })
      : undefined;
  // Local starts a new turn for every send, so a reused ID wouldn't stop a duplicate there.
  if (args.requestId !== undefined && thread?.executionTarget !== "cloud") {
    throw new Error(
      `--request-id works only for Cloud threads. Check \`room-cli thread log ${args.threadId}\` and \`room-cli thread queue list ${args.threadId}\` before sending again.`,
    );
  }
  // Chosen before sending, so a lost answer still leaves an ID to retry with.
  const requestId = args.requestId ?? randomUUID();
  const mode =
    args.mode ?? (thread?.executionTarget === "cloud" ? "queue" : "steer");
  const input = await uploadClientAttachmentInputs({
    input: buildPromptInputs({
      message: args.message,
      plan: args.plan,
      files: args.files,
      images: args.images,
    }),
    resolveProjectId: async () =>
      (thread ?? (await sdk.threads.get({ threadId: args.threadId })))
        .projectId,
    // Uploads keep no deadline: a large file may take longer.
    sdk: createCliRoomSdk(args.getUrl()),
  });
  const sending = sdk.threads.send({
    threadId: args.threadId,
    requestId,
    input,
    mode:
      mode === "steer"
        ? "steer-if-active"
        : mode === "auto"
          ? "auto"
          : "queue-if-active",
    ...(args.model ? { model: args.model } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
    ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
    ...(args.senderThreadId ? { senderThreadId: args.senderThreadId } : {}),
    ...(args.sendAt === undefined ? {} : { sendAt: args.sendAt }),
  });
  const response = await sending.catch(async (error: unknown) => {
    // A reused ID that the server already holds: the message is saved, so resending would only conflict again.
    if (
      args.requestId !== undefined &&
      error instanceof BbHttpError &&
      error.code === "request_conflict"
    ) {
      throw new Error(
        `Request ID ${args.requestId} was already used, so this message was not added again. If you are resending an unconfirmed message, it is already saved: check \`room-cli thread show ${args.threadId}\` and don't send it again.`,
      );
    }
    throw await describeFailedSend(args.threadId, error, async () => {
      // Only picks the hint, so 5 s: a server that lost the reply may not answer this either; then no ID (the safe side).
      const target =
        thread ??
        (await createCliRoomSdk(args.getUrl(), 5_000)
          .threads.get({ threadId: args.threadId })
          .catch(() => null));
      return target?.executionTarget === "cloud" ? requestId : undefined;
    });
  });
  return { ...response, mode };
}

const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Say whether a failed send reached the thread, so nobody resends blindly.
 * `retryId` gives the request ID only for a Cloud target, the one that dedupes it.
 */
async function describeFailedSend(
  threadId: string,
  error: unknown,
  retryId: () => Promise<string | undefined>,
): Promise<unknown> {
  // A caller-proof refusal or a failed connect happens before the server
  // looks at the message.
  const notSent =
    error instanceof BbHttpError
      ? error.code === CALLER_PROOF_REQUIRED_CODE
      : neverConnected(error);
  if (notSent) {
    return new Error(
      `The message was not sent; sending it again is safe. ${getErrorMessage(error)}`,
    );
  }
  // A 4xx is the server refusing the message; anything else (a tunnel 504 too) may follow acceptance.
  if (error instanceof BbHttpError && error.status < 500) return error;
  const requestId = await retryId();
  const retry =
    requestId === undefined
      ? ""
      : ` To resend it, run \`room-cli thread tell ${threadId}\` with the same message, options, and \`--request-id ${requestId}\`; Cloudroom won't add it twice.`;
  // A 500's error ID finds its server log line (#1341).
  const errorId =
    error instanceof BbHttpError
      ? (error.body as { errorId?: unknown } | null)?.errorId
      : undefined;
  const timedOut = error instanceof BbRequestTimeoutError;
  const reason = timedOut
    ? `no answer within ${DEFAULT_BB_REQUEST_TIMEOUT_MS / 1000} seconds; it may be busy`
    : `${getErrorMessage(error)}${typeof errorId === "string" ? `, error ID ${errorId}` : ""}`;
  // The server may still be working on it, so the log and queue can lag (#1832).
  const lag = timedOut
    ? " The server may still be handling it, so an empty log and queue don't prove it wasn't sent: wait a minute and check again before resending."
    : "";
  // A sent message shows in the log, a queued one in the queue; `thread show` lists neither.
  return new UnconfirmedSendError(
    `Cloudroom did not confirm the message, so it may already have been sent (${reason}). Check \`room-cli thread log ${threadId}\` and \`room-cli thread queue list ${threadId}\` before sending it again.${lag}${retry}`,
    requestId,
  );
}

function neverConnected(error: unknown): boolean {
  let current = error;
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_FAILURE_CODES.has(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function describeThreadTellOutcome(
  threadId: string,
  response: PostThreadMessageResult,
): string {
  if (response.delivery === "queued" && response.queuedMessage.pausedByStop) {
    return `Thread ${threadId} was stopped by the user; message ${response.queuedMessage.id} waits until the user messages that thread. Do not resend it or \`queue send\` it.`;
  }
  if (response.delivery === "queued") {
    // The server says WHY it is waiting, so the CLI does not have to guess
    // from the flags it happened to send. `room-cli thread queue list` shows the
    // same reason for the row afterwards.
    const queued = `Thread ${threadId} message queued (${describeQueueWait(response.queuedMessage)})`;
    const send = `\`room-cli thread queue send ${threadId} ${response.queuedMessage.id}\``;
    // A message cannot answer a question: say how to see and answer it (#1400).
    if (response.queuedMessage.waitingOn?.kind === "interaction") {
      return `${queued}; it dispatches once that is resolved. \`room-cli thread interactions list ${threadId}\` shows it, and \`show\` prints how to answer.`;
    }
    // Stop does not pause a scheduled row, and `queue send` skips its schedule (#999).
    return response.queuedMessage.waitingOn?.kind === "time"
      ? `${queued}; it dispatches at that time on its own. Do not run ${send}: it sends the message now.`
      : `${queued}; it dispatches when that clears unless Stop pauses the queue, then run ${send}`;
  }
  // "sent" means saved and handed to the agent, not accepted: a rejection
  // lands later and puts the thread in `error` (#1536).
  return `Thread ${threadId} message sent; the agent has not confirmed it yet. If it fails, \`room-cli thread show ${threadId}\` shows status error and why.`;
}

/**
 * What the retry did. A retry is a dispatch like any other, so it either went
 * or is waiting — and when it is waiting the server says why, exactly as `tell`
 * reports a queued send.
 */
function describeThreadRetryOutcome(
  threadId: string,
  response: ThreadRetryResult,
): string {
  const turn = `turn ${response.turnRequestId} (attempt ${response.attempt})`;
  return response.delivery === "queued"
    ? `Thread ${threadId} retry of ${turn} queued (${describeQueueWait(response)}); it dispatches when that clears`
    : `Thread ${threadId} retrying ${turn}`;
}

/** One short phrase for a queued row's wait, shared by `tell` and `queue`. */
export function describeQueueWait(row: {
  failureReason?: string | null;
  hardQueue?: boolean;
  pausedByStop?: boolean;
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}): string {
  if (typeof row.failureReason === "string") {
    return `failed, \`queue send\` retries: ${row.failureReason}`;
  }
  if (row.pausedByStop === true) {
    return "paused by Stop; a new message or `queue send` releases it";
  }
  const waitingOn = row.waitingOn ?? { kind: "thread-busy" as const };
  if (row.hardQueue === true && waitingOn.kind === "thread-busy") {
    return "hard queue: waiting for the thread and its child threads";
  }
  switch (waitingOn.kind) {
    case "time":
      return row.sendAt === null
        ? "scheduled"
        : `scheduled for ${new Date(row.sendAt).toLocaleString()}`;
    case "thread-busy":
      return "waiting for the current turn to finish";
    case "stopping":
      return "sending once the thread finishes stopping";
    case "turn-starting":
      return "waiting for the current turn to start";
    case "provisioning":
      return "waiting for the workspace";
    case "host-offline":
      return `waiting for ${waitingOn.hostName} to reconnect`;
    case "interaction":
      return "waiting for a pending interaction";
    case "repeated-message":
      return "held: this exact message already ran 5 times in a row; a person must send or delete it";
    case "plugin":
      return `${waitingOn.pluginId}: ${waitingOn.reason}`;
  }
}

/** `tell --parent`: the caller's parent as saved now, so a thread the user moved reaches its new parent, as in Cloud. */
async function requireParentThreadId(getUrl: () => string): Promise<string> {
  const callerId = resolveContextThreadId();
  if (!callerId) {
    throw new Error(
      "--parent needs ROOM_THREAD_ID: run it inside a Cloudroom thread, or pass a thread ID.",
    );
  }
  const caller = await createCliRoomSdk(
    getUrl(),
    CLI_READ_TIMEOUT_MS,
  ).threads.get({ threadId: callerId });
  if (!caller.parentThreadId) {
    throw new Error(
      `Thread ${callerId} has no parent that \`thread tell --parent\` can reach.`,
    );
  }
  return caller.parentThreadId;
}

export function resolveSenderThreadId(
  targetThreadId: string,
): string | undefined {
  const senderThreadId = resolveContextThreadId();
  if (!senderThreadId || senderThreadId === targetThreadId) {
    return undefined;
  }
  return senderThreadId;
}

function resolveThreadMessageMode(
  value: string | undefined,
): ThreadTellDeliveryMode | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "steer") return "steer";
  if (normalized === "steer-if-active") return "steer";
  if (normalized === "queue") return "queue";
  if (normalized === "queue-if-active") return "queue";
  if (normalized === "auto") return "auto";
  throw new Error(
    `Invalid message mode '${value}'. Expected 'queue', 'steer', or 'auto'.`,
  );
}
