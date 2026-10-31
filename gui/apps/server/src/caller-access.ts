import {
  CALLER_PROOF_REQUIRED_CODE,
  CALLER_PROOF_REQUIRED_MESSAGE,
  CALLER_PROOF_STATUS_HEADER,
  CALLER_TOKEN_HEADER,
  type CallerProofIssuer,
} from "@cloudroom/config/caller-proof";
import { isLoopbackAddress } from "@cloudroom/config/loopback";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiError } from "./errors.js";

const CALLER_TRUSTED_CONTEXT_KEY = "cloudroomCallerTrusted";
const CALLER_TOKEN_REJECTED_CONTEXT_KEY = "cloudroomCallerTokenRejected";

declare module "hono" {
  interface ContextVariableMap {
    [CALLER_TRUSTED_CONTEXT_KEY]: boolean | undefined;
    [CALLER_TOKEN_REJECTED_CONTEXT_KEY]: boolean | undefined;
  }
}

export const PLUGIN_WIRE_HTTP_PATH =
  /^\/api\/v1\/plugins\/[^/]+\/http(?:\/|$)/u;

const OPEN_POSTS = [
  /^\/api\/v1\/caller-proofs$/u,
  /^\/api\/v1\/caller-proofs\/[^/]+$/u,
];

const OPEN_READS = [
  /^\/api\/v1\/system\/(?:config|version)$/u,
  /^\/api\/v1\/plugins(?:\/contributions)?$/u,
  /^\/api\/v1\/projects\/[^/]+$/u,
  /^\/api\/v1\/threads$/u,
  /^\/api\/v1\/threads\/[^/]+$/u,
  /^\/api\/v1\/threads\/[^/]+\/(?:timeline|output|events|events\/wait)$/u,
  /^\/api\/v1\/environments\/[^/]+$/u,
  /^\/api\/v1\/cloudroom\/account\/mcp\/callback$/u,
  /^\/api\/v1\/file-previews\/[^/]+\/.+$/u,
];

const PREVIEW_READS = [
  /^\/api\/v1\/threads\/[^/]+\/worktree\/files\/.+$/u,
  /^\/api\/v1\/threads\/[^/]+\/thread-storage\/files\/.+$/u,
  /^\/api\/v1\/threads\/[^/]+\/files\/raw$/u,
];

export interface CallerTrustReader {
  get(
    key:
      | typeof CALLER_TRUSTED_CONTEXT_KEY
      | typeof CALLER_TOKEN_REJECTED_CONTEXT_KEY,
  ): boolean | undefined;
}

function isRead(method: string): boolean {
  const verb = method.toUpperCase();
  return verb === "GET" || verb === "HEAD";
}

function isPreviewRead(method: string, path: string): boolean {
  return isRead(method) && PREVIEW_READS.some((pattern) => pattern.test(path));
}

export function captureCallerTrust(
  context: Context,
  issuer: CallerProofIssuer,
): void {
  const token = context.req.header(CALLER_TOKEN_HEADER);
  const ignored =
    context.req.header("sec-fetch-site")?.toLowerCase() === "cross-site" &&
    !isPreviewRead(context.req.method, context.req.path);
  const trusted = !ignored && issuer.verify(token);
  context.set(CALLER_TRUSTED_CONTEXT_KEY, trusted);
  context.set(
    CALLER_TOKEN_REJECTED_CONTEXT_KEY,
    token !== undefined && !ignored && !trusted,
  );
}

export function callerProofStatus(context: CallerTrustReader): string {
  return context.get(CALLER_TOKEN_REJECTED_CONTEXT_KEY) === true
    ? "invalid"
    : "required";
}

interface IncomingSocketBindings {
  incoming?: { socket?: { localAddress?: string } };
}

export function arrivedOverLoopback(context: Pick<Context, "env">): boolean {
  const env = context.env as
    | (IncomingSocketBindings & { server?: IncomingSocketBindings })
    | undefined;
  const localAddress = (env?.server ?? env)?.incoming?.socket?.localAddress;
  return localAddress === undefined || isLoopbackAddress(localAddress);
}

export function isTrustedCaller(context: CallerTrustReader): boolean {
  return context.get(CALLER_TRUSTED_CONTEXT_KEY) === true;
}

export function isOpenWithoutCallerProof(
  method: string,
  path: string,
): boolean {
  if (method.toUpperCase() === "POST") {
    return OPEN_POSTS.some((pattern) => pattern.test(path));
  }
  return isRead(method) && OPEN_READS.some((pattern) => pattern.test(path));
}

export function callerProofRequiredResponse(
  context: CallerTrustReader,
): Response {
  return new Response(
    JSON.stringify({
      code: CALLER_PROOF_REQUIRED_CODE,
      message: CALLER_PROOF_REQUIRED_MESSAGE,
    }),
    {
      headers: {
        "content-type": "application/json",
        [CALLER_PROOF_STATUS_HEADER]: callerProofStatus(context),
      },
      status: 401,
    },
  );
}

export function assertTrustedCaller(context: CallerTrustReader): void {
  if (!isTrustedCaller(context)) {
    throw new ApiError(
      401,
      CALLER_PROOF_REQUIRED_CODE,
      CALLER_PROOF_REQUIRED_MESSAGE,
    );
  }
}

const finishProofSchema = z
  .object({ claim: z.string().min(1).max(256) })
  .strict();

export function registerCallerProofRoutes(
  app: Hono,
  issuer: CallerProofIssuer,
): void {
  app.post("/caller-proofs", (context) => context.json(issuer.start()));
  app.post("/caller-proofs/:id", async (context) => {
    const body = finishProofSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    const token = body.success
      ? await issuer.finish(context.req.param("id"), body.data.claim)
      : null;
    if (token === null) {
      throw new ApiError(403, "caller_proof_failed", "Caller proof failed");
    }
    return context.json({ token });
  });
}
