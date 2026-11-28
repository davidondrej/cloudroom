import {
  archiveThread,
  deleteQueuedThreadMessage,
  getThread,
  listQueuedThreadMessages,
  listUnarchivedAssignedChildThreads,
  type ClaimedQueuedThreadMessageRow,
  type DbNotifier,
  type DbTransaction,
  unarchiveThread,
  updateThread,
} from "@cloudroom/db";
import type {
  PromptInput,
  QueuedMessageSystemNotice,
  SystemMessageKind,
  Thread,
} from "@cloudroom/domain";
import { renderTemplate } from "@cloudroom/templates";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import {
  buildParentSystemInputFromTemplateSlot,
  buildParentSystemThreadMention,
  parentSystemThreadLabel,
  queueParentSystemMessage,
  UnsentParentSystemMessageError,
} from "./parent-system-messages.js";
import { systemMessageKindForTemplate } from "./system-message-kind.js";
import {
  appendThreadOwnershipChangeEvent,
  appendThreadOwnershipChangeEventInTransaction,
} from "./thread-events.js";

interface ThreadLabelSource {
  id: string;
  projectId: string;
  title: string | null;
}

type ThreadOwnershipTemplateId =
  | "systemMessageThreadOwnershipAssigned"
  | "systemMessageThreadOwnershipRemoved";

interface HandleThreadOwnershipChangeArgs {
  previousThread: Thread;
  updatedThread: Thread;
}

interface ReleaseUnarchivedChildrenFromArchivedThreadArgs {
  parentThreadId: string;
  sectionId: string | null;
}

interface ArchiveThreadAndReleaseChildrenArgs {
  threadId: string;
}

interface ThreadOwnershipTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
}

const THREAD_OWNERSHIP_MENTION_SLOT = "__BB_THREAD_OWNERSHIP_MENTION__";

/**
 * What a parent was last told about a child (true: "now a child"), as
 * "parent:child", while notices about it are on their way, with the child as
 * committed by a move not yet told. One run at a time tells the parent until
 * that matches the child's parent (#2281).
 */
const ownershipNoticeRuns = new Map<
  string,
  { child: Thread | null; running: boolean; told: boolean }
>();

/** Whether the child's parent, as read now, is still as the notice says. */
function ownershipNoticeHolds(
  child: Pick<Thread, "parentThreadId"> | null,
  parentThreadId: string,
  kind: SystemMessageKind,
): boolean {
  const isChild = child?.parentThreadId === parentThreadId;
  return isChild === (kind === "ownership-assigned");
}

/** A queued ownership notice about this child, unless the user edited it. */
function ownershipNoticeAbout(
  row: { content: string; systemNotice: string | null },
  childThread: ThreadLabelSource,
): SystemMessageKind | null {
  if (row.systemNotice === null) return null;
  const notice = JSON.parse(row.systemNotice) as QueuedMessageSystemNotice;
  const templateId =
    notice.kind === "ownership-assigned"
      ? "systemMessageThreadOwnershipAssigned"
      : notice.kind === "ownership-removed"
        ? "systemMessageThreadOwnershipRemoved"
        : null;
  if (
    templateId === null ||
    notice.subject?.kind !== "thread" ||
    notice.subject.threadId !== childThread.id
  ) {
    return null;
  }
  // An edited notice holds the user's text, so it is never cancelled.
  const queued = buildThreadOwnershipSystemInput(templateId, {
    ...childThread,
    title: notice.subject.threadName,
  });
  return row.content === JSON.stringify(queued) ? notice.kind : null;
}

/**
 * A queued ownership notice, unedited, whose change was undone before it was
 * delivered: sending it would wake the parent for something untrue (#2281).
 */
