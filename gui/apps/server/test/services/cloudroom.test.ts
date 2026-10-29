import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as sync from "../../src/services/cloudroom/sync.js";
import { listQueuedCommands } from "../helpers/commands.js";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { command, saveTeleportProgress } from "../../src/services/cloudroom/store.js";
import { teleports } from "../../src/services/cloudroom/teleport.js";
import { SandboxDirectory } from "../../src/services/cloudroom/sandboxes.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedEnvironment, seedHostSession, seedPrimaryHost, seedProjectWithSource, seedThread, seedThreadRuntimeState } from "../helpers/seed.js";
import { archiveThread, createThread, getThread, setProjectGitRemoteUrlIfMissing, events, cloudroomThreads, cloudroomCommands } from "@cloudroom/db";

it("forwards Cursor login and keys without creating conversation records", async () => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const calls: { path: string; body: unknown }[] = [];
  const core = createServer(async (req, res) => {
    const json = (body: unknown) => { res.writeHead(req.method === "POST" ? 202 : 200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/test", stop: true, resume: true, launch_settings: true, cursor_auth: true, harnesses: [{ id: "cursor", model: "default" }] });
    let text = ""; for await (const chunk of req) text += chunk;
    calls.push({ path: req.url!, body: text ? JSON.parse(text) : null });
    json({ state: "missing", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null });
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40) });
    const before = harness.db.select().from(events).all().length;
    const request = (action = "", body?: unknown) => harness.app.request(`/api/v1/cloudroom/account/cursor${action}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await request()).status).toBe(200);
    expect((await request("/login", { requestId: "login" })).status).toBe(200);
    expect((await request("/cancel", { requestId: "login" })).status).toBe(200);
    expect((await request("/key", { requestId: "key", apiKey: "synthetic-canary" })).status).toBe(200);
    expect((await request("/key", { requestId: "bad", apiKey: "invalid key" })).status).toBe(400);
    expect(calls).toEqual([
      { path: "/v1/accounts/cursor", body: null },
      { path: "/v1/accounts/cursor/login", body: { request_id: "login" } },
      { path: "/v1/accounts/cursor/cancel", body: { request_id: "login" } },
      { path: "/v1/accounts/cursor/key", body: { request_id: "key", api_key: "synthetic-canary" } },
    ]);
    expect(harness.db.select().from(events).all()).toHaveLength(before);
    expect(harness.db.select().from(cloudroomCommands).all()).toHaveLength(0);
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
});

it("reports storage before models and preserves transiently blocked messages through recovery", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  let level = "normal", reason = "disk_capacity", rejectPrompt = false, discoveryCalls = 0, sampleAge = 0;
  const prompts: string[] = [];
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({ storage: { enabled: true, level, reason, workspace_available_bytes: level === "blocked" ? 0 : 3e9, history_available_bytes: level === "blocked" ? 0 : 3e9, workspace_total_bytes: 80e9, history_total_bytes: 80e9, sampled_at: Date.now() - sampleAge } });
    if (req.url === "/v1/capabilities") { discoveryCalls++; return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model", models: level === "blocked" ? null : [{ model: "test-model", reasoning_levels: ["high"] }] }] }); }
    if (req.url === "/v1/ready") return json({ ready: level !== "blocked" }, level === "blocked" ? 503 : 200);
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    if (req.method !== "POST") return json({}, 404);
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text), command = req.url === "/v1/sessions" ? "start" : "prompt";
    if (command === "prompt") { prompts.push(body.request_id); if (rejectPrompt) return json({ code: "storage_blocked" }, 409); }
    json({ session_id: "cr_storage", receipt: { request_id: body.request_id, command, state: "accepted", input: {} }, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const request = (path: string, body?: unknown) => harness.app.request(`/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40) });
    await service.status();
    level = "blocked";
    const before = discoveryCalls;
    const status = await (await request("/cloudroom")).json();
    expect(status).toMatchObject({ ready: false, storage: { level: "blocked" }, error: expect.stringContaining("cloud disk is almost full") });
    expect(discoveryCalls).toBe(before);
    const input = { executionTarget: "cloud", requestId: "storage-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "Keep this prompt", mentions: [] }] };
    const blockedStart = await request("/threads", input);
    expect(blockedStart.status).toBe(503);
    expect(await blockedStart.json()).toMatchObject({ code: "storage_blocked", message: expect.stringContaining("cloud disk is almost full") });
    expect(prompts).toHaveLength(0);
    reason = "measurement_unavailable";
    expect(await (await request("/cloudroom")).json()).toMatchObject({ error: expect.stringContaining("measured") });
    reason = "disk_capacity"; level = "normal"; sampleAge = 60_000;
    expect(await (await request("/cloudroom")).json()).toMatchObject({ ready: false, storage: { workspace_available_bytes: null }, error: expect.stringContaining("measured") });
    sampleAge = 0; level = "low_space";
    expect(await (await request("/cloudroom")).json()).toMatchObject({ ready: true, storage: { level: "low_space" } });
    const response = await request("/threads", input);
    expect(response.status).toBe(201);
    const thread = await response.json();
    await expect.poll(() => prompts.length).toBe(1);
    rejectPrompt = true;
    await request(`/threads/${thread.id}/send`, { requestId: "storage-follow", mode: "auto", input: [{ type: "text", text: "Keep this follow-up", mentions: [] }] });
    await expect.poll(() => prompts.filter(id => id === "storage-follow").length).toBe(1);
    expect(harness.db.select().from(cloudroomCommands).all().find(c => c.id === "storage-follow")?.state).toBe("sending");
    level = "blocked";
    expect((await request(`/threads/${thread.id}/timeline`)).status).toBe(200);
    const blockedFollow = await request(`/threads/${thread.id}/send`, { requestId: "blocked-follow", mode: "auto", input: [{ type: "text", text: "Stay in draft", mentions: [] }] });
    expect(blockedFollow.status).toBe(503);
    expect(await blockedFollow.json()).toMatchObject({ code: "storage_blocked", message: expect.stringContaining("cloud disk is almost full") });
    rejectPrompt = false; level = "normal";
    await expect.poll(() => harness.db.select().from(cloudroomCommands).all().find(c => c.id === "storage-follow")?.state, { timeout: 5000 }).toBe("accepted");
    expect(prompts.filter(id => id === "storage-follow").length).toBeGreaterThanOrEqual(2);
    expect(await (await request("/cloudroom")).json()).toMatchObject({ ready: true, error: null, storage: { level: "normal" } });
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
}, 15000);

