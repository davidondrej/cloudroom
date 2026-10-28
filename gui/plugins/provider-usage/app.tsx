import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useSidebarThreads,
  type ExperimentalSidebarFooterDisclosureProps,
  UrlLink,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  formatUsageReset,
  formatUsdCents,
  usageBarColorClass,
} from "@cloudroom/shared-ui/lib/usage-format";
import { LIST_HOVER_TRANSITION } from "@cloudroom/shared-ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
} from "@cloudroom/shared-ui/option-display";
import {
  selectUsageMachine,
  usageRpcSuccessSchema,
  type UsageMachine,
  type UsageProvider,
  type UsageSnapshot,
  type UsageWindow as UsageWindowValue,
} from "./usage-schema.js";
import {
  emptyUsageMessage,
  hasReportedUsage,
  offlineUsageMessage,
  UsageFeedback,
  usageFeedbackMessages,
} from "./usage-feedback.js";

import {
  loadPlanSummary,
  planMeterLeft,
  planMeterPercent,
  type PlanSummary,
} from "./plan-usage.js";

export interface UsageStoreSnapshot {
  data: UsageSnapshot | null;
  error: string | null;
  isRefreshing: boolean;
}

const CARD_MAX_AGE_MS = 2 * 60_000;
const FOCUS_MAX_AGE_MS = 5 * 60_000;
const BACKGROUND_REFRESH_MS = 5 * 60_000;
const storeListeners = new Set<() => void>();
let storeSnapshot: UsageStoreSnapshot = {
  data: null,
  error: null,
  isRefreshing: false,
};
let activeRefreshCount = 0;
let lastMachineId: string | null = null;
let lastPlan: PlanSummary | null = null;

function updateStore(next: UsageStoreSnapshot): void {
  storeSnapshot = next;
  for (const listener of storeListeners) listener();
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function getStoreSnapshot(): UsageStoreSnapshot {
  return storeSnapshot;
}

function rpcErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = Reflect.get(body, "error");
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message : null;
}

function refreshUsage({
  force,
  machineIds,
  maxAgeMs,
  providerId = null,
  signal,
}: {
  force: boolean;
  machineIds: string[] | null;
  maxAgeMs: number;
  providerId?: string | null;
  signal?: AbortSignal;
}): Promise<void> {
  activeRefreshCount += 1;
  updateStore({ ...storeSnapshot, error: null, isRefreshing: true });
  return (async () => {
    try {
      const response = await fetch(
        "/api/v1/plugins/provider-usage/rpc/getUsage",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force, machineIds, maxAgeMs, providerId }),
          signal:
            signal === undefined
              ? AbortSignal.timeout(60_000)
              : AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
      );
      if (!response.ok)
        throw new Error(`Usage request returned HTTP ${response.status}.`);
      const body: unknown = await response.json();
      const parsed = usageRpcSuccessSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          rpcErrorMessage(body) ?? "Provider usage could not be loaded.",
        );
      }
      updateStore({
        data: parsed.data.result,
        error: null,
        isRefreshing: activeRefreshCount > 1,
      });
    } catch (cause) {
      if (signal?.aborted === true) {
        return;
      }
      console.warn("Provider usage refresh failed", cause);
      updateStore({
        ...storeSnapshot,
        error: "Couldn’t refresh usage.",
      });
    } finally {
      activeRefreshCount -= 1;
      if (activeRefreshCount === 0 && storeSnapshot.isRefreshing) {
        updateStore({ ...storeSnapshot, isRefreshing: false });
      }
    }
  })();
}

function formatResetCountdown(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const remaining = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "now";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}
const USAGE_BLOCKS = 12;

function usageTextColorClass(usedPercent: number): string {
  if (usedPercent >= 95) return "text-destructive-text";
  if (usedPercent >= 80) return "text-warning-text";
  return "text-sidebar-foreground";
}

