import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const locatorSchema = z.tuple([z.string().min(1), z.string().min(1)]);

interface CachedMeasurement {
  accountKey: string | null;
  observedAt: number | null;
  usage: { status: string };
}

/** Creates list and fetch handlers with a cache scoped to this usage source. */
export function experimental_createHostUsageSource<
  Measurement extends CachedMeasurement,
>(
  room: BbPluginApi,
  source: { pluginId: string; providerId?: string },
  schemas: {
    usagePlanSchema: z.ZodType;
    usageWindowKindSchema: z.ZodType<string>;
    usageMeasurementSchema: z.ZodType<Measurement>;
  },
) {
  const metadataSchema = z.object({
    accountKey: z.string().min(1).nullable().catch(null),
    plan: schemas.usagePlanSchema.nullable().catch(null),
  });
  const windowMetadataSchema = z.object({
    kind: schemas.usageWindowKindSchema.catch("custom"),
    model: z.string().nullable().catch(null),
  });
  const cache = new Map<string, Measurement>();
  const pending = new Map<
    string,
    { refresh: boolean; promise: Promise<Measurement> }
  >();

  async function listProviders(hostId: string) {
    const providers = await room.sdk.providers.list({
      hostId,
      capability: "usage",
    });
    return providers.filter(
      (provider) =>
        provider.pluginId === source.pluginId &&
        (source.providerId === undefined || provider.id === source.providerId),
    );
  }

  async function listResources() {
    const hosts = await room.sdk.hosts.list();
    const resources = (
      await Promise.all(
        hosts.map(async (host) => {
          const providers = await listProviders(host.id);
          return providers.map((provider) => {
            const id = JSON.stringify([host.id, provider.id]);
            return {
              id,
              accountKey: cache.get(id)?.accountKey ?? null,
              providerId: provider.id,
              label: provider.displayName,
              scope: {
                kind: "host" as const,
                hostId: host.id,
                hostName: host.name,
              },
            };
          });
        }),
      )
    ).flat();
    const ids = new Set(resources.map((resource) => resource.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    return { resources };
  }

  async function load(
    resourceId: string,
    refresh: boolean,
  ): Promise<Measurement> {
    const [hostId, providerId] = locatorSchema.parse(JSON.parse(resourceId));
    const host = (await room.sdk.hosts.list()).find(
      (host) => host.id === hostId,
    );
    if (!host) throw new Error("Usage resource no longer exists.");
    const previous = cache.get(resourceId);
    const unavailable = (message: string) =>
      schemas.usageMeasurementSchema.parse({
        accountKey: previous?.accountKey ?? null,
        observedAt: previous?.observedAt ?? null,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message,
        },
      });
    if (host.status === "disconnected")
      return unavailable("Machine is disconnected.");
    const providers = await listProviders(hostId);
    if (!providers.some((provider) => provider.id === providerId))
      throw new Error("Usage resource no longer exists.");
    if (
      !refresh &&
      previous?.usage.status === "ok" &&
      previous.observedAt !== null &&
      Date.now() - previous.observedAt < 60_000
    )
      return previous;

    try {
      const result = await room.sdk.system.usageLimits({ hostId, providerId });
      const usage = result[providerId];
      if (!usage) throw new Error("Provider returned no usage information.");
      const metadata = metadataSchema.parse(usage);
      const value = schemas.usageMeasurementSchema.parse({
        accountKey: metadata.accountKey,
        observedAt:
          usage.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
        usage: {
          accountEmail: null,
          planLabel: null,
          ...usage,
          plan: metadata.plan,
          ...(usage.status === "ok"
            ? {
                windows: usage.windows.map((window, index) => ({
                  ...window,
                  ...windowMetadataSchema.parse(window),
                  id: `${index}:${window.label}`,
                  cost: window.cost ?? null,
                })),
              }
            : {}),
        },
      });
      cache.set(resourceId, value);
      return value;
    } catch {
      return unavailable("Usage could not be collected from this machine.");
    }
  }

  async function getResource(input: {
    resourceId: string;
    refresh: boolean;
  }): Promise<Measurement> {
    const { resourceId, refresh } = input;
    const running = pending.get(resourceId);
    if (running) {
      if (!refresh || running.refresh) return running.promise;
      await running.promise.catch(() => undefined);
      return getResource(input);
    }
    const promise = load(resourceId, refresh).finally(() =>
      pending.delete(resourceId),
    );
    pending.set(resourceId, { refresh, promise });
    return promise;
  }

  return { listResources, getResource };
}
