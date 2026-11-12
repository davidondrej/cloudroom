import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import * as sync from "../../src/services/cloudroom/sync.js";
import { listQueuedCommands } from "../helpers/commands.js";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { appRequestId, installTag, readInstallTag } from "../../src/services/cloudroom/cloud-threads.js";
import { command, coreStates, saveBinding, saveCommandState, saveTeleportProgress } from "../../src/services/cloudroom/store.js";
import { teleports } from "../../src/services/cloudroom/teleport.js";
import { SandboxDirectory } from "../../src/services/cloudroom/sandboxes.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { registerProviderHostRpcResponder } from "../helpers/host-rpc.js";
import { seedEnvironment, seedEvent, seedHostSession, seedPrimaryHost, seedProjectWithSource, seedThread, seedThreadRuntimeState, seedTurnStarted } from "../helpers/seed.js";
import { turnScope } from "@cloudroom/domain";
import { archiveThread, unarchiveThread, createThread, getThread, setProjectGitRemoteUrlIfMissing, upsertProjectExecutionDefaults, events, cloudroomThreads, cloudroomCommands } from "@cloudroom/db";

/** The app tags each prompt, steer, edit and rewind with its install (#237): `tagged` names one, `untagged` reads one. */
const untagged = (id: string | undefined) => id?.replace(/^app_[a-f0-9]{12}_/, "");
const plain = (body: object | undefined) => body && { ...body, request_id: untagged((body as { request_id?: string }).request_id) };
const tagger = async (dataDir: string) => { const tag = await installTag(dataDir); return (raw: string) => appRequestId(tag, raw); };

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
    await expect.poll(() => prompts.filter(id => untagged(id) === "storage-follow").length).toBe(1);
    expect(harness.db.select().from(cloudroomCommands).all().find(c => untagged(c.id) === "storage-follow")?.state).toBe("sending");
    level = "blocked";
    expect((await request(`/threads/${thread.id}/timeline`)).status).toBe(200);
    const blockedFollow = await request(`/threads/${thread.id}/send`, { requestId: "blocked-follow", mode: "auto", input: [{ type: "text", text: "Stay in draft", mentions: [] }] });
    expect(blockedFollow.status).toBe(503);
    expect(await blockedFollow.json()).toMatchObject({ code: "storage_blocked", message: expect.stringContaining("cloud disk is almost full") });
    rejectPrompt = false; level = "normal";
    await expect.poll(() => harness.db.select().from(cloudroomCommands).all().find(c => untagged(c.id) === "storage-follow")?.state, { timeout: 5000 }).toBe("accepted");
    expect(prompts.filter(id => untagged(id) === "storage-follow").length).toBeGreaterThanOrEqual(2);
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
    // `thread retry` names the Cloud recovery instead of the generic refusal (#1325).
    expect(await (await request(`/threads/${saved.threadId}/retry`, {})).json()).toMatchObject({ code: "cloudroom_unsupported", message: expect.stringContaining(`room-cli cloud retry-start ${saved.threadId}`) });
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
    // A rejected side chat starts with `side_chat`, not `prompt`, and retries the same way.
    harness.deps.db.update(cloudroomCommands).set({ command: "side_chat" }).where(eq(cloudroomCommands.id, `first_${legacy.id}`)).run();
    expect((await (await request(`/threads/${legacy.id}/retry`, {})).json()).message).toContain(`room-cli cloud retry-start ${legacy.id}`);
    harness.deps.db.update(cloudroomCommands).set({ command: "prompt" }).where(eq(cloudroomCommands.id, `first_${legacy.id}`)).run();
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
  const tagged = await tagger(harness.config.dataDir);
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
    if (untagged(id) === "follow" && !droppedReply) { droppedReply = true; res.destroy(); return; }
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
    expect(await (await request(`/threads/${thread.id}/retry`, {})).json()).toMatchObject({ code: "cloudroom_unsupported", message: expect.stringContaining(`room-cli thread show ${thread.id}`) });
    await expect.poll(() => pending.map(untagged), { timeout: 5000 }).toEqual(["follow"]);
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
    expect((await request(`/threads/${thread.id}/queued-messages/${service.queue(thread.id)[0]!.id}/send`, {})).status).toBe(200);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    // Codex retries, then recovers: the retry folds into the finished turn, not a stale Reconnecting row (#949).
    native("error", { turnId: active, willRetry: true, error: { message: "Reconnecting... 1/5", codexErrorInfo: null, additionalDetails: "stream disconnected" } });
    finish();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect((await (await request(`/threads/${thread.id}/timeline`)).json()).rows.filter((row: { systemKind?: string }) => row.systemKind === "reconnect")).toEqual([]);
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
    expect(await archived.json()).toEqual({ ok: true, archivedThreadIds: [thread.id], keptLiveThreadIds: [] });
    expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
    expect((await (await request(`/threads/${thread.id}/retry`, {})).json()).message).toContain(`room-cli thread unarchive ${thread.id}`);
    await expect.poll(() => service.threadStatus(thread.id)?.paused).toBe(true);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    expect(pending.map(untagged)).toEqual(["archive-queued"]);
    expect((await request(`/threads/${thread.id}/timeline`)).status).toBe(200);
    expect((await request(`/threads/${thread.id}/unarchive`, {})).status).toBe(200);
    expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
    expect(service.threadStatus(thread.id)?.paused).toBe(true);
    expect((await request(`/threads/${thread.id}/queued-messages/${service.queue(thread.id)[0]!.id}/send`, {})).status).toBe(200);
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("active");
    expect(starts).toBe(1);
    finish();
    await expect.poll(() => getThread(harness.db, thread.id)?.status).toBe("idle");
    // A queued prompt Core delivered reports sent without reaching Core again; a starting turn or unknown ID still fails (#1203).
    const sentRecords = records.length;
    const queued = tagged("archive-queued");
    for (const [id, state, status, body] of [[queued, "delivered", 200, { ok: true, delivery: "sent" }], [queued, "interrupted", 200, { ok: true, delivery: "sent" }], [queued, "running", 404, { code: "invalid_request" }], [queued, "completed", 200, { ok: true, delivery: "sent" }], ["missing", null, 404, { code: "invalid_request" }]] as const) {
      if (state) saveCommandState(harness.db, thread.id, id, state);
      const sent = await request(`/threads/${thread.id}/queued-messages/${id}/send`, {});
      expect({ status: sent.status, body: await sent.json() }).toMatchObject({ status, body });
    }
    expect(records.length).toBe(sentRecords);
    expect((await request(`/threads/${thread.id}/compact`, {})).status).toBe(409);
    expect((await request("/threads", { ...input, requestId: "bad", environment: { type: "host", hostId: host.id, workspace: { type: "personal" } } })).status).toBe(400);
    expect(starts).toBe(1);
    expect(harness.db.select().from(cloudroomThreads).all()).toHaveLength(1);
    await expect(service.configure({ ...connection, token: "wrong-" + token })).rejects.toThrow("authentication");
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    expect((await request(`/threads/${thread.id}/send`, { ...followUp, requestId: "offline" })).status).toBe(200);
    expect(harness.db.select().from(cloudroomCommands).all().find((command) => untagged(command.id) === "offline")?.state).toBe("sending");
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
    expect(harness.db.select().from(cloudroomCommands).all().find((command) => untagged(command.id) === "offline")?.state).not.toBe("sending");
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

