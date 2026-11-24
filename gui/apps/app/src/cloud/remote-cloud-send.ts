import { isStandaloneBuiltinCompactCommand, type PromptInput } from "@cloudroom/domain";
import { BbHttpError, BbRequestTimeoutError } from "@cloudroom/sdk/browser";
import { sendMessageResponseSchema, type SendMessageResponse } from "@cloudroom/server-contract";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { OtherMacUnavailableError, onMacConnectionChange, otherMacLostAt, relayConnectionError } from "./mac-connection";

// The server executes a bare /compact or its command chip separately from the message ledger.
export function canRecoverCloudSend(input: readonly PromptInput[]): boolean {
  const only = input.length === 1 ? input[0] : undefined;
  return !(only?.type === "text" && only.text.trim() === "/compact") && !isStandaloneBuiltinCompactCommand(input);
}

function lostReply(error: unknown): boolean {
  return error instanceof OtherMacUnavailableError || error instanceof TypeError ||
    error instanceof BbRequestTimeoutError || (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof BbHttpError && !error.code && (error.status === 502 || error.status === 504));
}

// A reconnect wakes the check immediately. The timer also handles an HTTP outage with an open socket.
function waitForMac(delay: number): Promise<void> {
  return new Promise(resolve => {
    const unsubscribe = onMacConnectionChange(() => {
      if (otherMacLostAt() === null) done();
    });
    const timer = setTimeout(done, otherMacLostAt() === null ? delay : 30_000);
    function done() { clearTimeout(timer); unsubscribe(); resolve(); }
  });
}

export async function recoverRemoteCloudSend(
  threadId: string,
  requestId: string,
  send: () => Promise<SendMessageResponse>,
): Promise<SendMessageResponse> {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof SyntaxError) && !lostReply(error)) throw error;
  }

  const path = `/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/delivery/${encodeURIComponent(requestId)}`;
  let delay = 1000;
  for (;;) {
    await waitForMac(delay);
    delay = Math.min(10_000, delay * 2);
    try {
      const response = await fetchWithAppSurface(path, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (relayConnectionError(response)) continue;
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(typeof error?.message === "string" ? error.message : "Could not confirm delivery. Check the conversation before sending again.");
      }
      const receipt = sendMessageResponseSchema.nullable().safeParse(await response.json().catch(error => {
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }));
      if (!receipt.success) throw new Error("Could not confirm delivery. Check the conversation before sending again.");
      // Only an explicit null from this Mac authorizes a replay. The closure retains the original payload and ID.
      return receipt.data ?? await send();
    } catch (error) {
      if (!lostReply(error)) throw error;
    }
  }
}