it.each(["pi", "codex"])("recovers an idle %s stream without sending messages or hiding real errors", async (providerId) => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const streams: ServerResponse[] = [];
  const cursors: number[] = [];
  const rejectionMessage = providerId === "pi" ? "model" : "HTTP 409";
  const warn = vi.spyOn(harness.deps.logger, "warn");
  let streamStatus = 200;
  let posts = 0;
  let discoveryCalls = 0;
  const core = createServer((req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method === "POST") { posts++; return providerId === "pi" ? json({ code: "invalid_model" }, 400) : json({ error: "SECRET-CANARY" }, 409); }
    if (req.url === "/v1/capabilities") { discoveryCalls++; return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, harnesses: [{ id: providerId, model: "test-model" }] }); }
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/sessions/cr_idle") return json({ session: { session_id: "cr_idle", harness: providerId, state: "idle", native_id: null, current_request: null, last_sequence: 0, queue: [], receipts: {} } });
    if (req.url?.includes("/stream?")) {
      cursors.push(Number(new URL(req.url, "http://localhost").searchParams.get("after")));
      if (streamStatus !== 200) return json({ error: "SECRET-CANARY" }, streamStatus);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.push(res);
      return;
    }
    json({}, 404);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    const url = `http://127.0.0.1:${address.port}`;
    await service.configure({ url, token: "x".repeat(40) });
    const thread = createThread(harness.db, harness.hub, { executionTarget: "cloud", projectId: project.id, providerId, status: "idle" });
    harness.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: url, startRequestId: "idle", sessionId: "cr_idle", model: providerId === "pi" ? "test/test-model" : "test-model", reasoning: "medium", error: "Cloudroom connection or replay failed" }).run();
    const status = async () => (await harness.app.request(`/api/v1/cloudroom/threads/${thread.id}`)).json();
    const poll = () => expect.poll(status, { timeout: 5000 });
    const record = (sequence: number, data: object = { state: "idle" }) => streams.at(-1)!.write(`id: ${sequence}\nevent: record\ndata: ${JSON.stringify({ sequence, session_id: "cr_idle", kind: "state", data })}\n\n`);
    await expect.poll(() => streams.length, { timeout: 5000 }).toBe(1);
    const discoveryBeforeIdle = discoveryCalls;
    await poll().toMatchObject({ error: null, reconnecting: false });
    streamStatus = 503;
    streams.at(-1)!.destroy();
    await poll().toMatchObject({ error: null, reconnecting: true });
    await expect.poll(() => cursors.length, { timeout: 5000 }).toBeGreaterThan(1);
    expect(await status()).toMatchObject({ error: null, reconnecting: true });
    streamStatus = 200;
    await poll().toMatchObject({ error: null, reconnecting: false });
    expect(posts).toBe(0);
    expect(harness.db.select().from(events).all()).toHaveLength(0);
    expect(cursors.every(cursor => cursor === 0)).toBe(true);
    expect(discoveryCalls).toBe(discoveryBeforeIdle);

    streamStatus = 401;
    streams.at(-1)!.end();
    await poll().toMatchObject({ error: "Cloudroom authentication failed (HTTP 401)", reconnecting: false });
    streamStatus = 200;
    await poll().toMatchObject({ error: null, reconnecting: false });
    record(1, { state: 123 });
    await poll().toMatchObject({ error: expect.stringContaining("history"), reconnecting: false });
    const beforeReplay = streams.length;
    await expect.poll(() => streams.length, { timeout: 5000 }).toBeGreaterThan(beforeReplay);
    expect(await status()).toMatchObject({ error: expect.stringContaining("history") });
    record(1);
    await poll().toMatchObject({ error: null, reconnecting: false });
    expect(harness.db.select().from(cloudroomThreads).get()?.cursor).toBe(1);
    record(1);
    expect(harness.db.select().from(cloudroomThreads).get()?.cursor).toBe(1);

    const response = await harness.app.request(`/api/v1/threads/${thread.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "auto", requestId: "rejected-prompt", input: [{ type: "text", text: "Rejected message", mentions: [] }] }) });
    expect(response.ok).toBe(true);
    await poll().toMatchObject({ error: expect.stringContaining(rejectionMessage) });
    expect(getThread(harness.db, thread.id)?.status).toBe("error");
    const beforeReconnect = streams.length;
    streams.at(-1)!.destroy();
    await expect.poll(() => streams.length, { timeout: 5000 }).toBeGreaterThan(beforeReconnect);
    expect(await status()).toMatchObject({ error: expect.stringContaining(rejectionMessage), reconnecting: false });
    expect(cursors.at(-1)).toBe(1);
    expect(posts).toBe(1);
    service.stop(); service.start();
    await expect.poll(() => streams.length, { timeout: 5000 }).toBeGreaterThan(beforeReconnect + 1);
    expect(await status()).toMatchObject({ error: expect.stringContaining(rejectionMessage), reconnecting: false });
    expect(posts).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ threadId: thread.id, phase: "stream", networkCode: "UND_ERR_SOCKET" }), "Cloudroom connection state changed");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ phase: "replay", errorType: "ZodError" }), "Cloudroom connection state changed");
    // Core error text is shown and logged (ADR 0123); auth-failure bodies are never read.
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ phase: "stream", status: 503, message: "Cloudroom rejected the request (HTTP 503): SECRET-CANARY" }), "Cloudroom connection state changed");
    expect(JSON.stringify(warn.mock.calls.filter(([fields]) => (fields as { status?: unknown })?.status === 401))).not.toContain("SECRET-CANARY");
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
}, 30000);

it("reads checkout metadata from the thread's cloud session, never its local project", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  let branch = "cloud-only";
  let unavailable = false;
  const core = createServer((req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    expect(req.headers.authorization).toBe(`Bearer ${"x".repeat(40)}`);
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, harnesses: [] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/sessions/cr_checkout/workspace") return unavailable ? json({}, 404) : json({ path: "/code/test", branch, head: "a".repeat(40) });
    json({}, 404);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await service.configure({ url, token: "x".repeat(40) });
    const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: url, startRequestId: "checkout", sessionId: "cr_checkout", model: "test-model", reasoning: "medium" }).run();
    const read = () => harness.app.request(`/api/v1/cloudroom/threads/${thread.id}/workspace`);
    expect(await (await read()).json()).toEqual({ path: "/code/test", branch, head: "a".repeat(40) });
    branch = "changed-in-cloud";
    expect(await (await read()).json()).toMatchObject({ branch });
    unavailable = true;
    expect((await read()).ok).toBe(false);
    expect(listQueuedCommands(harness, "workspace.status")).toHaveLength(0);
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
});

it.each(["invalid_reasoning_effort", "codex_auth_required"])("holds rejected cloud starts (%s) across restart and retries the saved prompt once", async rejectCode => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const attempts: Record<string, number> = {};
  const prompts: object[] = [];
  let reject = true;
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model", models: [{ model: "test-model", reasoning_levels: ["high", "xhigh", "max"] }] }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/v1/sessions") {
      attempts[body.request_id] = (attempts[body.request_id] ?? 0) + 1;
      expect(body.reasoning).toBe("max");
      if (body.request_id === "temporary" && attempts.temporary === 1) return json({ code: "storage_blocked" }, 409);
      if (body.request_id === "lost-reply" && attempts["lost-reply"] === 1) { req.socket.destroy(); return; }
      if (reject) return json({ code: rejectCode, error: "SECRET-CANARY" }, 409);
      return json({ session_id: `cr_${body.request_id}`, receipt: { request_id: body.request_id, command: "start", state: "accepted", input: {} }, saving: {} }, 202);
    }
    prompts.push(body);
    json({ session_id: req.url!.split("/")[3], receipt: { request_id: body.request_id, command: "prompt", state: "accepted", input: { text: body.text } }, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const request = (path: string, body?: unknown) => harness.app.request(`/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const input = { executionTarget: "cloud", requestId: "max-start", title: "Rejected start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "max", environment: { type: "project-default" }, input: [{ type: "text", text: "Keep this exact prompt", mentions: [] }] };
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const invalid = await request("/threads", { ...input, reasoningLevel: "ultra" });
    expect(invalid.status).toBe(400);
    const wrongModel = await request("/threads", { ...input, model: "claude-fable-5-1" });
    expect(wrongModel.status).toBe(400);
    expect((await wrongModel.json()).message).toBe("claude-fable-5-1 is not a Codex model on Cloud. Codex offers test-model. Use the claude-code provider for Claude.");
    expect(attempts).toEqual({});
    expect(harness.deps.db.select().from(cloudroomThreads).all()).toHaveLength(0);
    expect((await request("/threads", input)).status).toBe(201);
    const saved = harness.deps.db.select().from(cloudroomThreads).get()!;
    await expect.poll(() => service.threadStatus(saved.threadId)).toMatchObject({ failedStart: true, sessionId: null, pendingDelivery: 0 });
    expect(getThread(harness.deps.db, saved.threadId)?.status).toBe("error");
    expect(service.threadStatus(saved.threadId)?.authRequired).toBe(rejectCode === "codex_auth_required");
    const firstMessages = (threadId: string) => harness.db.select().from(events).all().filter(event => event.threadId === threadId && event.type === "client/turn/requested");
    const originalMessage = firstMessages(saved.threadId);
    expect(originalMessage).toHaveLength(1);
    expect(await (await request(`/threads/${saved.threadId}/queued-messages`)).json()).toEqual([]);
    expect(service.threadStatus(saved.threadId)?.error).not.toContain("SECRET-CANARY");
    expect((await request(`/threads/${saved.threadId}/send`, { mode: "auto", input: [{ type: "text", text: "Must not be accepted", mentions: [] }] })).status).toBe(409);
    reject = false;
    service.stop(); service.start();
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(attempts["max-start"]).toBe(1);
    expect(prompts).toEqual([]);
    expect((await request(`/cloudroom/threads/${saved.threadId}/retry-start`, {})).status).toBe(200);
    expect(attempts["max-start"]).toBe(2);
    expect(prompts).toEqual([expect.objectContaining({ text: "Keep this exact prompt" })]);
    expect((await request("/threads", input)).status).toBe(201);
    expect(attempts["max-start"]).toBe(2);
    expect(prompts).toHaveLength(1);
    expect(firstMessages(saved.threadId)).toEqual(originalMessage);
    expect((await request("/threads", { ...input, requestId: "temporary" })).status).toBe(201);
    await expect.poll(() => attempts.temporary, { timeout: 4000 }).toBe(2);
    expect((await request("/threads", { ...input, requestId: "lost-reply" })).status).toBe(201);
    await expect.poll(() => attempts["lost-reply"], { timeout: 4000 }).toBe(2);
    expect(harness.deps.db.select().from(cloudroomThreads).all().filter(row => row.startRequestId === "lost-reply")).toHaveLength(1);
    const legacy = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "pending" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: legacy.id, coreUrl: `http://127.0.0.1:${address.port}`, startRequestId: "legacy", model: "test-model", reasoning: "max", error: "Cloudroom rejected the request (HTTP 409)" }).run();
    harness.deps.db.insert(cloudroomCommands).values({ id: `first_${legacy.id}`, threadId: legacy.id, command: "prompt", input: JSON.stringify({ text: "Saved old prompt" }), createdAt: Date.now() }).run();
    service.stop(); service.start();
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(attempts.legacy).toBeUndefined();
    expect(service.threadStatus(legacy.id)).toMatchObject({ failedStart: true, pendingDelivery: 0 });
    expect(firstMessages(legacy.id)).toHaveLength(1);
    expect(JSON.parse(firstMessages(legacy.id)[0]!.data).input[0].text).toBe("Saved old prompt");
    expect((await request(`/cloudroom/threads/${legacy.id}/retry-start`, {})).status).toBe(200);
    expect(attempts.legacy).toBe(1);
    expect(prompts).toContainEqual(expect.objectContaining({ text: "Saved old prompt" }));
    expect(firstMessages(legacy.id)).toHaveLength(1);
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
}, 15000);

