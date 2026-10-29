import { cloudExecution, cloudroom, isCloudThread } from "../cloudroom/commands.js";
import { isStandaloneBuiltinClearCommand, type Thread } from "@cloudroom/domain";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@cloudroom/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { captureUserMessageSentTelemetry, sendThreadMessage } from "./thread-send.js";

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  thread: Thread;
}

export async function acceptThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  if (isCloudThread(args.thread)) {
    const sentAt = Date.now();
    const response = await cloudroom(deps).send(args.thread, args.payload);
    if (!args.payload.senderThreadId && args.payload.input.length > 0) {
      captureUserMessageSentTelemetry(deps, { execution: cloudExecution(deps, args.thread.id), isChildThread: args.thread.parentThreadId !== null, messageSource: "thread_send", providerId: args.thread.providerId, sentAt, threadId: args.thread.id });
    }
    return response;
  }
  if (isStandaloneBuiltinClearCommand(args.payload.input)) {
    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });
    await sendThreadMessage(deps, {
      environment,
      payload: args.payload,
      thread: args.thread,
      trigger: "user",
    });
    return { ok: true, delivery: "sent" };
  }

  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: args.payload,
    source: { kind: "inline" },
    queuePayload: { kind: "inline" },
    pluginSubmission: args.payload.pluginSubmission ?? null,
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    trigger: "user",
  });
  if (outcome.kind === "dispatched") {
    return { ok: true, delivery: "sent" };
  }
  return {
    ok: true,
    delivery: "queued",
    queuedMessage: outcome.entry,
  };
}
