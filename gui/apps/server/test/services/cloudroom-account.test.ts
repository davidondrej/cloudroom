import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cloudroomThreads, threads } from "@cloudroom/db";
import { eq } from "drizzle-orm";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { cloudroomAccount, CloudroomAccountService, pendingLoginTimeoutMs } from "../../src/services/cloudroom/account.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource, seedThread } from "../helpers/seed.js";

const owners = [{ id: "11111111-1111-4111-8111-111111111111", email: "one@example.invalid" }, { id: "22222222-2222-4222-8222-222222222222", email: "two@example.invalid" }];
const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Not listening");
  return `http://127.0.0.1:${address.port}`;
};
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };

it("pairs through a loopback callback, keeps secrets out of status, persists/reconnects, and signs out without touching history or the VM", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const account = cloudroomAccount(harness.deps);
  const token = "core-fixture-" + "x".repeat(40), gateToken = "gate-fixture-secret";
  let owner = owners[0]!;
  let offline = false;
  const coreCalls: string[] = [];
  const core = createServer((req, res) => {
    coreCalls.push(req.url!);
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    expect(req.headers.cookie).toBe(`_port_auth=${gateToken}`);
    res.writeHead(offline ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/capabilities" ? { version: 1, repository: "/code/prepared", stop: true, resume: true, launch_settings: true, harnesses: [{ id: "codex", model: "test" }] } : { ready: true }));
  });
  const coreUrl = await listen(core);
  let expectedChallenge = "";
  let redemptionDelay: Promise<void> | null = null;
  let redeemed = 0;
  const website = createServer(async (req, res) => {
    if (req.url === "/api/desktop/onboarding") {
      expect(req.headers.origin).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      expect(owners.map(item => `Basic ${Buffer.from(`${item.id}:${token}`).toString("base64")}`)).toContain(req.headers.authorization);
      let text = ""; for await (const chunk of req) text += chunk;
      const progress = JSON.parse(text);
      expect(progress.connected).toBe(true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ macConnectedAt: "2026-09-20T12:00:00Z", projectSelectedAt: progress.projectSelected ? "2026-09-20T12:00:00Z" : null, firstMessageAt: null }));
      return;
    }
    expect(req.url).toBe("/api/desktop/redeem");
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    expect(createHash("sha256").update(body.verifier).digest("hex")).toBe(expectedChallenge);
    expect(body.code).toBe("c".repeat(64));
    redeemed++;
    if (redemptionDelay) await redemptionDelay;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ account: owner, connection: { url: coreUrl, token, gateToken } }));
  });
  const websiteUrl = await listen(website);
  const request = async (path: string, body?: unknown, headers?: Record<string, string>) => harness.app.request(`/api/v1/cloudroom/account${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const start = async () => {
    const response = await request("/sign-in", { projectId: project.id, websiteUrl });
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    expectedChallenge = url.searchParams.get("challenge")!;
    expect(url.href).not.toContain(token);
    expect(url.href).not.toContain(gateToken);
    return url;
  };
  const finish = (url: URL, state = url.searchParams.get("state")!) => fetch(`${url.searchParams.get("callback")}?${new URLSearchParams({ code: "c".repeat(64), state })}`);
  const savedPath = join(harness.deps.config.dataDir, "cloudroom.json");
  try {
    expect((await request("/sign-in", { projectId: project.id }, { Origin: "https://attacker.invalid" })).status).toBe(403);
    await expect(account.signIn({ projectId: project.id, websiteUrl: "https://attacker.invalid" })).rejects.toThrow("Cloudroom website");
    const url = await start();
    expect((await request("").then(r => r.json())).signingIn).toBe(true);
    const rejected = await finish(url, "d".repeat(64));
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("<h1>Sign-in not completed</h1>");
    expect((await fetch(url.searchParams.get("callback")!, { method: "POST", body: new URLSearchParams({ code: "c".repeat(64), state: url.searchParams.get("state")! }) })).status).toBe(400);
    expect(redeemed).toBe(0);
    const callbackResponse = await finish(url);
    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.headers.get("content-type")).toContain("text/html");
    const confirmation = await callbackResponse.text();
    expect(confirmation).toContain("<h1>You’re signed in</h1>");
    expect(confirmation).toContain('href="cloudroom://open"');
    expect(confirmation).toContain("--accent:#bfff00");
    expect(confirmation).not.toContain("#fd360e");
    for (const secret of [token, gateToken, url.searchParams.get("state")!, "c".repeat(64)]) expect(confirmation).not.toContain(secret);
    expect(callbackResponse.headers.get("cache-control")).toBe("no-store");
    expect(callbackResponse.headers.get("referrer-policy")).toBe("no-referrer");
    const nonce = confirmation.match(/<style nonce="([a-f0-9]+)">/)?.[1];
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(callbackResponse.headers.get("content-security-policy")).toContain(`style-src 'nonce-${nonce}'`);
    expect(callbackResponse.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(callbackResponse.headers.get("x-content-type-options")).toBe("nosniff");
    const status = await request("").then(r => r.json());
    expect(status).toMatchObject({ ready: true, account: owners[0], projectId: project.id, signingIn: false });
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain(gateToken);
    expect((await stat(savedPath)).mode & 0o777).toBe(0o600);
    expect(await new CloudroomAccountService(harness.deps).status()).toMatchObject({ account: owners[0], ready: true });
    await expect(finish(url)).rejects.toThrow();
    expect(redeemed).toBe(1);
    offline = true;
    expect(await account.status()).toMatchObject({ ready: false, account: owners[0] });
    offline = false;
    expect(await account.status()).toMatchObject({ ready: true, account: owners[0] });

    const thread = seedThread(harness.deps, { projectId: project.id });
    harness.db.update(threads).set({ executionTarget: "cloud" }).where(eq(threads.id, thread.id)).run();
    harness.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl, sessionId: "existing", startRequestId: "existing", model: "test", reasoning: "medium" }).run();
    expect((await request("/logout", {})).status).toBe(200);
    const saved = await readFile(savedPath, "utf8");
    expect(saved).not.toContain(token); expect(saved).not.toContain(gateToken);
    expect(saved).toContain(owners[0]!.id);
    expect(await account.status()).toMatchObject({ ready: false, account: null });
    expect(harness.db.select().from(cloudroomThreads).all()).toHaveLength(1);
    await expect(cloudroom(harness.deps).control(thread.id, "stop")).rejects.toThrow(/sign in/i);
    expect(coreCalls.some(path => path.includes("/stop") || path.includes("/close"))).toBe(false);
    owner = owners[1]!;
    expect((await finish(await start())).status).toBe(200);
    expect(await account.status()).toMatchObject({ ready: true, account: owners[1] });
    expect(harness.db.select().from(cloudroomThreads).get()?.accountId).toBe(owners[0]!.id);
    await expect(cloudroom(harness.deps).control(thread.id, "stop")).rejects.toThrow("another Cloudroom account");
    await account.logout();
    owner = owners[0]!;
    expect((await finish(await start())).status).toBe(200);
    expect(await account.status()).toMatchObject({ ready: true, account: owners[0] });
    await expect(cloudroom(harness.deps).threadClient(thread.id)).resolves.toBeDefined();
    expect(coreCalls.some(path => path.includes("/stop") || path.includes("/close"))).toBe(false);
    await account.logout();

    const cancelled = await start();
    expect((await request("/cancel", {})).status).toBe(200);
    await expect(finish(cancelled)).rejects.toThrow();
    let release!: () => void;
    redemptionDelay = new Promise<void>(resolve => { release = resolve; });
    const inFlightUrl = await start();
    const inFlight = finish(inFlightUrl).catch(() => null);
    await expect.poll(() => redeemed).toBe(4);
    expect((await finish(inFlightUrl)).status).toBe(400);
    expect((await account.status()).signingIn).toBe(true);
    await account.logout();
    release();
    await inFlight;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await account.status()).toMatchObject({ ready: false, account: null, signingIn: false });
    expect(await readFile(savedPath, "utf8")).not.toContain(token);
  } finally {
    account.cancel(); cloudroom(harness.deps).stop(); await close(website); await close(core); await harness.cleanup();
  }
}, 15000);

it("keeps browser sign-in open while a VM is provisioned and does not call the website or hosting when it expires", async () => {
  const harness = await createTestAppHarness();
  const account = cloudroomAccount(harness.deps);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return realFetch(input, init);
  }) as typeof fetch;
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === pendingLoginTimeoutMs) {
      expire = () => { (fn as () => void)(); };
      return realTimeout(() => {}, 0);
    }
    return realTimeout(fn as never, ms as never, ...(args as []));
  }) as unknown as typeof setTimeout;
  try {
    expect(pendingLoginTimeoutMs).toBe(30 * 60_000);
    expect(pendingLoginTimeoutMs).not.toBe(5 * 60_000);
    const started = await account.signIn({ websiteUrl: "http://127.0.0.1:9" });
    expect(started.url).toContain("/desktop?");
    expect(expire).toBeTypeOf("function");
    expect((await account.status()).signingIn).toBe(true);
    account.cancel();
    expect((await account.status()).signingIn).toBe(false);
    expect((await account.status()).signInError).toBeNull();
    await account.signIn({ websiteUrl: "http://127.0.0.1:9" });
    expect((await account.status()).signingIn).toBe(true);
    expire?.();
    expect((await account.status()).signInError).toBe("Sign-in expired. Try again.");
    expect((await account.status()).signingIn).toBe(false);
    expect(calls.filter(url => /^https:|\/api\/setup/.test(url))).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realTimeout;
    account.cancel();
    await harness.cleanup();
  }
});
