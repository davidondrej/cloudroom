import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => ({
  items: new Map<string, string>(),
  calls: [] as { args: string[]; input?: string }[],
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: object,
    done: (error: (Error & { code?: number }) | null, stdout: string) => void,
  ) => {
    const call: { args: string[]; input?: string } = { args };
    keychain.calls.push(call);
    return {
      stdin: {
        end(input?: string) {
          call.input = input;
          const line = input?.match(/-s "([^"]+)" -X "([0-9a-f]+)"/);
          if (line) keychain.items.set(line[1]!, line[2]!);
          const service = args[args.indexOf("-s") + 1]!;
          if (args[0] !== "find-generic-password") return done(null, "");
          const found = keychain.items.get(service);
          if (found) return done(null, `${found}\n`);
          done(Object.assign(new Error("not found"), { code: 44 }), "");
        },
      },
    };
  },
}));

import { keychainService, mergeSignIns, syncMcpSignIns } from "./profile.js";

const login = { accessToken: "account", refreshToken: "account-refresh", expiresAt: 1 };
// Expiry times an hour from now, so the copied access tokens are still valid.
const hour = Date.now() + 3_600_000;
const signIn = (token: string, expiresAt: number) => ({ accessToken: token, expiresAt: hour + expiresAt, clientId: "c" });

let root: string;
let main: string;
let profile: string;
const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { configurable: true, value });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "accounts-mcp-"));
  main = path.join(root, "main");
  profile = path.join(root, "profile");
  await Promise.all([fs.mkdir(main), fs.mkdir(profile)]);
  vi.stubEnv("CLAUDE_CONFIG_DIR", main);
  keychain.items.clear();
  keychain.calls.length = 0;
});

afterEach(async () => {
  setPlatform(platform);
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const write = (dir: string, value: unknown) =>
  fs.writeFile(path.join(dir, ".credentials.json"), JSON.stringify(value));
const read = async (dir: string) =>
  JSON.parse(await fs.readFile(path.join(dir, ".credentials.json"), "utf8"));

describe("mergeSignIns", () => {
  it("keeps the newer sign-in per server and skips ones without tokens", () => {
    expect(
      mergeSignIns(
        { a: signIn("main-a", 200), b: signIn("main-b", 100), c: signIn("main-c", 5), d: { clientId: "x" } },
        { b: signIn("own-b", 300), c: signIn("own-c", 1), e: { clientId: "own", expiresAt: 999 } },
      ),
    ).toEqual({ a: signIn("main-a", 200), b: signIn("own-b", 300), c: signIn("main-c", 5), e: { clientId: "own", expiresAt: 999 } });
    expect(mergeSignIns({ e: signIn("main-e", 1) }, { e: { clientId: "own", expiresAt: 999 } })).toEqual({
      e: signIn("main-e", 1),
    });
  });

  it("copies only access tokens that haven't expired, never refresh tokens", () => {
    const withRefresh = { ...signIn("main", 10), refreshToken: "main-refresh" };
    const expired = { accessToken: "old", refreshToken: "old-refresh", expiresAt: Date.now() - 1 };
    const ownLogin = { ...signIn("own", 0), refreshToken: "own-refresh" };
    const merged = mergeSignIns({ a: withRefresh, b: expired, c: withRefresh }, { c: ownLogin });
    expect(merged).toEqual({ a: signIn("main", 10), c: ownLogin });
    expect(JSON.stringify(merged)).not.toContain("main-refresh");
  });

  it("returns null when nothing changes", () => {
    expect(mergeSignIns({ a: signIn("a", 1) }, { a: signIn("a", 1) })).toBeNull();
    expect(mergeSignIns(undefined, {})).toBeNull();
  });
});

describe("syncMcpSignIns with .credentials.json", () => {
  beforeEach(() => setPlatform("linux"));

  it("copies MCP sign-ins and keeps the account's own login", async () => {
    await write(main, { claudeAiOauth: { accessToken: "mac" }, mcpOAuth: { "linear|hash": signIn("l", 10) } });
    await write(profile, { claudeAiOauth: login, other: true });
    const cacheFile = path.join(profile, "mcp-needs-auth-cache.json");
    const unrelated = { figma: { timestamp: 123 } };
    await fs.writeFile(cacheFile, JSON.stringify({ linear: { timestamp: 123 }, ...unrelated }));

    expect(await syncMcpSignIns(profile)).toBe(true);
    expect(await read(profile)).toEqual({ claudeAiOauth: login, other: true, mcpOAuth: { "linear|hash": signIn("l", 10) } });
    expect(JSON.parse(await fs.readFile(cacheFile, "utf8"))).toEqual(unrelated);
    if (platform !== "win32")
      expect((await fs.stat(path.join(profile, ".credentials.json"))).mode & 0o777).toBe(0o600);
    const failedAgain = { linear: { timestamp: 456 }, ...unrelated };
    await fs.writeFile(cacheFile, JSON.stringify(failedAgain));
    expect(await syncMcpSignIns(profile)).toBe(false);
    expect(JSON.parse(await fs.readFile(cacheFile, "utf8"))).toEqual(failedAgain);
  });

  it("skips while Claude Code holds its write lock", async () => {
    await write(main, { mcpOAuth: { linear: signIn("l", 10) } });
    await fs.mkdir(path.join(profile, ".storage-write.lock"));

    expect(await syncMcpSignIns(profile)).toBe(false);
    await expect(fs.access(path.join(profile, ".credentials.json"))).rejects.toThrow();
  });
});

describe("syncMcpSignIns with the macOS Keychain", () => {
  beforeEach(() => setPlatform("darwin"));
  const hex = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("hex");

  it("merges into the profile's own entry through security -i", async () => {
    keychain.items.set(keychainService(main), hex({ mcpOAuth: { figma: signIn("f", 9) } }));
    keychain.items.set(keychainService(profile), hex({ claudeAiOauth: login }));

    expect(await syncMcpSignIns(profile)).toBe(true);
    const saved = keychain.calls.find((call) => call.args[0] === "-i");
    expect(saved?.input).toContain(`-s "${keychainService(profile)}"`);
    expect(JSON.parse(Buffer.from(keychain.items.get(keychainService(profile))!, "hex").toString())).toEqual({
      claudeAiOauth: login,
      mcpOAuth: { figma: signIn("f", 9) },
    });
  });

  it("never writes when the profile's entry can't be read", async () => {
    keychain.items.set(keychainService(main), hex({ mcpOAuth: { figma: signIn("f", 9) } }));
    keychain.items.set(keychainService(profile), "not json");

    await expect(syncMcpSignIns(profile)).rejects.toThrow("Claude credentials are not readable JSON.");
    expect(keychain.calls.some((call) => call.args[0] === "-i")).toBe(false);
  });

  it("names entries like Claude Code", () => {
    expect(keychainService()).toBe("Claude Code-credentials");
    expect(keychainService("/Users/a/.gui-cloudroom/plugins/accounts/profiles/x")).toMatch(
      /^Claude Code-credentials-[0-9a-f]{8}$/,
    );
  });
});