it("routes Cloud through the core, projects conversations, pauses queues, and replays after detach without native hosts", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const token = "fixture-" + "x".repeat(40);
  const gateToken = "synthetic-gate";
  let coreRequests = 0;
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  const receipts = new Map<string, object>();
  let sid = "";
  let stopped = false;
  let active: string | null = null;
  const pending: string[] = [];
  let starts = 0;
  let droppedReply = false;
  const record = (kind: string, data: object, native?: object) => {
    const sequence = records.length + 1;
    const value = { sequence, timestamp_ms: 1700000000000 + sequence, session_id: sid, kind, data, ...(native ? { native: JSON.stringify(native) } : {}) };
    records.push(value);
    const frame = `id: ${sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  const receipt = (id: string, command: string, state: string, input: object = {}) => {
    const value = { request_id: id, command, state, input };
    receipts.set(id, value);
    record("receipt", value);
    return value;
  };
  const native = (method: string, params: object) => record("native_event", {}, { method, params: { threadId: "native", ...params } });
  const begin = (id: string) => {
    active = id;
    record("state", { state: "starting_turn", request_id: id });
    native("turn/started", { turn: { id, status: "inProgress" } });
    native("item/started", { item: { id: "tool", type: "commandExecution", command: "pwd", cwd: "/code/test", status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null }, turnId: id });
    native("item/completed", { item: { id: "tool", type: "commandExecution", command: "pwd", cwd: "/code/test", status: "completed", aggregatedOutput: "/code/test", exitCode: 0, durationMs: 1 }, turnId: id });
    native("item/started", { item: { id: "answer", type: "agentMessage", text: "" }, turnId: id });
    native("item/agentMessage/delta", { itemId: "answer", turnId: id, delta: "Working in Cloud" });
    record("state", { state: "running", request_id: id, turn_id: id });
  };
  const finish = () => {
    native("item/completed", { item: { id: "answer", type: "agentMessage", text: "Cloud result" }, turnId: active });
    native("turn/completed", { turn: { id: active, status: "completed" } });
    receipt(active!, "prompt", "completed");
    active = null;
    record("state", { state: "idle" });
  };
  const core = createServer(async (req, res) => {
    coreRequests++;
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.cookie !== `_port_auth=${gateToken}`) return json({}, 403);
    if (req.headers.authorization !== `Bearer ${token}`) return json({}, 401);
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (let i = after; i < records.length; i++) res.write(`id: ${i + 1}\nevent: record\ndata: ${JSON.stringify(records[i])}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const id = body.request_id;
    if (receipts.has(id)) return json({ session_id: sid, receipt: receipts.get(id), saving: {} }, 202);
    if (req.url === "/v1/sessions") {
      starts++;
      sid = `cr_${id}`;
      expect(body.model).toBe("test-model");
      expect(body.reasoning).toBe("high");
      const accepted = receipt(id, "start", "completed");
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: sid, receipt: accepted, saving: {} }, 202);
    }
    const action = req.url!.split("/").at(-1);
    const command = action === "prompts" ? "prompt" : action!;
    const accepted = receipt(id, command, "accepted", command === "prompt" ? { text: body.text } : {});
    if (command === "prompt") {
      if (!active && !stopped) begin(id); else pending.push(id);
    }
    if (command === "stop") { stopped = true; if (active) finish(); receipt(id, command, "completed"); }
    if (command === "resume") { stopped = false; receipt(id, command, "completed"); if (pending.length) begin(pending.shift()!); }
    if (id === "follow" && !droppedReply) { droppedReply = true; res.destroy(); return; }
    json({ session_id: sid, receipt: accepted, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const request = (path: string, body?: unknown) => harness.app.request(`/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const connection = { url: `http://127.0.0.1:${address.port}`, token, gateToken, projectId: project.id };
    const malformed = await request("/cloudroom", { ...connection, token: `${token}\t` });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(coreRequests).toBe(0);
    await expect(service.configure({ ...connection, gateToken: undefined })).rejects.toThrow("authentication");
    await expect(service.configure({ ...connection, gateToken: "wrong-gate" })).rejects.toThrow("authentication");
    await service.configure(connection);
    const status = await (await request("/cloudroom")).text();
    expect(status).not.toContain(token);
    expect(status).not.toContain(gateToken);
    const input = { executionTarget: "cloud", requestId: "create", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "first\n\nRead at least 15 sources.", mentions: [] }] };
    const response = await request("/threads", input);
    expect(response.status, await response.clone().text()).toBe(201);
    const thread = await response.json();
    expect(thread.executionTarget).toBe("cloud");
    expect(thread.titleFallback).toBe("first Read at least 15 sources.");
    expect(thread.environmentId).toBeNull();
    const initialMessage = harness.db.select().from(events).all().find(event => event.type === "client/turn/requested");
    expect(initialMessage).toBeDefined();
    expect(initialMessage?.createdAt).toBe(harness.db.select().from(cloudroomCommands).all().find(row => row.id === `first_${thread.id}`)?.createdAt);
    await expect.poll(() => ({ status: getThread(harness.db, thread.id)?.status, error: service.threadStatus(thread.id)?.error })).toEqual({ status: "active", error: null });
    expect(records).toContainEqual(expect.objectContaining({ kind: "receipt", data: expect.objectContaining({ command: "prompt", input: { text: "first\n\nRead at least 15 sources." } }) }));
    expect((await request("/threads", input)).status).toBe(201);
    expect(starts).toBe(1);
    const followUp = { requestId: "follow", mode: "auto", input: [{ type: "text", text: "follow up", mentions: [] }] };
    expect((await request(`/threads/${thread.id}/send`, followUp)).status).toBe(200);
    expect((await request(`/threads/${thread.id}/send`, followUp)).status).toBe(200);
    await expect.poll(() => pending, { timeout: 5000 }).toEqual(["follow"]);
    await expect.poll(() => service.queue(thread.id).length).toBe(1);
    expect(await (await request(`/threads/${thread.id}`)).json()).toMatchObject({ queuedMessageCount: 1 });
    await expect.poll(() => harness.db.select().from(cloudroomThreads).get()?.cursor).toBe(records.length);
    expect(harness.db.select().from(events).all().filter((event) => JSON.parse(event.data).input?.[0]?.text === "follow up")).toHaveLength(0);
    expect((await request(`/threads/${thread.id}/stop`, {})).status).toBe(200);
    await expect.poll(() => service.threadStatus(thread.id)?.paused).toBe(true);
    expect(service.queue(thread.id)).toHaveLength(1);
    await expect.poll(() => harness.db.select().from(cloudroomThreads).get()?.cursor).toBe(records.length);
    for (const kind of ["storage_warning", "storage_pause", "storage_recovered"]) record(kind, { text: `Storage notice: ${kind}` });
    await expect.poll(() => harness.db.select().from(events).all().filter(e => JSON.parse(e.data).operation?.startsWith("storage_")).length).toBe(3);
    expect(harness.db.select().from(events).all().filter(e => JSON.parse(e.data).operation?.startsWith("storage_")).map(e => JSON.parse(e.data).message)).toEqual(["Storage notice: storage_warning", "Storage notice: storage_pause", "Storage notice: storage_recovered"]);
    const count = harness.db.select().from(events).all().length;
    service.stop();
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(harness.db.select().from(events).all()).toHaveLength(count);
    expect((await request(`/threads/${thread.id}/queued-messages/follow/send`, {})).status).toBe(200);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    finish();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    const stored = harness.db.select().from(events).all();
    expect(stored.some((event) => event.type === "item/agentMessage/delta")).toBe(true);
    expect(stored.filter((event) => event.type === "turn/started")).toHaveLength(2);
    expect(stored.filter((event) => event.type === "client/turn/requested")).toHaveLength(2);
    expect(stored.some((event) => JSON.parse(event.data).item?.type === "userMessage")).toBe(false);
    expect(stored.filter((event) => JSON.parse(event.data).item?.type === "commandExecution")).toHaveLength(4);
    expect(stored.find((event) => event.type === "client/turn/requested")).toEqual(initialMessage);
    expect((await request(`/threads/${thread.id}/timeline`)).status).toBe(200);
    const tabs = await (await request(`/threads/${thread.id}/tabs`)).json();
    const savedTabs = await harness.app.request(`/api/v1/threads/${thread.id}/tabs`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: tabs.revision, tabs: tabs.tabs }) });
    expect(savedTabs.status).toBe(200);
    expect((await request(`/threads/${thread.id}/send`, { ...followUp, requestId: "archive-active" })).status).toBe(200);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    expect((await request(`/threads/${thread.id}/send`, { ...followUp, requestId: "archive-queued" })).status).toBe(200);
    const archived = await request(`/threads/${thread.id}/archive-all`, {});
    expect(archived.status, await archived.clone().text()).toBe(200);
    expect(await archived.json()).toEqual({ ok: true, archivedThreadIds: [thread.id] });
    expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
    await expect.poll(() => service.threadStatus(thread.id)?.paused).toBe(true);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(pending).toEqual(["archive-queued"]);
    expect((await request(`/threads/${thread.id}/timeline`)).status).toBe(200);
    expect((await request(`/threads/${thread.id}/unarchive`, {})).status).toBe(200);
    expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
    expect(service.threadStatus(thread.id)?.paused).toBe(true);
    expect((await request(`/threads/${thread.id}/queued-messages/archive-queued/send`, {})).status).toBe(200);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    expect(starts).toBe(1);
    finish();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect((await request(`/threads/${thread.id}/compact`, {})).status).toBe(409);
    expect((await request("/threads", { ...input, requestId: "bad", environment: { type: "host", hostId: host.id, workspace: { type: "personal" } } })).status).toBe(400);
    expect(starts).toBe(1);
    expect(harness.db.select().from(cloudroomThreads).all()).toHaveLength(1);
    await expect(service.configure({ ...connection, token: "wrong-" + token })).rejects.toThrow("authentication");
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    expect((await request(`/threads/${thread.id}/send`, { ...followUp, requestId: "offline" })).status).toBe(200);
    expect(harness.db.select().from(cloudroomCommands).all().find((command) => command.id === "offline")?.state).toBe("sending");
    expect(getThread(harness.db, thread.id)?.executionTarget).toBe("cloud");
    expect(starts).toBe(1);
    expect((await request(`/threads/${thread.id}/archive-all`, {})).status).toBe(200);
    expect((await request(`/threads/${thread.id}/archive-all`, {})).status).toBe(200);
    expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
    const pendingStops = harness.db.select().from(cloudroomCommands).all().filter((command) => command.command === "stop" && command.state === "sending");
    expect(pendingStops).toHaveLength(1);
    service.stop();
    core.listen(address.port, "127.0.0.1");
    await once(core, "listening");
    service.start();
    await expect.poll(() => harness.db.select().from(cloudroomCommands).all().find((command) => command.id === pendingStops[0]!.id)?.state, { timeout: 5000 }).toBe("completed");
    expect(harness.db.select().from(cloudroomCommands).all().find((command) => command.id === "offline")?.state).not.toBe("sending");
    expect(stopped).toBe(true);
    expect(starts).toBe(1);
    expect((await request(`/threads/${thread.id}/unarchive`, {})).status).toBe(200);
    expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>((resolve) => core.close(() => resolve())); await harness.cleanup();
  }
}, 20000);

