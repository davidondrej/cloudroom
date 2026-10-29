import { readOrCreateSecretFile } from "@cloudroom/secret-storage";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { cloudroom } from "./commands.js";

const relay = process.env.CLOUDROOM_CONNECT_URL ?? "https://cloudroom.run";
const DEV_COPY = "Dev copies don't connect to cloudroom.run. Set CLOUDROOM_CONNECT_URL to a local relay.";
const registration = z.object({ handle: z.string().regex(/^[a-z0-9]{1,63}$/), credential: z.string().regex(/^[a-f0-9]{64}$/), serverUrl: z.string().url() });

/** A dev copy serves no app at "/", so a phone sent to it opens a blank page. Only a local relay may reach it. */
const blocked = (deps: AppDeps) => (deps.config.isDevelopment && !process.env.CLOUDROOM_CONNECT_URL ? DEV_COPY : undefined);

/** The signed-in account. The Connect plugin registers this Mac again when it changes, and signs out when `blocked` is set. */
export async function connectAccount(deps: AppDeps): Promise<{ accountId: string | null; blocked?: string }> {
  const reason = blocked(deps);
  if (reason) return { accountId: null, blocked: reason };
  return { accountId: (await cloudroom(deps).sandboxes.account())?.userId ?? null };
}

/** Registers this Mac with Cloudroom Connect on cloudroom.run (ADR 0184). The relay confirms the sign-in with the website. */
export async function registerConnect(deps: AppDeps) {
  const reason = blocked(deps);
  if (reason) throw new ApiError(409, "connect_dev_copy", reason);
  const account = await cloudroom(deps).sandboxes.account();
  if (!account) throw new ApiError(409, "cloudroom_signed_out", "Sign in to Cloudroom to use it on your phone.");
  const installId = await readOrCreateSecretFile({ bytes: 16, dataDir: deps.config.dataDir, encoding: "hex", fileName: "telemetry-id" });
  const response = await fetch(`${relay}/api/register`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${account.userId}:${account.token}`).toString("base64")}` },
    body: JSON.stringify({ installId }),
  }).catch((error: unknown) => { throw new ApiError(503, "connect_unreachable", `Cloudroom Connect could not be reached: ${error instanceof Error ? error.message : String(error)}`); });
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new ApiError(response.status === 401 ? 401 : 503, "connect_register_failed", typeof body.error === "string" ? body.error : `Cloudroom Connect returned HTTP ${response.status}.`);
  return { ...registration.parse(body), accountId: account.userId };
}