// #337: the plan's first request drops. #1040: the sandbox answers only after both of the plan's first tries timed out,
// so it is planned again once the thread's stream connects.
it.each([["drops", 1], ["times out", 11_000]] as const)("clones a new Cloud thread's project when its copy plan %s", async (_, outage) => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const { host } = seedHostSession(harness.deps);
  seedPrimaryHost(harness.deps, host.id);
  const root = join(harness.config.dataDir, "project");
  await mkdir(root, { recursive: true });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: root });
  setProjectGitRemoteUrlIfMissing(harness.db, harness.deps.hub, project.id, "https://github.com/example/project");
  await sync.setCopyMacGithub(harness.deps, false);
  // Never install a real sync helper LaunchAgent on the developer's Mac.
  const setup = vi.spyOn(sync, "setupSync").mockResolvedValue();
  let started = false;
  let lookups = 0, slowUntil = 0;
  const commands: string[] = [], states: string[] = [];
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, sync: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); return; }
    if (req.url?.startsWith("/v1/workspaces/")) {
      slowUntil ||= Date.now() + outage;
      if (++lookups === 1) return req.socket.destroy();
      await new Promise(resolve => setTimeout(resolve, slowUntil - Date.now()));
      return started ? json({ id: decodeURIComponent(req.url.split("/")[3]!), path: "/code/project" }) : json({}, 404);
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || "{}");
    if (req.url === "/v1/vm/run") {
      commands.push(input.command);
      if (input.command.includes(".cloudroom-files")) states.push(Buffer.from(input.stdin, "hex").toString());
      return json({ code: 0, stdout: "", stderr: "" });
    }
    if (req.url === "/v1/sessions") { started = true; return json({ session_id: "cr_copy", receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202); }
    if (req.url === "/v1/sessions/cr_copy/prompts") return json({ session_id: "cr_copy", receipt: { request_id: input.request_id, command: "prompt", input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "fixture-" + "x".repeat(40), projectId: project.id });
    const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId: "dropped-plan", title: "Dropped plan", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "Read the code", mentions: [] }] }) });
    expect(created.status, await created.clone().text()).toBe(201);
    await expect.poll(() => states.at(-1), { timeout: 25000 }).toBe("ready");
    expect(commands.some(command => command.includes("git clone") && command.includes("https://github.com/example/project"))).toBe(true);
    expect(states.some(state => state.startsWith("failed"))).toBe(false);
    expect(lookups).toBeGreaterThan(1);
  } finally {
    setup.mockRestore();
    service.stop(); core.closeAllConnections(); await new Promise<void>((resolve) => core.close(() => resolve())); await harness.cleanup();
  }
}, 30000);