it.each([true, false, null])("starts without copying local files or waiting for sync (external target exists: %s)", async (targetExists) => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const { host } = seedHostSession(harness.deps);
  seedPrimaryHost(harness.deps, host.id);
  const root = join(harness.config.dataDir, "project");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "file"), "project contents");
  const target = join(harness.config.dataDir, "private-target");
  if (targetExists) await writeFile(target, "synthetic-secret");
  await symlink(target, join(root, "runtime/workspace"));
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: targetExists === null ? join(root, "missing") : root });
  setProjectGitRemoteUrlIfMissing(harness.db, harness.deps.hub, project.id, targetExists ? "git@github.com:example/project.git" : "https://SECRET-URL-CANARY@github.com/example/project.git");
  const workspace = { id: `bb_${project.id}`, path: "/code/project" };
  let available = true;
  let direct = false;
  let starts = 0;
  const paths: string[] = [];
  let requestText = "";
  const setup = vi.spyOn(sync, "setupSync").mockRejectedValue(new Error("Sync is broken"));
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!available) return json({}, 503);
    paths.push(req.url ?? "");
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: direct, command_guard: true, sync: true, harnesses: [{ id:"codex", model:"test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    requestText += body;
    const input = JSON.parse(body || "{}");
    if (req.url === "/v1/sessions") {
      starts++;
      expect(input).toMatchObject({ workspace: workspace.id, workspace_name: expect.any(String) });
      return json({session_id:"cr_waiting",receipt:{request_id:input.request_id, command:"start", input, state:"accepted"}, saving:{}}, 202);
    }
    if (req.url === "/v1/sessions/cr_waiting/prompts") return json({session_id:"cr_waiting",receipt:{request_id:input.request_id,command:"prompt",input,state:"accepted"},saving:{}},202);
    return json({},404);
  });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "fixture-" + "x".repeat(40), projectId: project.id });
    available = false;
    const created = await harness.app.request('/api/v1/threads', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ executionTarget:'cloud', requestId:'background-start', title:'Background start', projectId:project.id, providerId:'codex', origin:'app', model:'test-model', reasoningLevel:'high', environment:{type:'project-default'}, input:[{type:'text',text:'Keep my message',mentions:[]}] }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = await created.json();
    expect(starts).toBe(0);
    expect(harness.db.select().from(cloudroomCommands).all().some(row => row.threadId === thread.id && row.input.includes('Keep my message'))).toBe(true);
    expect(await (await harness.app.request(`/api/v1/threads/${thread.id}/queued-messages`)).json()).toEqual([]);
    const firstMessages = () => harness.db.select().from(events).all().filter(event => event.threadId === thread.id && event.type === "client/turn/requested");
    expect(firstMessages()).toHaveLength(1);
    expect(JSON.stringify(await (await harness.app.request(`/api/v1/threads/${thread.id}/timeline`)).json())).toContain("Keep my message");
    const originalMessage = firstMessages()[0];
    await expect.poll(() => service.threadStatus(thread.id)).toMatchObject({ error: null, reconnecting: true, starting: true, pendingDelivery: 1 });
    service.stop();
    available = true;
    service.start();
    await expect.poll(() => service.threadStatus(thread.id)?.error, { timeout: 4000 }).toContain("Update the cloud core");
    expect(starts).toBe(0);
    direct = true;
    await expect.poll(() => starts, { timeout: 5000 }).toBe(1);
    expect(requestText).not.toContain(target);
    expect(requestText).not.toContain('synthetic-secret');
    await expect.poll(() => service.threadStatus(thread.id)?.pendingDelivery).toBe(0);
    const state = await (await harness.app.request(`/api/v1/cloudroom/threads/${thread.id}`)).json();
    expect(state).toMatchObject({ sessionId: "cr_waiting", error: null, starting: true });
    expect(await (await harness.app.request(`/api/v1/threads/${thread.id}`)).json()).toMatchObject({ queuedMessageCount: 0 });
    service.stop(); service.start();
    expect(firstMessages()).toEqual([originalMessage]);
    expect(service.queue(thread.id)).toEqual([]);
    expect(state).not.toHaveProperty("syncProgress");
    expect(paths.some(path => path.startsWith("/v1/workspaces"))).toBe(targetExists !== null);
    expect(requestText).toContain("Keep my message");
    expect(requestText).not.toContain("project contents");
    expect(requestText).not.toContain("SECRET-URL-CANARY");
    expect(requestText).not.toContain("github.com/example/project");
    expect(JSON.parse(originalMessage!.data).input[0].text).toBe("Keep my message");
    expect(setup).toHaveBeenCalled();
    expect(listQueuedCommands(harness, "workspace.status")).toHaveLength(0);
  } finally {
    setup.mockRestore();
    service.stop(); core.closeAllConnections(); await new Promise<void>((resolve) => core.close(() => resolve())); await harness.cleanup();
  }
});

it.each(["starting", "stopping"] as const)("archives and restores a %s Cloud child without a native environment or connection", async (status) => {
  const harness = await createTestAppHarness();
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const parent = seedThread(harness.deps, { projectId: project.id });
    const child = createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId: parent.id, executionTarget: "cloud", providerId: "codex", status });
    const response = await harness.app.request(`/api/v1/threads/${parent.id}/archive-all`, { method: "POST" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, archivedThreadIds: [child.id, parent.id] });
    for (const id of [parent.id, child.id]) {
      expect(getThread(harness.db, id)?.archivedAt).not.toBeNull();
      expect((await harness.app.request(`/api/v1/threads/${id}/unarchive`, { method: "POST" })).status).toBe(200);
      expect(getThread(harness.db, id)?.archivedAt).toBeNull();
    }
  } finally {
    await harness.cleanup();
  }
});


