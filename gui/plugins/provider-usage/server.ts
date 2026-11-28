import {
  normalizeUsageMeasurement,
  selectUsageResources,
} from "./usage-normalization.js";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  usageSnapshotSchema,
  type ProviderUsage,
  type UsageMachine,
  type UsageProvider,
  type UsageSnapshot,
} from "./usage-schema.js";

import {
  usageListMethod,
  usageFetchMethod,
  usageMeasurementSchema,
  type UsageResourceList,
  type UsageMeasurement,
  usageSourceRpcContract,
  type UsageResource as Resource,
  ACCOUNTS_LIST_METHOD,
  accountViewsSchema,
} from "./usage-source-contract.js";

const SAVED_MEASUREMENTS_KEY = "measurements:v1";
const CLAUDE_PROVIDER_ID = "claude-code";
// Claude /api/oauth/usage throttles hard per token; poll on a randomized 15–45 min cadence.
const CLAUDE_POLL_MIN_MS = 15 * 60_000;
const CLAUDE_POLL_MAX_MS = 45 * 60_000;
const CLAUDE_MIN_GAP_MS = 5 * 60_000;
const CLAUDE_POST_TURN_MIN_MS = 15_000;
const CLAUDE_POST_TURN_MAX_MS = 45_000;
const USAGE_UPDATED_EVENT = "usage-updated";
const ACCOUNT_PROVIDERS = [
  "claude-code",
  "codex",
  "acp-cursor",
  "acp-antigravity",
] as const;

const randomDelay = (minMs: number, maxMs: number): number =>
  minMs + Math.floor(Math.random() * (maxMs - minMs + 1));

function rollExpiredWindows(
  measurement: UsageMeasurement,
  now = Date.now(),
): UsageMeasurement {
  if (measurement.usage.status !== "ok") return measurement;
  let changed = false;
  const windows = measurement.usage.windows.map((window) => {
    if (window.resetsAt === null) return window;
    const resetAt = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetAt) || resetAt > now) return window;
    changed = true;
    return { ...window, usedPercent: 0, resetsAt: null };
  });
  return changed
    ? { ...measurement, usage: { ...measurement.usage, windows } }
    : measurement;
}

function pluginIdFromKey(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string"
      ? parsed[0]
      : null;
  } catch {
    return null;
  }
}

interface SourceResult {
  pluginId: string;
  label: string | null;
  resources: UsageResourceList["resources"];
  error: string | null;
}

const TINT_COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([-+.%\w\s,/]*\)|[a-z]{3,20})$/iu;

export const providerUsageRpcContract = defineRpcContract({
  getUsage: {
    input: z.strictObject({
      force: z.boolean(),
      machineIds: z.nullable(z.array(z.string().check(z.minLength(1)))),
      providerId: z.nullable(z.string()),
      maxAgeMs: z.number().check(z.int(), z.nonnegative()),
    }),
    output: usageSnapshotSchema,
  },
});

type UsageRequest = z.infer<typeof providerUsageRpcContract.getUsage.input>;
function normalizedTint(
  tint: { light: string; dark: string } | undefined,
): { light: string; dark: string } | null {
  if (
    tint === undefined ||
    !TINT_COLOR_PATTERN.test(tint.light.trim()) ||
    !TINT_COLOR_PATTERN.test(tint.dark.trim())
  ) {
    return null;
  }
  return { light: tint.light.trim(), dark: tint.dark.trim() };
}

function normalizedUsage(
  usage: Resource["usage"] | undefined,
): ProviderUsage | null {
  if (usage === undefined) return null;
  switch (usage.status) {
    case "ok":
      return {
        status: "ok",
        accountEmail: usage.accountEmail || null,
        planLabel: usage.planLabel || null,
        windows: usage.windows.map((window) => ({
          label: window.label,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt || null,
          cost: window.cost ?? null,
        })),
        credits: usage.credits ?? null,
      };
    case "not_installed":
      return { status: "not_installed" };
    case "unauthenticated":
      return { status: "unauthenticated" };
    case "expired":
      return { status: "expired" };
    case "error":
      return {
        status: "error",
        message: usage.message || "Usage could not be collected.",
      };
  }
}

