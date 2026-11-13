import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

// A turn starts on account A, the user picks B, then the turn's rate limit lands (#1151). Host "h" is this computer.
it.each([
  {
    name: "Local turn that ran on A",
    target: "local",
    ranOnA: true,
    limited: ["claude-code:a"],
  },
  {
    name: "Local turn on A that a message joined after the switch (#1300)",
    target: "joined",
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
  {
    name: "turn on another machine, which runs on its own login (#531)",
    target: "machine",
    ranOnA: true,
    limited: [],
  },
  {
    name: "turn on another machine that got A's one-year token",
    target: "machine-token",
    ranOnA: true,
    limited: ["claude-code:a"],
  },
  {
    name: "machine thread moved to Cloud, as before #531",
    target: "machine-cloud",
    ranOnA: true,
    limited: ["claude-code:a"],
  },
] as const)("a rate limit on a $name", async ({ target, ranOnA, limited }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  let status: "idle" | "active" = "idle";
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: {
      system: { config: async () => ({ primaryHostId: "h" }) as never },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            providerId: "claude-code",
            executionTarget: target.endsWith("cloud") ? "cloud" : "local",
            status,
          }),
      },
    },
  });
  // A has a one-year token; on another machine it also has a folder, except in the token row.
  const secrets = path.join(dataDir, "plugins", "accounts", "secrets");
  await fs.mkdir(secrets, { recursive: true });
  await fs.writeFile(
    path.join(secrets, "a.json"),
    JSON.stringify({ accessToken: "t", refreshToken: "", expiresAt: null }),
  );
  const profile = ["machine", "machine-cloud"].includes(target) ? "pa" : null;
  await bb.storage.kv.set("accounts:v1", [
    { ...account("a"), profile },
    account("b"),
  ]);
  await bb.storage.kv.set("order:v1", { "claude-code": ["a", "b"] });
  await plugin(bb);
  if (ranOnA)
    await harness.resolveProviderEnv("claude-code", {
      threadId: "t",
      projectId: "p",
      hostId: target.startsWith("machine") ? "m" : "h",
    });
  status = "active";
  await harness.callRpc("accounts.use", { provider: "claude-code", id: "b" });
  // A message joining the running turn asks for the env again; the turn stays on A.
  if (target === "joined")
    await harness.resolveProviderEnv("claude-code", {
      threadId: "t",
      projectId: "p",
      hostId: "h",
    });
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