it.each(["codex", "pi"])("renames a Cloud %s thread offline without native execution or execution-setting changes", async (providerId) => {
  const harness = await createTestAppHarness();
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const environment = seedEnvironment(harness.deps, { projectId: project.id, hostId: host.id, status: "ready" });
    for (const environmentId of [null, environment.id]) {
      const thread = createThread(harness.db, harness.hub, { projectId: project.id, environmentId, executionTarget: "cloud", providerId, status: "active", title: "Before" });
      const patch = (body: unknown) => harness.app.request(`/api/v1/threads/${thread.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const renamed = await patch({ title: "Queue test" });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: thread.id, title: "Queue test", executionTarget: "cloud" });
      expect(getThread(harness.db, thread.id)).toMatchObject({ title: "Queue test", status: "active" });
      const fetched = await harness.app.request(`/api/v1/threads/${thread.id}`);
      expect(await fetched.json()).toMatchObject({ title: "Queue test" });
      for (const body of [{ title: "" }, { title: 42 }]) expect((await patch(body)).status).toBe(400);
      for (const body of [{ title: "Blocked", model: "other-model" }, { title: "Blocked", reasoningLevel: "high" }, { title: "Blocked", parentThreadId: "other-thread" }]) {
        expect((await patch(body)).status).toBe(409);
        expect(getThread(harness.db, thread.id)?.title).toBe("Queue test");
      }
      expect((await patch({ title: null })).status).toBe(200);
      expect(getThread(harness.db, thread.id)?.title).toBeNull();
    }
    expect(listQueuedCommands(harness, "thread.rename")).toEqual([]);
    expect(harness.db.select().from(cloudroomCommands).all()).toEqual([]);
  } finally { await harness.cleanup(); }
});

it("lets a Cloud thread clear or keep its parent, re-links one in its own sandbox, and keeps a shared-sandbox child put", async () => {
  const harness = await createTestAppHarness();
  let labelFails = false, replyLost = false;
  const labels: { thread: string; parent: string | null; local: string | null | undefined }[] = [];
  const website = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const input = text ? JSON.parse(text) : {};
    if (input.action === "label") labels.push({ thread: input.thread, parent: input.parent, local: getThread(harness.db, input.thread)?.parentThreadId });
    const lost = replyLost && input.action === "label";
    if (lost) replyLost = false;
    res.writeHead((labelFails || lost) && input.action === "label" ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/desktop/logins" ? { claude: false, codex: false, pi: false, github: false } : input.action === "label" ? { saved: true } : {}));
  });
  website.listen(0, "127.0.0.1"); await once(website, "listening");
  const address = website.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    await cloudroom(harness.deps).configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "parent@example.com" }, undefined, `http://127.0.0.1:${address.port}`, "a".repeat(64));
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const lead = seedThread(harness.deps, { projectId: project.id });
    const cloud = (parentThreadId?: string) => createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId, executionTarget: "cloud", providerId: "codex", status: "idle" });
    const cloudParent = cloud(), own = cloud(lead.id), shared = cloud(cloudParent.id);
    harness.db.insert(cloudroomThreads).values([cloudParent, own, shared].map((thread, index) => ({ threadId: thread.id, coreUrl: `sandbox:${thread === shared ? cloudParent.id : thread.id}`, sessionId: `cr_${index}`, startRequestId: `start_${index}`, model: "test-model", reasoning: "medium" }))).run();
    const patch = (id: string, parentThreadId: string | null, extra = {}) => harness.app.request(`/api/v1/threads/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentThreadId, ...extra }) });
    const parentOf = (id: string) => getThread(harness.db, id)?.parentThreadId;

    expect((await patch(own.id, lead.id)).status).toBe(200);
    labelFails = true;
    const unsaved = await patch(own.id, null);
    expect({ status: unsaved.status, parent: parentOf(own.id) }).toEqual({ status: 503, parent: lead.id });
    labelFails = false;
    const archived = seedThread(harness.deps, { projectId: project.id });
    archiveThread(harness.db, harness.hub, archived.id);
    const tried = labels.length, archivedParent = await patch(own.id, archived.id), selfParent = await patch(own.id, own.id);
    expect({ archived: archivedParent.status, self: selfParent.status, labels: labels.length }).toEqual({ archived: 400, self: 400, labels: tried });
    const noSection = await patch(own.id, null, { sectionId: "sec_missing" }), withModel = await patch(own.id, null, { model: "other-model" }), badTitle = await patch(own.id, null, { title: 123 });
    expect({ section: noSection.status, model: withModel.status, title: badTitle.status, labels: labels.length, parent: parentOf(own.id) }).toEqual({ section: 404, model: 400, title: 400, labels: tried, parent: lead.id });
    replyLost = true;
    const lost = await patch(own.id, null), retried = await patch(own.id, null);
    expect({ lost: lost.status, retried: retried.status, parent: parentOf(own.id) }).toEqual({ lost: 503, retried: 200, parent: null });
    expect(labels.at(-1)).toEqual({ thread: own.id, parent: null, local: lead.id });
    expect(parentOf(own.id)).toBeNull();
    expect((await patch(own.id, lead.id)).status).toBe(200);
    expect(parentOf(own.id)).toBe(lead.id);
    const service = cloudroom(harness.deps) as unknown as { childTurnEnded?: (child: { id: string; parentThreadId: string }, status: string) => void; tellLocalParent(threadId: string, status: string, turn: string): void; noticeCloudParent(threadId: string, status: string, turn: string): Promise<void> };
    const reports = vi.fn();
    service.childTurnEnded = reports;
    service.tellLocalParent(own.id, "completed", "turn-1");
    expect(reports).toHaveBeenCalledWith(expect.objectContaining({ id: own.id, parentThreadId: lead.id }), "completed");
    expect((await patch(own.id, cloudParent.id)).status).toBe(200);
    expect(parentOf(own.id)).toBe(cloudParent.id);

    const moved = await patch(shared.id, lead.id);
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ message: "Only a Cloud thread in its own sandbox can move under another parent. Clear its parent (--clear-parent-thread) to make it top-level." });
    expect(parentOf(shared.id)).toBe(cloudParent.id);
    expect((await patch(shared.id, cloudParent.id)).status).toBe(200);
    expect((await patch(shared.id, null)).status).toBe(200);
    expect(parentOf(shared.id)).toBeNull();
    const topLevel = await patch(shared.id, lead.id);
    expect(topLevel.status).toBe(409);
    expect(await topLevel.json()).toMatchObject({ message: "Only a Cloud thread in its own sandbox can get a parent." });
    const owner = await patch(cloudParent.id, shared.id);
    expect({ status: owner.status, body: await owner.json() }).toMatchObject({ status: 409, body: { message: "A Cloud thread can't move under a thread that shares its sandbox." } });
    const vm = cloud(lead.id);
    harness.db.insert(cloudroomThreads).values({ threadId: vm.id, coreUrl: "http://127.0.0.1:9", sessionId: "cr_vm", startRequestId: "start_vm", model: "test-model", reasoning: "medium" }).run();
    expect((await patch(vm.id, lead.id)).status).toBe(200);
    const cleared = await patch(vm.id, null);
    expect(cleared.status).toBe(409);
    expect(await cleared.json()).toMatchObject({ message: "A thread on your cloud VM can't change its parent." });
    expect(parentOf(vm.id)).toBe(lead.id);
    const other = cloud();
    harness.db.insert(cloudroomThreads).values({ threadId: other.id, coreUrl: `sandbox:${other.id}`, sessionId: "cr_other", startRequestId: "start_other", model: "test-model", reasoning: "medium", accountId: "22222222-2222-4222-8222-222222222222" }).run();
    const crossAccount = await patch(own.id, other.id);
    expect({ status: crossAccount.status, body: await crossAccount.json() }).toMatchObject({ status: 409, body: { code: "cloudroom_other_account" } });

    const notices = (id: string) => harness.db.select().from(cloudroomCommands).all().filter(row => row.threadId === id).map(row => JSON.parse(row.input).text);
    harness.db.insert(cloudroomCommands).values({ id: `first_${own.id}`, threadId: own.id, command: "prompt", input: JSON.stringify({ text: "Start", parent_thread: cloudParent.id }), state: "completed", createdAt: 1 }).run();
    await service.noticeCloudParent(own.id, "completed", "turn-2");
    expect(notices(cloudParent.id)).toEqual([]);
    expect((await patch(own.id, shared.id)).status).toBe(200);
    await service.noticeCloudParent(own.id, "completed", "turn-3");
    expect(notices(shared.id)).toEqual([expect.stringContaining(`Child thread ${own.id} completed`)]);
  } finally { cloudroom(harness.deps).stop(); website.close(); await harness.cleanup(); }
});

it("keeps each queued follow-up's reasoning and rejects locked or conflicting changes", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const prompts: object[] = [];
  let promptReasoning = false;
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  let sid = "";
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: sid, kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, ...(promptReasoning ? { prompt_reasoning: true } : {}), harnesses: [{ id: "codex", model: "test-model", models: [{ model: "test-model", reasoning_levels: ["medium", "high", "xhigh", "max"] }] }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const [index, value] of records.entries()) if (index + 1 > after) res.write(`id: ${index + 1}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/v1/sessions") {
      sid = "cr_reasoning";
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: sid, receipt: { request_id: body.request_id, command: "start", state: "completed", input: {} }, saving: {} }, 202);
    }
    prompts.push(body);
    const receipt = { request_id: body.request_id, command: "prompt", state: "accepted", input: { text: body.text, ...(body.reasoning ? { reasoning: body.reasoning } : {}) } };
    record("receipt", receipt);
    if (body.request_id.startsWith("first_")) { record("state", { state: "starting_turn", request_id: body.request_id }); record("receipt", { ...receipt, state: "completed" }); record("state", { state: "idle" }); }
    json({ session_id: sid, receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const send = (threadId: string, body: object) => harness.app.request(`/api/v1/threads/${threadId}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId: "reason-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "start", mentions: [] }] }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = await created.json();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    const text = [{ type: "text", text: "queued", mentions: [] }];
    expect((await send(thread.id, { requestId: "same-launch", mode: "auto", reasoningLevel: "high", input: text })).status).toBe(200);
    await expect.poll(() => prompts.at(-1)).toEqual({ request_id: "same-launch", text: "queued" });
    expect((await send(thread.id, { requestId: "needs-core", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(409);
    expect(prompts.some((body) => (body as { request_id?: string }).request_id === "needs-core")).toBe(false);
    promptReasoning = true;
    expect((await send(thread.id, { requestId: "max-turn", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(200);
    expect((await send(thread.id, { requestId: "xhigh-turn", mode: "auto", reasoningLevel: "xhigh", input: text })).status).toBe(200);
    await expect.poll(() => prompts.map((body) => (body as { reasoning?: string }).reasoning)).toEqual([undefined, undefined, "max", "xhigh"]);
    expect(service.queue(thread.id).map((item) => item.reasoningLevel)).toEqual(["max", "xhigh"]);
    expect(service.threadStatus(thread.id)?.reasoning).toBe("xhigh");
    expect((await send(thread.id, { requestId: "max-turn", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(200);
    expect(prompts).toHaveLength(4);
    expect((await send(thread.id, { requestId: "max-turn", mode: "auto", reasoningLevel: "high", input: text })).status).toBe(409);
    expect((await send(thread.id, { mode: "auto", model: "other-model", reasoningLevel: "max", input: text })).status).toBe(409);
    expect((await send(thread.id, { mode: "auto", reasoningLevel: "low", input: text })).status).toBe(400);
    expect((await send(thread.id, { requestId: "plain", mode: "auto", input: text })).status).toBe(200);
    await expect.poll(() => prompts.at(-1)).toEqual({ request_id: "plain", text: "queued", reasoning: "xhigh" });
    record("state", { state: "starting_turn", request_id: "same-launch" });
    record("state", { state: "starting_turn", request_id: "max-turn" });
    record("state", { state: "starting_turn", request_id: "xhigh-turn" });
    await expect.poll(() => harness.db.select().from(events).all().filter((event) => event.type === "client/turn/requested").map((event) => JSON.parse(event.data).execution.reasoningLevel)).toEqual(["high", "high", "max", "xhigh"]);
    expect(service.threadStatus(thread.id)?.reasoning).toBe("xhigh");
    expect(harness.db.select().from(cloudroomThreads).get()?.reasoning).toBe("high");
    harness.deps.db.insert(cloudroomCommands).values({ id: "legacy-launch", threadId: thread.id, command: "prompt", input: JSON.stringify({ text: "queued", reasoning: "high" }), state: "sending", createdAt: Date.now() }).run();
    expect((await send(thread.id, { requestId: "legacy-launch", mode: "auto", reasoningLevel: "high", input: text })).status).toBe(200);
    await expect.poll(() => prompts.at(-1)).toMatchObject({ request_id: "legacy-launch", text: "queued", reasoning: "high" });
    expect((await send(thread.id, { requestId: "legacy-launch", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(409);
    record("receipt", { request_id: "plain", command: "prompt", state: "failed", error: "Pi model does not support the selected thinking level" });
    await expect.poll(() => harness.db.select().from(events).all().some((event) => event.type === "system/error" && JSON.parse(event.data).message.includes("thinking level"))).toBe(true);
    // Core restarts a killed agent idle and keeps the cause on the lost turn.
    record("receipt", { request_id: "xhigh-turn", command: "prompt", state: "unknown_after_restart", error: "invalid native state: unmanaged Claude subagent emitted output (signal 9)" });
    await expect.poll(() => harness.db.select().from(events).all().some((event) => event.type === "system/error" && JSON.parse(event.data).message.includes("unmanaged Claude subagent"))).toBe(true);
  } finally {
    service.stop();
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await harness.cleanup();
  }
});

it("shows a Cloud follow-up in the chat at once, like Local, and queues the next one", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const prompts: string[] = [];
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: "cr_smooth", kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const [index, value] of records.entries()) if (index + 1 > after) res.write(`id: ${index + 1}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/v1/sessions") {
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: "cr_smooth", receipt: { request_id: body.request_id, command: "start", state: "completed", input: {} }, saving: {} }, 202);
    }
    prompts.push(body.request_id);
    const receipt = { request_id: body.request_id, command: "prompt", state: "accepted", input: { text: body.text } };
    record("receipt", receipt);
    if (body.request_id.startsWith("first_")) { record("state", { state: "starting_turn", request_id: body.request_id }); record("receipt", { ...receipt, state: "completed" }); record("state", { state: "idle" }); }
    json({ session_id: "cr_smooth", receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const send = async (threadId: string, text: string) => (await harness.app.request(`/api/v1/threads/${threadId}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: text, mode: "auto", input: [{ type: "text", text, mentions: [] }] }) })).json();
  const chat = () => harness.db.select().from(events).all().filter((event) => event.type === "client/turn/requested").map((event) => JSON.parse(event.data).input[0].text);
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId: "smooth-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "start", mentions: [] }] }) });
    const thread = await created.json();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(await send(thread.id, "now")).toMatchObject({ delivery: "sent" });
    expect(getThread(harness.db, thread.id)?.status).toBe("active");
    expect(chat()).toEqual(["start", "now"]);
    expect(service.queue(thread.id)).toEqual([]);
    expect(await send(thread.id, "next")).toMatchObject({ delivery: "queued" });
    expect(service.queue(thread.id).map((item) => item.id)).toEqual(["next"]);
    await expect.poll(() => prompts.slice(1)).toEqual(["now", "next"]);
    record("state", { state: "resuming" });
    record("state", { state: "idle" });
    await expect.poll(() => harness.db.select().from(cloudroomThreads).get()?.cursor).toBe(records.length);
    expect(getThread(harness.db, thread.id)?.status).toBe("active");
    record("state", { state: "starting_turn", request_id: "now" });
    await expect.poll(() => harness.db.select().from(cloudroomCommands).all().find((command) => command.id === "now")?.state).toBe("running");
    expect(chat()).toEqual(["start", "now"]);
    expect(service.queue(thread.id).map((item) => item.id)).toEqual(["next"]);
  } finally {
    service.stop();
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await harness.cleanup();
  }
});

it("credits Claude usage that arrives after a follow-up was sent to the turn that used it", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: "cr_usage", kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "claude-code", model: "test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const [index, value] of records.entries()) if (index + 1 > after) res.write(`id: ${index + 1}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/v1/sessions") {
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: "cr_usage", receipt: { request_id: body.request_id, command: "start", state: "completed", input: {} }, saving: {} }, 202);
    }
    const receipt = { request_id: body.request_id, command: "prompt", state: "accepted", input: { text: body.text } };
    record("receipt", receipt);
    if (body.request_id.startsWith("first_")) { record("state", { state: "starting_turn", request_id: body.request_id }); record("receipt", { ...receipt, state: "completed" }); record("state", { state: "idle" }); }
    json({ session_id: "cr_usage", receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const send = async (threadId: string, text: string) => (await harness.app.request(`/api/v1/threads/${threadId}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: text, mode: "auto", input: [{ type: "text", text, mentions: [] }] }) })).json();
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId: "usage-start", projectId: project.id, providerId: "claude-code", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "start", mentions: [] }] }) });
    const thread = await created.json();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(await send(thread.id, "one")).toMatchObject({ delivery: "sent" });
    record("state", { state: "starting_turn", request_id: "one" });
    record("receipt", { request_id: "one", command: "prompt", state: "completed" });
    record("state", { state: "idle" });
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(await send(thread.id, "two")).toMatchObject({ delivery: "sent" });
    record("usage", { contextUsage: { tokens: 128, contextWindow: 100000 }, tokens: { input: 100, output: 28, total: 128 }, lastUsage: { input: 100, output: 28, totalTokens: 128 } });
    await expect.poll(() => harness.db.select().from(cloudroomThreads).get()!.cursor >= records.findIndex((value) => (value as { kind: string }).kind === "usage") + 1).toBe(true);
    expect(harness.db.select().from(events).all().filter((event) => event.type === "thread/tokenUsage/updated").map((event) => event.turnId)).toEqual(["one"]);
    expect(service.threadStatus(thread.id)?.error ?? null).toBeNull();
  } finally {
    service.stop();
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await harness.cleanup();
  }
});

it("queues Cloud follow-ups at once while the cloud is still starting, then delivers them in order", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const prompts: string[] = [];
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  let release = () => {};
  let starting: Promise<void> | null = null;
  let holdCapabilities = false;
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: "cr_slow", kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") {
      if (holdCapabilities && starting) await starting;
      return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    }
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const [index, value] of records.entries()) if (index + 1 > after) res.write(`id: ${index + 1}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/v1/sessions") {
      if (starting) await starting;
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: "cr_slow", receipt: { request_id: body.request_id, command: "start", state: "completed", input: {} }, saving: {} }, 202);
    }
    prompts.push(body.request_id);
    const receipt = { request_id: body.request_id, command: "prompt", state: "accepted", input: { text: body.text } };
    record("receipt", receipt);
    json({ session_id: "cr_slow", receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const send = async (threadId: string, text: string) => (await harness.app.request(`/api/v1/threads/${threadId}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: text, mode: "auto", input: [{ type: "text", text, mentions: [] }] }) })).json();
  const quick = <T,>(work: Promise<T>) => Promise.race([work, new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1500))]);
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    starting = new Promise((resolve) => { release = resolve; });
    const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId: "slow-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "start", mentions: [] }] }) });
    const thread = await created.json();
    holdCapabilities = true;
    expect(getThread(harness.db, thread.id)?.status).toBe("pending");
    expect(await quick(send(thread.id, "second"))).toMatchObject({ delivery: "queued" });
    expect(await quick(send(thread.id, "third"))).toMatchObject({ delivery: "queued" });
    expect(service.queue(thread.id).map((item) => item.id)).toEqual(["second", "third"]);
    expect(prompts).toEqual([]);
    release();
    await expect.poll(() => prompts, { timeout: 5000 }).toEqual([`first_${thread.id}`, "second", "third"]);
  } finally {
    release();
    service.stop();
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await harness.cleanup();
  }
});

it.each(["codex", "pi"])("edits and cancels queued Cloud %s prompts, then steers, compacts, and rewinds through core", async (providerId) => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  const commands: object[] = [];
  const sid = "cr_features";
  let holdPrompts = false;
  const input = (text: string) => [{ type: "text", text, mentions: [] }, { type: "localImage", path: "image.png" }, { type: "localFile", path: "note.txt" }];
  const attachmentRoot = join(harness.config.dataDir, "attachments", project.id);
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(join(attachmentRoot, "image.png"), "image bytes");
  await writeFile(join(attachmentRoot, "note.txt"), "file bytes");
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: sid, kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({
      version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true,
      structured_prompt: true, attachments: true, queue_edit: true, queue_cancel: true, steer: true, rewind: true, compact: true,
      harnesses: [{ id: providerId, provider: "fixture", model: "test-model", service_tier: true, steer: true, compact: true, rewind: true }],
    });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const [index, value] of records.entries()) if (index + 1 > after) res.write(`id: ${index + 1}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = ""; for await (const chunk of req) text += chunk;
    if (req.url?.includes("/attachments?")) {
      const query = new URL(req.url, "http://fixture").searchParams;
      const id = query.get("request_id");
      expect(text).toBe(query.get("kind") === "image" ? "image bytes" : "file bytes");
      return json({ session_id: sid, receipt: { request_id: id, command: "attach", state: "completed", input: { id, path: `/code/test/.cloudroom/attachments/${id}/${query.get("name")}` } }, saving: {} }, 202);
    }
    const body = text ? JSON.parse(text) : {};
    commands.push({ url: req.url, ...body });
    if (req.url === "/v1/sessions") {
      record("native_identity", { id: "native" });
      record("state", { state: "idle" });
      return json({ session_id: sid, receipt: { request_id: body.request_id, command: "start", state: "completed", input: {} }, saving: {} }, 202);
    }
    if (holdPrompts && String(req.url).endsWith("/prompts")) return json({ error: "waking" }, 503);
    if (String(req.url).endsWith("/edit") && body.text === "rejected edit") return json({ error: "already dispatched" }, 409);
    if (String(req.url).endsWith("/steer") && String(body.text).includes("too late")) return json({ error: "steer target is no longer the active request", code: "request_rejected" }, 409);
    const path = String(req.url ?? "");
    const command = path.endsWith("/prompts") ? "prompt" : path.split("/").pop() ?? "unknown";
    const receipt = { request_id: body.request_id, command, state: "accepted", input: body };
    record("receipt", receipt);
    if (command === "prompt" && String(body.request_id).startsWith("first_")) {
      record("state", { state: "starting_turn", request_id: body.request_id });
      record("checkpoint", { kind: "turn", id: `turn-${body.request_id}`, request_id: body.request_id });
      record("state", { state: "running", request_id: body.request_id });
    }
    json({ session_id: sid, receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const request = (path: string, body?: unknown, method = "POST") => harness.app.request(`/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const created = await request("/threads", { executionTarget: "cloud", requestId: "feature-start", projectId: project.id, providerId, origin: "app", model: providerId === "pi" ? "fixture/test-model" : "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: input("start") });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = await created.json();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    expect((await request(`/threads/${thread.id}/send`, { requestId: "queued-1", mode: "auto", input: input("old") })).status).toBe(200);
    await expect.poll(() => service.queue(thread.id)).toEqual([expect.objectContaining({ id: "queued-1", content: input("old") })]);
    await expect.poll(() => command(harness.db, "queued-1")?.state).toBe("accepted");
    const queued = service.queue(thread.id)[0]!;
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, { input: input("rejected edit"), expectedUpdatedAt: queued.updatedAt }, "PATCH")).status).toBeGreaterThanOrEqual(400);
    expect(service.queue(thread.id)[0]).toMatchObject({ content: queued.content, updatedAt: queued.updatedAt });
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, { input: input("new"), expectedUpdatedAt: queued.updatedAt - 1 }, "PATCH")).status).toBe(409);
    const edited = await request(`/threads/${thread.id}/queued-messages/${queued.id}`, { input: input("new"), expectedUpdatedAt: queued.updatedAt }, "PATCH");
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(service.queue(thread.id)[0]?.content).toEqual(input("new"));
    const confirmedRevision = service.queue(thread.id)[0]!.updatedAt;
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, { input: input("new"), expectedUpdatedAt: queued.updatedAt }, "PATCH")).status).toBe(200);
    expect(service.queue(thread.id)[0]!.updatedAt).toBe(confirmedRevision);
    expect((await request(`/threads/${thread.id}/send`, { requestId: "queued-1", mode: "auto", input: queued.content })).status).toBe(200);
    expect(service.queue(thread.id)[0]?.content).toEqual(input("new"));
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, undefined, "DELETE")).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/cancel"))).toBe(true);
    await expect.poll(() => service.queue(thread.id)).toEqual([]);
    holdPrompts = true;
    expect((await request(`/threads/${thread.id}/send`, { requestId: "queued-2", mode: "auto", input: input("draft") })).status).toBe(200);
    const waiting = service.queue(thread.id).find((item) => item.id === "queued-2")!;
    expect(command(harness.db, "queued-2")?.state).toBe("sending");
    expect(waiting.editable).toBe(true);
    const offline = await request(`/threads/${thread.id}/queued-messages/queued-2`, { input: input("final"), expectedUpdatedAt: waiting.updatedAt }, "PATCH");
    expect(offline.status, await offline.clone().text()).toBe(200);
    expect(service.queue(thread.id).find((item) => item.id === "queued-2")?.content).toEqual(input("final"));
    holdPrompts = false;
    const sentTo = (name: string) => commands.findIndex((item) => { const sent = item as { url?: string; request_id?: string; target_request_id?: string }; return Boolean(sent.url?.endsWith(name)) && (sent.request_id === "queued-2" || sent.target_request_id === "queued-2"); });
    await expect.poll(() => sentTo("/edit")).toBeGreaterThan(-1);
    expect(sentTo("/prompts")).toBeGreaterThan(-1);
    expect(sentTo("/prompts")).toBeLessThan(sentTo("/edit"));
    expect(service.queue(thread.id).find((item) => item.id === "queued-2")?.content).toEqual(input("final"));
    expect((await request(`/threads/${thread.id}/queued-messages/queued-2`, undefined, "DELETE")).status).toBe(200);
    await expect.poll(() => service.queue(thread.id)).toEqual([]);
    expect((await request(`/threads/${thread.id}/send`, { requestId: "steer-1", mode: "steer", input: [{ type: "text", text: "course correct", mentions: [] }] })).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/steer"))).toBe(true);
    // A refused steer, here because its turn just ended, is queued instead of blocking every command behind it.
    expect((await request(`/threads/${thread.id}/send`, { requestId: "steer-late", mode: "steer", input: [{ type: "text", text: "too late", mentions: [] }] })).status).toBe(200);
    await expect.poll(() => commands.some((item) => { const sent = item as { url?: string; text?: string }; return Boolean(sent.url?.endsWith("/prompts") && sent.text?.includes("too late")); })).toBe(true);
    expect(command(harness.db, "steer-late")?.state).toBe("failed");
    const late = service.queue(thread.id);
    expect(late).toHaveLength(1);
    expect((await request(`/threads/${thread.id}/queued-messages/${late[0]!.id}`, undefined, "DELETE")).status).toBe(200);
    await expect.poll(() => service.queue(thread.id)).toEqual([]);
    record("state", { state: "idle" });
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect((await request(`/threads/${thread.id}/compact`, {})).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/compact"))).toBe(true);
    await service.control(thread.id, "stop");
    await expect.poll(() => service.threadStatus(thread.id)?.paused).toBe(true);
    const requested = harness.db.select().from(events).all().find((event) => event.type === "client/turn/requested");
    expect((await request(`/threads/${thread.id}/edit-message`, { operationId: "edit-1", input: input("rewritten"), expectedRequestSequence: requested?.sequence })).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/rewind"))).toBe(true);
    // Editing after Stop must not leave the replacement stuck behind a paused queue.
    expect(commands.map((item) => (item as { url?: string }).url?.split("/").pop()).filter((name) => name === "resume" || name === "rewind")).toEqual(["resume", "rewind"]);
    expect(commands.some((item) => (item as { url?: string; text?: string }).url?.endsWith("/prompts") && (item as { text?: string }).text === "rewritten")).toBe(false);
    const rewind = commands.find((item) => (item as { url?: string }).url?.endsWith("/rewind")) as { request_id: string; before: string; replacement: { request_id: string; text: string; content: unknown } };
    expect(rewind.replacement.text).toBe("rewritten");
    record("rewind", { id: "corrected-native", request_id: rewind.request_id, before: rewind.before, replacement: { request_id: rewind.replacement.request_id, input: rewind.replacement } });
    record("state", { state: "starting_turn", request_id: rewind.replacement.request_id });
    await expect.poll(() => harness.db.select().from(events).all().filter((event) => event.type === "client/turn/requested").map((event) => JSON.parse(event.data).input[0].text)).toEqual(["rewritten"]);
    expect((await request(`/threads/${thread.id}/edit-message`, { operationId: "edit-1", input: input("rewritten"), expectedRequestSequence: requested?.sequence })).status).toBe(200);
    expect(commands.filter((item) => (item as { url?: string }).url?.endsWith("/rewind"))).toHaveLength(1);
    for (const sent of commands) {
      const command = sent as { url: string; content?: unknown; attachments?: { kind: string; path: string }[]; replacement?: { content?: unknown; attachments?: { kind: string; path: string }[] } };
      const payload = command.replacement ?? command;
      if (!payload.attachments?.length) continue;
      expect(payload.content).toEqual([expect.objectContaining({ type: "text" })]);
      expect(payload.attachments.map(part => part.kind)).toEqual(["image", "file"]);
      expect(payload.attachments.every(part => part.path.startsWith("/code/test/.cloudroom/attachments/"))).toBe(true);
    }
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>((resolve) => core.close(() => resolve())); await harness.cleanup();
  }
});

it("shows Teleport the moment it starts, and never leaves a failed or interrupted check stuck", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id });
  const thread = seedThread(harness.deps, { projectId: project.id, environmentId: environment.id });
  seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId: "native-1", model: "test-model" });
  const service = cloudroom(harness.deps);
  const heldChecks: ((body: unknown) => void)[] = [];
  const core = createServer(async (req, res) => {
    const json = (body: unknown) => { res.writeHead(req.method === "POST" ? 202 : 200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/test", stop: true, resume: true, launch_settings: true, teleport: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url === "/v1/teleports/check") return void heldChecks.push(json);
    res.writeHead(404); res.end();
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const api = (path: string, body?: unknown) => harness.app.request(`/api/v1${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const phase = async () => ((await (await api(`/threads/${thread.id}`)).json()) as { teleport?: { phase: string } }).teleport?.phase;
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40) });
    const started = api(`/cloudroom/threads/${thread.id}/teleport`, { action: "start" });
    await vi.waitFor(() => expect(heldChecks).toHaveLength(1));
    expect(await phase()).toBe("checking");
    teleports(harness.deps).recover();
    expect(await phase()).toBe("checking");
    expect((await api(`/cloudroom/threads/${thread.id}/teleport`, { action: "start" })).status).toBe(409);
    heldChecks[0]!({ ok: false, code: "model_unavailable", error: "Cloud cannot run test-model." });
    expect((await started).status).toBe(409);
    expect(await phase()).toBe("cancelled");
    expect(getThread(harness.db, thread.id)?.executionTarget).not.toBe("cloud");

    saveTeleportProgress(harness.db, thread.id, { id: "interrupted", owner: thread.id, phase: "checking", completed: 0, total: 0 });
    teleports(harness.deps).recover();
    expect(await phase()).toBe("cancelled");

    const stopped = api(`/cloudroom/threads/${thread.id}/teleport`, { action: "start" });
    await vi.waitFor(() => expect(heldChecks).toHaveLength(2));
    teleports(harness.deps).abandon(thread.id);
    heldChecks[1]!({ ok: true });
    const response = await stopped;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "teleport_interrupted", message: expect.stringContaining("stopped or archived") });

    harness.db
      .insert(events)
      .values({
        id: "big",
        threadId: thread.id,
        scopeKind: "thread",
        sequence: 99,
        type: "item/completed",
        data: JSON.stringify({ text: "x".repeat(64 * 1024 * 1024) }),
        createdAt: 0,
      })
      .run();
    for (const action of ["check", "start"])
      expect(
        await (
          await api(`/cloudroom/threads/${thread.id}/teleport`, { action })
        ).json(),
      ).toMatchObject({ code: "teleport_history_size" });
    expect(heldChecks).toHaveLength(2);
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>((resolve) => core.close(() => resolve())); await harness.cleanup();
  }
});

it("Remove stops copying an agent's login and hides it until Add back; unknown or login-less agents are refused", async () => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const post = (path: string, body: unknown = {}) => harness.app.request(`/api/v1/cloudroom/account/agents/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const settings = async () => (await (await harness.app.request("/api/v1/system/config")).json() as { generalSettings: { hiddenProviderIds: string[]; defaultProviderId: string | null } }).generalSettings;
  try {
    expect((await post("nope/disconnect")).status).toBe(404);
    expect((await post("pi/disconnect")).status).toBe(400);
    await harness.app.request("/api/v1/settings/general", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...await settings(), defaultProviderId: "pi" }) });
    expect((await settings()).defaultProviderId).toBe("pi");

    expect((await post("pi/disconnect", { remove: true })).status).toBe(200);
    expect(await service.sandboxes.skipLogins()).toContain("pi");
    expect(await settings()).toMatchObject({ hiddenProviderIds: ["pi"] });
    expect((await settings()).defaultProviderId).not.toBe("pi");

    expect((await post("pi/restore")).status).toBe(200);
    expect(await service.sandboxes.skipLogins()).not.toContain("pi");
    expect(await settings()).toMatchObject({ hiddenProviderIds: [] });
  } finally {
    service.stop(); await harness.cleanup();
  }
});

/** A fake website that keeps the account's logins in memory. `refuse` answers every removal with an error. */
async function fakeLoginsWebsite(refuse = false) {
  const logins = new Map<string, string>();
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { action?: string; name: string; value?: string };
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (body.action === "remove") {
      if (refuse) return reply(400, { error: "Invalid login." });
      logins.delete(body.name);
      return reply(200, { removed: true });
    }
    logins.set(body.name, body.value ?? "");
    reply(200, { saved: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return { logins, account: { website: `http://127.0.0.1:${address.port}`, userId: "user", token: "token" }, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

it("Disconnect changes nothing when the website refuses to remove the login", async () => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const website = await fakeLoginsWebsite(true);
  (service.sandboxes as { account: () => Promise<unknown> }).account = async () => website.account;
  try {
    const response = await harness.app.request("/api/v1/cloudroom/account/agents/pi/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remove: true }) });
    expect(response.status).toBe(503);
    expect(await sync.loginMarkers(harness.deps)).toEqual({});
    expect((await (await harness.app.request("/api/v1/system/config")).json() as { generalSettings: { hiddenProviderIds: string[] } }).generalSettings.hiddenProviderIds).toEqual([]);
  } finally {
    service.stop(); await website.close(); await harness.cleanup();
  }
});

it("a background login save never brings back a login Disconnect removed, whether it starts before or during it", async () => {
  const website = await fakeLoginsWebsite();
  const sandboxes = new SandboxDirectory(async () => website.account);
  const skip = new Set<string>();
  sandboxes.skipLogins = async () => skip;
  try {
    await sandboxes.saveLogin("claude", "first");
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const before = sandboxes.saveLogin("claude", "before", undefined, true);
    const disconnect = sandboxes.withLogins(async () => { skip.add("claude"); await gate; await sandboxes.removeLogin("claude"); });
    const during = sandboxes.saveLogin("claude", "during", undefined, true);
    release();
    await disconnect;
    expect([await before, await during]).toEqual([true, false]);
    expect(website.logins.has("claude")).toBe(false);
  } finally {
    await website.close();
  }
});

it("concurrent Disconnects keep every marker", async () => {
  const harness = await createTestAppHarness();
  try {
    await Promise.all(["codex", "claude", "pi", "opencode"].map(name => sync.markLogin(harness.deps, name, "blocked")));
    expect(Object.keys(await sync.loginMarkers(harness.deps)).sort()).toEqual(["claude", "codex", "opencode", "pi"]);
  } finally {
    await harness.cleanup();
  }
});
