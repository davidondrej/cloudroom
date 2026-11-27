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
const CLAUDE_RETRY_BASE_MS = 35_000;
const CLAUDE_RETRY_JITTER_MS = 5_000;
const CLAUDE_RETRY_MAX_ATTEMPTS = 3;
const CLAUDE_IDLE_RECOVERY_COOLDOWN_MS = 60_000;
const USAGE_UPDATED_EVENT = "usage-updated";

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
  const mergeAccounts = async (
    machines: UsageMachine[],
    providers: Provider[],
    refreshClaude: boolean,
    skipLocalClaude: boolean,
  ): Promise<void> => {
    const sources = (
      await room.sdk.plugins
        .experimental_discoverRpc({ method: ACCOUNTS_LIST_METHOD })
        .catch(() => [])
    ).filter((source) => source.method === ACCOUNTS_LIST_METHOD);
    for (const source of sources)
      for (const providerId of [
        "claude-code",
        "codex",
        "acp-cursor",
        "acp-antigravity",
      ]) {
        const raw: unknown = await room.sdk.plugins
          .callRpc({
            pluginId: source.pluginId,
            method: ACCOUNTS_LIST_METHOD,
            input:
              providerId === "claude-code" && refreshClaude
                ? {
                    provider: providerId,
                    refresh: true,
                    ...(skipLocalClaude ? { skipLocal: true } : {}),
                  }
                : { provider: providerId },
            outputSchema: accountViewsSchema,
            signal: AbortSignal.timeout(providerId === "claude-code" && refreshClaude ? 40_000 : 10_000),
          })
          .catch(() => []);
        const parsed = accountViewsSchema.safeParse(raw);
        const accounts = (parsed.success ? parsed.data : []).filter(
          (account) => !account.needsSignIn,
        );
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
          return {
            ...entry,
            accountLabel: (sameLogin ? mac.name : null) ?? entry.accountLabel,
            usage: providerId === "claude-code" && mac.email && (mac.inUse || mac.limitedUntil)
              ? accountUsage(
                  skipLocalClaude ? { ...mac, windows: [], credits: null } : mac,
                  entry.usage,
                )
              : entry.usage,
          };
        };
        if (!accounts.some((account) => account.id !== "local")) {
          for (const machine of machines)
            machine.providers = machine.providers.map((entry) =>
              entry.providerId === providerId ? localEntry(machine, entry) : entry,
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
          const entries = accounts.flatMap((account): UsageProvider[] => {
            if (account.id === "local")
              return local
                ? [localEntry(machine, { ...local, accountId: "local", inUse: account.inUse })]
                : [];
            return [{
              ...base, id: `accounts:${account.id}`, accountLabel: account.name ?? account.email,
              accountId: account.id, inUse: account.inUse, usage: accountUsage(account),
            }];
          });
          if (index < 0) machine.providers.push(...entries);
          else machine.providers.splice(index, 1, ...entries);
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
  const failures = new Set<string>();
  const pending = new Map<
    string,
    { force: boolean; promise: Promise<UsageMeasurement> }
  >();
  const claudeRetries = new Map<
    string,
    { attempts: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  const lastIdleRecoveryAt = new Map<string, number>();
  const keyOf = (pluginId: string, resourceId: string) =>
    JSON.stringify([pluginId, resourceId]);

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
  const clearClaudeRetry = (key: string): void => {
    const state = claudeRetries.get(key);
    if (state?.timer) clearTimeout(state.timer);
    claudeRetries.delete(key);
  };
  const scheduleClaudeRetry = (pluginId: string, resourceId: string): void => {
    if (disposed) return;
    const key = keyOf(pluginId, resourceId);
    const state = claudeRetries.get(key) ?? { attempts: 0, timer: null };
    if (state.timer !== null || state.attempts >= CLAUDE_RETRY_MAX_ATTEMPTS)
      return;
    const delay =
      CLAUDE_RETRY_BASE_MS * 2 ** state.attempts +
      Math.floor(Math.random() * CLAUDE_RETRY_JITTER_MS);
    state.attempts += 1;
    const timer = setTimeout(() => {
      state.timer = null;
      if (disposed || !failures.has(key)) {
        claudeRetries.delete(key);
        return;
      }
      void fetchResource(pluginId, resourceId, false)
        .then(() => {
          claudeRetries.delete(key);
          room.realtime?.publish(USAGE_UPDATED_EVENT, {});
        })
        .catch(() => {
          if (failures.has(key)) scheduleClaudeRetry(pluginId, resourceId);
        });
    }, delay);
    timer.unref?.();
    state.timer = timer;
    claudeRetries.set(key, state);
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
        clearClaudeRetry(key);
        persistMeasurements();
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, { force, promise });
    return promise;
  };
  const readUsage = async (request: UsageRequest): Promise<UsageSnapshot> => {
    await hydrateMeasurements();
    const hostId = request.machineIds?.find((id) => !id.startsWith("source:"));
    const [hosts, sources, usageProviders, config] = await Promise.all([
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
    ]);
    hosts.sort(
      (a, b) =>
        Number(b.id === config?.primaryHostId) -
        Number(a.id === config?.primaryHostId),
    );
    for (const id of inventories.keys())
      if (!sources.some((source) => source.pluginId === id))
        inventories.delete(id);
    for (let offset = 0; offset < sources.length; offset += 3) {
      await Promise.all(
        sources.slice(offset, offset + 3).map(async (source) => {
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
    }
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
        failures.delete(key);
        resourceMeta.delete(key);
        lastIdleRecoveryAt.delete(key);
        clearClaudeRetry(key);
        evicted = true;
      }
    }
    if (evicted) persistMeasurements();
    const selected = [...inventories.values()].flatMap((source) =>
      source.resources
        .filter((resource) => {
          const machineId =
            resource.scope.kind === "shared"
              ? `source:${source.pluginId}`
              : resource.scope.hostId;
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
    let primaryClaudeRefreshed = false;
    for (let offset = 0; offset < selected.length; offset += 3) {
      await Promise.all(
        selected.slice(offset, offset + 3).map(async ({ source, resource }) => {
          const key = keyOf(source.pluginId, resource.id);
          const cached = measurements.get(key);
          if (
            !request.force &&
            cached &&
            Date.now() - cached.loadedAt < request.maxAgeMs
          )
            return;
          if (
            !request.force &&
            resource.providerId === CLAUDE_PROVIDER_ID &&
            claudeRetries.get(key)?.timer != null
          )
            return;
          if (request.force && resource.providerId === CLAUDE_PROVIDER_ID) {
            clearClaudeRetry(key);
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
            if (resource.providerId === CLAUDE_PROVIDER_ID) {
              scheduleClaudeRetry(source.pluginId, resource.id);
            }
          }
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
        machine.providers.push(
          resourceProvider(
            resource,
            cached ? rollExpiredWindows(cached.value) : undefined,
            source.pluginId,
            providers,
          ),
        );
        if (source.error !== null || failures.has(key))
          machine.error = "Some usage could not be refreshed.";
      }
    }
    const refreshClaude = request.force && (request.providerId === null || request.providerId === "claude-code") &&
      machines.some((machine) => !machine.id.startsWith("source:") &&
        (request.machineIds === null || request.machineIds.includes(machine.id)));
    await mergeAccounts(machines, providers, refreshClaude, primaryClaudeRefreshed);
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
    recoverClaude = false,
  ) => {
    const providerId = event?.thread?.providerId;
    for (const [key, entry] of measurements) {
      const meta = resourceMeta.get(key);
      if (!providerId || !meta || meta.providerId === providerId) {
        entry.loadedAt = 0;
      }
    }
    if (!recoverClaude || providerId !== CLAUDE_PROVIDER_ID || disposed) return;
    const threadHostId = event?.thread?.host?.id ?? null;
    const now = Date.now();
    for (const key of [...failures]) {
      const meta = resourceMeta.get(key);
      if (meta?.providerId !== CLAUDE_PROVIDER_ID) continue;
      if (threadHostId && meta.hostId && meta.hostId !== threadHostId) continue;
      if (claudeRetries.get(key)?.timer != null) continue;
      if (now - (lastIdleRecoveryAt.get(key) ?? 0) < CLAUDE_IDLE_RECOVERY_COOLDOWN_MS)
        continue;
      lastIdleRecoveryAt.set(key, now);
      void fetchResource(meta.pluginId, meta.resourceId, true)
        .then(() => {
          room.realtime?.publish(USAGE_UPDATED_EVENT, {});
        })
        .catch(() => {
          if (failures.has(key))
            scheduleClaudeRetry(meta.pluginId, meta.resourceId);
        });
    }
  };
  room.events.on("thread.idle", (event) => markDirty(event, true));
  room.events.on("thread.failed", (event) => markDirty(event, false));
  room.onDispose(() => {
    disposed = true;
    for (const key of [...claudeRetries.keys()]) clearClaudeRetry(key);
  });
}
