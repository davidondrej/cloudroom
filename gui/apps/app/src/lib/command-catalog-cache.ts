import {
  commandListResponseSchema,
  type CommandListResponse,
} from "@cloudroom/server-contract";
import { createLastKnownCache } from "@/lib/last-known-cache";

// The last slash-command list per project and provider. Threads in other
// environments preview it while their own list loads, so `/` feels instant.
const commandCatalogCache = createLastKnownCache({
  prefix: "bb.command-catalog",
  version: "1",
  schema: commandListResponseSchema,
  maxEntries: 8,
});

export function commandCatalogCacheKey(
  projectId: string | undefined,
  providerId: string | undefined,
): string {
  return commandCatalogCache.key(projectId ?? null, providerId ?? null);
}

// Parsed once per key: the menu reads this on every render until a fetch lands.
const parsed = new Map<string, CommandListResponse | null>();

export function readCachedCommandCatalog(
  key: string,
): CommandListResponse | null {
  if (!parsed.has(key)) parsed.set(key, commandCatalogCache.read(key));
  return parsed.get(key) ?? null;
}

export function writeCachedCommandCatalog(
  key: string,
  value: CommandListResponse,
): void {
  parsed.set(key, value);
  commandCatalogCache.write(key, value);
}

export function clearCachedCommandCatalogs(): void {
  parsed.clear();
  commandCatalogCache.clear();
}