it.each(["starting", "stopping"] as const)("archives and restores a %s Cloud child without a native environment or connection", async (status) => {
  const harness = await createTestAppHarness();
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const parent = seedThread(harness.deps, { projectId: project.id });
    const child = createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId: parent.id, executionTarget: "cloud", providerId: "codex", status });
    const response = await harness.app.request(`/api/v1/threads/${parent.id}/archive-all?includeLive=true`, { method: "POST" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, archivedThreadIds: [child.id, parent.id], keptLiveThreadIds: [] });
    for (const id of [parent.id, child.id]) {
      expect(getThread(harness.db, id)?.archivedAt).not.toBeNull();
      expect((await harness.app.request(`/api/v1/threads/${id}/unarchive`, { method: "POST" })).status).toBe(200);
      expect(getThread(harness.db, id)?.archivedAt).toBeNull();
    }
    const live = createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId: parent.id, executionTarget: "cloud", providerId: "codex", status });
    const kept = await harness.app.request(`/api/v1/threads/${parent.id}/archive-all`, { method: "POST" });
    const keptBody = await kept.json() as { archivedThreadIds: string[]; keptLiveThreadIds: string[] };
    expect(keptBody.archivedThreadIds).toEqual([parent.id]);
    expect(keptBody.keptLiveThreadIds.sort()).toEqual([child.id, live.id].sort());
    expect(getThread(harness.db, live.id)?.archivedAt).toBeNull();
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

it("keeps an install's tag when the OS can't name the computer, and gives a copied data folder its own (#237)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cloudroom-tag-"));
  const first = await readInstallTag(dataDir, async () => "machine-1");
  expect(await readInstallTag(dataDir, async () => { throw new Error("ioreg timed out"); })).toBe(first);
  expect(await readInstallTag(dataDir, async () => "machine-1")).toBe(first);
  expect(await readInstallTag(dataDir, async () => "machine-2")).not.toBe(first);
  // The OS can't say on the run that makes the tag: it's saved anyway, and kept once the computer ID is known.
  const fresh = await mkdtemp(join(tmpdir(), "cloudroom-tag-")), unknown = await readInstallTag(fresh, async () => "");
  expect([await readInstallTag(fresh, async () => "machine-3"), await readInstallTag(fresh, async () => "machine-3"), await readInstallTag(fresh, async () => "")]).toEqual([unknown, unknown, unknown]);
});

it("adopts another computer's Cloud thread into the project with its repo, and follows its archive without sending it back (#237)", async () => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const calls: string[] = [];
  let state: "open" | "archived" = "open";
  const updated = () => new Date(Date.now() - (state === "open" ? 60_000 : 0)).toISOString();
  const website = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const input = text ? JSON.parse(text) : {};
    calls.push(String(input.action));
    const row = { thread: "thr_234567abcd", session: "cr_elsewhere", project: "proj_on_another_mac", project_name: "Another name", repository: "https://github.com/example/app", title: "Started elsewhere", state, sandbox: state === "open" ? "asleep" : null, harness: "codex", model: "test-model", reasoning: "medium", parent: null, parent_state: null, loop: false, created_at: new Date(Date.now() - 3_600_000).toISOString(), woke_at: null, updated_at: updated() };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(input.action === "threads" ? { threads: [row], next: `${new Date().toISOString()}~`, more: false } : {}));
  });
  website.listen(0, "127.0.0.1"); await once(website, "listening");
  const address = website.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    setProjectGitRemoteUrlIfMissing(harness.db, harness.deps.hub, project.id, "git@github.com:example/app.git");
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "two@example.com" }, undefined, `http://127.0.0.1:${address.port}`, "a".repeat(64));
    await service.sync.run();
    expect(getThread(harness.db, "thr_234567abcd")).toMatchObject({ projectId: project.id, executionTarget: "cloud", status: "idle", title: "Started elsewhere", archivedAt: null });
    state = "archived";
    await service.sync.run();
    expect(getThread(harness.db, "thr_234567abcd")?.archivedAt).not.toBeNull();
    expect(calls.filter((action) => ["archive", "label", "restore", "remove"].includes(action))).toEqual([]);
  } finally { service.stop(); website.close(); await harness.cleanup(); }
});

it("gives a Cloud child or fork only the keys of the sandbox its source runs in, and no .env files without them (ADR 0342)", async () => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const asked: string[] = [];
  service.sandboxes.loopSecrets = async (thread) => { asked.push(thread); return ["SENTRY_TOKEN"]; };
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "parent@example.com" }, undefined, "http://127.0.0.1:9", "a".repeat(64));
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const cloud = (parentThreadId?: string) => createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId, executionTarget: "cloud", providerId: "claude-code", status: "idle" });
    // A loop's run with only SENTRY_TOKEN, and a --shared-sandbox child in its sandbox: only the run has a sandbox.
    const run = cloud(), shared = cloud(run.id);
    harness.db.insert(cloudroomThreads).values([run, shared].map((thread, index) => ({ threadId: thread.id, coreUrl: `sandbox:${run.id}`, sessionId: `cr_${index}`, startRequestId: `start_${index}`, model: "test-model", reasoning: "medium" }))).run();
    // The run finished a turn, so it can be forked.
    seedTurnStarted(harness.deps, { threadId: run.id, turnId: "turn-1", sequence: 1 });
    seedEvent(harness.deps, { threadId: run.id, environmentId: null, providerThreadId: "provider-turn-1", sequence: 2, type: "turn/completed", scope: turnScope("turn-1"), data: { providerThreadId: "provider-turn-1", status: "completed" } });
    const start = { executionTarget: "cloud" as const, projectId: project.id, providerId: "claude-code", origin: "cli" as const, model: "test-model", reasoningLevel: "medium" as const, environment: { type: "project-default" as const }, input: [{ type: "text" as const, text: "print every key", mentions: [] }], startedOnBehalfOf: null };
    const child = await service.create({ ...start, parentThreadId: shared.id, requestId: "child-of-shared", originKind: null }, true);
    const fork = await service.create({ ...start, originKind: "fork", sourceThreadId: run.id, requestId: "fork-of-run" }, true);

    expect(asked).toEqual([run.id, run.id]);
    for (const id of [child.id, fork.id]) {
      expect(JSON.parse(command(harness.db, `first_${id}`)!.input)).toMatchObject({ key_source: run.id, no_env: true });
      // What its first wake sends as `from`, even after an app restart.
      expect(service.sandboxes.keySource(id)).toBe(run.id);
    }
  } finally { service.stop(); await harness.cleanup(); }
});