function UsageBlocks({ usedPercent }: { usedPercent: number }) {
  const lit = Math.max(
    1,
    Math.round((Math.min(100, usedPercent) / 100) * USAGE_BLOCKS),
  );
  return (
    <span aria-hidden="true" className="flex shrink-0 gap-[1.5px]">
      {Array.from({ length: USAGE_BLOCKS }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-[9px] w-[clamp(2px,calc((100cqw_-_11ch_-_125px)/12),5px)] rounded-[1px]",
            index < lit ? usageBarColorClass(usedPercent) : "bg-sidebar-border",
          )}
        />
      ))}
    </span>
  );
}

function UsageLine({
  last,
  label,
  usedPercent,
  detail,
}: {
  last: boolean;
  label: string;
  usedPercent: number;
  detail: string;
}) {
  return (
    <span className="@container flex items-center gap-[7px] whitespace-nowrap">
      <span aria-hidden="true" className="text-subtle-foreground">
        {last ? "└" : "├"}
      </span>
      <span className="w-11 shrink-0 truncate lowercase text-muted-foreground">
        {label}
      </span>
      <UsageBlocks usedPercent={usedPercent} />
      <span
        className={cn(
          "w-[30px] shrink-0 text-right tabular-nums",
          usageTextColorClass(usedPercent),
        )}
      >
        {Math.round(usedPercent)}%
      </span>
      <span
        aria-hidden="true"
        className="min-w-0 truncate tabular-nums text-subtle-foreground"
      >
        {detail}
      </span>
    </span>
  );
}

function PlanUsage({
  plan,
  className,
}: {
  plan: PlanSummary;
  className?: string;
}) {
  return (
    <section
      aria-label="Cloudroom plan"
      className={cn(
        "border-b border-dashed border-sidebar-border pb-1.5",
        className,
      )}
    >
      <h2 className="flex min-w-0 items-center gap-2 font-normal">
        <img src="/icon-192.png?v=room" alt="" aria-hidden="true" className="size-3 shrink-0 object-contain" />
        <span className="shrink-0 lowercase text-primary-text">cloudroom</span>
        <span className="min-w-0 truncate text-subtle-foreground">
          {plan.plan}
        </span>
      </h2>
      {plan.meters.map((meter, index) => (
        <p
          key={meter.label}
          title={`${meter.used.toLocaleString("en-US")} of ${meter.limit.toLocaleString("en-US")} ${meter.label} used, ${plan.period}`}
        >
          <span aria-hidden="true">
            <UsageLine
              last={index === plan.meters.length - 1}
              label={meter.label}
              usedPercent={planMeterPercent(meter)}
              detail={planMeterLeft(meter)}
            />
          </span>
          <span className="sr-only">
            {`${meter.label}: ${Math.round(planMeterPercent(meter))}% used, ${planMeterLeft(meter)}`}
          </span>
        </p>
      ))}
    </section>
  );
}

function UsageWindow({
  window,
  last,
}: {
  window: UsageWindowValue;
  last: boolean;
}) {
  const [showReset, setShowReset] = useState(false);
  const reset = formatUsageReset(window.resetsAt);
  const countdown = formatResetCountdown(window.resetsAt);
  const value =
    window.cost === null
      ? Math.round(window.usedPercent) + "% used"
      : formatUsdCents(window.cost.usedUsdCents, true) +
        " / " +
        formatUsdCents(window.cost.limitUsdCents, false);
  const label = window.label
    .replace(/^Five-hour limit$|^5 hours$/u, "5h")
    .replace(/^Weekly limit$|^Weekly/u, "7d")
    .replace(/^Daily limit$/u, "1d")
    .replace(/^Plan usage$/u, "plan")
    .replace(/^On-demand spend$/u, "spend");
  return (
    <button
      type="button"
      className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      title={`${window.label} · ${reset ?? "Reset time not reported"}`}
      aria-label={`${window.label}: ${value}. ${reset ?? "Reset time not reported"}`}
      aria-expanded={showReset}
      onClick={() => setShowReset((shown) => !shown)}
    >
      <UsageLine
        last={last}
        label={label}
        usedPercent={window.usedPercent}
        detail={countdown ?? "—"}
      />
      {showReset ? (
        <span className="block whitespace-normal pl-3.5 text-subtle-foreground">
          {reset ?? "Reset time not reported."}
          {window.cost === null ? "" : ` · ${value}`}
        </span>
      ) : null}
    </button>
  );
}

