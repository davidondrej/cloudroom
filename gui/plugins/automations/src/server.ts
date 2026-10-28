import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isReviewThread, migrations } from "./data.js";
import { ingestLegacyImport } from "./legacy-import.js";
import { pluginDataDirFromDb } from "./path.js";
import { automationRpcContract, createRpcHandlers } from "./rpc.js";
import {
  closeAutomationRunForSettledThread,
  disableAutomationsForDeletedThreadEvent,
  errorMessage,
  reconcileRunningAutomationRuns,
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

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const pluginDataDir = pluginDataDirFromDb(db);
  await ingestLegacyImport({ bb, db, pluginDataDir });

  const service = createAutomationService({
    bb,
    db,
    pluginDataDir,
    serverUrl: resolveServerUrl(),
  });

  bb.rpc.register(
    automationRpcContract,
    createRpcHandlers(service, bb.sdk, db),
  );
  registerAutomationCli({ bb, service });

  const reviewChanged = (threadId: string) => {
    if (isReviewThread(db, threadId)) {
      publishAutomationChange(
        bb,
        REVIEW_SIGNAL_PROJECT,
        "automation-runs-changed",
      );
    }
  };
  bb.events.on("thread.created", ({ thread }) => {
    if (recordCloudRun(db, thread)) reviewChanged(thread.id);
  });
  bb.events.on("thread.idle", ({ thread }) => {
    closeAutomationRunForSettledThread(bb, db, {
      threadId: thread.id,
      status: "idle",
    });
    reviewChanged(thread.id);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    closeAutomationRunForSettledThread(bb, db, {
      threadId: thread.id,
      status: "failed",
      error,
    });
    reviewChanged(thread.id);
  });
  bb.events.on("thread.archived", ({ thread }) => reviewChanged(thread.id));
  bb.events.on("thread.unarchived", ({ thread }) => reviewChanged(thread.id));

  bb.events.on("thread.deleted", ({ thread }) => {
    disableAutomationsForDeletedThreadEvent(bb, db, thread.id);
  });

  bb.background.service("automation-sweep", {
    async start(signal) {
      try {
        await reconcileRunningAutomationRuns(bb, db);
      } catch (error) {
        bb.log.error(
          `Automation startup reconciliation failed: ${errorMessage(error)}`,
        );
      }
      void backfillCloudRuns(bb, db).catch((error: unknown) =>
        bb.log.warn(`Loop review backfill failed: ${errorMessage(error)}`),
      );
      while (!signal.aborted) {
        try {
          await sweepDueAutomations(bb, db, {
            pluginDataDir,
            serverUrl: resolveServerUrl(),
          });
        } catch (error) {
          bb.log.error(`Automation sweep failed: ${errorMessage(error)}`);
        }
        await sleep(SWEEP_INTERVAL_MS, signal);
      }
    },
  });

  // Local webhook loops get their events from the website (ADR 0262).
  bb.background.service("automation-webhooks", {
    start: (signal) => pollWebhooks(bb, db, service, signal),
  });
}