it("keeps each queued follow-up's reasoning and rejects locked or conflicting changes", async () => {
  const harness = await createTestAppHarness();
  const tagged = await tagger(harness.config.dataDir);
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const prompts: object[] = [];
  let promptReasoning = false;
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  let sid = "";
  const record = (kind: string, data: object, native?: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: sid, kind, data, ...(native ? { native: JSON.stringify(native) } : {}) };
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
    await expect.poll(() => plain(prompts.at(-1))).toEqual({ request_id: "same-launch", text: "queued" });
    expect((await send(thread.id, { requestId: "needs-core", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(409);
    expect(prompts.some((body) => untagged((body as { request_id?: string }).request_id) === "needs-core")).toBe(false);
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
    await expect.poll(() => plain(prompts.at(-1))).toEqual({ request_id: "plain", text: "queued", reasoning: "xhigh" });
    record("state", { state: "starting_turn", request_id: tagged("same-launch") });
    record("state", { state: "starting_turn", request_id: tagged("max-turn") });
    record("state", { state: "starting_turn", request_id: tagged("xhigh-turn") });
    await expect.poll(() => harness.db.select().from(events).all().filter((event) => event.type === "client/turn/requested").map((event) => JSON.parse(event.data).execution.reasoningLevel)).toEqual(["high", "high", "max", "xhigh"]);
    expect(service.threadStatus(thread.id)?.reasoning).toBe("xhigh");
    expect(harness.db.select().from(cloudroomThreads).get()?.reasoning).toBe("high");
    harness.deps.db.insert(cloudroomCommands).values({ id: "legacy-launch", threadId: thread.id, command: "prompt", input: JSON.stringify({ text: "queued", reasoning: "high" }), state: "sending", createdAt: Date.now() }).run();
    expect((await send(thread.id, { requestId: "legacy-launch", mode: "auto", reasoningLevel: "high", input: text })).status).toBe(200);
    await expect.poll(() => plain(prompts.at(-1))).toMatchObject({ request_id: "legacy-launch", text: "queued", reasoning: "high" });
    expect((await send(thread.id, { requestId: "legacy-launch", mode: "auto", reasoningLevel: "max", input: text })).status).toBe(409);
    record("receipt", { request_id: tagged("plain"), command: "prompt", state: "failed", error: "Pi model does not support the selected thinking level" });
    await expect.poll(() => harness.db.select().from(events).all().some((event) => event.type === "system/error" && JSON.parse(event.data).message.includes("thinking level"))).toBe(true);
    // Core restarts a killed agent idle and keeps the cause on the lost turn.
    record("receipt", { request_id: tagged("xhigh-turn"), command: "prompt", state: "unknown_after_restart", error: "invalid native state: unmanaged Claude subagent emitted output (signal 9)" });
    await expect.poll(() => harness.db.select().from(events).all().some((event) => event.type === "system/error" && JSON.parse(event.data).message.includes("unmanaged Claude subagent"))).toBe(true);
    // A Codex error too long for a title keeps its code and text; the failed turn's receipt adds no second card (#949).
    const full = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
    record("native_event", { method: "error" }, { method: "error", params: { threadId: "native", turnId: "t", willRetry: false, error: { message: full, codexErrorInfo: "contextWindowExceeded", additionalDetails: null } } });
    record("receipt", { request_id: "xhigh-turn", command: "prompt", state: "failed", error: full });
    await expect.poll(() => harness.db.select().from(events).all().filter((event) => event.type === "system/error" && event.data.includes("context window")).map((event) => JSON.parse(event.data))).toMatchObject([{ code: "contextWindowExceeded", message: "Codex error (contextWindowExceeded)", detail: full }]);
  } finally {
    service.stop();
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await harness.cleanup();
  }
});

it("shows a Cloud follow-up in the chat at once, like Local, and queues the next one", async () => {
  const harness = await createTestAppHarness();
  const tagged = await tagger(harness.config.dataDir);
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
    expect(service.queue(thread.id).map((item) => untagged(item.id))).toEqual(["next"]);
    await expect.poll(() => prompts.slice(1).map(untagged)).toEqual(["now", "next"]);
    record("state", { state: "resuming" });
    record("state", { state: "idle" });
    await expect.poll(() => harness.db.select().from(cloudroomThreads).get()?.cursor).toBe(records.length);
    expect(getThread(harness.db, thread.id)?.status).toBe("active");
    record("state", { state: "starting_turn", request_id: tagged("now") });
    await expect.poll(() => harness.db.select().from(cloudroomCommands).all().find((command) => untagged(command.id) === "now")?.state).toBe("running");
    expect(chat()).toEqual(["start", "now"]);
    expect(service.queue(thread.id).map((item) => untagged(item.id))).toEqual(["next"]);
  } finally {
    service.stop();
    core.closeAllConnections();
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await harness.cleanup();
  }
});

it("starts Cloud Claude with no level at the Mac catalog default, after a retry's saved level and the project's remembered one (#656)", async () => {
  const harness = await createTestAppHarness();
  const { host, session } = seedHostSession(harness.deps);
  seedPrimaryHost(harness.deps, host.id);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const catalogDown = registerProviderHostRpcResponder(harness, { hostId: host.id, sessionId: session.id, modelErrorsByProviderId: { "claude-code": { errorCode: "unavailable", errorMessage: "catalog down" } } });
  const service = cloudroom(harness.deps);
  const core = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const requestId = text ? JSON.parse(text).request_id : undefined;
    res.writeHead(requestId ? 202 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/capabilities" ? { version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "claude-code", model: "test-model" }] }
      : requestId ? { session_id: "cr_effort", receipt: { request_id: requestId, command: req.url === "/v1/sessions" ? "start" : "prompt", state: "accepted", input: {} }, saving: {} } : {}));
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const start = (requestId: string) => harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId, projectId: project.id, providerId: "claude-code", origin: "cli", model: "test-model", environment: { type: "project-default" }, input: [{ type: "text", text: "start", mentions: [] }] }) });
    const level = (requestId: string) => harness.db.select().from(cloudroomThreads).all().find((row) => row.startRequestId === requestId)?.reasoning;
    expect((await start("first")).status).toBe(201);
    expect(level("first")).toBe("medium");
    catalogDown.unregister();
    registerProviderHostRpcResponder(harness, { hostId: host.id, sessionId: session.id, modelsByProviderId: { "claude-code": { models: [availableModelFixture({ model: "test-model", reasoningLevels: ["medium", "xhigh"], defaultReasoningLevel: "xhigh" })], selectedOnlyModels: [] } } });
    expect((await start("first")).status).toBe(201); // the retry keeps "medium" instead of a 409
    expect((await start("second")).status).toBe(201);
    expect(level("second")).toBe("xhigh");
    upsertProjectExecutionDefaults(harness.db, { projectId: project.id, providerId: "claude-code", model: "test-model", reasoningLevel: "low", permissionMode: "full", serviceTier: "default" });
    expect((await start("third")).status).toBe(201);
    expect(level("third")).toBe("low"); // the project's remembered effort beats the catalog
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
  const tagged = await tagger(harness.config.dataDir);
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const prompts: string[] = [];
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  let release = () => {};
  let starting: Promise<void> | null = null;
  let holdCapabilities = false, failStart = false, blocked = false;
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: "cr_slow", kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json(blocked ? { storage: { enabled: true, level: "blocked", reason: "disk_capacity", workspace_available_bytes: 0, history_available_bytes: 0, workspace_total_bytes: 80e9, history_total_bytes: 80e9, sampled_at: Date.now() } } : {});
    if (req.url === "/v1/capabilities") {
      if (holdCapabilities && starting) await starting;
      return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, queue_cancel: true, harnesses: [{ id: "codex", model: "test-model" }] });
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
      if (failStart) return json({ error: "refused" }, 400);
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
    expect(await quick(send(thread.id, "fourth"))).toMatchObject({ delivery: "queued" });
    expect(service.queue(thread.id).map((item) => untagged(item.id))).toEqual(["second", "third", "fourth"]);
    expect(prompts).toEqual([]);
    // #866: before its session starts, a follow-up is removed at once with no request: with the VM gone and, as after a
    // restart, no capabilities cached, or after a failed start whose retry would send it. Missing or blank IDs are refused.
    const remove = async (id: string) => { const response = await harness.app.request(`/api/v1/threads/${thread.id}/queued-messages/${id}`, { method: "DELETE" }); return { status: response.status, ...await response.json() }; };
    const config = join(harness.config.dataDir, "cloudroom.json"), connection = await readFile(config, "utf8");
    await writeFile(config, JSON.stringify({ sandboxToken: "a".repeat(64) }), { mode: 0o600 });
    (service as unknown as { lastCapabilities: null }).lastCapabilities = null;
    for (const [id, status] of [["%20", 404], ["missing", 404], [tagged("second"), 200]] as const) {
      expect(await quick(remove(id))).toMatchObject({ status });
    }
    await writeFile(config, connection, { mode: 0o600 });
    expect(service.queue(thread.id).map((item) => untagged(item.id))).toEqual(["third", "fourth"]);
    failStart = true;
    release();
    await expect.poll(() => command(harness.db, `first_${thread.id}`)?.state).toBe("failed");
    expect(await remove(tagged("third"))).toMatchObject({ status: 200 });
    failStart = false;
    await harness.app.request(`/api/v1/cloudroom/threads/${thread.id}/retry-start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await expect.poll(() => prompts.map(untagged), { timeout: 2000 }).toEqual([`first_${thread.id}`, "fourth"]);
    // A cancel Core can't take yet keeps its cause, here blocked storage, and says the delete is saved.
    blocked = true;
    await send(thread.id, "fifth");
    expect(await remove(tagged("fifth"))).toMatchObject({ status: 503, message: expect.stringMatching(/disk.*The delete is saved/is) });
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
  const tagged = await tagger(harness.config.dataDir);
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  const commands: object[] = [];
  const sid = "cr_features";
  let holdPrompts = false;
  const attachmentRoot = join(harness.config.dataDir, "attachments", project.id);
  const input = (text: string) => [{ type: "text", text, mentions: [] }, { type: "localImage", path: join(attachmentRoot, "image.png") }, { type: "localFile", path: "note.txt" }];
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
      expect(query.get("name")).toBe(query.get("kind") === "image" ? "image.png" : "note.txt");
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
    expect((await request(`/threads/${thread.id}/send`, { requestId: tagged("queued-1"), mode: "auto", input: input("old") })).status).toBe(200);
    await expect.poll(() => service.queue(thread.id)).toEqual([expect.objectContaining({ id: tagged("queued-1"), content: input("old") })]);
    await expect.poll(() => command(harness.db, tagged("queued-1"))?.state).toBe("accepted");
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
    expect((await request(`/threads/${thread.id}/send`, { requestId: tagged("queued-1"), mode: "auto", input: queued.content })).status).toBe(200);
    expect(service.queue(thread.id)[0]?.content).toEqual(input("new"));
    expect((await request(`/threads/${thread.id}/queued-messages/${queued.id}`, undefined, "DELETE")).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/cancel"))).toBe(true);
    await expect.poll(() => service.queue(thread.id)).toEqual([]);
    holdPrompts = true;
    expect((await request(`/threads/${thread.id}/send`, { requestId: tagged("queued-2"), mode: "auto", input: input("draft") })).status).toBe(200);
    const waiting = service.queue(thread.id).find((item) => item.id === tagged("queued-2"))!;
    expect(command(harness.db, tagged("queued-2"))?.state).toBe("sending");
    expect(waiting.editable).toBe(true);
    const offline = await request(`/threads/${thread.id}/queued-messages/${tagged("queued-2")}`, { input: input("final"), expectedUpdatedAt: waiting.updatedAt }, "PATCH");
    expect(offline.status, await offline.clone().text()).toBe(200);
    expect(service.queue(thread.id).find((item) => item.id === tagged("queued-2"))?.content).toEqual(input("final"));
    holdPrompts = false;
    const sentTo = (name: string) => commands.findIndex((item) => { const sent = item as { url?: string; request_id?: string; target_request_id?: string }; return Boolean(sent.url?.endsWith(name)) && (sent.request_id === tagged("queued-2") || sent.target_request_id === tagged("queued-2")); });
    await expect.poll(() => sentTo("/edit")).toBeGreaterThan(-1);
    expect(sentTo("/prompts")).toBeGreaterThan(-1);
    expect(sentTo("/prompts")).toBeLessThan(sentTo("/edit"));
    expect(service.queue(thread.id).find((item) => item.id === tagged("queued-2"))?.content).toEqual(input("final"));
    expect((await request(`/threads/${thread.id}/queued-messages/${tagged("queued-2")}`, undefined, "DELETE")).status).toBe(200);
    await expect.poll(() => service.queue(thread.id)).toEqual([]);
    expect((await request(`/threads/${thread.id}/send`, { requestId: tagged("steer-1"), mode: "steer", input: [{ type: "text", text: "course correct", mentions: [] }] })).status).toBe(200);
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/steer"))).toBe(true);
    // Core steers text only, so a steer's files are uploaded first and named by their sandbox paths.
    expect((await request(`/threads/${thread.id}/send`, { requestId: tagged("steer-files"), mode: "steer", input: input("see files") })).status).toBe(200);
    await expect.poll(() => commands.find((item) => (item as { request_id?: string }).request_id === tagged("steer-files"))).toMatchObject({
      text: expect.stringMatching(new RegExp(`see files[\\s\\S]*\\[Attached image: /code/test/\\.cloudroom/attachments/${tagged("steer-files")}a0/image\\.png\\]\n\\[Attached file: /code/test/\\.cloudroom/attachments/${tagged("steer-files")}a1/note\\.txt\\]$`)),
    });
    // A refused steer, here because its turn just ended, is queued instead of blocking every command behind it.
    expect((await request(`/threads/${thread.id}/send`, { requestId: tagged("steer-late"), mode: "steer", input: [{ type: "text", text: "too late", mentions: [] }] })).status).toBe(200);
    await expect.poll(() => commands.some((item) => { const sent = item as { url?: string; text?: string }; return Boolean(sent.url?.endsWith("/prompts") && sent.text?.includes("too late")); })).toBe(true);
    expect(command(harness.db, tagged("steer-late"))?.state).toBe("failed");
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
    const rewritten = request(`/threads/${thread.id}/edit-message`, { operationId: "edit-1", input: input("rewritten"), expectedRequestSequence: requested?.sequence });
    await expect.poll(() => commands.some((item) => (item as { url?: string }).url?.endsWith("/rewind"))).toBe(true);
    // Editing after Stop must not leave the replacement stuck behind a paused queue.
    expect(commands.map((item) => (item as { url?: string }).url?.split("/").pop()).filter((name) => name === "resume" || name === "rewind")).toEqual(["resume", "rewind"]);
    expect(commands.some((item) => (item as { url?: string; text?: string }).url?.endsWith("/prompts") && (item as { text?: string }).text === "rewritten")).toBe(false);
    const rewind = commands.find((item) => (item as { url?: string }).url?.endsWith("/rewind")) as { request_id: string; before: string; replacement: { request_id: string; text: string; content: unknown } };
    expect(rewind.replacement.text).toBe("rewritten");
    record("rewind", { id: "corrected-native", request_id: rewind.request_id, before: rewind.before, replacement: { request_id: rewind.replacement.request_id, input: rewind.replacement } });
    record("state", { state: "starting_turn", request_id: rewind.replacement.request_id });
    expect((await rewritten).status).toBe(200);
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

it("a message to a lost Cloud agent restarts it from its saved chat, and a refused one fails instead of saying sent (#154, #155)", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const sid = "cr_lost", calls: string[] = [], records: object[] = [], streams = new Set<ServerResponse>();
  let state = "idle", history = true, keepPausedCapability = true;
  const record = (kind: string, data: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: Date.now(), session_id: sid, kind, data };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, queue_reorder: true, resume_keep_paused: keepPausedCapability, harnesses: [{ id: "codex", model: "test-model", models: [{ model: "test-model", reasoning_levels: ["high"] }] }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const value of records.slice(after)) res.write(`id: ${(value as { sequence: number }).sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    if (req.method !== "POST") return json({}, 404);
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const command = req.url === "/v1/sessions" ? "start" : req.url!.split("/").pop()!.replace(/s$/, "");
    calls.push(`${command}${body.keep_paused ? "+keep" : ""}:${state}`);
    // Real Core: only `resume` may restart a lost session, and only with its saved chat intact.
    if (state === "process_lost" && command === "resume" && !history) return json({ code: "request_rejected", error: "saved conversation is unavailable; inspect session recovery before retrying" }, 409);
    if (state === "process_lost" && command !== "resume") return json({ code: "request_rejected", error: "process unavailable; history does not restore execution" }, 409);
    const receipt = { request_id: body.request_id, command, state: command === "resume" ? "completed" : "accepted", input: command === "prompt" ? { text: body.text } : body.keep_paused ? { keep_paused: true } : {} };
    if (command === "resume") { state = "idle"; record("state", { state: "resuming" }); record("state", { state: "idle" }); }
    record("receipt", receipt);
    json({ session_id: sid, receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const request = (path: string, body?: unknown) => harness.app.request(`/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // How `room-cli thread tell` sends to a Cloud thread.
  const tell = (threadId: string, text: string, requestId?: string) => request(`/threads/${threadId}/send`, { requestId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
  const lose = () => { state = "process_lost"; record("state", { state: "process_lost", reason: "Agent process exited unexpectedly (out of memory)", out_of_memory: true }); };
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const created = await request("/threads", { executionTarget: "cloud", requestId: "lost-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "Build it", mentions: [] }] });
    expect(created.status).toBe(201);
    const threadId = (await created.json()).id as string;
    await expect.poll(() => calls).toContain("prompt:idle");
    lose();
    await expect.poll(() => getThread(harness.db, threadId)?.status).toBe("error");
    calls.length = 0;
    const revived = await tell(threadId, "Memory is free now; carry on");
    expect({ status: revived.status, body: await revived.json() }).toMatchObject({ status: 200, body: { ok: true } });
    expect(calls).toEqual(["resume:process_lost", "prompt:idle"]);
    // #844 review: Stop paused an older message. Two quick sends restart once, keeping the pause until a message is first.
    keepPausedCapability = false;
    await service.status();
    harness.db.insert(cloudroomCommands).values({ id: "older-resume", threadId, command: "resume", input: "{}", state: "accepted", createdAt: Date.now() - 1000 }).run();
    record("receipt", { request_id: "stop", command: "stop", state: "accepted", input: {} });
    record("receipt", { request_id: "older", command: "prompt", state: "accepted", input: { text: "Older" } });
    lose();
    await expect.poll(() => getThread(harness.db, threadId)?.status).toBe("error");
    expect(service.threadStatus(threadId)?.paused).toBe(true);
    // #967: a message Stop holds says so, not that it waits for the current turn, despite an older accepted resume; a
    // session that replaced the stopped one isn't held by it.
    for (const [sessionId, held] of [["cr_replaced", false], [sid, true]] as const) {
      saveBinding(harness.db, threadId, { sessionId });
      expect(service.queue(threadId).map(row => row.pausedByStop), sessionId).toEqual([held]);
    }
    calls.length = 0;
    const unsupported = await tell(threadId, "Correction A", "correction-a");
    expect(unsupported.ok).toBe(false);
    expect(await unsupported.json()).toMatchObject({ message: expect.stringContaining("Update the cloud core") });
    expect(calls).toEqual([]);
    // The saved send succeeds once Core supports it, even while the app's cached capabilities still say otherwise.
    keepPausedCapability = true;
    expect((await Promise.all([tell(threadId, "Correction A", "correction-a"), tell(threadId, "Correction B")])).map(response => response.status)).toEqual([200, 200]);
    expect(calls.slice(0, 4)).toEqual(["resume+keep:process_lost", "prompt:idle", "reorder:idle", "resume:idle"]);
    expect(calls.filter(call => call.startsWith("prompt"))).toHaveLength(2);
    lose(); history = false;
    await expect.poll(() => getThread(harness.db, threadId)?.status).toBe("error");
    const refused = await tell(threadId, "Are you there?");
    expect(refused.ok).toBe(false);
    expect(await refused.json()).toMatchObject({ message: expect.stringContaining("saved conversation is unavailable") });
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
}, 15000);

it("maps exactly the Core session states core/docs/api.md lists", async () => {
  const doc = await readFile(new URL("../../../../../core/docs/api.md", import.meta.url), "utf8");
  const documented = [...(doc.match(/Session `state` values: (.*)/)?.[1] ?? "").matchAll(/`(\w+)`/g)].map((match) => match[1]);
  expect(documented.length).toBeGreaterThan(10);
  expect([...documented].sort()).toEqual([...coreStates].sort());
});

it("tells a Cloud parent once when Core keeps refusing its child's start for now, and keeps it trying (#865)", async () => {
  const harness = await createTestAppHarness(), service = cloudroom(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: seedHostSession(harness.deps).host.id });
  // Every start gets the 409 Core gives while its agent's model check fails, which says it will pass.
  let held: (() => void) | null = null, hold = false;
  const core = createServer(async (req, res) => { if (hold && req.url === "/v1/sessions") await new Promise<void>(resolve => { held = resolve; }); res.writeHead(req.url === "/v1/sessions" ? 409 : 200, { "Content-Type": "application/json" }); res.end(JSON.stringify(req.url === "/v1/capabilities" ? { version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, harnesses: [{ id: "codex", model: "test-model" }] } : { error: "model catalog unavailable", code: "model_catalog_unavailable" })); });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const url = `http://127.0.0.1:${(core.address() as { port: number }).port}`, now = Date.now();
  try {
    await service.configure({ url, token: "x".repeat(40), projectId: project.id });
    const parent = createThread(harness.db, harness.hub, { projectId: project.id, executionTarget: "cloud", providerId: "codex", status: "idle" });
    const [child, archived] = [0, 1].map(() => createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId: parent.id, executionTarget: "cloud", providerId: "codex", status: "pending" }));
    harness.db.insert(cloudroomThreads).values([{ threadId: parent.id, coreUrl: "http://127.0.0.1:9", sessionId: "cr_parent" }, { threadId: child.id, coreUrl: url }, { threadId: archived.id, coreUrl: url }].map(row => ({ startRequestId: `start_${row.threadId}`, model: "test-model", reasoning: "medium", ...row }))).run();
    harness.db.insert(cloudroomCommands).values([child, archived].map(({ id }) => ({ id: `first_${id}`, threadId: id, command: "prompt" as const, input: JSON.stringify({ text: "Start" }), state: "sending" as const, createdAt: now }))).run();
    const notices = () => harness.db.select().from(cloudroomCommands).all().filter(row => row.threadId === parent.id).map(row => JSON.parse(row.input).text);
    // The last row archives its child while the start that crosses 2 minutes is still waiting for Core.
    // The last row unarchives it 3 minutes later: its next refusal starts a new 2 minutes.
    for (const [id, after, sent, archive, unarchive] of [[child.id, 0, 0], [child.id, 60_000, 0], [child.id, 120_000, 1], [child.id, 600_000, 1], [archived.id, 0, 1], [archived.id, 120_000, 1, true], [archived.id, 300_000, 1, false, true]] as const) {
      vi.spyOn(Date, "now").mockReturnValue(now + after);
      hold = Boolean(archive);
      if (unarchive) unarchiveThread(harness.db, harness.hub, id);
      const started = (service as unknown as { deliver(id: string): Promise<void> }).deliver(id);
      if (archive) { await expect.poll(() => held, { interval: 5 }).not.toBeNull(); archiveThread(harness.db, harness.hub, id); held!(); }
      await expect(started).rejects.toThrow();
      await new Promise(resolve => setImmediate(resolve));
      vi.restoreAllMocks();
      expect({ id, after, sent: notices().length, first: command(harness.db, `first_${id}`)?.state }).toEqual({ id, after, sent, first: "sending" });
    }
    expect(notices()[0]).toMatch(/has not started: Cloud model discovery is unavailable.*don't spawn a replacement/);
  } finally { service.stop(); core.closeAllConnections(); core.close(); await harness.cleanup(); }
});
