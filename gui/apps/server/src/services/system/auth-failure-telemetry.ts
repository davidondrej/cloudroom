import { firstAgentTag } from "./first-agent.js";
import { countThreads, getAppSettings, getLatestStoredThreadEventOfTypes, getThread, type DbConnection } from "@cloudroom/db";
import type { ServerLogger } from "../../types.js";
import { localLogins, reportCloudFailure, scrub } from "../cloudroom/setup-telemetry.js";
import { buildTurnFailedEvent, loadFailedTurn } from "../threads/turn-failed.js";
import type { TelemetryService } from "./telemetry.js";

interface Deps {
  db: DbConnection;
  logger: ServerLogger;
  telemetry: TelemetryService;
}

let deps: Deps | null = null;

/** Why a Cloud turn failed when the harness left no error of its own: Core's failed state or the prompt's delivery state.
 *  `code`: Core's refusal code (`claude_auth_required`), or `http_409` when it sent none the app knows. */
export interface CloudFailure {
  category: string;
  code?: string | null;
  message?: string | null;
}

export function installAuthFailureTelemetry(next: Deps): () => void {
  deps = next;
  return () => {
    if (deps === next) deps = null;
  };
}

export function noteTurnFailed(threadId: string, cloud?: CloudFailure): void {
  const current = deps;
  if (!current) return;
  setImmediate(async () => {
    const thread = getThread(current.db, threadId);
    if (!thread || thread.deletedAt !== null) return;
    const failed = buildTurnFailedEvent(current.db, threadId);
    const execution = thread.executionTarget === "cloud" ? "cloud_sandbox" : "local";
    // A Cloud prompt that never started: why Cloud refused it, and whether this computer could have run it instead. The
    // first one each app run also sends a snapshot with a network check.
    const refused = execution === "cloud_sandbox" && !failed?.errorInfo && cloud?.category.startsWith("prompt-") === true;
    if (refused) reportCloudFailure();
    const refusal = refused ? { cloud_code: cloud?.code ?? null, local_logins: await localLogins(), default_agent: getAppSettings(current.db).defaultProviderId ?? "none" } : {};
    current.telemetry.capture({
      name: "turn_failed",
      properties: {
        execution,
        is_child_thread: thread.parentThreadId !== null,
        provider: thread.providerId,
        error_category: failed?.errorInfo?.category ?? cloud?.category ?? "unknown",
        ...(process.platform === "win32" ? { error_message: failureText(current.db, threadId, failed?.interruptionReason, cloud?.message) } : {}),
        ...refusal,
        ...firstAgentTag(current.db, threadId),
      },
    });
    if (failed?.errorInfo?.category !== "unauthorized") return;
    const running = countThreads(current.db, {
      status: "active",
      providerId: thread.providerId,
      includeHidden: true,
    }).total;
    current.logger.warn(
      {
        threadId,
        provider: thread.providerId,
        providerCode: failed.errorInfo.providerCode,
        execution,
        runningThreads: running,
      },
      "Provider login failed",
    );
    current.telemetry.capture({
      name: "provider_auth_failed",
      properties: {
        execution,
        provider: thread.providerId,
        provider_code: failed.errorInfo.providerCode,
        running_threads: running,
      },
    });
  });
}

function failureText(db: DbConnection, threadId: string, interruption: string | null | undefined, cloud: string | null | undefined): string | null {
  try {
    const row = getLatestStoredThreadEventOfTypes(db, { threadId, types: ["provider/error", "system/error"], afterSequence: loadFailedTurn(db, threadId)?.requestSequence ?? 0 });
    const data = row ? (JSON.parse(row.data) as { message?: unknown; detail?: unknown }) : {};
    const parts = [data.message, data.detail !== data.message ? data.detail : null].map((part) => (typeof part === "string" ? scrub(part) : null));
    return parts.filter(Boolean).join(" | ") || (cloud ? scrub(cloud) : null) || (interruption ? `interrupted: ${interruption}` : null);
  } catch {
    return null;
  }
}
