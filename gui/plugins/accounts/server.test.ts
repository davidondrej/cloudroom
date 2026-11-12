import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const dirs: string[] = [];
afterEach(() =>
  Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  ),
);

const account = (id: string) => ({
  id,
  provider: "claude-code" as const,
  email: `${id}@example.com`,
  plan: null,
  accountKey: null,
  createdAt: 0,
});

// A turn starts on account A, the user picks B, then the turn's rate limit lands (#1151).
it.each([
  {
    name: "Local turn that ran on A",
    target: "local",
    ranOnA: true,
    limited: ["claude-code:a"],
  },
  {
    name: "Local turn this plugin never saw start",
    target: "local",
    ranOnA: false,
    limited: [],
  },
  {
    name: "Cloud turn, which uses the selected account",
    target: "cloud",
    ranOnA: false,
    limited: ["claude-code:b"],
  },
] as const)("a rate limit on a $name", async ({ target, ranOnA, limited }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            providerId: "claude-code",
            executionTarget: target,
          }),
      },
    },
  });
  await bb.storage.kv.set("accounts:v1", [account("a"), account("b")]);
  await bb.storage.kv.set("order:v1", { "claude-code": ["a", "b"] });
  await plugin(bb);
  if (ranOnA)
    await harness.resolveProviderEnv("claude-code", {
      threadId: "t",
      projectId: "p",
      hostId: "h",
    });
  await harness.callRpc("accounts.use", { provider: "claude-code", id: "b" });
  await harness.emitThreadEvent(
    "turn.failed",
    makeTurnFailedEvent({
      threadId: "t",
      errorInfo: {
        category: "rate-limit",
        providerCode: null,
        httpStatusCode: 429,
      },
    }),
  );
  expect(Object.keys((await bb.storage.kv.get("limits:v1")) ?? {})).toEqual(
    limited,
  );
});
