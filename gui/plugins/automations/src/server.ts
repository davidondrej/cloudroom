import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isReviewThread, migrations } from "./data.js";
import { ingestLegacyImport } from "./legacy-import.js";
import { pluginDataDirFromDb } from "./path.js";
import { automationRpcContract, createRpcHandlers } from "./rpc.js";
import {
  closeAutomationRunForSettledThread,
  disableAutomationsForDeletedThreadEvent,
  errorMessage,
  reconcileArchivePausedAutomations,
  reconcileRunningAutomationRuns,
  resumeAutomationsForUnarchivedThread,
} from "./run.js";
import { registerAutomationCli } from "./cli.js";
import { publishAutomationChange, REVIEW_SIGNAL_PROJECT } from "./realtime.js";
import { backfillCloudRuns, recordCloudRun } from "./review.js";
import { createAutomationService } from "./service.js";
import { pollWebhooks } from "./hooks.js";
import { sleep, sweepDueAutomations, SWEEP_INTERVAL_MS } from "./sweep.js";

function resolveServerUrl(): string {
  return process.env.ROOM_SERVER_URL?.trim() || "http://127.0.0.1:39886";
}

export default async function plugin(room: BbPluginApi) {
  const db = room.storage.database();
  room.storage.migrate(db, migrations);
  const pluginDataDir = pluginDataDirFromDb(db);
  await ingestLegacyImport({ bb: room, db, pluginDataDir });

  const service = createAutomationService({
    bb: room,
    db,
    pluginDataDir,
    serverUrl: resolveServerUrl(),
  });

  room.rpc.register(
    automationRpcContract,
    createRpcHandlers(service, room.sdk, db),
  );
  registerAutomationCli({ bb: room, service });

  const reviewChanged = (threadId: string) => {
    if (isReviewThread(db, threadId)) {
      publishAutomationChange(
        room,
        REVIEW_SIGNAL_PROJECT,
        "automation-runs-changed",
      );
    }
  };
  room.events.on("thread.created", ({ thread }) => {
    if (recordCloudRun(db, thread)) reviewChanged(thread.id);
  });
  room.events.on("thread.idle", async ({ thread }) => {
    await closeAutomationRunForSettledThread(room, db, {
      threadId: thread.id,
      threadCreatedAt: thread.createdAt,
      status: "idle",
    });
    reviewChanged(thread.id);
  });
  room.events.on("thread.failed", async ({ thread, error, errorInfo }) => {
    await closeAutomationRunForSettledThread(room, db, {
      threadId: thread.id,
      status: "failed",
      error,
      rateLimited: errorInfo?.category === "rate-limit",
    });
    reviewChanged(thread.id);
  });
  room.events.on("thread.archived", ({ thread }) => reviewChanged(thread.id));
  room.events.on("thread.unarchived", ({ thread }) => {
    reviewChanged(thread.id);
    resumeAutomationsForUnarchivedThread(room, db, thread.id);
  });

  room.events.on("thread.deleted", ({ thread }) => {
    disableAutomationsForDeletedThreadEvent(room, db, thread.id);
  });

  room.background.service("automation-sweep", {
    async start(signal) {
      try {
        await reconcileRunningAutomationRuns(room, db);
        await reconcileArchivePausedAutomations(room, db);
      } catch (error) {
        room.log.error(
          `Automation startup reconciliation failed: ${errorMessage(error)}`,
        );
      }
      void backfillCloudRuns(room, db).catch((error: unknown) =>
        room.log.warn(`Loop review backfill failed: ${errorMessage(error)}`),
      );
      while (!signal.aborted) {
        try {
          await sweepDueAutomations(room, db, {
            pluginDataDir,
            serverUrl: resolveServerUrl(),
          });
        } catch (error) {
          room.log.error(`Automation sweep failed: ${errorMessage(error)}`);
        }
        await sleep(SWEEP_INTERVAL_MS, signal);
      }
    },
  });

  // Local webhook loops get their events from the website (ADR 0262).
  room.background.service("automation-webhooks", {
    start: (signal) => pollWebhooks(room, db, service, signal),
  });
}
