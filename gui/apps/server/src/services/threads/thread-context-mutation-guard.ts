import { ApiError } from "../../errors.js";

const inFlightByThreadId = new Map<string, number>();
/** Why sends wait, while an exclusive change other than a context clear holds the thread. */
const busyMessageByThreadId = new Map<string, string>();

export class ThreadContextClearInProgressError extends ApiError {
  constructor(message = "Thread context is being cleared") {
    super(409, "invalid_request", message);
  }
}

async function withThreadContextMutationGuard<T>(
  threadId: string,
  mode: "clear" | "send",
  work: () => Promise<T>,
  busyMessage?: string,
): Promise<T> {
  const inFlight = inFlightByThreadId.get(threadId) ?? 0;
  if (inFlight !== 0 && (mode === "clear" || inFlight < 0)) {
    if (mode === "send")
      throw new ThreadContextClearInProgressError(
        busyMessageByThreadId.get(threadId),
      );
    throw new ApiError(
      409,
      "invalid_request",
      "Thread is processing another request",
    );
  }
  inFlightByThreadId.set(threadId, mode === "clear" ? -1 : inFlight + 1);
  if (busyMessage !== undefined) busyMessageByThreadId.set(threadId, busyMessage);
  try {
    return await work();
  } finally {
    const remaining =
      mode === "clear" ? 0 : (inFlightByThreadId.get(threadId) ?? 1) - 1;
    if (mode === "clear") busyMessageByThreadId.delete(threadId);
    if (remaining === 0) inFlightByThreadId.delete(threadId);
    else inFlightByThreadId.set(threadId, remaining);
  }
}

export async function withThreadSendGuard<T>(
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  return withThreadContextMutationGuard(threadId, "send", work);
}

export async function withThreadContextClearGuard<T>(
  threadId: string,
  work: () => Promise<T>,
  busyMessage?: string,
): Promise<T> {
  return withThreadContextMutationGuard(threadId, "clear", work, busyMessage);
}
