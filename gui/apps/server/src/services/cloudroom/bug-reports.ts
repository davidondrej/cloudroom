import { arch, release } from "node:os";
import { readOrCreateSecretFile } from "@cloudroom/secret-storage";
import { getAppSettings, getThread } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { cloudroom, configuredWebsite } from "./commands.js";

/** A Local agent's report of a Cloudroom bug (ADR 0158). Signed-out apps report anonymously with the telemetry install ID. */
export async function reportBug(deps: AppDeps, input: { message: string; threadId?: string }): Promise<{ sent: boolean }> {
  if (!getAppSettings(deps.db).bugReportsEnabled) return { sent: false };
  const account = await cloudroom(deps).sandboxes.account();
  const thread = input.threadId ? getThread(deps.db, input.threadId) : undefined;
  const context = {
    app: deps.config.appVersion, cloudroom: process.env.BB_DESKTOP_VERSION ?? null, os: `${process.platform} ${release()} ${arch()}`,
    ...(thread ? { thread: thread.id, project: thread.projectId, provider: thread.providerId, model: thread.modelOverride, target: thread.executionTarget } : {}),
  };
  const installId = await readOrCreateSecretFile({ bytes: 16, dataDir: deps.config.dataDir, encoding: "hex", fileName: "telemetry-id" });
  const response = await fetch(`${account?.website ?? configuredWebsite()}/api/desktop/bug-reports`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", ...(account ? { Authorization: `Basic ${Buffer.from(`${account.userId}:${account.token}`).toString("base64")}` } : {}) },
    body: JSON.stringify({ message: input.message, context, installId }),
  }).catch((error: unknown) => { throw new ApiError(503, "bug_report_failed", `Cloudroom could not reach the website: ${error instanceof Error ? error.message : String(error)}`); });
  if (!response.ok) {
    const value = await response.json().catch(() => ({})) as { error?: unknown };
    throw new ApiError(response.status === 429 ? 429 : 503, "bug_report_failed", typeof value.error === "string" ? value.error : `The website returned HTTP ${response.status}.`);
  }
  return { sent: true };
}
