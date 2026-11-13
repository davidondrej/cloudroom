import type { ThreadEvent } from "./provider-event.js";

/** A piece of streamed text or output. Each adds its `delta` to what its item already has. */
export type StreamDeltaEvent = Extract<ThreadEvent, { delta: string }>;

const STREAM_DELTA_TYPES: ReadonlySet<string> = new Set<
  StreamDeltaEvent["type"]
>([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/plan/delta",
]);

// One fast command can print megabytes. A joined piece stays small enough to read and send in one go.
const MAX_JOINED_DELTA_CHARS = 64 * 1024;

export function isStreamDeltaEvent(
  event: ThreadEvent,
): event is StreamDeltaEvent {
  return STREAM_DELTA_TYPES.has(event.type);
}

/**
 * The two pieces as one event, or null when they must stay two. A stream saved one row per token costs a disk
 * write per token (#1248), and readers only ever join the pieces of an item in order.
 *
 * Only call this for events that follow each other in their thread, with no other event between them: joining
 * across another event would move text past it.
 */
export function joinStreamDeltas(
  first: ThreadEvent,
  second: ThreadEvent,
): StreamDeltaEvent | null {
  if (
    first.type !== second.type ||
    !isStreamDeltaEvent(first) ||
    !isStreamDeltaEvent(second)
  ) {
    return null;
  }
  // A reset replaces the output so far, so it starts a new piece. A piece that follows a reset still only adds.
  if ("reset" in second && second.reset) {
    return null;
  }
  if (first.delta.length + second.delta.length > MAX_JOINED_DELTA_CHARS) {
    return null;
  }
  // Same thread, session, turn, parent tool call and item: every field but the text must match, so a field added
  // later keeps pieces apart until this function learns what it means.
  const { delta: firstDelta, ...firstRest } = first;
  const { delta: secondDelta, ...secondRest } = second;
  if (
    JSON.stringify(sorted({ ...firstRest, reset: undefined })) !==
    JSON.stringify(sorted({ ...secondRest, reset: undefined }))
  ) {
    return null;
  }
  return { ...first, delta: firstDelta + secondDelta };
}

function sorted(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
