import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPiModelContextWindowResolverFrom,
  type PiModelContextWindowResolver,
} from "../delta-translation.js";
import { buildPiAvailableModels, type PiCatalogModel } from "../model-list.js";
import {
  PiRpcChild,
  PiRpcChildExitedError,
  buildPiChildEnv,
} from "./rpc-child.js";

const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

interface PiRpcModel {
  id: string;
  name?: string;
  provider: string;
  input?: unknown;
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

export function getSupportedThinkingLevels(
  model: Pick<PiRpcModel, "reasoning" | "thinkingLevelMap">,
): string[] {
  if (!model.reasoning) {
    return ["off"];
  }
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}

function toCatalogModel(model: PiRpcModel): PiCatalogModel | undefined {
  if (
    typeof model.id !== "string" ||
    model.id.length === 0 ||
    typeof model.provider !== "string" ||
    model.provider.length === 0
  ) {
    return undefined;
  }
  return {
    id: model.id,
    input: Array.isArray(model.input)
      ? model.input.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    name: typeof model.name === "string" ? model.name : model.id,
    provider: model.provider,
    reasoning: model.reasoning === true,
    supportedThinkingLevels: getSupportedThinkingLevels(model),
  };
}

export interface PiCatalog {
  listModels(): Promise<{
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  }>;
  rawModels(): Promise<PiRpcModel[]>;
  probe(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const catalogsByCwd = new Map<string, Promise<PiCatalog>>();

function windowsShellPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return path;
  }
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
  const drive = match?.[1];
  return drive === undefined
    ? path
    : `${drive.toUpperCase()}:\\${match?.[2]?.replaceAll("/", "\\") ?? ""}`;
}

function piAgentDir(env: NodeJS.ProcessEnv): string {
  let configured = env.PI_CODING_AGENT_DIR;
  if (!configured) {
    return join(homedir(), ".pi", "agent");
  }
  if (process.platform === "win32") {
    configured = windowsShellPath(configured);
  }
  if (configured === "~") {
    return homedir();
  }
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(homedir(), configured.slice(2));
  }
  return configured.startsWith("file://")
    ? fileURLToPath(configured)
    : configured;
}

function piModelsFilePath(cwd: string, env: NodeJS.ProcessEnv): string {
  const modelsPath = join(piAgentDir(env), "models.json");
  try {
    return resolve(realpathSync(cwd), modelsPath);
  } catch {
    return resolve(cwd, modelsPath);
  }
}

function fileStamp(path: string): string | null {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : null;
  }
}