function CreditsNote({ detail }: { detail: string | null }) {
  return (
    <p role="status" className="flex gap-[7px] text-destructive-text">
      <span aria-hidden="true" className="text-subtle-foreground">
        └
      </span>
      <span className="min-w-0">
        paying API prices{detail === null ? "" : ` · ${detail}`}
      </span>
    </p>
  );
}

function accountsOnCredits(
  snapshot: UsageSnapshot | null,
): Map<string, string> {
  const paid = new Map<string, string>();
  for (const machine of snapshot?.machines ?? [])
    for (const provider of machine.providers)
      if (
        provider.usage?.status === "ok" &&
        provider.usage.credits &&
        provider.inUse !== false
      )
        paid.set(
          `${provider.providerId}:${accountName(provider) ?? machine.id}`,
          provider.displayName,
        );
  return paid;
}

/** A tree-style status line under a provider, like `└ not installed`. */
function UsageNote({ children }: { children: string }) {
  return (
    <p className="flex gap-[7px] text-muted-foreground">
      <span aria-hidden="true" className="text-subtle-foreground">
        └
      </span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

async function signInMacCodex(): Promise<void> {
  const call = async (method: "GET" | "POST") => {
    const response = await fetch("/api/v1/cloudroom/mac/codex-login", method === "POST" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : {});
    if (!response.ok) throw new Error("Codex sign-in could not start.");
    return (await response.json()) as { state: string; message?: string };
  };
  let status = await call("POST");
  while (status.state === "waiting") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = await call("GET");
  }
  if (status.state === "error") throw new Error(status.message ?? "Codex sign-in failed.");
}

function CodexSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [state, setState] = useState<"idle" | "waiting" | "error">("idle");
  const [error, setError] = useState("");
  const signIn = () => {
    setState("waiting");
    signInMacCodex().then(
      () => { setState("idle"); onSignedIn(); },
      (cause: unknown) => { setState("error"); setError(cause instanceof Error ? cause.message : String(cause)); },
    );
  };
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <UsageNote>{state === "waiting" ? "finish in your browser" : "session expired"}</UsageNote>
        <Button type="button" size="sm" className="h-6 px-2.5 text-xs" disabled={state === "waiting"} onClick={signIn}>
          {state === "waiting" ? "Waiting…" : "Sign in"}
        </Button>
      </div>
      {state === "error" ? <p role="alert" className="text-destructive">{error}</p> : null}
    </div>
  );
}

function ProviderUsageBody({ provider, onCodexSignedIn }: { provider: UsageProvider; onCodexSignedIn?: () => void }) {
  const usage = provider.usage;
  if (usage === null) return <UsageNote>Usage not reported.</UsageNote>;
  switch (usage.status) {
    case "ok":
      return usage.windows.length === 0 ? (
        usage.credits ? (
          <CreditsNote detail={usage.credits.detail} />
        ) : (
          <UsageNote>No usage limits reported for this plan.</UsageNote>
        )
      ) : (
        <div>
          {usage.windows.map((window, index) => (
            <UsageWindow
              key={window.label}
              window={window}
              last={!usage.credits && index === usage.windows.length - 1}
            />
          ))}
          {usage.credits ? <CreditsNote detail={usage.credits.detail} /> : null}
        </div>
      );
    case "not_installed":
      return <UsageNote>Not installed on this machine.</UsageNote>;
    case "unauthenticated":
      return <UsageNote>{provider.signInHint}</UsageNote>;
    case "expired":
      return provider.providerId === "codex" && onCodexSignedIn ? (
        <CodexSignIn onSignedIn={onCodexSignedIn} />
      ) : (
        <UsageNote>{provider.expiredHint}</UsageNote>
      );
    case "error":
      return <UsageNote>{usage.message}</UsageNote>;
  }
}