type Provider = Awaited<
  ReturnType<BbPluginApi["sdk"]["providers"]["list"]>
>[number];

function normalizedProvider(
  provider: Pick<
    Provider,
    "id" | "displayName" | "logoUrl" | "icon" | "strings"
  >,
  usage: Resource["usage"] | undefined,
): UsageProvider {
  return {
    id: provider.id,
    providerId: provider.id,
    accountLabel: null,
    displayName: provider.displayName,
    logoUrl: provider.logoUrl,
    icon: provider.icon ?? null,
    strings: { iconTint: normalizedTint(provider.strings?.iconTint) },
    signInHint:
      provider.strings?.signInHint ??
      "Sign in to " + provider.displayName + ", then reload usage.",
    expiredHint:
      provider.strings?.expiredHint ??
      "Your " +
        provider.displayName +
        " session expired. Sign in again, then reload usage.",
    usage: normalizedUsage(usage),
  };
}

function resourceProvider(
  resource: UsageResourceList["resources"][number],
  measurement: UsageMeasurement | undefined,
  pluginId: string,
  providers: Provider[],
): UsageProvider {
  const metadata = providers.find(
    (provider) => provider.id === resource.providerId,
  );
  return {
    ...normalizedProvider(
      metadata ?? {
        id: resource.providerId,
        displayName: resource.providerId,
        logoUrl: null,
      },
      measurement?.usage,
    ),
    ...(resource.scope.kind === "shared"
      ? {
          signInHint:
            "Sign in to this account in the source plugin’s settings, then reload usage.",
          expiredHint:
            "This account’s session expired. Sign in again in the source plugin’s settings, then reload usage.",
        }
      : {}),
    id: `${pluginId}:${resource.id}`,
    accountLabel:
      resource.scope.kind === "shared"
        ? (measurement?.usage.accountEmail ?? resource.label)
        : null,
  };
}

function accountUsage(
  account: z.infer<typeof accountViewsSchema>[number],
  native: ProviderUsage | null = null,
): ProviderUsage | null {
  if (native && native.status !== "ok") return native;
  const windows = account.windows.length
    ? account.windows.map((window) => ({
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(),
        cost: null,
      }))
    : [...(native?.windows ?? [])];
  // Add one fallback bar for a real rejection that none of the measured windows shows.
  if (
    account.limitedUntil &&
    account.limitedUntil > Date.now() &&
    !windows.some((window) => Math.round(window.usedPercent) >= 100)
  ) {
    windows.push({
      label: "Limit hit",
      usedPercent: 100,
      resetsAt: new Date(account.limitedUntil).toISOString(),
      cost: null,
    });
  }
  const credits = account.windows.length ? account.credits : (account.credits ?? native?.credits);
  if (!windows.length && !credits) return native;
  return {
    status: "ok",
    accountEmail: account.email ?? native?.accountEmail ?? null,
    planLabel: account.plan ?? native?.planLabel ?? null,
    credits: credits ? { detail: credits.detail || null } : null,
    windows,
  };
}

