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
import { subscribe } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

// In a loop's script (#2656): on exit, leave the loop's file only if a request to Cloudroom failed in transport and
// Cloudroom never answered at all (no response headers from its origin), so its outage never turns the loop off.
const unavailableFile = process.env.ROOM_LOOP_UNAVAILABLE_FILE;
const cloudroomOrigin = unavailableFile
  ? originOf(process.env.ROOM_SERVER_URL)
  : null;
let answered = false;
let transportFailed = false;
if (unavailableFile && cloudroomOrigin) {
  subscribe("undici:request:headers", (message) => {
    if (
      (message as { request?: { origin?: unknown } }).request?.origin ===
      cloudroomOrigin
    )
      answered = true;
  });
  process.on("exit", () => {
    if (!transportFailed || answered) return;
    try {
      writeFileSync(unavailableFile, "");
    } catch {}
  });
}

function originOf(url: string | undefined): string | null {
  try {
    return url === undefined ? null : new URL(url).origin;
  } catch {
    return null;
  }
}

// Codes that mean Cloudroom didn't answer. Anything else (a bad port, a blocked connection) is this shell's own setup.
const NO_ANSWER_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Every request to Cloudroom fails here first, under the caller proof and before a command wraps the error. It counts
 *  when a code above, or our own timeout, is in the error or its causes (AggregateError too), and no EPERM or EACCES. */
function noteLoopTransportFailure(
  input: RequestInfo | URL,
  error: unknown,
): void {
  if (
    !cloudroomOrigin ||
    originOf(input instanceof Request ? input.url : String(input)) !==
      cloudroomOrigin
  )
    return;
  let noAnswer = false;
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current))
      continue;
    seen.add(current);
    const { code, name, cause, errors } = current as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (code === "EPERM" || code === "EACCES") return;
    if (
      (typeof code === "string" && NO_ANSWER_CODES.has(code)) ||
      name === "TimeoutError" ||
      name === "BbRequestTimeoutError"
    )
      noAnswer = true;
    pending.push(cause, ...(Array.isArray(errors) ? errors : []));
  }
  if (noAnswer) transportFailed = true;
}

export const CLI_READ_TIMEOUT_MS = 45_000;

const callerProofFetch = createCallerProofFetch((input, init) =>
  fetch(input, init).catch((error: unknown) => {
    noteLoopTransportFailure(input, error);
    throw error;
  }),
);

const HUMAN_CLICK_POLL_MS = 1_000;
// A minute longer than the server keeps a request, so the server's own answer comes first.
const HUMAN_CLICK_WAIT_MS = 11 * 60_000;

const refusal = (code: string, message: string): Response =>
  Response.json({ code, message, error: message }, { status: 403 });

// A plugin or skill install, or a plugin update, needs a click in the app (ADR 0260).
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
        noteLoopTransportFailure(input, error);
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
