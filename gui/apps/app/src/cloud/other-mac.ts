// The desktop app showing another of your Macs through cloudroom.run. When that Mac drops off the relay, its page
// stays on screen: requests are sent again, and a small "Reconnecting…" note shows until it is back.
import { tunnelOffline } from "./cloud-mode";
import { OtherMacUnavailableError, observeMacResponse, otherMacLostAt, relayConnectionError, setMacUnreachable } from "./mac-connection";

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
/** After this long without the Mac, requests fail at once and the note offers "Use this Mac". */
export const LONG_GONE_MS = 30_000;

/** The relay's own answer for a Mac that is gone. "Offline" never reached the Mac, so even a write is safe to send again. */
const macGone = (response: Response, read: boolean) =>
  tunnelOffline(response) ||
  (read &&
    response.status === 502 &&
    response.headers.get("x-cloudroom-tunnel-error") === "1");

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Sends a request again while the relay says the Mac is gone, so a short drop looks like a slow request. */
export function keepOtherMacOnScreen(): void {
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const read = method === "GET" || method === "HEAD";
    const signal = init?.signal ?? request?.signal;
    // A body that is a stream can only be sent once.
    const resendable = !(init?.body instanceof ReadableStream);
    const url = new URL(request?.url ?? String(input), window.location.href);
    const macApi = url.origin === window.location.origin && url.pathname.startsWith("/api/v1/");
    const send = async () => {
      const response = await network(request && resendable ? request.clone() : input, init).catch(error => {
        if (macApi && error instanceof TypeError && !signal?.aborted) setMacUnreachable(true);
        throw error;
      });
      if (macApi) observeMacResponse(response);
      return response;
    };
    let response = await send();
    for (const delayMs of RETRY_DELAYS_MS) {
      if (!resendable || !macGone(response, read) || signal?.aborted) break;
      const lost = otherMacLostAt();
      if (lost !== null && Date.now() - lost > LONG_GONE_MS) break;
      await sleep(delayMs, signal);
      response = await send();
    }
    if (macApi && method === "POST" && /^\/api\/v1\/threads\/[^/]+\/send$/.test(url.pathname) && relayConnectionError(response)) {
      throw new OtherMacUnavailableError();
    }
    return response;
  };
}