async function spawnCatalog(
  cwd: string,
  extensionPath: string,
  touch: () => void,
): Promise<PiCatalog> {
  interface CatalogChildGeneration {
    child: PiRpcChild;
    ready: Promise<Record<string, unknown>>;
    modelsPath: string;
    modelsStamp: string | null;
    getModelScope():
      | { scopedModelIds: string[]; defaultModelId?: string }
      | undefined;
  }

  let generation: CatalogChildGeneration | null = null;
  let closed = false;
  const retire = (active: CatalogChildGeneration): void => {
    if (generation === active) {
      generation = null;
    }
    active.child.kill();
  };
  const spawnGeneration = (): CatalogChildGeneration => {
    const env = buildPiChildEnv({});
    const modelsPath = piModelsFilePath(cwd, env);
    const modelsStamp = fileStamp(modelsPath);
    let modelScope:
      | { scopedModelIds: string[]; defaultModelId?: string }
      | undefined;
    let settleModelScopeRequest: (() => void) | undefined;
    const acceptModelScope = (value: Record<string, unknown>): void => {
      const scopedModelIds = Array.isArray(value.scopedModelIds)
        ? value.scopedModelIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      modelScope = {
        scopedModelIds,
        defaultModelId:
          typeof value.defaultModelId === "string"
            ? value.defaultModelId
            : undefined,
      };
    };
    const child = new PiRpcChild({
      cwd,
      env,
      args: ["--mode", "rpc", "--no-session", "--extension", extensionPath],
      onEvent: () => {},
      onChannelMessage: (message) => {
        if (message.kind === "model-scope") {
          acceptModelScope(message);
          return;
        }
        if (
          message.kind === "reply" &&
          message.id === "catalog-model-scope" &&
          typeof message.result === "object" &&
          message.result !== null
        ) {
          acceptModelScope(message.result as Record<string, unknown>);
          settleModelScopeRequest?.();
          settleModelScopeRequest = undefined;
        }
      },
      onExit: () => {
        settleModelScopeRequest?.();
        settleModelScopeRequest = undefined;
      },
      recordThreadId: null,
    });
    const ready = (async (): Promise<Record<string, unknown>> => {
      const data = await child.requestOk({ type: "get_state" });
      if (!child.exited) {
        await new Promise<void>((resolveScope) => {
          const timeout = setTimeout(resolveScope, 2_000);
          timeout.unref?.();
          settleModelScopeRequest = () => {
            clearTimeout(timeout);
            resolveScope();
          };
          child.sendChannel({
            kind: "request",
            id: "catalog-model-scope",
            method: "model-scope",
          });
        });
      }
      return typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : {};
    })();
    const spawned: CatalogChildGeneration = {
      child,
      ready,
      modelsPath,
      modelsStamp,
      getModelScope: () => modelScope,
    };
    ready.catch((error: unknown) => {
      if (!(error instanceof PiRpcChildExitedError)) {
        retire(spawned);
      }
    });
    return spawned;
  };
  const activeGeneration = (): CatalogChildGeneration => {
    if (closed) {
      throw new Error("Pi model catalog is closed");
    }
    if (generation !== null && !generation.child.exited) {
      const stamp = fileStamp(generation.modelsPath);
      if (stamp !== null && stamp !== generation.modelsStamp) {
        retire(generation);
      }
    }
    if (generation === null || generation.child.exited) {
      generation = spawnGeneration();
    }
    return generation;
  };
  const fetchRawFrom = async (
    active: CatalogChildGeneration,
  ): Promise<PiRpcModel[]> => {
    await active.ready;
    let data: { models?: unknown[] } | undefined;
    try {
      data = (await active.child.requestOk({
        type: "get_available_models",
      })) as { models?: unknown[] } | undefined;
    } catch (error) {
      if (!(error instanceof PiRpcChildExitedError)) {
        retire(active);
      }
      throw error;
    }
    if (!closed) {
      touch();
    }
    const models = (data?.models ?? []).filter(
      (entry): entry is PiRpcModel =>
        typeof entry === "object" && entry !== null,
    );
    if (models.length === 0 && generation === active) {
      generation = null;
      active.child.kill();
    }
    return models;
  };
  const withGeneration = async <T>(
    run: (active: CatalogChildGeneration) => Promise<T>,
    retryOwnExit: boolean,
  ): Promise<{ active: CatalogChildGeneration; value: T }> => {
    let active = activeGeneration();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return { active, value: await run(active) };
      } catch (error) {
        if (
          !(error instanceof PiRpcChildExitedError) ||
          attempt === 3 ||
          (generation === active && !(retryOwnExit && attempt === 0))
        ) {
          throw error;
        }
        active = activeGeneration();
      }
    }
  };
  const fetchGeneration = async (): Promise<{
    active: CatalogChildGeneration;
    raw: PiRpcModel[];
  }> => {
    if (!closed) {
      touch();
    }
    const { active, value } = await withGeneration(fetchRawFrom, true);
    return { active, raw: value };
  };
  const fetchRaw = async (): Promise<PiRpcModel[]> =>
    (await fetchGeneration()).raw;
  const probe = async (): Promise<Record<string, unknown>> =>
    (await withGeneration((active) => active.ready, false)).value;
  await probe();
  return {
    async listModels() {
      const { active, raw } = await fetchGeneration();
      const models: PiCatalogModel[] = [];
      for (const model of raw) {
        const catalogModel = toCatalogModel(model);
        if (catalogModel) {
          models.push(catalogModel);
        } else {
          process.stderr.write(
            `pi bridge: skipped an incomplete model from provider "${String(model.provider)}"\n`,
          );
        }
      }
      const modelScope = active.getModelScope();
      return buildPiAvailableModels({
        models,
        scopedModelIds: modelScope?.scopedModelIds,
        preferredDefaultId: modelScope?.defaultModelId,
      });
    },
    rawModels: fetchRaw,
    probe,
    async close() {
      closed = true;
      const activeChild = generation?.child;
      if (activeChild === undefined) return;
      activeChild.kill();
      await activeChild.waitForExit();
    },
  };
}

function catalogIdleMs(): number {
  const configured = Number(process.env.BB_PI_CATALOG_IDLE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 5 * 60_000;
}
const catalogIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function touchCatalog(key: string): void {
  const existing = catalogIdleTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    catalogIdleTimers.delete(key);
    const catalog = catalogsByCwd.get(key);
    catalogsByCwd.delete(key);
    void catalog?.then((entry) => entry.close()).catch(() => undefined);
  }, catalogIdleMs());
  timer.unref?.();
  catalogIdleTimers.set(key, timer);
}

export function peekPiCatalog(cwd: string): Promise<PiCatalog> | null {
  return catalogsByCwd.get(resolve(cwd)) ?? null;
}

export function getPiCatalog(
  cwd: string,
  extensionPath: string,
): Promise<PiCatalog> {
  const key = resolve(cwd);
  const existing = catalogsByCwd.get(key);
  if (existing) {
    return existing;
  }
  const created = spawnCatalog(key, extensionPath, () =>
    touchCatalog(key),
  ).catch((error: unknown) => {
    catalogsByCwd.delete(key);
    throw error;
  });
  catalogsByCwd.set(key, created);
  return created;
}

export async function closeAllPiCatalogs(): Promise<void> {
  for (const [, timer] of catalogIdleTimers) {
    clearTimeout(timer);
  }
  catalogIdleTimers.clear();
  const catalogs = [...catalogsByCwd.values()];
  catalogsByCwd.clear();
  await Promise.all(
    catalogs.map((catalog) =>
      catalog.then((entry) => entry.close()).catch(() => undefined),
    ),
  );
}

export function createLiveContextWindowResolver(): {
  resolve: PiModelContextWindowResolver;
  learn(models: readonly PiRpcModel[]): void;
} {
  const known = new Map<string, PiRpcModel>();
  let resolver = createPiModelContextWindowResolverFrom([]);
  return {
    resolve: (lastAssistant) => resolver(lastAssistant),
    learn(models) {
      let changed = false;
      for (const model of models) {
        if (typeof model.contextWindow !== "number") {
          continue;
        }
        const key = `${model.provider}\0${model.id}`;
        if (!known.has(key)) {
          known.set(key, model);
          changed = true;
        }
      }
      if (changed) {
        resolver = createPiModelContextWindowResolverFrom(
          [...known.values()].map((model) => ({
            id: model.id,
            provider: model.provider,
            contextWindow: model.contextWindow,
          })),
        );
      }
    },
  };
}