export default function providerUsagePlugin(room: BbPluginApi): void {
  type AccountListEntry = {
    providerId: (typeof ACCOUNT_PROVIDERS)[number];
    accounts: z.infer<typeof accountViewsSchema>;
    ok: boolean;
  };

  const discoverAccountSources = async () =>
    (
      await room.sdk.plugins
        .experimental_discoverRpc({ method: ACCOUNTS_LIST_METHOD })
        .catch(() => [])
    ).filter((source) => source.method === ACCOUNTS_LIST_METHOD);

  const fetchAccountProvider = async (
    pluginId: string,
    providerId: (typeof ACCOUNT_PROVIDERS)[number],
    refreshClaude: boolean,
    skipLocalClaude: boolean,
  ): Promise<AccountListEntry> => {
    try {
      const raw: unknown = await room.sdk.plugins.callRpc({
        pluginId,
        method: ACCOUNTS_LIST_METHOD,
        input:
          providerId === CLAUDE_PROVIDER_ID && refreshClaude
            ? {
                provider: providerId,
                refresh: true,
                ...(skipLocalClaude ? { skipLocal: true } : {}),
              }
            : { provider: providerId },
        outputSchema: accountViewsSchema,
        signal: AbortSignal.timeout(
          providerId === CLAUDE_PROVIDER_ID && refreshClaude ? 40_000 : 10_000,
        ),
      });
      const parsed = accountViewsSchema.safeParse(raw);
      if (!parsed.success) return { providerId, accounts: [], ok: false };
      return {
        providerId,
        accounts: parsed.data.filter((account) => !account.needsSignIn),
        ok: true,
      };
    } catch {
      return { providerId, accounts: [], ok: false };
    }
  };

  const listAllAccounts = async (): Promise<{
    sources: Awaited<ReturnType<typeof discoverAccountSources>>;
    bySource: Map<string, AccountListEntry[]>;
  }> => {
    const sources = await discoverAccountSources();
    const bySource = new Map<string, AccountListEntry[]>();
    await Promise.all(
      sources.map(async (source) => {
        const entries = await Promise.all(
          ACCOUNT_PROVIDERS.map((providerId) =>
            fetchAccountProvider(source.pluginId, providerId, false, false),
          ),
        );
        bySource.set(source.pluginId, entries);
      }),
    );
    return { sources, bySource };
  };

  const hasActiveAddedClaude = (
    bySource: Map<string, AccountListEntry[]>,
  ): boolean => {
    for (const entries of bySource.values()) {
      const claude = entries.find((e) => e.providerId === CLAUDE_PROVIDER_ID);
      if (
        claude?.accounts.some(
          (account) => account.id !== "local" && account.inUse === true,
        )
      ) {
        return true;
      }
    }
    return false;
  };

  const applyAccounts = (
    machines: UsageMachine[],
    providers: Provider[],
    bySource: Map<string, AccountListEntry[]>,
    skipLocalClaude: boolean,
    observedAtByProviderId: ReadonlyMap<string, number>,
  ): void => {
    for (const entries of bySource.values())
      for (const { providerId, accounts } of entries) {
        // The name the user gave "This Mac" belongs to this computer's own login, not another machine's.
        const mac = accounts.find((account) => account.id === "local");
        const localEntry = (machine: UsageMachine, entry: UsageProvider) => {
          if (!machine.primary || !mac) return entry;
          const measuredEmail =
            entry.usage?.status === "ok" ? entry.usage.accountEmail : null;
          const sameLogin =
            !mac.email ||
            !measuredEmail ||
            mac.email.trim().toLowerCase() === measuredEmail.trim().toLowerCase();
          const macNewest = mac.windows.reduce(
            (max, window) => Math.max(max, window.checkedAt ?? 0),
            0,
          );
          const nativeObservedAt = observedAtByProviderId.get(entry.id) ?? 0;
          const preferNative =
            skipLocalClaude ||
            (entry.usage?.status === "ok" &&
              nativeObservedAt > 0 &&
              nativeObservedAt >= macNewest);
          return {
            ...entry,
            accountLabel: (sameLogin ? mac.name : null) ?? entry.accountLabel,
            usage:
              providerId === CLAUDE_PROVIDER_ID &&
              mac.email &&
              (mac.inUse || mac.limitedUntil)
                ? accountUsage(
                    preferNative
                      ? { ...mac, windows: [], credits: null }
                      : mac,
                    entry.usage,
                  )
                : entry.usage,
          };
        };
        if (!accounts.some((account) => account.id !== "local")) {
          for (const machine of machines)
            machine.providers = machine.providers.map((entry) =>
              entry.providerId === providerId
                ? localEntry(machine, entry)
                : entry,
            );
          continue;
        }
        const metadata = providers.find(
          (provider) => provider.id === providerId,
        );
        for (const machine of machines) {
          if (machine.id.startsWith("source:")) continue;
          const index = machine.providers.findIndex(
            (provider) => provider.providerId === providerId,
          );
          const local = index < 0 ? undefined : machine.providers[index];
          const base =
            local ??
            (metadata ? normalizedProvider(metadata, undefined) : null);
          if (base === null) continue;
          const mapped = accounts.flatMap((account): UsageProvider[] => {
            if (account.id === "local")
              return local
                ? [
                    localEntry(machine, {
                      ...local,
                      accountId: "local",
                      inUse: account.inUse,
                    }),
                  ]
                : [];
            return [
              {
                ...base,
                id: `accounts:${account.id}`,
                accountLabel: account.name ?? account.email,
                accountId: account.id,
                inUse: account.inUse,
                usage: accountUsage(account),
              },
            ];
          });
          if (index < 0) machine.providers.push(...mapped);
          else machine.providers.splice(index, 1, ...mapped);
        }
      }
  };
  let disposed = false;
  const inventories = new Map<string, SourceResult>();
  const resourceMeta = new Map<
    string,
    {
      pluginId: string;
      resourceId: string;
      providerId: string;
      hostId: string | null;
    }
  >();
  const measurements = new Map<
    string,
    { value: UsageMeasurement; loadedAt: number }
  >();
  const claudeSchedule = new Map<
    string,
    { lastAttemptAt: number; nextPollAt: number }
  >();
  const failures = new Set<string>();
  const pending = new Map<
    string,
    { force: boolean; promise: Promise<UsageMeasurement> }
  >();
  const pendingClaudePostTurnHosts = new Set<string | null>();
  let primaryHostId: string | null = null;
  let claudePollTimer: ReturnType<typeof setTimeout> | null = null;
  let claudePostTurnTimer: ReturnType<typeof setTimeout> | null = null;
  const keyOf = (pluginId: string, resourceId: string) =>
    JSON.stringify([pluginId, resourceId]);
  const markClaudeAttempt = (key: string, now = Date.now()) => {
    claudeSchedule.set(key, {
      lastAttemptAt: now,
      nextPollAt: now + randomDelay(CLAUDE_POLL_MIN_MS, CLAUDE_POLL_MAX_MS),
    });
  };

  let hydrated: Promise<void> | null = null;
  let lastSavedJson = "";
  let persistChain: Promise<void> = Promise.resolve();
  const buildSavedSnapshot = (): Record<string, UsageMeasurement> => {
    const saved: Record<string, UsageMeasurement> = {};
    for (const [key, entry] of measurements) {
      if (entry.value.usage.status === "ok") saved[key] = entry.value;
    }
    return saved;
  };
  const hydrateMeasurements = (): Promise<void> => {
    if (hydrated !== null) return hydrated;
    hydrated = (async () => {
      const raw: unknown = await room.storage?.kv
        ?.get(SAVED_MEASUREMENTS_KEY)
        .catch(() => undefined);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      for (const [key, item] of Object.entries(raw)) {
        if (measurements.has(key)) continue;
        const parsed = usageMeasurementSchema.safeParse(item);
        if (parsed.success && parsed.data.usage.status === "ok") {
          measurements.set(key, {
            value: normalizeUsageMeasurement(parsed.data),
            loadedAt: 0,
          });
        }
      }
      lastSavedJson = JSON.stringify(buildSavedSnapshot());
    })();
    return hydrated;
  };
  const persistMeasurements = (): void => {
    const kv = room.storage?.kv;
    if (!kv || disposed) return;
    const saved = buildSavedSnapshot();
    const json = JSON.stringify(saved);
    if (json === lastSavedJson) return;
    lastSavedJson = json;
    persistChain = persistChain
      .then(() => kv.set(SAVED_MEASUREMENTS_KEY, saved))
      .catch(() => {});
  };

  const fetchResource = async (
    pluginId: string,
    resourceId: string,
    force: boolean,
  ): Promise<UsageMeasurement> => {
    const key = keyOf(pluginId, resourceId);
    const running = pending.get(key);
    if (running) {
      if (!force || running.force) return running.promise;
      await running.promise.catch(() => undefined);
      return fetchResource(pluginId, resourceId, force);
    }
    if (resourceMeta.get(key)?.providerId === CLAUDE_PROVIDER_ID) {
      markClaudeAttempt(key);
    }
    const promise = room.sdk.plugins
      .callRpc({
        pluginId,
        method: usageFetchMethod,
        input: { resourceId, refresh: force },
        outputSchema: usageSourceRpcContract[usageFetchMethod].output,
        signal: AbortSignal.timeout(45_000),
      })
      .then((raw) => {
        const value = normalizeUsageMeasurement(raw);
        if (value.usage.status === "error")
          throw new Error("Usage could not be refreshed.");
        measurements.set(key, { value, loadedAt: Date.now() });
        failures.delete(key);
        persistMeasurements();
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, { force, promise });
    return promise;
  };

  const refreshInBackground = (
    pluginId: string,
    resourceId: string,
    force: boolean,
  ): void => {
    if (disposed) return;
    const key = keyOf(pluginId, resourceId);
    if (pending.has(key)) return;
    const before = measurements.get(key)?.value;
    const hadFailure = failures.has(key);
    void fetchResource(pluginId, resourceId, force)
      .then((next) => {
        if (disposed) return;
        if (hadFailure || JSON.stringify(next) !== JSON.stringify(before)) {
          room.realtime?.publish(USAGE_UPDATED_EVENT, {});
        }
      })
      .catch(() => {
        if (disposed) return;
        failures.add(key);
        if (!hadFailure) room.realtime?.publish(USAGE_UPDATED_EVENT, {});
      });
  };

  const refreshHostClaudeIfActive = async (
    hostIds?: ReadonlySet<string | null>,
  ) => {
    if (disposed) return;
    const { bySource } = await listAllAccounts();
    const addedClaudeActive = hasActiveAddedClaude(bySource);
    const now = Date.now();
    for (const [key, meta] of resourceMeta) {
      if (meta.providerId !== CLAUDE_PROVIDER_ID) continue;
      if (hostIds && meta.hostId && !hostIds.has(meta.hostId)) continue;
      if (addedClaudeActive && meta.hostId === primaryHostId) continue;
      const lastCheckedAt = Math.max(
        claudeSchedule.get(key)?.lastAttemptAt ?? 0,
        measurements.get(key)?.loadedAt ?? 0,
      );
      if (lastCheckedAt > 0 && now - lastCheckedAt < CLAUDE_MIN_GAP_MS) continue;
      refreshInBackground(meta.pluginId, meta.resourceId, false);
    }
  };

  const scheduleClaudePoll = (): void => {
    if (disposed) return;
    if (claudePollTimer !== null) clearTimeout(claudePollTimer);
    claudePollTimer = setTimeout(() => {
      claudePollTimer = null;
      if (disposed) return;
      void refreshHostClaudeIfActive().catch(() => {});
      scheduleClaudePoll();
    }, randomDelay(CLAUDE_POLL_MIN_MS, CLAUDE_POLL_MAX_MS));
    claudePollTimer.unref?.();
  };
  scheduleClaudePoll();

  const readUsage = async (request: UsageRequest): Promise<UsageSnapshot> => {
    await hydrateMeasurements();
    const hostId = request.machineIds?.find((id) => !id.startsWith("source:"));
    const [hosts, sources, usageProviders, config, initialAccounts] =
      await Promise.all([
        room.sdk.hosts
          .list()
          .then((hosts) => hosts.filter((host) => host.type !== "ephemeral")),
        room.sdk.plugins.experimental_discoverRpc({ method: usageListMethod }),
        room.sdk.providers
          .list(
            hostId === undefined
              ? { capability: "usage" }
              : { capability: "usage", hostId },
          )
          .catch(() => []),
        room.sdk.system.config().catch(() => null),
        listAllAccounts(),
      ]);
    primaryHostId = config?.primaryHostId ?? primaryHostId;
    hosts.sort(
      (a, b) =>
        Number(b.id === config?.primaryHostId) -
        Number(a.id === config?.primaryHostId),
    );
    for (const id of inventories.keys())
      if (!sources.some((source) => source.pluginId === id))
        inventories.delete(id);
    await Promise.all(
      sources.map(async (source) => {
        try {
          const inventory = await room.sdk.plugins.callRpc({
            pluginId: source.pluginId,
            method: usageListMethod,
            input: {},
            outputSchema: usageSourceRpcContract[usageListMethod].output,
            signal: AbortSignal.timeout(45_000),
          });
          inventories.set(source.pluginId, {
            pluginId: source.pluginId,
            label: inventory.label ?? null,
            resources: inventory.resources,
            error: null,
          });
        } catch {
          const previous = inventories.get(source.pluginId);
          inventories.set(source.pluginId, {
            pluginId: source.pluginId,
            label: previous?.label ?? null,
            resources: previous?.resources ?? [],
            error: "Usage resources could not be listed.",
          });
        }
      }),
    );
    // A source may report a provider without native usage (Kimi). Look up
    // just its name and icon: the registry answers without checking any host.
    const others = [
      ...new Set(
        [...inventories.values()].flatMap((source) =>
          source.resources.map((resource) => resource.providerId),
        ),
      ),
    ].filter((id) => !usageProviders.some((provider) => provider.id === id));
    const providers = [
      ...usageProviders,
      ...(
        await Promise.all(
          others.map((providerId) =>
            room.sdk.providers
              .list({ providerId })
              .then((list) => list.filter((item) => item.id === providerId))
              .catch(() => []),
          ),
        )
      ).flat(),
    ];
    const keys = new Set<string>();
    const discoveredPlugins = new Set(sources.map((source) => source.pluginId));
    const erroredPlugins = new Set<string>();
    for (const source of inventories.values()) {
      if (source.error !== null) erroredPlugins.add(source.pluginId);
      for (const resource of source.resources) {
        const key = keyOf(source.pluginId, resource.id);
        keys.add(key);
        resourceMeta.set(key, {
          pluginId: source.pluginId,
          resourceId: resource.id,
          providerId: resource.providerId,
          hostId: resource.scope.kind === "host" ? resource.scope.hostId : null,
        });
      }
    }
    let evicted = false;
    for (const key of [...measurements.keys()]) {
      const owner = pluginIdFromKey(key);
      if (
        !keys.has(key) &&
        owner !== null &&
        discoveredPlugins.has(owner) &&
        !erroredPlugins.has(owner)
      ) {
        measurements.delete(key);
        claudeSchedule.delete(key);
        failures.delete(key);
        resourceMeta.delete(key);
        evicted = true;
      }
    }
    if (evicted) persistMeasurements();
    const addedClaudeActive = hasActiveAddedClaude(initialAccounts.bySource);
    const selected = [...inventories.values()].flatMap((source) =>
      source.resources
        .filter((resource) => {
          const machineId =
            resource.scope.kind === "shared"
              ? `source:${source.pluginId}`
              : resource.scope.hostId;
          // Skip fetching "This Mac" Claude when an added account is active and overrides it.
          if (
            addedClaudeActive &&
            resource.providerId === CLAUDE_PROVIDER_ID &&
            resource.scope.kind === "host" &&
            resource.scope.hostId === config?.primaryHostId
          ) {
            return false;
          }
          // A provider or a machine selection triggers fetches; neither means
          // inventory only, so background refreshes never fetch every source.
          return (
            (request.providerId === null
              ? request.machineIds !== null
              : resource.providerId === request.providerId) &&
            (request.machineIds === null ||
              request.machineIds.includes(machineId)) &&
            (resource.scope.kind === "shared" ||
              hosts.some(
                (host) =>
                  resource.scope.kind === "host" &&
                  host.id === resource.scope.hostId &&
                  host.status === "connected",
              ))
          );
        })
        .map((resource) => ({ source, resource })),
    );
    const refreshClaude =
      request.force &&
      (request.providerId === null ||
        request.providerId === CLAUDE_PROVIDER_ID) &&
      hosts.some(
        (host) =>
          request.machineIds === null || request.machineIds.includes(host.id),
      );
    // When an added Claude account is active, refresh it in parallel with the other providers.
    const parallelClaudeAccountsPromise =
      refreshClaude && addedClaudeActive
        ? Promise.all(
            initialAccounts.sources.map(async (source) => ({
              pluginId: source.pluginId,
              entry: await fetchAccountProvider(
                source.pluginId,
                CLAUDE_PROVIDER_ID,
                true,
                false,
              ),
            })),
          )
        : null;
    let primaryClaudeRefreshed = false;
    const now = Date.now();
    const hasAnyCached = selected.some(({ source, resource }) =>
      measurements.has(keyOf(source.pluginId, resource.id)),
    );
    await Promise.all(
      selected.map(async ({ source, resource }) => {
        const key = keyOf(source.pluginId, resource.id);
        const cached = measurements.get(key);
        if (!request.force && cached) {
          if (resource.providerId === CLAUDE_PROVIDER_ID) {
            const schedule = claudeSchedule.get(key);
            if (cached.loadedAt === 0) {
              if (schedule && now - schedule.lastAttemptAt < CLAUDE_MIN_GAP_MS) {
                return;
              }
            } else {
              const dueAt =
                schedule?.nextPollAt ?? cached.loadedAt + CLAUDE_POLL_MIN_MS;
              const lastAttemptAt = Math.max(
                schedule?.lastAttemptAt ?? 0,
                cached.loadedAt,
              );
              if (now < dueAt || now - lastAttemptAt < CLAUDE_MIN_GAP_MS) {
                return;
              }
            }
          } else if (now - cached.loadedAt < request.maxAgeMs) {
            return;
          }
          // Stale-while-revalidate: return cached bars immediately and refresh in background.
          refreshInBackground(source.pluginId, resource.id, false);
          return;
        }
        if (!request.force && resource.providerId === CLAUDE_PROVIDER_ID) {
          const schedule = claudeSchedule.get(key);
          if (schedule && now - schedule.lastAttemptAt < CLAUDE_MIN_GAP_MS) {
            return;
          }
        }
        if (!request.force && hasAnyCached) {
          refreshInBackground(source.pluginId, resource.id, false);
          return;
        }
        try {
          await fetchResource(source.pluginId, resource.id, request.force);
          if (
            resource.providerId === CLAUDE_PROVIDER_ID &&
            resource.scope.kind === "host" &&
            resource.scope.hostId === config?.primaryHostId
          ) {
            primaryClaudeRefreshed = true;
          }
        } catch {
          failures.add(key);
        }
      }),
    );
    const accountsBySource = initialAccounts.bySource;
    let claudeAccountsRefreshFailed = false;
    const applyRefreshedClaudeAccounts = (
      pluginId: string,
      entry: AccountListEntry,
    ) => {
      if (!entry.ok) {
        claudeAccountsRefreshFailed = true;
        return;
      }
      const current = accountsBySource.get(pluginId) ?? [];
      accountsBySource.set(
        pluginId,
        current.map((item) =>
          item.providerId === CLAUDE_PROVIDER_ID ? entry : item,
        ),
      );
    };
    if (parallelClaudeAccountsPromise !== null) {
      const refreshed = await parallelClaudeAccountsPromise;
      for (const { pluginId, entry } of refreshed) {
        applyRefreshedClaudeAccounts(pluginId, entry);
      }
    } else if (refreshClaude) {
      await Promise.all(
        initialAccounts.sources.map(async (source) => {
          const entry = await fetchAccountProvider(
            source.pluginId,
            CLAUDE_PROVIDER_ID,
            true,
            primaryClaudeRefreshed,
          );
          applyRefreshedClaudeAccounts(source.pluginId, entry);
        }),
      );
    }
    const machines: UsageMachine[] = hosts.map((host) => ({
      id: host.id,
      displayName: host.name,
      status: host.status,
      providers: [],
      error: null,
      ...(host.id === config?.primaryHostId ? { primary: true as const } : {}),
    }));
    const candidates: Array<{
      source: SourceResult;
      resource: UsageResourceList["resources"][number];
      machineId: string;
    }> = [];
    for (const source of inventories.values()) {
      const hasShared =
        source.label !== null ||
        source.resources.some((resource) => resource.scope.kind === "shared");
      if (hasShared || (source.error !== null && source.resources.length === 0))
        machines.push({
          id: `source:${source.pluginId}`,
          displayName:
            source.label ??
            sources.find((item) => item.pluginId === source.pluginId)
              ?.displayName ??
            source.pluginId,
          status: "connected",
          providers: [],
          error: source.error,
        });
      for (const resource of source.resources) {
        const machineId =
          resource.scope.kind === "shared"
            ? `source:${source.pluginId}`
            : resource.scope.hostId;
        candidates.push({ source, resource, machineId });
      }
    }
    const observedAtByProviderId = new Map<string, number>();
    for (const machine of machines) {
      const visible = selectUsageResources(
        candidates.filter((candidate) => candidate.machineId === machine.id),
        ({ source, resource }) => ({
          ...resource,
          accountKey: measurements.has(keyOf(source.pluginId, resource.id))
            ? measurements.get(keyOf(source.pluginId, resource.id))!.value
                .accountKey
            : resource.accountKey,
        }),
      );
      for (const { source, resource } of visible) {
        const key = keyOf(source.pluginId, resource.id);
        const cached = measurements.get(key);
        const providerEntry = resourceProvider(
          resource,
          cached ? rollExpiredWindows(cached.value) : undefined,
          source.pluginId,
          providers,
        );
        const observedAt = cached
          ? (cached.value.observedAt ?? cached.loadedAt)
          : 0;
        if (observedAt > 0) observedAtByProviderId.set(providerEntry.id, observedAt);
        machine.providers.push(providerEntry);
        const ignoredLocalClaude =
          addedClaudeActive &&
          resource.providerId === CLAUDE_PROVIDER_ID &&
          machine.primary === true;
        if (source.error !== null || (!ignoredLocalClaude && failures.has(key)))
          machine.error = "Some usage could not be refreshed.";
      }
      if (
        claudeAccountsRefreshFailed &&
        !machine.id.startsWith("source:") &&
        (request.machineIds === null || request.machineIds.includes(machine.id))
      ) {
        machine.error = "Some usage could not be refreshed.";
      }
    }
    applyAccounts(
      machines,
      providers,
      accountsBySource,
      primaryClaudeRefreshed,
      observedAtByProviderId,
    );
    const providerOrder = new Map(
      providers.map((provider, index) => [provider.id, index]),
    );
    for (const machine of machines)
      machine.providers.sort(
        (a, b) =>
          (providerOrder.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) -
          (providerOrder.get(b.providerId) ?? Number.MAX_SAFE_INTEGER),
      );
    return { machines };
  };
  room.rpc.register(providerUsageRpcContract, { getUsage: readUsage });
  const markDirty = (
    event?: { thread?: { providerId?: string; host?: { id?: string } | null } },
    scheduleClaude = false,
  ) => {
    const providerId = event?.thread?.providerId;
    if (providerId === CLAUDE_PROVIDER_ID) {
      if (!scheduleClaude || disposed) return;
      pendingClaudePostTurnHosts.add(event?.thread?.host?.id ?? null);
      if (claudePostTurnTimer !== null) return;
      claudePostTurnTimer = setTimeout(() => {
        claudePostTurnTimer = null;
        const hostsToCheck = new Set(pendingClaudePostTurnHosts);
        pendingClaudePostTurnHosts.clear();
        void refreshHostClaudeIfActive(
          hostsToCheck.has(null) ? undefined : hostsToCheck,
        ).catch(() => {});
      }, randomDelay(CLAUDE_POST_TURN_MIN_MS, CLAUDE_POST_TURN_MAX_MS));
      claudePostTurnTimer.unref?.();
      return;
    }
    for (const [key, entry] of measurements) {
      const meta = resourceMeta.get(key);
      if (meta?.providerId === CLAUDE_PROVIDER_ID) continue;
      if (!providerId || !meta || meta.providerId === providerId) {
        entry.loadedAt = 0;
      }
    }
  };
  room.events.on("thread.idle", (event) => markDirty(event, true));
  room.events.on("thread.failed", (event) => markDirty(event, false));
  room.onDispose(() => {
    disposed = true;
    pendingClaudePostTurnHosts.clear();
    if (claudePollTimer !== null) clearTimeout(claudePollTimer);
    if (claudePostTurnTimer !== null) clearTimeout(claudePostTurnTimer);
  });
}
