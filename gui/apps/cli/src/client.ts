import { createCallerProofFetch } from "@cloudroom/config/caller-proof";
import {
  BbRequestTimeoutError,
  createNodeBbSdk,
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

export function createCliBbSdk(baseUrl: string, timeoutMs?: number): BbSdk {
  if (timeoutMs === undefined) {
    return createNodeBbSdk({ baseUrl, fetch: cliFetch });
  }
  const timeoutFetch = createRequestTimeoutFetch({ timeoutMs });
  return createNodeBbSdk({
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
