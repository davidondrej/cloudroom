import {
  archiveThread,
  deleteQueuedThreadMessage,
  getThread,
  listQueuedThreadMessages,
  listUnarchivedAssignedChildThreads,
  type DbNotifier,
  type DbTransaction,
  unarchiveThread,
  updateThread,
} from "@cloudroom/db";
import type {
  PromptInput,
  QueuedMessageSystemNotice,
  SystemMessageKind,
  SystemMessageSubject,
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

interface QueueParentSystemMessageBestEffortArgs {
  childThread: ThreadLabelSource & Pick<Thread, "archivedAt">;
  input: PromptInput[];
  parentThreadId: string;
  reason: "assigned" | "removed";
  templateId: ThreadOwnershipTemplateId;
  threadName: string;
}

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

async function queueParentSystemMessageBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueParentSystemMessageBestEffortArgs,
): Promise<void> {
  try {
    const kind = systemMessageKindForTemplate(args.templateId);
    // A notice about this child still queued for the parent is a change it
    // hasn't heard yet. This change undoes or repeats it, so neither wakes the
    // parent: the next notice it gets matches the relationship (#2281).
    const queued = listQueuedThreadMessages(deps.db, args.parentThreadId)
      .filter((row) => ownershipNoticeAbout(row, args.childThread))
      .at(-1);
    if (queued) {
      if (ownershipNoticeAbout(queued, args.childThread) !== kind) {
        deleteQueuedThreadMessage(deps.db, deps.hub, queued.id);
      }
      return;
    }
    // An archived child needs nothing from its parent, so moving one (say, a
    // retired parent's 50) tells neither parent; its own history keeps it (#2639).
    if (args.childThread.archivedAt !== null) return;
    const subject: SystemMessageSubject = {
      kind: "thread",
      threadId: args.childThread.id,
      threadName: args.threadName,
    };
    await queueParentSystemMessage(deps, {
      input: args.input,
      parentThreadId: args.parentThreadId,
      systemMessageKind: kind,
      systemMessageSubject: subject,
    });
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        reason: args.reason,
        err: error,
      },
      "Failed to queue parent ownership system message",
    );
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

  if (args.updatedThread.parentThreadId) {
    await queueParentSystemMessageBestEffort(deps, {
      childThread: args.updatedThread,
      parentThreadId: args.updatedThread.parentThreadId,
      input: buildThreadOwnershipSystemInput(
        "systemMessageThreadOwnershipAssigned",
        args.updatedThread,
      ),
      reason: "assigned",
      templateId: "systemMessageThreadOwnershipAssigned",
      threadName: parentSystemThreadLabel(args.updatedThread),
    });
  }
  if (args.previousThread.parentThreadId) {
    await queueParentSystemMessageBestEffort(deps, {
      childThread: args.updatedThread,
      parentThreadId: args.previousThread.parentThreadId,
      input: buildThreadOwnershipSystemInput(
        "systemMessageThreadOwnershipRemoved",
        args.updatedThread,
      ),
      reason: "removed",
      templateId: "systemMessageThreadOwnershipRemoved",
      threadName: parentSystemThreadLabel(args.updatedThread),
    });
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
