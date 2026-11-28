import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { ThreadEventScopeKind, ThreadEventType } from "@cloudroom/domain";
import { CloudroomError } from "./services/cloudroom/client.js";
import type { ServerLogger } from "./types.js";

interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

interface ApiErrorOptions {
  details?: unknown;
  retryable?: boolean;
}

interface TurnStartGuardFailureDetails {
  eventType: ThreadEventType;
  scopeKind: ThreadEventScopeKind;
  threadId: string;
  turnId: string;
}

export class ApiError extends HTTPException {
  readonly body: ApiErrorBody;

  constructor(
    status: ConstructorParameters<typeof HTTPException>[0],
    code: string,
    message: string,
    options?: boolean | ApiErrorOptions,
  ) {
    super(status, { message });
    const resolvedOptions = normalizeApiErrorOptions(options);
    this.body = { code, message };
    if (resolvedOptions.details !== undefined) {
      this.body.details = resolvedOptions.details;
    }
    if (resolvedOptions.retryable !== undefined) {
      this.body.retryable = resolvedOptions.retryable;
    }
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.body), {
      status: this.status,
      headers: {
        "content-type": "application/json",
      },
    });
  }
}

function normalizeApiErrorOptions(
  options: boolean | ApiErrorOptions | undefined,
): ApiErrorOptions {
  if (typeof options === "boolean") {
    return { retryable: options };
  }
  return options ?? {};
}

export class TurnStartGuardError extends ApiError {
  readonly details: TurnStartGuardFailureDetails;

  constructor(details: TurnStartGuardFailureDetails) {
    super(
      409,
      "invalid_request",
      `Cannot append ${details.eventType} for turn ${details.turnId} before turn/started is stored`,
    );
    this.name = "TurnStartGuardError";
    this.details = details;
  }
}

export function errorToResponse(
  error: unknown,
  logger: ServerLogger,
  request?: { method: string; path: string },
): Response {
  if (error instanceof TurnStartGuardError) {
    logger.warn(
      { err: error, ...error.details },
      "Rejected turn-scoped server event before turn/started",
    );
    return error.toResponse();
  }
  if (error instanceof ApiError) {
    // A change refused as not found logs which check refused it, under an ID its caller sees: a `thread tell` that
    // arrived still answered "not found", and nothing showed why (#2755).
    if (error.status === 404 && request && request.method !== "GET") {
      const errorId = randomUUID().slice(0, 8);
      logger.warn({ err: error, errorId, method: request.method, path: request.path }, "Request refused as not found");
      return new Response(JSON.stringify({ ...error.body, errorId }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (error.status !== 500) return error.toResponse();
  } else if (error instanceof HTTPException) {
    return new Response(
      JSON.stringify({
        code: "internal_error",
        message: error.message,
      }),
      {
        status: error.status,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }
  // The caller can't see why a 500 happened; this ID finds its log line (#1341).
  const errorId = randomUUID().slice(0, 8);
  logger.error(
    { err: error, errorId, method: request?.method, path: request?.path },
    "Unhandled server error",
  );
  return new Response(
    JSON.stringify({
      ...(error instanceof ApiError
        ? error.body
        : {
            code: "internal_error",
            message:
              error instanceof CloudroomError
                ? error.message
                : "Internal server error",
          }),
      errorId,
    }),
    {
      status: 500,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}
