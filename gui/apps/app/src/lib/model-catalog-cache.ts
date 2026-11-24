import { availableModelSchema } from "@cloudroom/domain";
import { z } from "zod";
import { createLastKnownCache } from "@/lib/last-known-cache";

const cachedModelCatalogSchema = z.object({
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
});

const modelCatalogCache = createLastKnownCache({
  prefix: "bb.model-catalog",
  version: "1",
  schema: cachedModelCatalogSchema,
  maxEntries: 8,
  obsoletePrefixes: ["bb.claude-model-catalog"],
});

export function modelCatalogCacheKey({
  environmentId,
  hostId,
  providerId,
  projectId = null,
}: {
  environmentId: string | null;
  hostId: string | null;
  providerId: string | null;
  projectId?: string | null;
}): string {
  // A project's list stays apart from the machine's, whose key is unchanged (#1236).
  const project = projectId === null ? [] : [projectId];
  return modelCatalogCache.key(environmentId, hostId, providerId, ...project);
}

export const readCachedModelCatalog = modelCatalogCache.read;
export const writeCachedModelCatalog = modelCatalogCache.write;
export const clearCachedModelCatalogs = modelCatalogCache.clear;
