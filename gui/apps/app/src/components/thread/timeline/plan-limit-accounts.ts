import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import { wsManager } from "@/lib/ws";

const PLUGIN = "accounts";
const PROVIDERS = new Set(["claude-code", "codex", "acp-cursor"]);
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
      z.object({
        usedPercent: z.number(),
        resetsAt: z.number().nullish(),
        model: z.string().nullish(),
      }),
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

/**
 * Checked against the clock each time, since a card can stay open past a reset.
 * One model's full bar ("7d fable") only counts for a thread on that model.
 */
export function atLimit(
  account: PlanLimitAccount,
  model: string,
  now = Date.now(),
): boolean {
  return (
    (account.limitedUntil ?? 0) > now ||
    account.windows.some(
      (window) =>
        window.usedPercent >= 100 &&
        (window.resetsAt == null || window.resetsAt > now) &&
        (!window.model || model.toLowerCase().includes(window.model)),
    )
  );
}

/** The first account with room for the thread's model, else the first one: it may still have credits. */
export function nextAccount(
  others: readonly PlanLimitAccount[],
  model: string,
): PlanLimitAccount | null {
  const now = Date.now();
  return (
    others.find((account) => !atLimit(account, model, now)) ??
    others[0] ??
    null
  );
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
 * Picks the account every thread uses (ADR 0197). The plugin then continues every Local thread the old account's limit
 * stopped, this one included (ADR 20261107-082836); Core does the same for Cloud threads after the new login (ADR 0117).
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
    ...(args.isCloud ? {} : { threadId: args.threadId }),
  });
}
