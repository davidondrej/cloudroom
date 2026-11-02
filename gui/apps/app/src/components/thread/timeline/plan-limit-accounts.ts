import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";

const PLUGIN = "accounts";
const PROVIDERS = new Set(["claude-code", "codex"]);
const QUERY_KEY = "plan-limit-accounts";

const accountsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    inUse: z.boolean(),
    needsSignIn: z.boolean().optional(),
    limitedUntil: z.number().nullish(),
    windows: z.array(
      z.object({ usedPercent: z.number(), resetsAt: z.number().nullish() }),
    ),
  }),
);
type AccountView = z.infer<typeof accountsSchema>[number];

export interface PlanLimitAccount {
  id: string;
  label: string;
  limitedUntil: number | null;
  windows: AccountView["windows"];
}

/** Checked against the clock each time, since a card can stay open past a reset. */
export function atLimit(account: PlanLimitAccount, now = Date.now()): boolean {
  return (
    (account.limitedUntil ?? 0) > now ||
    account.windows.some(
      (window) =>
        window.usedPercent >= 100 &&
        (window.resetsAt == null || window.resetsAt > now),
    )
  );
}

/** The first account with room, else the first one: it may still have credits. */
export function nextAccount(
  others: readonly PlanLimitAccount[],
): PlanLimitAccount | null {
  const now = Date.now();
  return others.find((account) => !atLimit(account, now)) ?? others[0] ?? null;
}

/** The thread agent's accounts (ADR 0194). Every other signed-in account is offered, even at its limit. */
export function usePlanLimitAccounts(providerId: string) {
  const enabled = PROVIDERS.has(providerId);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return wsManager.onPluginSignal((signal) => {
      if (signal.pluginId === PLUGIN && signal.channel === "accounts-changed") {
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      }
    });
  }, [enabled, queryClient]);
  const { data } = useQuery({
    queryKey: [QUERY_KEY, providerId],
    queryFn: async () =>
      accountsSchema.parse(
        await callPluginRpc(fetch, PLUGIN, "accounts.list", {
          provider: providerId,
        }),
      ),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const accounts = (data ?? [])
    // "This Mac" without an email has no login on this computer.
    .filter(
      (account) =>
        !account.needsSignIn &&
        (account.inUse || account.id !== "local" || account.email),
    )
    .map((account) => ({
      id: account.id,
      label: account.name ?? account.email ?? `This ${COMPUTER_TITLE}`,
      inUse: account.inUse,
      limitedUntil: account.limitedUntil ?? null,
      windows: account.windows,
    }));
  return {
    inUse: accounts.find((account) => account.inUse) ?? null,
    others: accounts.filter((account) => !account.inUse),
  };
}

/**
 * Picks the account every thread uses (ADR 0197), then continues this thread on it.
 * Cloud threads continue on their own: Core sends "keep working" after a new login (ADR 0117).
 */
export async function switchAccount(args: {
  providerId: string;
  accountId: string;
  threadId: string;
  isCloud: boolean;
}): Promise<void> {
  await callPluginRpc(fetch, PLUGIN, "accounts.use", {
    provider: args.providerId,
    id: args.accountId,
    cloud: args.isCloud,
  });
  if (args.isCloud) return;
  try {
    await sdk.threads.retry({
      threadId: args.threadId,
      reason: "Switched account",
    });
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "retry_already_queued") {
      throw error;
    }
    const queued = await sdk.threads.queuedMessages.list({
      threadId: args.threadId,
    });
    const retry = queued.find((row) => row.payload.kind === "retry");
    if (retry) {
      await sdk.threads.queuedMessages.send({
        threadId: args.threadId,
        queuedMessageId: retry.id,
        mode: "auto",
      });
    }
  }
}