function accountName(account: UsageProvider): string | null {
  return (
    account.accountLabel ??
    (account.usage?.status === "ok" ? account.usage.accountEmail : null)
  );
}

/** The account threads use, next to the provider name. With several accounts, it switches between them. */
function AccountChip({
  accounts,
  refresh,
}: {
  accounts: UsageProvider[];
  refresh: () => void;
}) {
  const shown =
    accounts.find((account) => account.inUse) ??
    (accounts.length === 1 ? accounts[0] : undefined);
  const label = shown ? accountName(shown) : null;
  const switchable = accounts.filter((account) => account.accountId);
  const chip = "block min-w-0 truncate font-normal text-subtle-foreground";
  if (label === null) return null;
  if (switchable.length < 2)
    return (
      <span title={label} className={chip}>
        {label}
      </span>
    );
  const use = async (account: UsageProvider) => {
    await fetch("/api/v1/plugins/accounts/rpc/accounts.use", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: account.providerId,
        id: account.accountId,
      }),
    }).catch(() => undefined);
    refresh();
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={`Account in use: ${label}`}
          className={cn(chip, "text-left hover:text-sidebar-foreground")}
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        {switchable.map((account) => (
          <DropdownMenuItem
            key={account.id}
            role="menuitemradio"
            aria-checked={account.inUse === true}
            onSelect={() => void use(account)}
            className="flex items-center gap-2"
          >
            <span className="min-w-0 flex-1 truncate">
              {accountName(account) ?? `This ${COMPUTER_TITLE}`}
            </span>
            <Icon
              name="Check"
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0",
                account.inUse ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MachineSelector({
  machines,
  activeMachine,
  onSelect,
}: {
  machines: UsageMachine[];
  activeMachine: UsageMachine | null;
  onSelect: (machineId: string) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={machines.length === 0}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            activeMachine === null
              ? "Usage machine"
              : "Usage machine: " + activeMachine.displayName
          }
          disabled={machines.length === 0}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            LIST_HOVER_TRANSITION,
            "h-6 shrink overflow-hidden px-1 font-mono text-[10.5px] font-normal text-subtle-foreground hover:bg-sidebar-accent",
          )}
        >
          <span className="block min-w-0 flex-1 truncate">
            ~/{activeMachine?.displayName ?? "usage"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        mobileTitle="Usage source"
        className="max-w-72"
      >
        {machines.map((machine) => {
          const isActive = machine.id === activeMachine?.id;
          return (
            <DropdownMenuItem
              key={machine.id}
              role="menuitemradio"
              aria-label={machine.displayName}
              aria-checked={isActive}
              onSelect={() => onSelect(machine.id)}
              className="flex items-center gap-2"
            >
              <Icon
                name={machine.id.startsWith("source:") ? "Layers" : "Laptop"}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">
                {machine.displayName}
              </span>
              <Icon
                name="Check"
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const formatMinutes = (minutes: number) =>
  minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

/** Today's and the last 7 days' active minutes, shown only while the Time in Cloudroom plugin is enabled. */
function TimeInCloudroom() {
  const [time, setTime] = useState<{ today: number; week: number } | null>(null);
  useEffect(() => {
    let live = true;
    let timer: number | null = null;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const { days = {} } = (await (await fetch("/api/v1/cloudroom/time-in-app")).json()) as { days?: Record<string, number> };
      const day = (back: number) => new Date(Date.now() - back * 864e5).toLocaleDateString("en-CA");
      const week = [0, 1, 2, 3, 4, 5, 6].reduce((sum, back) => sum + (days[day(back)] ?? 0), 0);
      if (live) setTime({ today: days[day(0)] ?? 0, week });
    };
    // The plugin list is checked once, when the panel opens; then the minutes, once a minute.
    void (async () => {
      const list = (await (await fetch("/api/v1/plugins")).json()) as { plugins?: { id: string; enabled: boolean }[] };
      if (!live || !list.plugins?.some((plugin) => plugin.id === "time-in-cloudroom" && plugin.enabled)) return;
      await load();
      if (live) timer = window.setInterval(() => void load().catch(() => {}), 60_000);
    })().catch(() => {});
    return () => {
      live = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, []);
  if (time === null) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <section aria-label="Time in Cloudroom" className="flex shrink-0 items-center gap-1 tabular-nums">
            <Icon name="Clock" aria-hidden="true" className="size-3 shrink-0" />
            {formatMinutes(time.today)}
          </section>
        </TooltipTrigger>
        <TooltipContent side="top" className="grid grid-cols-[auto_auto] gap-x-4 border border-border bg-popover text-popover-foreground shadow-md">
          <span className="text-muted-foreground">Today</span>
          <span className="text-right tabular-nums">{formatMinutes(time.today)}</span>
          <span className="text-muted-foreground">Last 7 days</span>
          <span className="text-right tabular-nums">{formatMinutes(time.week)}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const PLAN_RETRY_MS = 10_000;
const MONO_CLASS = "font-mono text-[10.5px] leading-[1.75]";
const CARD_HEADER_CLASS =
  "mx-1.5 flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border pr-1 font-mono text-[10.5px] text-subtle-foreground";
const USAGE_CARD_CLASS =
  "overflow-hidden rounded-xl border border-border bg-card text-sidebar-foreground";
const BILLING_URL = "https://www.cloudroom.dev/billing";
const FREE_WITHOUT_CREDITS = [
  "new cloud agents",
  "idle cloud threads",
  "sleeping sandboxes",
  "waiting for you",
  "local threads",
  "your ai tokens",
  "your own computers",
  "chat history",
  "archived threads",
  "spare sandboxes",
  "the cloud queue",
  "desktop app",
  "phone app",
  "plugins and skills",
  "voice input",
  "share links",
  "inviting friends",
  "reviewing diffs",
];

function usePlanSummary(): [PlanSummary | null, () => void] {
  const [plan, setPlan] = useState(lastPlan);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    const load = () => {
      const next = (summary: PlanSummary | null) => {
        if (controller.signal.aborted) return;
        timer = window.setTimeout(load, summary === null ? PLAN_RETRY_MS : CARD_MAX_AGE_MS);
      };
      if (document.visibilityState === "hidden") return next(lastPlan);
      loadPlanSummary(controller.signal).then(
        (summary) => {
          lastPlan = summary;
          setPlan(summary);
          next(summary);
        },
        () => next(null),
      );
    };
    load();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [reloads]);
  return [plan, useCallback(() => setReloads((count) => count + 1), [])];
}

export function ProviderUsageStatusContent({
  dismiss,
  snapshot,
  threadMachineId,
  plan = null,
  reloadPlan,
  refreshEnabled = true,
}: Partial<ExperimentalSidebarFooterDisclosureProps> & {
  snapshot: UsageStoreSnapshot;
  threadMachineId: string | null;
  plan?: PlanSummary | null;
  reloadPlan?: () => void;
  refreshEnabled?: boolean;
}) {
  const [, refreshCountdowns] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => refreshCountdowns((tick) => tick + 1),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const machines = snapshot.data?.machines ?? [];
  const [requestedMachineId, setRequestedMachineId] = useState<string | null>(
    lastMachineId,
  );
  const activeMachine = selectUsageMachine(
    machines,
    requestedMachineId,
    threadMachineId,
  );
  const providers = useMemo(() => {
    const groups = new Map<
      string,
      UsageProvider & { accounts: UsageProvider[] }
    >();
    for (const account of activeMachine?.providers ?? []) {
      if (account.usage?.status === "not_installed") continue;
      const group = groups.get(account.providerId);
      if (group) group.accounts.push(account);
      else
        groups.set(account.providerId, {
          ...account,
          id: account.providerId,
          accounts: [account],
        });
    }
    return [...groups.values()];
  }, [activeMachine]);
  const hasUsage = hasReportedUsage(
    providers.flatMap((provider) => provider.accounts),
  );
  const feedback =
    activeMachine === null
      ? snapshot.error !== null
        ? usageFeedbackMessages.loadFailed
        : snapshot.isRefreshing
          ? usageFeedbackMessages.loading
          : usageFeedbackMessages.noSources
      : activeMachine.status === "disconnected"
        ? offlineUsageMessage(activeMachine, hasUsage)
        : snapshot.error !== null || activeMachine.error !== null
          ? hasUsage
            ? usageFeedbackMessages.refreshFailed
            : usageFeedbackMessages.loadFailed
          : providers.length === 0
            ? emptyUsageMessage(activeMachine)
            : null;
  const activeMachineId = activeMachine?.id ?? null;
  const hasProviders = providers.length > 0;

  useEffect(() => {
    if (!refreshEnabled || activeMachineId === null || !hasProviders) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void refreshUsage({
        force: false,
        machineIds: [activeMachineId],
        maxAgeMs: CARD_MAX_AGE_MS,
      });
    };
    refresh();
    const timer = window.setInterval(refresh, CARD_MAX_AGE_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [activeMachineId, hasProviders, refreshEnabled]);

  const selectMachine = useCallback((machineId: string) => {
    lastMachineId = machineId;
    setRequestedMachineId(machineId);
  }, []);

  return (
    <div className={cn("flex flex-col", dismiss && "max-h-80")}>
      <div data-provider-usage-header="" className={CARD_HEADER_CLASS}>
        <div className="flex min-w-0 flex-1">
          <MachineSelector
            machines={machines}
            activeMachine={activeMachine}
            onSelect={selectMachine}
          />
        </div>
        <TimeInCloudroom />
        <button
          type="button"
          aria-label="Reload provider usage"
          disabled={snapshot.isRefreshing}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-subtle-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
          onClick={() => {
            reloadPlan?.();
            void refreshUsage({
              force: true,
              machineIds: activeMachineId === null ? null : [activeMachineId],
              maxAgeMs: 0,
            });
          }}
        >
          <Icon
            name="RotateCcw"
            aria-hidden="true"
            className={
              "size-3 " + (snapshot.isRefreshing ? "animate-spin" : "")
            }
          />
        </button>
        {dismiss ? (
          <button
            type="button"
            aria-label="Collapse provider usage"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-subtle-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            onClick={dismiss}
          >
            <Icon name="ChevronDown" aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div
        className={cn(
          "min-h-0 space-y-1.5 overflow-y-auto px-[11px] pb-2.5 pt-1.5",
          MONO_CLASS,
        )}
      >
        {plan === null || plan.meters.length === 0 ? null : (
          <PlanUsage plan={plan} />
        )}
        {feedback === null ? null : (
          <UsageFeedback
            message={feedback}
            loading={feedback === usageFeedbackMessages.loading}
          />
        )}
        {providers.map((provider) => (
          <section key={provider.id} aria-label={provider.displayName}>
            <h2 className="flex min-w-0 items-center gap-2 font-normal">
              <ProviderIcon
                providerKind="agent"
                provider={provider}
                fallback="Bot"
                className="size-3 shrink-0"
              />
              <span className="shrink-0 lowercase text-primary-text">
                {provider.displayName}
              </span>
              <AccountChip
                accounts={provider.accounts}
                refresh={() =>
                  void refreshUsage({
                    force: false,
                    machineIds:
                      activeMachineId === null ? null : [activeMachineId],
                    maxAgeMs: CARD_MAX_AGE_MS,
                  })
                }
              />
            </h2>
            {(provider.accounts.some((account) => account.accountId)
              ? [
                  provider.accounts.find((account) => account.inUse) ??
                    provider.accounts[0]!,
                ]
              : provider.accounts
            ).map((account) => (
                  <div key={account.id}>
                    {account.accountLabel === null ||
                    provider.accounts.length === 1 ||
                    account.accountId ? null : (
                      <h3
                        title={account.accountLabel}
                        className="truncate text-subtle-foreground"
                      >
                        {account.accountLabel}
                      </h3>
                    )}
                    {account.usage === null && snapshot.isRefreshing ? (
                      <UsageNote>{usageFeedbackMessages.loading}</UsageNote>
                    ) : account.usage === null &&
                      (activeMachine?.error != null ||
                        snapshot.error !== null) ? (
                      <UsageNote>{usageFeedbackMessages.unavailable}</UsageNote>
                    ) : (
                      <ProviderUsageBody
                        provider={account}
                        onCodexSignedIn={
                          activeMachine?.id.startsWith("source:") ||
                          (account.accountId && account.accountId !== "local")
                            ? undefined
                            : () =>
                                void refreshUsage({
                                  force: true,
                                  machineIds:
                                    activeMachineId === null ? null : [activeMachineId],
                                  maxAgeMs: 0,
                                })
                        }
                      />
                    )}
                  </div>
                ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function PriceChip({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        "rounded-[3px] px-1.5 font-bold tracking-wider text-primary-foreground",
        className,
      )}
    >
      {label}
    </span>
  );
}

function CreditsPriceList() {
  const columnLength = Math.ceil(FREE_WITHOUT_CREDITS.length / 2);
  return (
    <section aria-label="What uses credits" className={USAGE_CARD_CLASS}>
      <h2 className={cn(CARD_HEADER_CLASS, "pl-[5px] font-normal")}>
        ~/what uses credits
      </h2>
      <div
        className={cn(
          "grid gap-x-4 gap-y-3 px-[11px] pb-2.5 pt-2 sm:grid-cols-3",
          MONO_CLASS,
        )}
      >
        <div>
          <p className="mb-1 flex items-center gap-2">
            <PriceChip label="PAID" className="bg-primary" />
            <span className="text-subtle-foreground">uses credits</span>
          </p>
          <p className="flex gap-[7px] font-bold text-foreground">
            <span
              aria-hidden="true"
              className="font-normal text-subtle-foreground"
            >
              └
            </span>
            agents actively running
          </p>
        </div>
        <div className="sm:col-span-2 sm:border-l sm:border-dashed sm:border-border sm:pl-4">
          <p className="mb-1 flex items-center gap-2">
            <PriceChip label="FREE" className="bg-success" />
            <span className="text-subtle-foreground">0 credits</span>
          </p>
          <ul className="grid gap-x-6 sm:auto-cols-fr sm:grid-flow-col sm:grid-rows-9">
            {FREE_WITHOUT_CREDITS.map((item, index) => (
              <li key={item} className="flex min-w-0 gap-[7px]">
                <span aria-hidden="true" className="text-subtle-foreground">
                  {(index + 1) % columnLength === 0 ||
                  index === FREE_WITHOUT_CREDITS.length - 1
                    ? "└"
                    : "├"}
                </span>
                <span className="min-w-0 flex-1 truncate">{item}</span>
                <span className="font-bold text-success">0</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function UsagePageContent({
  snapshot,
  plan,
  reloadPlan,
  refreshEnabled = true,
}: {
  snapshot: UsageStoreSnapshot;
  plan: PlanSummary | null;
  reloadPlan?: () => void;
  refreshEnabled?: boolean;
}) {
  return (
    <div className="space-y-3 [zoom:1.25]">
      {plan === null || plan.meters.length === 0 ? null : (
        <div
          className={cn(
            USAGE_CARD_CLASS,
            "flex items-start gap-3 px-[11px] py-2",
            MONO_CLASS,
          )}
        >
          <PlanUsage plan={plan} className="min-w-0 flex-1 border-0 pb-0" />
          <UrlLink
            href={BILLING_URL}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 text-foreground no-underline hover:bg-muted"
          >
            billing
            <Icon name="ExternalLink" aria-hidden="true" className="size-3" />
          </UrlLink>
        </div>
      )}
      <CreditsPriceList />
      <div className={USAGE_CARD_CLASS}>
        <ProviderUsageStatusContent
          snapshot={snapshot}
          threadMachineId={null}
          reloadPlan={reloadPlan}
          refreshEnabled={refreshEnabled}
        />
      </div>
    </div>
  );
}

function UsageSettings() {
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const [plan, reloadPlan] = usePlanSummary();
  return (
    <UsagePageContent snapshot={snapshot} plan={plan} reloadPlan={reloadPlan} />
  );
}

function ProviderUsageStatus(props: ExperimentalSidebarFooterDisclosureProps) {
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const { threadId } = useBbContext();
  const sidebarThreads = experimental_useSidebarThreads();
  const threadMachineId = useMemo(
    () =>
      sidebarThreads.threads.find((thread) => thread.id === threadId)?.host
        ?.id ?? null,
    [sidebarThreads.threads, threadId],
  );
  const [plan, reloadPlan] = usePlanSummary();
  return (
    <ProviderUsageStatusContent
      {...props}
      snapshot={snapshot}
      threadMachineId={threadMachineId}
      plan={plan}
      reloadPlan={reloadPlan}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "usage", component: UsageSettings });
  const footer = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "usage",
    label: "Provider usage",
    icon: "ChartColumn",
    component: ProviderUsageStatus,
  });
  app.contentScripts.register({
    id: "refresh-usage",
    mount({ signal }) {
      let timer: number | null = null;
      let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
      let blurredAt: number | null = null;
      const scheduleSafetyRefresh = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (signal.aborted) return;
        timer = window.setTimeout(runSafetyRefresh, BACKGROUND_REFRESH_MS);
      };
      const reconcile = async (maxAgeMs: number) => {
        if (storeSnapshot.data === null)
          await refreshUsage({
            force: false,
            machineIds: null,
            maxAgeMs,
            signal,
          });
        const machineIds = (storeSnapshot.data?.machines ?? [])
          .filter((machine) => machine.status === "connected")
          .map((machine) => machine.id);
        if (machineIds.length > 0 && !signal.aborted)
          await refreshUsage({ force: false, machineIds, maxAgeMs, signal });
      };
      const runSafetyRefresh = () => {
        void reconcile(BACKGROUND_REFRESH_MS);
        scheduleSafetyRefresh();
      };
      let notified = new Set<string>();
      const showCredits = () => {
        const paid = accountsOnCredits(storeSnapshot.data);
        const names = [...new Set(paid.values())];
        footer.setAlert(
          names.length === 0
            ? null
            : `${names.join(" and ")} on usage credits at API pricing`,
        );
        for (const [key, name] of paid)
          if (
            !notified.has(key) &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          )
            new Notification(`${name} is using usage credits`, {
              body: "Your plan limit is at 100%. New requests are billed at API pricing.",
              tag: `provider-usage-credits-${key}`,
            });
        if (storeSnapshot.data !== null) notified = new Set(paid.keys());
      };
      const unsubscribe = subscribeStore(showCredits);
      const onActive = () => {
        const inactiveAt =
          hiddenAt === null
            ? blurredAt
            : blurredAt === null
              ? hiddenAt
              : Math.min(hiddenAt, blurredAt);
        hiddenAt = null;
        blurredAt = null;
        if (
          inactiveAt !== null &&
          Date.now() - inactiveAt >= FOCUS_MAX_AGE_MS
        ) {
          void reconcile(FOCUS_MAX_AGE_MS);
        }
        scheduleSafetyRefresh();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          hiddenAt ??= Date.now();
          return;
        }
        onActive();
      };
      const onBlur = () => {
        blurredAt ??= Date.now();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", onBlur);
      window.addEventListener("focus", onActive);
      void reconcile(BACKGROUND_REFRESH_MS);
      scheduleSafetyRefresh();
      return () => {
        unsubscribe();
        footer.setAlert(null);
        if (timer !== null) window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("focus", onActive);
      };
    },
  });
});