export function isUndoneQueuedOwnershipNotice(
  row: Pick<
    ClaimedQueuedThreadMessageRow,
    "content" | "subjectThread" | "systemNotice" | "threadId"
  >,
  { kind, subject }: QueuedMessageSystemNotice,
): boolean {
  if (
    (kind !== "ownership-assigned" && kind !== "ownership-removed") ||
    subject?.kind !== "thread"
  ) {
    return false;
  }
  // The claim read the child, so a drain of many notices reads none (#2281).
  const child = row.subjectThread;
  return (
    child !== null &&
    ownershipNoticeAbout(row, {
      ...child,
      id: subject.threadId,
      title: null,
    }) !== null &&
    !ownershipNoticeHolds(child, row.threadId, kind)
  );
}

/**
 * Tells a parent the child's ownership until what it was last told matches the
 * child's parent. A move while a notice is on its way is left to this run,
 * which tells the parent once it settles, so a notice undone meanwhile (dropped
 * right before it is written) is never sent and a lasting change still is.
 */
async function tellParentOwnership(
  deps: LoggedPendingInteractionWorkSessionDeps,
  parentThreadId: string,
  childThreadId: string,
): Promise<void> {
  const key = `${parentThreadId}:${childThreadId}`;
  const run = ownershipNoticeRuns.get(key);
  if (!run || run.running) return;
  run.running = true;
  const logFailure = (err: unknown) =>
    deps.logger.error(
      { childThreadId, parentThreadId, err },
      "Failed to queue parent ownership system message",
    );
  try {
    // Starts from the committed move; one made meanwhile brings another pass.
    for (let child = run.child; child !== null; child = run.child) {
      run.child = null;
      const isChild = child.parentThreadId === parentThreadId;
      if (isChild === run.told) return;
      const told = run.told;
      run.told = isChild;
      const templateId = isChild
        ? "systemMessageThreadOwnershipAssigned"
        : "systemMessageThreadOwnershipRemoved";
      const kind = systemMessageKindForTemplate(templateId);
      // A notice about this child still queued for the parent is a change it
      // hasn't heard yet. This change undoes or repeats it, so neither wakes the
      // parent: the next notice it gets matches the relationship (#2281).
      const queued = listQueuedThreadMessages(deps.db, parentThreadId)
        .filter((row) => ownershipNoticeAbout(row, child))
        .at(-1);
      if (queued) {
        if (ownershipNoticeAbout(queued, child) !== kind) {
          deleteQueuedThreadMessage(deps.db, deps.hub, queued.id);
        }
        return; // Nothing yielded since the move, so the parent is up to date.
      }
      // An archived child needs nothing from its parent, so moving one (say, a
      // retired parent's 50) tells neither parent; its own history keeps it (#2639).
      if (child.archivedAt !== null) return;
      try {
        await queueParentSystemMessage(deps, {
          input: buildThreadOwnershipSystemInput(templateId, child),
          parentThreadId,
          systemMessageKind: kind,
          systemMessageSubject: {
            kind: "thread",
            threadId: child.id,
            threadName: parentSystemThreadLabel(child),
          },
          stillAccurate: () =>
            ownershipNoticeHolds(
              getThread(deps.db, child.id),
              parentThreadId,
              kind,
            ),
        });
      } catch (error) {
        if (error instanceof UnsentParentSystemMessageError) {
          run.told = told; // Undone meanwhile: nothing was sent.
          run.child = getThread(deps.db, child.id);
          continue;
        }
        logFailure(error); // Counted as told: a change since gets its own.
      }
    }
  } catch (error) {
    logFailure(error); // Best effort: the move is committed either way.
  } finally {
    ownershipNoticeRuns.delete(key);
  }
}

function buildThreadOwnershipSystemInput(
  templateId: ThreadOwnershipTemplateId,
  thread: ThreadLabelSource,
): PromptInput[] {
  const mention = buildParentSystemThreadMention({ thread });
  const renderedText = renderTemplate(templateId, {
    threadMention: THREAD_OWNERSHIP_MENTION_SLOT,
  });
  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: THREAD_OWNERSHIP_MENTION_SLOT,
    segments: [{ kind: "mention", mention }],
  });
}

