// Connect GitHub's device flow for cloud sandboxes: every repo (the OAuth app) or only picked repos (the GitHub App, #2084).
// GitHub and the website are mocked.
import { beforeEach, expect, test, vi } from "vitest";

const saved: string[] = [];
const chosen: boolean[] = [];
const copyFlags: boolean[] = [];
let loggedIn = false;
let saveFails = false;
let installStatus = 200;
vi.mock("node:timers/promises", () => ({ setTimeout: (_ms: number, _v: unknown, o?: { signal?: AbortSignal }) => new Promise<void>((resolve, reject) => { if (o?.signal?.aborted) return reject(o.signal.reason); o?.signal?.addEventListener("abort", () => reject(o.signal!.reason)); setImmediate(resolve); }) }));
vi.mock("../../src/services/cloudroom/commands.js", () => ({ cloudroom: () => ({ sandboxes: {
  account: async () => ({ id: "a" }), logins: async () => ({ github: loggedIn }), githubAccount: async () => null, removeLogin: async () => {},
  saveLogin: async (_name: string, entry: string, _only: unknown, _background: boolean, byHand: boolean) => { if (saveFails) throw new Error("website down"); saved.push(entry); chosen.push(byHand); loggedIn = true; },
} }) }));
vi.mock("../../src/services/cloudroom/sync.js", () => ({ copyMacGithub: async () => true, setCopyMacGithub: async (_deps: unknown, on: boolean) => { copyFlags.push(on); } }));
vi.mock("../../src/services/cloudroom/sandboxes.js", () => ({ githubAccountSchema: { parse: (x: unknown) => x }, macGithubToken: async () => "", sandboxGithubLogin: async (token: string) => JSON.stringify({ token }) }));

const { githubAuth } = await import("../../src/services/cloudroom/github-login.js");
const deps = {} as never;
type Call = { url: string; body: Record<string, string>; auth: string | null };
let calls: Call[] = [];
let installs: number[] = [];
let tokenAnswers: Record<string, unknown>[] = [];
const until = async (test: () => boolean | Promise<boolean>) => { for (let i = 0; i < 2000; i++) { if (await test()) return; await new Promise((r) => setImmediate(r)); } throw new Error("timeout"); };

beforeEach(() => {
  calls = []; saved.length = 0; chosen.length = 0; copyFlags.length = 0; loggedIn = false; saveFails = false; installStatus = 200;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    calls.push({ url, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith("/login/device/code")) return json({ device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    if (url.endsWith("/login/oauth/access_token")) return json(tokenAnswers.shift() ?? { error: "authorization_pending" });
    if (url.includes("/user/installations")) {
      if (installStatus !== 200) return new Response("{}", { status: installStatus });
      const count = installs.length > 1 ? installs.shift()! : installs[0];
      return json({ total_count: Math.abs(count), installations: Array.from({ length: Math.abs(count) }, () => ({ id: 1, suspended_at: count < 0 ? "2026-01-01T00:00:00Z" : null })) });
    }
    throw new Error("unexpected " + url);
  });
});

test("specific repos: the App's client ID, no scope, then waits for an install before saving", async () => {
  tokenAnswers = [{ error: "authorization_pending" }, { access_token: "ghu_test", token_type: "bearer", scope: "" }];
  installs = [0, 0, 0, 0, 0, 0];
  const first = await githubAuth(deps, "login", "req1", true);
  expect(first).toMatchObject({ state: "waiting", user_code: "ABCD-1234", verification_url: "https://github.com/login/device" });
  expect(calls[0].body).toEqual({ client_id: "Iv23lilRDA0DFyES7mNr" });
  await until(async () => (await githubAuth(deps)).user_code === null);
  const picking = await githubAuth(deps);
  expect(picking).toMatchObject({ state: "waiting", user_code: null, login_id: "req1", verification_url: "https://github.com/apps/cloudroom-agents/installations/new" });
  expect(saved).toEqual([]);
  expect(calls.find((c) => c.url.includes("/user/installations"))?.auth).toBe("Bearer ghu_test");
  expect(calls.filter((c) => c.url.endsWith("access_token")).every((c) => c.body.client_id === "Iv23lilRDA0DFyES7mNr")).toBe(true);
  installs = [1];
  await until(() => saved.length === 1);
  expect(JSON.parse(saved[0]).token).toBe("ghu_test");
  expect(chosen).toEqual([true]);
  expect(copyFlags).toEqual([false]);
  await until(async () => (await githubAuth(deps)).state === "connected");
  expect((await githubAuth(deps)).message).toBeNull();
});

test("a suspended install does not count as picked", async () => {
  tokenAnswers = [{ access_token: "ghu_test" }];
  installs = [-1];
  await githubAuth(deps, "login", "req4", true);
  await until(async () => (await githubAuth(deps)).user_code === null && (await githubAuth(deps)).state === "waiting");
  await until(() => calls.filter((c) => c.url.includes("/user/installations")).length >= 3);
  expect(saved).toEqual([]);
  await githubAuth(deps, "cancel", "req4");
});

test("a failed switch keeps the old login connected and says what failed", async () => {
  loggedIn = true;
  tokenAnswers = [{ error: "access_denied" }];
  await githubAuth(deps, "login", "req5", true);
  await until(async () => (await githubAuth(deps)).state === "connected");
  expect((await githubAuth(deps)).message).toBe("GitHub sign-in was declined.");
  expect(saved).toEqual([]);
});

test("GitHub refusing the new token ends the wait at once", async () => {
  loggedIn = true;
  tokenAnswers = [{ access_token: "ghu_test" }];
  installStatus = 401;
  await githubAuth(deps, "login", "req6", true);
  await until(async () => (await githubAuth(deps)).state === "connected");
  expect((await githubAuth(deps)).message).toContain("GitHub rejected the new login");
  expect(calls.filter((c) => c.url.includes("/user/installations")).length).toBe(1);
});

test("a failed save turns the Mac's gh copy back on", async () => {
  tokenAnswers = [{ access_token: "gho_test" }];
  saveFails = true;
  await githubAuth(deps, "login", "req7");
  await until(async () => (await githubAuth(deps)).state === "error");
  expect(copyFlags).toEqual([false, true]);
});

test("every repo: the OAuth app and its scope, saved right away, no install check", async () => {
  tokenAnswers = [{ access_token: "gho_test" }];
  await githubAuth(deps, "login", "req2");
  expect(calls[0].body).toEqual({ client_id: "Ov23li9OTKaEYO6RAHos", scope: "repo read:org workflow" });
  await until(() => saved.length === 1);
  expect(JSON.parse(saved[0]).token).toBe("gho_test");
  expect(calls.some((c) => c.url.includes("/user/installations"))).toBe(false);
});

test("cancel while picking repos saves nothing", async () => {
  tokenAnswers = [{ access_token: "ghu_test" }];
  installs = [0];
  await githubAuth(deps, "login", "req3", true);
  await until(async () => (await githubAuth(deps)).user_code === null && (await githubAuth(deps)).state === "waiting");
  await githubAuth(deps, "cancel", "req3");
  const polls = calls.length;
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  expect(calls.length).toBe(polls);
  expect(saved).toEqual([]);
  expect((await githubAuth(deps)).state).toBe("missing");
});
