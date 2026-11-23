import { setTimeout as sleep } from "node:timers/promises";
import { createCallerProofFetch } from "@cloudroom/config/caller-proof";
import {
  HUMAN_CLICK_REQUIRED_CODE,
  HUMAN_CLICK_THREAD_HEADER,
  humanClickAction,
} from "@cloudroom/config/human-click";
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

const HUMAN_CLICK_POLL_MS = 1_000;
// A minute longer than the server keeps a request, so the server's own answer comes first.
const HUMAN_CLICK_WAIT_MS = 11 * 60_000;

const refusal = (code: string, message: string): Response =>
  Response.json({ code, message, error: message }, { status: 403 });

// A plugin install or update needs a click in the Cloudroom app (ADR 0260).
// The server keeps the request and shows it there. Wait for the answer, then
// reply as the action itself did, so callers need no code of their own.
async function waitForHumanClick(
  url: URL,
  method: string,
  response: Response,
): Promise<Response> {
  if (
    response.status !== 403 ||
    humanClickAction(method, url.pathname) === null
  ) {
    return response;
  }
  const asked = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown; requestId?: unknown } | null;
  if (
    asked?.code !== HUMAN_CLICK_REQUIRED_CODE ||
    typeof asked.requestId !== "string"
  ) {
    return response;
  }
  process.stderr.write(
    "Waiting for the user to approve this in the Cloudroom app (up to 10 minutes)...\n",
  );
  const deadline = Date.now() + HUMAN_CLICK_WAIT_MS;
  let request: {
    status?: string;
    response?: { status: number; body: unknown } | null;
  } | null = null;
  // One failed check (a restart, a busy server) is not an answer: keep asking until the
  // deadline, and past it while an approved install is still running.
  while (Date.now() < deadline || request?.status === "running") {
    await sleep(HUMAN_CLICK_POLL_MS);
    const poll = await callerProofFetch(
      new URL(`/api/v1/human-clicks/${asked.requestId}`, url),
    ).catch(() => null);
    // The server forgot the request: it restarted, so nothing will answer.
    if (poll?.status === 404) break;
    request = poll?.ok ? await poll.json().catch(() => null) : null;
    if (
      request !== null &&
      request.status !== "waiting" &&
      request.status !== "running"
    ) {
      break;
    }
  }
  if (request?.status === "done" && request.response) {
    return Response.json(request.response.body, {
      status: request.response.status,
    });
  }
  return request?.status === "declined"
    ? refusal(
        "human_click_declined",
        "The user declined this in the Cloudroom app.",
      )
    : refusal(
        "human_click_unanswered",
        "Nobody approved this in the Cloudroom app in time. Ask the user to open Cloudroom, then run the command again.",
      );
}

export async function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  const thread = process.env.ROOM_THREAD_ID;
  if (thread && humanClickAction(method, url.pathname) !== null) {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(HUMAN_CLICK_THREAD_HEADER, thread);
    init = { ...init, headers };
  }
  return waitForHumanClick(url, method, await callerProofFetch(input, init));
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
