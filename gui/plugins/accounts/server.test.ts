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
    name: "Cloud turn started on A before the switch to B",
    target: "started-cloud",
    ranOnA: false,
    limited: ["claude-code:a"],
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
  if (target === "started-cloud") {
    await harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "t", providerId: "claude-code", executionTarget: "cloud" }),
    });
  }
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
  const fullWeekly = (percent: number) => [
    { label: "Five-hour limit", usedPercent: 0, resetsAt: null }, ...weekly(percent),
  ];
  const asked: string[] = [];
  let online = true;
  let full = 40;
  // While set, D's read waits for it.
  let hold: Promise<void> | null = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/oauth/profile"))
      return new Response(null, { status: 503 });
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
  // When each of D's bars was last confirmed by a read.
  const checked = async (host: typeof harness) =>
    (
      (await host.callRpc("accounts.list", { provider: "claude-code" })) as {
        id: string;
        windows: { checkedAt?: number | null }[];
      }[]
    )
      .find((row) => row.id === "d")!
      .windows.map((window) => window.checkedAt);
  try {
    await plugin(bb);
    // B had nothing saved, so one reply fills its row. C's saved bar and D's full login need none.
    await vi.waitFor(async () =>
      expect(await rows(harness)).toMatchObject({
        a: weekly(20),
        b: weekly(75),
        c: weekly(0, null),
        d: fullWeekly(40),
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
      expect(await rows(next.harness)).toMatchObject({ d: fullWeekly(55) }),
    );
    const lastRead = await checked(next.harness);
    expect(lastRead.every((at) => at! > Date.now() - 60_000)).toBe(true);

    // Offline after a restart: every saved bar stays, and D shows no error.
    asked.length = 0;
    hold = null;
    online = false;
    next = await next.harness.lifecycle.reload(plugin);
    await vi.waitFor(() => expect(asked.sort()).toEqual(["a", "d-full"]));
    expect(await rows(next.harness)).toMatchObject({
      b: weekly(75),
      c: weekly(0, null),
      d: fullWeekly(55),
    });
    // D's full login ended and Claude Code can't renew it (#1979): Sign in again, even after a restart.
    await fs.writeFile(
      path.join(home, "profiles", "pd", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "d-full",
          refreshToken: "r",
          expiresAt: 1,
          refreshTokenExpiresAt: 1,
        },
      }),
    );
    next = await next.harness.lifecycle.reload(plugin);
    await vi.waitFor(async () =>
      expect((await rows(next.harness)).d).toMatch(/Sign in again/),
    );
    // Its bars can't be read now: they keep the last read's time, so the page greys them once it's old.
    expect(await checked(next.harness)).toEqual(lastRead);
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

it.each(["added", "local"])("reconciles %s Claude warnings on Reload", async (login) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-recovery-"));
  dirs.push(dataDir);
  const home = path.join(dataDir, "plugins/accounts");
  const profile = path.join(home, "profiles/added");
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(path.join(home, "secrets"));
  await fs.writeFile(
    path.join(home, "secrets/added.json"),
    JSON.stringify({ accessToken: "fixture", refreshToken: "", expiresAt: null }),
  );
  const native = path.join(dataDir, "native");
  await fs.mkdir(native);
  await fs.writeFile(
    path.join(native, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "mac@example.com", organizationUuid: "mac-org" },
    }),
  );
  for (const dir of [native, profile])
    await fs.writeFile(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: path.basename(dir) },
      }),
    );
  vi.stubEnv("CLAUDE_CONFIG_DIR", native);
  if (process.platform === "darwin") {
    await fs.writeFile(path.join(dataDir, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o700 });
    vi.stubEnv("PATH", `${dataDir}:${process.env.PATH}`);
  }
  // Plans Cloud was sent.
  const sent: (string | undefined)[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    dataDir,
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({ providerId: "claude-code", executionTarget: "cloud" }),
      },
      system: { config: async () => ({ primaryHostId: "here" }) as never },
      cloudroom: {
        claudeAuth: async (input) => {
          sent.push(input?.plan);
          return { state: "connected" } as never;
        },
      },
    },
  });
  const reset = Date.now() + 3_600_000;
  const window = (utilization: number) => ({
    utilization,
    resets_at: new Date(reset).toISOString(),
  });
  const usage: Record<string, unknown> = { five_hour: window(98), seven_day: null };
  let replyProbes = 0;
  let offline = false;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/oauth/profile"))
      return Response.json({
        organization: {
          organization_type: "claude_max",
          rate_limit_tier: "default_claude_max_5x",
        },
      });
    if (!url.endsWith("/api/oauth/usage")) {
      replyProbes++;
      throw new Error("unexpected inference request");
    }
    return offline ? new Response(null, { status: 503 }) : Response.json(usage);
  });
  const current = async (refresh = false) => {
    const rows = (await harness.callRpc("accounts.list", {
      provider: "claude-code",
      refresh,
    })) as Array<{
      id: string;
      limitedUntil: number | null;
      windows: { label: string; usedPercent: number }[];
    }>;
    return rows.find((row) => row.id === login)!;
  };
  const block = async (key: string) => {
    const { errors } = await harness.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "t",
        errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 },
        rateLimits: {
          providerId: "claude-code",
          kind: "subscription-window",
          status: "blocked",
          windows: [{ providerKey: key, label: null, status: "blocked", resetsAtMs: reset }],
          reachedReason: key,
          overageStatus: null,
          overageReason: null,
        },
      }),
    );
    expect(errors).toEqual([]);
    expect((await current(true)).limitedUntil).toBe(reset);
  };
  try {
    await bb.storage.kv.set("accounts:v1", [
      { ...account("added"), profile: "added", plan: "pro", tier: "pro" },
    ]);
    await bb.storage.kv.set("cloud:v1", "added");
    await bb.storage.kv.set("order:v1", {
      "claude-code": login === "local" ? ["local", "added"] : ["added", "local"],
    });
    await bb.storage.kv.set("mac-login:v1", true);
    await plugin(bb);
    // Saved as Pro, Max on Claude's side: the page and Cloud get Max (#2534).
    await vi.waitFor(async () => {
      const rows = (await harness.callRpc("accounts.list", {
        provider: "claude-code",
      })) as { id: string; plan: string | null }[];
      expect(rows.find((row) => row.id === "added")?.plan).toBe("Max");
      expect(sent).toEqual(login === "added" ? ["max"] : []);
    });
    await current(true);
    await block("five_hour");
    offline = true;
    delete usage.five_hour;
    expect((await current(true)).limitedUntil).toBe(reset);
    offline = false;
    expect(await current(true)).toMatchObject({
      limitedUntil: null,
      windows: [
        { label: "Five-hour limit", usedPercent: 0 },
        { label: "Weekly limit", usedPercent: 0 },
      ],
    });
    expect(replyProbes).toBe(0);

    usage.five_hour = window(98);
    await block("five_hour");
    usage.five_hour = {
      utilization: 98,
      resets_at: new Date(Date.now() + 5 * 3_600_000 + 5_000).toISOString(),
    };
    expect((await current(true)).limitedUntil).toBeNull();

    usage.limits = [
      {
        kind: "weekly_scoped",
        scope: { model: { display_name: "Fable" } },
        percent: 100,
        resets_at: new Date(reset).toISOString(),
      },
    ];
    await block("seven_day_fable");
    delete usage.limits;
    expect((await current(true)).limitedUntil).toBe(reset);
    usage.limits = [];
    const removed = await current(true);
    expect(removed.limitedUntil).toBeNull();
    expect(removed.windows.some((w) => w.label.includes("Fable"))).toBe(false);

    usage.seven_day_overage_included = window(100);
    await block("seven_day_overage_included");
    usage.extra_usage = { is_enabled: true, used_credits: 1, monthly_limit: 100 };
    expect((await current(true)).limitedUntil).toBe(reset);
    usage.seven_day_overage_included = window(10);
    expect((await current(true)).limitedUntil).toBeNull();

    usage.extra_usage = { is_enabled: true, used_credits: 100, monthly_limit: 100 };
    await block("overage");
    usage.extra_usage = { is_enabled: true, used_credits: 100, monthly_limit: 200 };
    expect((await current(true)).limitedUntil).toBeNull();
  } finally {
    await harness.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
