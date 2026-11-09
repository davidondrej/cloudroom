import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { providerSchema, type Provider } from "./contract.js";

const KEY = "limited-threads:v1";
const storedSchema = z
  .record(
    z.string(),
    z.object({
      provider: providerSchema,
      account: z.string(),
      // The failed turn, so a thread the user stopped or moved on from is never re-run.
      requestId: z.string().optional(),
    }),
  )
  .catch({});
// A retry the reset-time policy is still scheduling answers "already queued" before its row exists.
const ATTEMPTS = 4;
const PAUSE_MS = 500;

const code = (error: unknown) => Reflect.get(Object(error), "code");

/**
 * Local threads a plan limit stopped, and the account each one hit it on. Picking another account of that agent, from
 * any thread or Settings, continues every one of them on it (ADR 20261107-082836). Cloud threads are Core's (ADR 0117).
 */
export async function limitedThreads(
  bb: BbPluginApi,
  label: (provider: Provider, account: string) => Promise<string>,
) {
  const stopped = storedSchema.parse(await bb.storage.kv.get(KEY));
  const resuming = new Set<string>();
  const save = () => bb.storage.kv.set(KEY, stopped);

  const forget = async (threadId: string) => {
    if (!(threadId in stopped)) return;
    delete stopped[threadId];
    await save();
  };

  /** Retries the turn the limit stopped, now on `to`; the timeline then shows the switch in one line. */
  const resume = async (threadId: string, to: string) => {
    const entry = stopped[threadId];
    if (!entry || entry.account === to || resuming.has(threadId)) return;
    resuming.add(threadId);
    try {
      const accountSwitch = {
        provider: entry.provider,
        from: await label(entry.provider, entry.account),
        to: await label(entry.provider, to),
      };
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          await bb.sdk.threads.retry({
            threadId,
            ...(entry.requestId ? { turnRequestId: entry.requestId } : {}),
            reason: "Switched account",
            accountSwitch,
          });
          await forget(threadId);
          return;
        } catch (error) {
          // Stopped, or moved on since: nothing to continue.
          if (code(error) === "no_failed_turn") return await forget(threadId);
          if (code(error) !== "retry_already_queued" || attempt === ATTEMPTS) {
            bb.log.warn(`Thread ${threadId} not continued: ${String(error)}`);
            return;
          }
          // A retry waiting for the old account's reset goes: the new account needs no wait.
          const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
          for (const row of queued) {
            if (row.payload.kind !== "retry") continue;
            await bb.sdk.threads.queuedMessages.delete({
              threadId,
              queuedMessageId: row.id,
            });
          }
          await new Promise((done) => setTimeout(done, PAUSE_MS * attempt));
        }
      }
    } finally {
      resuming.delete(threadId);
    }
  };

  return {
    forget,
    resume,
    async record(
      threadId: string,
      provider: Provider,
      account: string,
      requestId?: string,
    ) {
      stopped[threadId] = {
        provider,
        account,
        ...(requestId ? { requestId } : {}),
      };
      await save();
    },
    account: (threadId: string) => stopped[threadId]?.account,
    /** `to` is now the account in use: every thread another account's limit stopped continues on it. */
    async switched(provider: Provider, to: string) {
      const waiting = Object.keys(stopped).filter(
        (threadId) => stopped[threadId]?.provider === provider,
      );
      await Promise.allSettled(waiting.map((threadId) => resume(threadId, to)));
    },
  };
}