export async function handleThreadOwnershipChange(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: HandleThreadOwnershipChangeArgs,
): Promise<void> {
  if (
    args.updatedThread.parentThreadId === args.previousThread.parentThreadId
  ) {
    return;
  }

  appendThreadOwnershipChangeEvent(deps, {
    threadId: args.updatedThread.id,
    environmentId: args.updatedThread.environmentId,
    previousParentThreadId: args.previousThread.parentThreadId,
    nextParentThreadId: args.updatedThread.parentThreadId,
  });

  // Each parent was last told the relationship before this change, unless a
  // run for it is still on its way, which knows what it told and tells this
  // move once its notice settles.
  const parentThreadIds = [
    args.updatedThread.parentThreadId,
    args.previousThread.parentThreadId,
  ].filter((id): id is string => id !== null);
  for (const parentThreadId of parentThreadIds) {
    const key = `${parentThreadId}:${args.updatedThread.id}`;
    const run = ownershipNoticeRuns.get(key);
    if (run) run.child = args.updatedThread;
    else {
      ownershipNoticeRuns.set(key, {
        child: args.updatedThread,
        running: false,
        told: args.previousThread.parentThreadId === parentThreadId,
      });
    }
  }
  for (const parentThreadId of parentThreadIds) {
    await tellParentOwnership(deps, parentThreadId, args.updatedThread.id);
  }
}

function releaseUnarchivedChildrenFromArchivedThreadInTransaction(
  deps: ThreadOwnershipTransactionDeps,
  args: ReleaseUnarchivedChildrenFromArchivedThreadArgs,
): void {
  const childThreads = listUnarchivedAssignedChildThreads(deps.db, {
    parentThreadId: args.parentThreadId,
  });

  for (const childThread of childThreads) {
    releaseChildInTransaction(deps, childThread, args.sectionId);
  }
}

function releaseChildInTransaction(
  deps: ThreadOwnershipTransactionDeps,
  childThread: Thread,
  sectionId: string | null,
): Thread | null {
  const updatedThread = updateThread(deps.db, deps.hub, childThread.id, {
    parentThreadId: null,
    sectionId,
  });
  if (!updatedThread) {
    return null;
  }
  appendThreadOwnershipChangeEventInTransaction(deps, {
    threadId: updatedThread.id,
    environmentId: updatedThread.environmentId,
    previousParentThreadId: childThread.parentThreadId,
    nextParentThreadId: updatedThread.parentThreadId,
  });
  return updatedThread;
}

export function unarchiveThreadKeepingOpenParent(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "hub">,
  threadId: string,
  keepParent = false,
): Thread | null {
  const notificationBuffer = new NotificationBuffer();
  const result = deps.db.transaction(
    (tx) => {
      const thread = unarchiveThread(tx, notificationBuffer, threadId);
      if (!thread?.parentThreadId) {
        return thread;
      }
      const parent = getThread(tx, thread.parentThreadId);
      if (
        parent &&
        parent.deletedAt === null &&
        (keepParent || parent.archivedAt === null)
      ) {
        return thread;
      }
      return releaseChildInTransaction(
        { db: tx, hub: notificationBuffer },
        thread,
        parent?.sectionId ?? thread.sectionId,
      );
    },
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);
  return result;
}

export function archiveThreadAndReleaseChildren(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "hub">,
  args: ArchiveThreadAndReleaseChildrenArgs,
): Thread | null {
  const notificationBuffer = new NotificationBuffer();
  const result = deps.db.transaction(
    (tx) => {
      const archivedThread = archiveThread(
        tx,
        notificationBuffer,
        args.threadId,
      );
      if (!archivedThread) {
        return null;
      }

      releaseUnarchivedChildrenFromArchivedThreadInTransaction(
        {
          db: tx,
          hub: notificationBuffer,
        },
        {
          parentThreadId: archivedThread.id,
          sectionId: archivedThread.sectionId,
        },
      );

      return archivedThread;
    },
    { behavior: "immediate" },
  );

  notificationBuffer.flushInto(deps.hub);
  return result;
}
