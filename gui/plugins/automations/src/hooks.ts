import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { listEnabledWebhookAutomations, type Db } from "./data.js";
import { errorMessage } from "./run.js";
import type { AutomationService } from "./service.js";
import { sleep } from "./sweep.js";

// Local webhook loops (ADR 0262). The website holds each loop's secret URL and the events sent to it, so nothing on
// this Mac is reachable from outside, and events wait while it is off (up to 7 days). While a webhook loop is on, the
// Mac asks for its events about once a minute (the website sets how often) and runs each batch. It acks a batch only
// once a run has taken it (the agent's thread started, or the script ran). Until then the batch comes back the same,
// and its ID names the run, so it never runs twice and a failed run is tried again.

const DEFAULT_WAIT_MS = 60_000;
type HookApi = Pick<BbPluginApi, "log"> & {
  sdk: { cloudroom: Pick<BbPluginApi["sdk"]["cloudroom"], "automations"> };
};
type HookEvent = { kind: string | null; body: string; received_at: string };

/** Events as prompt data, the same as cloud loops get them (web/lib/hooks.ts). */
export function formatEvents(events: readonly HookEvent[]): string {
  return events
    .map(
      (event) =>
        `--- webhook ${event.received_at}${event.kind ? ` · ${event.kind}` : ""}\n${event.body.replace(/<\/?webhook_events/gi, "<_webhook_events")}`,
    )
    .join("\n");
}

export async function pollWebhooks(
  bb: HookApi,
  db: Db,
  service: Pick<AutomationService, "runWebhook">,
  signal: AbortSignal,
): Promise<void> {
  let wait = DEFAULT_WAIT_MS;
  let lastProblem = "";
  // Batches still running here: a slow thread start or script must not start a second attempt.
  const busy = new Set<string>();
  const ack = (batch: string) =>
    bb.sdk.cloudroom.automations({ action: "ack", batches: [batch] }).then(
      () => undefined,
      (error: unknown) =>
        bb.log.warn(
          `Webhook batch ${batch} not acked; it comes back and is acked then: ${errorMessage(error)}`,
        ),
    );
  while (!signal.aborted) {
    const loops = listEnabledWebhookAutomations(db).map((row) => row.id);
    if (loops.length > 0) {
      try {
        const answer = await bb.sdk.cloudroom.automations({
          action: "events",
          local: loops,
        });
        wait = Math.min(
          Math.max(answer.recheck_ms ?? DEFAULT_WAIT_MS, 10_000),
          3_600_000,
        );
        for (const batch of answer.batches ?? []) {
          if (busy.has(batch.batch)) continue;
          busy.add(batch.batch);
          void service
            .runWebhook({
              automationId: batch.local,
              batch: batch.batch,
              events: formatEvents(batch.events),
            })
            .then((took) => (took ? ack(batch.batch) : undefined))
            .catch((error: unknown) =>
              bb.log.error(
                `Webhook run for loop ${batch.local} not started: ${errorMessage(error)}`,
              ),
            )
            .finally(() => busy.delete(batch.batch));
        }
        lastProblem = "";
      } catch (error) {
        // Signed out or offline: say so once, and keep asking.
        const problem = errorMessage(error);
        if (problem !== lastProblem)
          bb.log.warn(`Webhook loops could not get their events: ${problem}`);
        lastProblem = problem;
      }
    }
    await sleep(wait, signal);
  }
}
