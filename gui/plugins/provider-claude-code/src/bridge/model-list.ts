import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  applyClaudeEffortSettings,
  buildClaudeCodeModels,
  type ClaudeEffortSettings,
} from "../model-list.js";
import { translateMissingClaudeCliError } from "./missing-cli-error.js";
import { claudeSpawnOptions } from "./sdk-session.js";
import { resolveClaudeCodeExecutable } from "./session-options.js";

function buildModelProbeOptions(env: NodeJS.ProcessEnv): Options {
  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable({ env });
  return {
    cwd: process.cwd(),
    maxTurns: 0,
    persistSession: false,
    allowDangerouslySkipPermissions: true,
    permissionMode: "bypassPermissions",
    settingSources: [],
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    ...claudeSpawnOptions({
      onStderr: () => undefined,
      record: false,
      threadId: () => null,
    }),
  };
}

async function readClaudeEffortSettings(
  env: NodeJS.ProcessEnv,
): Promise<ClaudeEffortSettings> {
  const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  try {
    return JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) ?? {};
  } catch {
    return {};
  }
}

export async function listClaudeCodeBridgeModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}> {
  let session: ReturnType<typeof query>;
  try {
    session = query({
      prompt: ".",
      options: buildModelProbeOptions(env),
    });
  } catch (error) {
    throw translateMissingClaudeCliError(error);
  }

  try {
    const initialization = await session.initializationResult();
    return applyClaudeEffortSettings(
      buildClaudeCodeModels(initialization.models),
      await readClaudeEffortSettings(env),
      initialization.models,
    );
  } catch (error) {
    throw translateMissingClaudeCliError(error);
  } finally {
    session.close();
  }
}

interface ClaudeCodeBridgeModelListMemoOptions {
  list?: () => ReturnType<typeof listClaudeCodeBridgeModels>;
  now?: () => number;
  ttlMs: number;
}

export function createClaudeCodeBridgeModelListMemo({
  list = listClaudeCodeBridgeModels,
  now = Date.now,
  ttlMs,
}: ClaudeCodeBridgeModelListMemoOptions): () => ReturnType<
  typeof listClaudeCodeBridgeModels
> {
  type Catalog = Awaited<ReturnType<typeof listClaudeCodeBridgeModels>>;
  let settled: { catalog: Catalog; expiresAt: number } | null = null;
  let pending: Promise<Catalog> | null = null;
  return () => {
    if (settled !== null && settled.expiresAt > now()) {
      return Promise.resolve(settled.catalog);
    }
    settled = null;
    if (pending !== null) {
      return pending;
    }
    const probe = list()
      .then((catalog) => {
        settled = { catalog, expiresAt: now() + ttlMs };
        return catalog;
      })
      .finally(() => {
        if (pending === probe) {
          pending = null;
        }
      });
    pending = probe;
    return probe;
  };
}
