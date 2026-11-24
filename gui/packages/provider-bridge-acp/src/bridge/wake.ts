import { extractAcpContentText } from "../wire.js";
import type { AcpContentBlock } from "../wire.js";

/** An agent-started turn closes after this long without an update: ACP has no "done" signal for one. */
const QUIET_MS = 30_000;
/** A running command or a waiting question holds it open, for at most this long without an update. */
const HELD_MS = 600_000;
/** Output this soon after a prompt ended is that prompt's leftover, not new work. */
const LEFTOVER_MS = 2_000;

const ENDED_CALL_STATUSES: ReadonlySet<unknown> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

interface AcpWakeUpdate {
  sessionUpdate: string;
  toolCallId?: unknown;
  status?: unknown;
  content?: unknown;
}

export interface AcpWakeHooks {
  /** No turn is open. */
  isIdle(): boolean;
  /** Something other than the agent's own command holds the turn: a question to the user, a tool Cloudroom runs. */
  isHeld(): boolean;
  /** Text the chat never shows. */
  isNotice?(text: string): boolean;
  openTurn(): void;
  closeTurn(): void;
}

export interface AcpWake {
  /** The open turn is one the agent started itself. */
  readonly active: boolean;
  /** Takes every agent update: opens an agent-started turn, or keeps one open. */
  note(update: AcpWakeUpdate): void;
  /** Restarts the quiet timer, as when the user answers a question. */
  touch(): void;
  promptEnded(): void;
  /** The turn ended, or a prompt took it over. */
  end(): void;
}

/**
 * An agent can keep working after its turn ended, as agy does when a background command finishes. That work gets a turn
 * of its own, so it reaches the chat and the thread shows as working, until the agent goes quiet.
 */
export function createAcpWake(hooks: AcpWakeHooks): AcpWake {
  let timer: NodeJS.Timeout | undefined;
  let promptEndedAt: number | undefined;
  const runningCalls = new Set<unknown>();

  function arm(since = Date.now()): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const held = runningCalls.size > 0 || hooks.isHeld();
      if (held && Date.now() - since < HELD_MS) arm(since);
      else hooks.closeTurn();
    }, QUIET_MS);
  }

  function isNewWork(update: AcpWakeUpdate): boolean {
    // A session that never ran a prompt has no work to resume.
    if (
      promptEndedAt === undefined ||
      Date.now() - promptEndedAt < LEFTOVER_MS
    ) {
      return false;
    }
    if (update.sessionUpdate === "tool_call") {
      return true;
    }
    if (
      update.sessionUpdate !== "agent_message_chunk" &&
      update.sessionUpdate !== "agent_thought_chunk"
    ) {
      return false;
    }
    const text = extractAcpContentText(
      update.content as AcpContentBlock | undefined,
    );
    return (
      text !== undefined && text.trim() !== "" && hooks.isNotice?.(text) !== true
    );
  }

  return {
    get active() {
      return timer !== undefined;
    },
    note(update) {
      if (timer === undefined) {
        if (!hooks.isIdle() || !isNewWork(update)) {
          return;
        }
        hooks.openTurn();
      }
      if (ENDED_CALL_STATUSES.has(update.status)) {
        runningCalls.delete(update.toolCallId);
      } else if (update.sessionUpdate === "tool_call") {
        runningCalls.add(update.toolCallId);
      }
      arm();
    },
    touch() {
      if (timer !== undefined) arm();
    },
    promptEnded() {
      promptEndedAt = Date.now();
    },
    end() {
      clearTimeout(timer);
      timer = undefined;
      runningCalls.clear();
    },
  };
}
