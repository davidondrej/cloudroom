import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({
  keychain: "",
  file: "",
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: readonly string[],
    _options: object,
    callback: (
      error: Error | null,
      result: { stdout: string; stderr: string },
    ) => void,
  ) => callback(null, { stdout: state.keychain, stderr: "" }),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (file: string) =>
      Promise.resolve(
        file.endsWith(".credentials.json")
          ? state.file
          : JSON.stringify({ oauthAccount: { emailAddress: null } }),
      ),
  },
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@get-bb/plugin-sdk/provider-bridge")
  >()),
  experimental_resolveExecutablePath: () => Promise.resolve("/test/claude"),
  experimental_readCliVersion: () => Promise.resolve("2.1.318"),
}));

import {
  getClaudeProviderHealth,
  getClaudeProviderUsage,
} from "./provider-maintenance.js";

const originalPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  vi.unstubAllGlobals();
});

function saveLogin(fields: Record<string, unknown>) {
  const credentials = JSON.stringify({
    claudeAiOauth: {
      accessToken: "test-access-token",
      expiresAt: null,
      subscriptionType: "pro",
      rateLimitTier: "default_claude_max_5x",
      ...fields,
    },
  });
  state.file = credentials;
  state.keychain = Buffer.from(credentials, "utf8").toString("hex");
}

beforeEach(() => {
  saveLogin({});
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ limits: [] }),
    }),
  );
});

describe("Claude Code credential loading", () => {
  it("loads a hex-encoded Keychain credential", async () => {
    state.file = "";

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({ status: "ok" }),
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer test-access-token",
    });
  });

  it("uses the credential file when the Keychain value is invalid", async () => {
    state.keychain = "invalid-keychain-value";

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({ status: "ok" }),
    });
  });

  it("distinguishes usage-check throttling from an exhausted Claude limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429 }),
    );

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: expect.objectContaining({
        status: "error",
        message:
          "Anthropic temporarily throttled this usage check. This does not mean your Claude limit is exhausted. Try again later.",
      }),
    });
  });
});

describe("Claude Code login expiry", () => {
  const HOUR_MS = 60 * 60_000;
  const renewable = {
    expiresAt: Date.now() - HOUR_MS,
    refreshToken: "test-refresh-token",
    refreshTokenExpiresAt: Date.now() + 30 * 24 * HOUR_MS,
  };
  const renewMessage =
    "Claude renews its sign-in on its next reply. Usage shows after that.";

  it.each([
    ["the access token is valid", { expiresAt: Date.now() + HOUR_MS }, "ready"],
    ["Claude Code can renew the expired access token", renewable, "ready"],
    [
      "an older Claude Code saved no end for the refresh token",
      { ...renewable, refreshTokenExpiresAt: undefined },
      "ready",
    ],
    [
      "a malformed refresh-token end reads as missing",
      { ...renewable, refreshTokenExpiresAt: "soon" },
      "ready",
    ],
    [
      "the refresh token has ended too",
      { ...renewable, refreshTokenExpiresAt: Date.now() - 1 },
      "expired",
    ],
    [
      "there is no refresh token",
      { ...renewable, refreshToken: undefined },
      "expired",
    ],
    [
      "Claude Code ended the login",
      { expiresAt: Date.now() + HOUR_MS, refreshToken: "" },
      "unauthenticated",
    ],
  ])("health when %s", async (_case, login, status) => {
    saveLogin(login);

    const result = await getClaudeProviderHealth();

    expect(result).toEqual({
      supported: true,
      health: expect.objectContaining({ status }),
    });
  });

  it("keeps a login Claude Code ended in the Keychain signed out, despite an old credential file", async () => {
    saveLogin(renewable);
    const ended = JSON.stringify({
      claudeAiOauth: {
        accessToken: "",
        refreshToken: "",
        expiresAt: 0,
        loginEnded: "time_limit",
      },
    });
    state.keychain = Buffer.from(ended, "utf8").toString("hex");

    const [health, usage] = await Promise.all([
      getClaudeProviderHealth(),
      getClaudeProviderUsage(),
    ]);

    expect(health).toEqual({
      supported: true,
      health: expect.objectContaining({ status: "unauthenticated" }),
    });
    expect(usage).toEqual({
      supported: true,
      usage: { status: "unauthenticated" },
    });
  });

  it("waits for Claude Code to renew before reading usage", async () => {
    saveLogin(renewable);

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage: {
        status: "error",
        message: renewMessage,
        planLabel: "Max",
        accountEmail: null,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports usage as expired when Claude Code can't renew", async () => {
    saveLogin({ ...renewable, refreshTokenExpiresAt: Date.now() - 1 });

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({ supported: true, usage: { status: "expired" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a renewable login waits for Claude Code", renewable, "error"],
    ["a login without a refresh token is expired", {}, "expired"],
  ])("on a 401, %s", async (_case, login, status) => {
    saveLogin({ ...login, expiresAt: Date.now() + HOUR_MS });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );

    const result = await getClaudeProviderUsage();

    expect(result).toEqual({
      supported: true,
      usage:
        status === "error"
          ? expect.objectContaining({ status, message: renewMessage })
          : { status },
    });
  });
});
