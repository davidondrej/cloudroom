import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";

export type Thread = PluginThreadEventPayloads["thread.idle"]["thread"];
export type Interaction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];
export type Kind = "question" | "error" | "finished";

export interface PendingEvents {
  bodies: Partial<Record<Kind, string>>;
  eventAt: number;
}

const KIND_PRIORITY: readonly Kind[] = ["question", "error", "finished"];
const TITLE_MAX_LENGTH = 80;
const BODY_MAX_LENGTH = 180;

export function firstLine(text: string | null | undefined): string {
  return (
    (text ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function threadTitle(thread: Thread): string {
  return (
    thread.title?.trim() ||
    thread.titleFallback?.trim() ||
    `Thread ${thread.id.slice(0, 8)}`
  );
}

export function describeInteraction(interaction: Interaction): string {
  const payload = interaction.payload;
  if (payload.kind === "user_question") {
    return (
      firstLine(payload.questions[0]?.prompt) ||
      "The agent has a question for you"
    );
  }
  if (payload.kind === "approval") {
    const subject = payload.subject;
    if (subject.kind === "command") {
      return `Approve command: ${firstLine(subject.command)}`;
    }
    if (subject.kind === "file_change") return "Approve file changes";
    if (subject.kind === "permission_grant") {
      return subject.toolName
        ? `Grant permissions to ${subject.toolName}`
        : "Grant additional permissions";
    }
    return "Review the plan before the agent continues";
  }
  if ("title" in payload) return payload.title;
  return "Waiting for your input";
}

export function resolveNotification(
  thread: Thread,
  events: PendingEvents,
  openInteraction: Interaction | null,
): { title: string; body: string } | null {
  if (
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.visibility !== "visible"
  ) {
    return null;
  }
  const lastReadAt = thread.lastReadAt ?? 0;
  const unread = lastReadAt < thread.latestAttentionAt;
  if (!unread && lastReadAt >= events.eventAt) return null;
  const stillTrue: Record<Kind, boolean> = {
    question: openInteraction !== null,
    error: thread.status === "error",
    finished: thread.status === "idle" && unread,
  };
  const kind = KIND_PRIORITY.find(
    (candidate) =>
      events.bodies[candidate] !== undefined && stillTrue[candidate],
  );
  if (kind === undefined) return null;
  const body =
    kind === "question" && openInteraction !== null
      ? describeInteraction(openInteraction)
      : (events.bodies[kind] ?? "");
  return {
    title: truncate(threadTitle(thread), TITLE_MAX_LENGTH),
    body: truncate(body, BODY_MAX_LENGTH),
  };
}