// Each Keychain call takes 2 s: the MCP sign-in copy makes up to 4, past the env's 5 s deadline.
it(
  "a slow Keychain never holds up the account's CLAUDE_CONFIG_DIR",
  { timeout: 15_000 },
  async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
    dirs.push(dataDir);
    const bin = path.join(dataDir, "bin");
    const keychain = path.join(dataDir, "keychain");
    await fs.mkdir(bin);
    await fs.mkdir(keychain);
    await fs.writeFile(
      path.join(bin, "security"),
      `#!/bin/sh
sleep 2
[ "$1" = find-generic-password ] || { cat >/dev/null; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = -s ] && s="$2"; shift; done
[ -f "${keychain}/$s" ] && cat "${keychain}/$s" || exit 44
`,
      { mode: 0o755 },
    );
    const fakeToken = {
      accessToken: "fake",
      expiresAt: Date.now() + 3_600_000,
    };
    await fs.writeFile(
      path.join(keychain, "Claude Code-credentials"),
      Buffer.from(JSON.stringify({ mcpOAuth: { linear: fakeToken } })).toString(
        "hex",
      ),
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("HOME", dataDir);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    try {
      const { bb, harness } = createFakePluginHost({
        pluginId: "accounts",
        dataDir,
        sdk: {
          system: { config: async () => ({ primaryHostId: "h" }) as never },
        },
      });
      await bb.storage.kv.set("accounts:v1", [
        { ...account("a"), profile: "pa" },
      ]);
      await bb.storage.kv.set("order:v1", { "claude-code": ["a"] });
      await plugin(bb);
      const started = Date.now();
      const env = await harness.resolveProviderEnv("claude-code", {
        threadId: "t",
        projectId: "p",
        hostId: "h",
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(
        env.find((entry) => entry.name === "CLAUDE_CONFIG_DIR")?.value,
      ).toBe(path.join(dataDir, "plugins", "accounts", "profiles", "pa"));
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.unstubAllEnvs();
    }
  },
);

// Usage lived only in memory, so a restart emptied every account that isn't in use: those are not checked again.
it("accounts not in use keep their usage bars and reset times across a restart", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-test-"));
  dirs.push(dataDir);
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: { system: { config: async () => ({ primaryHostId: "h" }) as never } },
  });
  const home = path.join(dataDir, "plugins", "accounts");
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  for (const id of ["a", "b", "c", "d"])
    await fs.writeFile(
      path.join(home, "secrets", `${id}.json`),
      JSON.stringify({ accessToken: id, refreshToken: "", expiresAt: null }),
    );
  // D has a full login, so its usage is read without a reply.
  await fs.mkdir(path.join(home, "profiles", "pd"), { recursive: true });
  await fs.writeFile(
    path.join(home, "profiles", "pd", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "d-full" } }),
  );
  await bb.storage.kv.set("accounts:v1", [
    account("a"),
    account("b"),
    account("c"),
    { ...account("d"), profile: "pd" },
  ]);
  await bb.storage.kv.set("order:v1", {
    "claude-code": ["a", "b", "c", "d"],
  });
  // C was last read before its weekly limit reset.
  await bb.storage.kv.set("usage:v1", {
    c: [{ label: "Weekly limit", usedPercent: 90, resetsAt: Date.now() - 1 }],
  });
  const reset = Math.floor(Date.now() / 1_000) + 2 * 86_400;
  const weekly = (
    usedPercent: number,
    resetsAt: number | null = reset * 1_000,
  ) => [{ label: "Weekly limit", usedPercent, resetsAt }];
  const asked: string[] = [];
  let online = true;
  let full = 40;
  // While set, D's read waits for it.
  let hold: Promise<void> | null = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("authorization")!.slice(7);
    asked.push(token);
    if (token === "d-full") await hold;
    if (!online) throw new Error("offline");
    if (url.endsWith("/api/oauth/usage"))
      return Response.json({
        seven_day: {
          utilization: full,
          resets_at: new Date(reset * 1_000).toISOString(),
        },
      });
    return new Response("{}", {
      headers: {
        "anthropic-ratelimit-unified-7d-utilization":
          token === "a" ? "0.2" : "0.75",
        "anthropic-ratelimit-unified-7d-reset": String(reset),
      },
    });
  });
  const rows = async (host: typeof harness) =>
    Object.fromEntries(
      (
        (await host.callRpc("accounts.list", { provider: "claude-code" })) as {
          id: string;
          windows: unknown;
          error: string | null;
        }[]
      ).map((row) => [row.id, row.error ?? row.windows]),
    );
  try {
    await plugin(bb);
    // B had nothing saved, so one reply fills its row. C's saved bar and D's full login need none.
    await vi.waitFor(async () =>
      expect(await rows(harness)).toMatchObject({
        a: weekly(20),
        b: weekly(75),
        c: weekly(0, null),
        d: weekly(40),
      }),
    );
    expect(asked.sort()).toEqual(["a", "b", "d-full"]);

    // A restart while D's read is still waiting: the old run's read ends quietly, the new run's lands.
    asked.length = 0;
    let release = () => {};
    hold = new Promise((resolve) => (release = resolve));
    let next = await harness.lifecycle.reload(plugin);
    await vi.waitFor(() => expect(asked).toContain("d-full"));
    next = await next.harness.lifecycle.reload(plugin);
    full = 55;
    release();
    await vi.waitFor(async () =>
      expect(await rows(next.harness)).toMatchObject({ d: weekly(55) }),
    );

    // Offline after a restart: every saved bar stays, and D shows no error.
    asked.length = 0;
    hold = null;
    online = false;
    next = await next.harness.lifecycle.reload(plugin);
    await vi.waitFor(() => expect(asked.sort()).toEqual(["a", "d-full"]));
    expect(await rows(next.harness)).toMatchObject({
      b: weekly(75),
      c: weekly(0, null),
      d: weekly(55),
    });
    // Removing an account drops its saved bars.
    await next.harness.callRpc("accounts.remove", {
      provider: "claude-code",
      id: "b",
    });
    expect(
      Object.keys((await next.bb.storage.kv.get("usage:v1")) ?? {}).sort(),
    ).toEqual(["a", "c", "d"]);
  } finally {
    vi.unstubAllGlobals();
  }
});
