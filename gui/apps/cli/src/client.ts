import { createCallerProofFetch } from "@cloudroom/config/caller-proof";
import {
  BbRequestTimeoutError,
  createNodeRoomSdk,
  createRequestTimeoutFetch,
  type BbSdk,
} from "@cloudroom/sdk/node";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

export const CLI_READ_TIMEOUT_MS = 45_000;

const callerProofFetch = createCallerProofFetch((input, init) =>
  fetch(input, init),
);

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  return callerProofFetch(input, init);
}

export function createCliRoomSdk(baseUrl: string, timeoutMs?: number): BbSdk {
  if (timeoutMs === undefined) {
    return createNodeRoomSdk({ baseUrl, fetch: cliFetch });
  }
  const timeoutFetch = createRequestTimeoutFetch({ timeoutMs });
  return createNodeRoomSdk({
    baseUrl,
    fetch: async (input, init) => {
      try {
        return await timeoutFetch(input, init);
      } catch (error) {
        if (error instanceof BbRequestTimeoutError) {
          const proxy = await import("./plugin-cli-proxy.js");
          error.message = proxy.describeUnreachableServer(
            baseUrl,
            error,
            timeoutMs,
          );
        }
        throw error;
      }
    },
  });
}
