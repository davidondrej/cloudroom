import { firstAgentTag } from "./first-agent.js";
import { countThreads, getAppSettings, getLatestStoredThreadEventOfTypes, getThread, type DbConnection } from "@cloudroom/db";
import type { ServerLogger } from "../../types.js";
import { localLogins, reportCloudFailure, scrub } from "../cloudroom/setup-telemetry.js";
import { buildTurnFailedEvent, loadFailedTurn, turnFailureFacts } from "../threads/turn-failed.js";
import { CORE_PLAN_LIMIT, notePlanLimit, notePlanLimitEnded } from "./plan-limit-telemetry.js";
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
  /** The step a never-started prompt failed at (#1398). */
  step?: string;
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
    const settings = getAppSettings(current.db);
    const refusal = refused ? { cloud_code: cloud?.code ?? null, cloud_step: cloud?.step ?? null, ...(settings.telemetryEnabled ? { local_logins: await localLogins() } : {}), default_agent: settings.defaultProviderId ?? "none" } : {};
    // Core reports a Cloud plan limit only in its failure reason, so it counts as one with Local's category.
    const cloudCategory = cloud?.message?.includes(CORE_PLAN_LIMIT) ? "rate-limit" : cloud?.category;
    const category = failed?.errorInfo?.category ?? cloudCategory ?? "unknown";
    // Local waits; Cloud notes its own in saveStatus. A thread already running again (a queued message) never waited.
    if (execution === "local") {
      if (category !== "rate-limit") notePlanLimitEnded(threadId);
      else if (thread.status === "error") notePlanLimit(threadId, { provider: thread.providerId, execution, child: thread.parentThreadId !== null });
    }
    // A provider's "unknown" says less than Cloud's reason or our own code for where it failed (docs/scopes/analytics.md#failed-turns).
    const info = failed?.errorInfo;
    const providerCode = known(info?.providerCode);
    const facts = turnFailureFacts(current.db, threadId);
    current.telemetry.capture({
      name: "turn_failed",
      properties: {
        execution,
        is_child_thread: thread.parentThreadId !== null,
        provider: thread.providerId,
        error_category: known(category) ?? known(cloudCategory) ?? facts.code ?? "unknown",
        error_message: failureText(current.db, threadId, failed?.interruptionReason, cloud?.message),
        ...(info?.httpStatusCode ? { http_status: info.httpStatusCode } : {}),
        ...(providerCode ? { provider_code: providerCode } : {}),
        ...(facts.startedBy ? { started_by: facts.startedBy } : {}),
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

function known(value: string | null | undefined): string | null {
  return value && value !== "unknown" ? value : null;
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
