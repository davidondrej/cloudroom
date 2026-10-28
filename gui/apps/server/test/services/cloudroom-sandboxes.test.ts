import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { saveStatus } from "../../src/services/cloudroom/store.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { cloudroomThreads, createThread, getThread } from "@cloudroom/db";

// The Cursor key check runs this computer's Cursor CLI, which rejects the tests' fake keys.
vi.mock("../../src/services/cloudroom/sandboxes.js", async (original) => ({ ...await original<object>(), cursorKeyRejected: async () => false }));

const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return `http://127.0.0.1:${address.port}`;
};
const body = async (req: import("node:http").IncomingMessage) => { let text = ""; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };
const waitFor = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  if (!check()) throw new Error(`timed out: ${label}`);
};

it("gives each cloud thread its own sandbox, wakes it only for work, and archives it through the website", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const capture = vi.spyOn(harness.deps.telemetry, "capture");
  const website: { action: string; thread?: string; project?: string; auth?: string; title?: string; project_name?: string; session?: string; harness?: string; model?: string; parent?: string | null }[] = [];
  const core: { path: string; auth?: string }[] = [];
  let state: "new" | "awake" | "asleep" | "archived" = "new";
  let sandboxThread = "";
  let coreUrl = "";
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    core.push({ path: req.url!, auth: req.headers.authorization });
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`id: 1\nevent: record\ndata: ${JSON.stringify({ sequence: 1, session_id: "cr_one", kind: "state", data: { state: "running" } })}\n\n`); return; }
    const input = await body(req);
    if (req.url === "/v1/sessions") return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202);
    if (req.url?.startsWith("/v1/sessions/cr_one/prompts")) return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "prompt", input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const input = await body(req);
    website.push({ action: input.action ?? input.name, thread: input.thread, project: input.project, auth: req.headers.authorization, title: input.title, project_name: input.project_name, session: input.session, harness: input.harness, model: input.model, parent: input.parent });
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "awake") return json({ sandboxes: state === "awake" ? [{ thread: sandboxThread, origin: coreUrl, token: "t".repeat(64) }] : [] });
    if (input.action === "wake") { state = "awake"; sandboxThread = input.thread; }
    if (input.action === "archive") state = "archived";
    else if (state === "archived") return json({ error: "This thread is archived. Restore it to continue.", code: "sandbox_archived" }, 409);
    const view = { thread: input.thread, state, generation: state === "awake" ? 1 : 0, issue: null };
    return json(state === "awake" ? { ...view, origin: coreUrl, token: "t".repeat(64) } : view);
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  const request = (path: string, value?: unknown) => harness.app.request(`/api/v1${path}`, { method: value === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  try {
    const account = { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" };
    await service.configure(null, account, undefined, websiteUrl, "a".repeat(64));
    const status = await (await request("/cloudroom")).json();
    expect(status).toMatchObject({ ready: true, account });
    expect(JSON.stringify(status)).not.toContain("a".repeat(64));

    const created = await request("/threads", { executionTarget: "cloud", requestId: "sandbox-start", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: [{ type: "text", text: "Work in your own sandbox", mentions: [] }] });
    expect(created.status).toBe(201);
    const thread = (await created.json()) as { id: string };
    const saved = () => harness.deps.db.select().from(cloudroomThreads).get()!;
    expect(saved().coreUrl).toBe(`sandbox:${thread.id}`);
    await waitFor(() => saved().sessionId === "cr_one", "cloud start");
    // One website call registers and wakes the new thread's sandbox.
    expect(website.filter(call => call.thread === thread.id && call.action !== "label").map(call => call.action)).toEqual(["wake"]);
    // Then the website learns the thread's name, project, harness, model, and Core session (ADR 0182, 0239).
    await waitFor(() => website.some(call => call.action === "label"), "thread label");
    expect(website.filter(call => call.action === "label")).toMatchObject([{ thread: thread.id, title: "Work in your own sandbox", project_name: project.name, session: "cr_one", harness: "codex", model: "test-model", parent: null }]);
    expect((await harness.app.request(`/api/v1/threads/${thread.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Renamed" }) })).status).toBeLessThan(300);
    await waitFor(() => website.some(call => call.action === "label" && call.title === "Renamed"), "renamed label");
    expect(website.find(call => call.action === "wake")?.project).toBe(project.id);
    expect(website.every(call => call.auth === `Basic ${Buffer.from(`${account.id}:${"a".repeat(64)}`).toString("base64")}`)).toBe(true);
    expect(core.find(call => call.path === "/v1/sessions")?.auth).toBe(`Bearer ${"t".repeat(64)}`);

    // The sandbox falls asleep mid-turn. Idle delivery ticks must not wake it, and the thread stops showing as running.
    await waitFor(() => getThread(harness.deps.db, thread.id)?.status === "active", "running turn");
    state = "asleep";
    service.sandboxes.forget(thread.id);
    const wakes = () => website.filter(call => call.action === "wake").length;
    const before = wakes();
    await new Promise(resolve => setTimeout(resolve, 3200));
    expect(wakes()).toBe(before);
    expect(getThread(harness.deps.db, thread.id)?.status).toBe("idle");
    saveStatus(harness.deps.db, thread.id, "active");
    expect((await request(`/threads/${thread.id}/stop`, {})).status).toBe(200);
    expect([wakes(), getThread(harness.deps.db, thread.id)?.status]).toEqual([before, "idle"]);

    // New work wakes it, and the message reaches the sandbox's Core.
    const sent = await request(`/threads/${thread.id}/send`, { requestId: "follow-up", mode: "auto", input: [{ type: "text", text: "Follow-up", mentions: [] }] });
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    await waitFor(() => wakes() > before, "wake for new work");
    await waitFor(() => core.some(call => call.path.startsWith("/v1/sessions/cr_one/prompts")), "prompt delivery");
    // Cloud threads and messages count in anonymous usage, tagged with where they run.
    expect(capture).toHaveBeenCalledWith({ name: "thread_created", properties: { execution: "cloud_sandbox", is_child_thread: false, provider: "codex" } });
    expect(capture).toHaveBeenCalledWith({ name: "user_message_sent", properties: { execution: "cloud_sandbox", is_child_thread: false, message_source: "thread_create", provider: "codex" } });
    expect(capture).toHaveBeenCalledWith({ name: "user_message_sent", properties: { execution: "cloud_sandbox", is_child_thread: false, message_source: "thread_send", provider: "codex" } });

    // Archive goes to the website, which stops the sandbox even mid-task, so the thread stops showing as running.
    await waitFor(() => getThread(harness.deps.db, thread.id)?.status === "active", "running follow-up");
    service.sandboxes.forget(thread.id);
    expect((await request(`/threads/${thread.id}/stop`, {})).status).toBe(200);
    expect(core.some(call => call.path.startsWith("/v1/sessions/cr_one/stop"))).toBe(true);
    expect((await harness.app.request(`/api/v1/threads/${thread.id}/archive-all`, { method: "POST" })).status).toBeLessThan(300);
    await waitFor(() => website.some(call => call.action === "archive" && call.thread === thread.id), "archive");
    expect(getThread(harness.deps.db, thread.id)?.status).toBe("idle");
    // Stopping it afterwards has nothing to do.
    expect((await request(`/threads/${thread.id}/stop`, {})).status).toBe(200);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
});

it("an unarchived Cloud child becomes top-level, keeps its parent's sandbox, and archives it as the last thread", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const website: { action: string; thread?: string }[] = [];
  const core: string[] = [];
  let state: "asleep" | "awake" | "archived" = "asleep";
  let restoreFails = true;
  let coreUrl = "";
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    core.push(req.url!);
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    const input = await body(req);
    if (req.url === "/v1/sessions/cr_child/detach") return json({ detached: true }, 202);
    if (req.url === "/v1/sessions/cr_child/prompts") return json({ session_id: "cr_child", receipt: { request_id: input.request_id, command: "prompt", input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const input = await body(req);
    website.push({ action: input.action ?? input.name, thread: input.thread });
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "archive") state = "archived";
    if (input.action === "restore") {
      if (restoreFails) { restoreFails = false; return json({ error: "The website is down." }, 500); }
      state = "asleep";
    }
    if (input.action === "wake") {
      if (state === "archived") return json({ error: "This thread is archived. Restore it to continue.", code: "sandbox_archived" }, 409);
      state = "awake";
    }
    const view = { thread: input.thread, state, generation: 1, issue: null };
    return json(state === "awake" ? { ...view, origin: coreUrl, token: "t".repeat(64) } : view);
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  const post = (path: string, value?: unknown) => harness.app.request(`/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const calls = (action: string) => website.filter(call => call.action === action).map(call => call.thread);
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    const parent = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    const child = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", parentThreadId: parent.id, status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values([
      { threadId: parent.id, coreUrl: `sandbox:${parent.id}`, sessionId: "cr_parent", startRequestId: "parent", model: "test-model", reasoning: "medium" },
      { threadId: child.id, coreUrl: `sandbox:${parent.id}`, sessionId: "cr_child", startRequestId: "child", model: "test-model", reasoning: "medium" },
    ]).run();

    // Archiving the parent archives its child, and the shared sandbox once, after its last thread.
    expect((await post(`/threads/${parent.id}/archive-all`)).status).toBe(200);
    await waitFor(() => calls("archive").length > 0, "sandbox archive");
    expect(calls("archive")).toEqual([parent.id]);

    // Unarchiving the child makes it a top-level thread and restores the sandbox it runs in: its former parent's.
    expect((await post(`/threads/${child.id}/unarchive`)).status).toBe(200);
    expect(getThread(harness.deps.db, child.id)).toMatchObject({ archivedAt: null, parentThreadId: null });
    expect(getThread(harness.deps.db, parent.id)?.archivedAt).not.toBeNull();
    await waitFor(() => calls("restore").length > 0, "restore");
    expect(calls("restore")).toEqual([parent.id]);

    // That restore failed, so the wake finds the sandbox archived, restores it, and delivers. Core first detaches the
    // thread, so the archived parent hears nothing of its new work.
    const sent = await post(`/threads/${child.id}/send`, { requestId: "follow-up", mode: "auto", input: [{ type: "text", text: "Continue", mentions: [] }] });
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    await waitFor(() => core.includes("/v1/sessions/cr_child/prompts"), "prompt delivery");
    expect(calls("restore")).toEqual([parent.id, parent.id]);
    expect(core.indexOf("/v1/sessions/cr_child/detach")).toBeGreaterThan(-1);
    expect(core.indexOf("/v1/sessions/cr_child/detach")).toBeLessThan(core.indexOf("/v1/sessions/cr_child/prompts"));

    // Archiving its last active thread archives the sandbox again.
    expect((await post(`/threads/${child.id}/archive-all`)).status).toBe(200);
    await waitFor(() => calls("archive").length === 2, "second sandbox archive");
    expect(calls("archive")).toEqual([parent.id, parent.id]);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
});

it("moving back to the VM: new threads start on the VM while sandbox threads stay put", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  let sandboxesOn = true;
  const savedLogins: string[] = [];
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    // The VM runs Cursor; sandboxes (token t…) do not.
    const vm = req.headers.authorization === `Bearer ${"v".repeat(64)}`;
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }, ...(vm ? [{ id: "cursor", model: "default" }] : [])] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    const input = await body(req);
    if (req.url === "/v1/sessions") return json({ session_id: `cr_${input.request_id}`, receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const coreUrl = await listen(coreServer);
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/desktop/logins") { if (input.name) savedLogins.push(input.name); return res.end(JSON.stringify({ saved: true, claude: false, codex: false, pi: false, github: false, cursor: false })); }
    if (input.action === "mode") return res.end(JSON.stringify({ sandboxes: sandboxesOn }));
    res.end(JSON.stringify({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64) }));
  });
  const websiteUrl = await listen(websiteServer);
  const request = (path: string, value: unknown) => harness.app.request(`/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const start = async (id: string) => {
    const created = await request("/threads", { executionTarget: "cloud", requestId: id, projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: [{ type: "text", text: "Hi", mentions: [] }] });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = (await created.json()) as { id: string };
    return harness.deps.db.select().from(cloudroomThreads).all().find(row => row.threadId === thread.id)!;
  };
  try {
    await service.configure({ url: coreUrl, token: "v".repeat(64) }, { id: "11111111-1111-4111-8111-111111111111", email: "vm@example.com" }, undefined, websiteUrl, "a".repeat(64));
    const inSandbox = await start("with-sandboxes");
    expect(inSandbox.coreUrl).toBe(`sandbox:${inSandbox.threadId}`);
    // An account that still has a VM connects Claude for its sandboxes too, where its new threads run.
    await service.claudeAuth("token", undefined, "sk-ant-oat01-test", "max");
    expect(savedLogins).toContain("claude");
    // Cursor too, with an API key. The picker offers what sandboxes run, never the VM's harnesses.
    expect(await service.cursorAuth()).toMatchObject({ state: "missing" });
    await service.cursorAuth("key", undefined, "key_cursor");
    expect(savedLogins).toContain("cursor");
    await vi.waitFor(async () => expect((await service.status()).harnesses?.map(h => h.id)).toEqual(["codex"]));
    sandboxesOn = false;
    (service.sandboxes as unknown as { mode: null }).mode = null;
    const onVm = await start("moved-back");
    expect(onVm.coreUrl).toBe(coreUrl);
    // Only VM threads can move into a sandbox, and only while sandboxes are on.
    expect((await request(`/cloudroom/threads/${inSandbox.threadId}/teleport`, { action: "move" })).status).toBe(409);
    expect((await request(`/cloudroom/threads/${onVm.threadId}/teleport`, { action: "move" })).status).toBe(409);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
});

it("sends a new thread's first message before its project copy starts, so a slow upload can't hold it back", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cloudroom-copy-order-"));
  await writeFile(join(folder, "notes.txt"), "small project not on GitHub");
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: folder });
  const service = cloudroom(harness.deps);
  const core: string[] = [];
  let firstPrompt: { text: string; copyStarted: boolean } | null = null;
  let coreUrl = "";
  // The first workspace lookup plans the copy; the second one is the copy itself starting.
  const copyStarted = () => core.filter(path => path.startsWith("/v1/workspaces/")).length >= 2;
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    core.push(req.url!);
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    const input = await body(req);
    if (req.url === "/v1/sessions") return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202);
    if (req.url?.startsWith("/v1/sessions/cr_one/prompts")) {
      // A slow connection: the message takes a while to land. The copy must not start meanwhile.
      await new Promise(resolve => setTimeout(resolve, 400));
      firstPrompt ??= { text: input.text, copyStarted: copyStarted() };
      return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "prompt", input, state: "accepted" }, saving: {} }, 202);
    }
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const input = await body(req);
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    json({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64) });
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId: "copy-order", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: [{ type: "text", text: "test", mentions: [] }] }) });
    expect(created.status).toBe(201);
    await waitFor(() => firstPrompt !== null, "first message");
    expect(firstPrompt!.copyStarted).toBe(false);
    // The agent still learns that its files are on the way.
    expect(firstPrompt!.text).toContain("Cloudroom is copying its files");
    await waitFor(copyStarted, "copy after the first message");
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
    await rm(folder, { recursive: true, force: true });
  }
});

it("tells the user to remove forced API login when Codex refuses ChatGPT sign-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-forced-api-"));
  const path = process.env.PATH, codexHome = process.env.CODEX_HOME;
  try {
    // Same output and exit code as the real `codex login` with `forced_login_method = "api"`.
    await writeFile(join(dir, "codex"), "#!/bin/sh\necho 'ChatGPT login is disabled. Use API key login instead.' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${dir}:${path}`;
    process.env.CODEX_HOME = dir;
    const { macCodexLogin, startMacCodexLogin } = await import("../../src/services/cloudroom/sandboxes.js");
    const run = startMacCodexLogin();
    await waitFor(() => run.done, "codex login exit");
    expect(run.error).toContain('Remove `forced_login_method = "api"`');
    expect(run.error).toContain(join(dir, "config.toml"));
    macCodexLogin();
  } finally {
    process.env.PATH = path;
    if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome;
    await rm(dir, { recursive: true, force: true });
  }
});

it("sleeping cloud threads share one awake-list check per app, and a thread woken elsewhere connects without a wake", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const website: string[] = [];
  const streams: string[] = [];
  const awake: string[] = [];
  let awakeFails = false;
  let coreUrl = "";
  const coreServer = createServer((req, res) => {
    if (req.url?.includes("/stream?")) { streams.push(req.url); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}");
  });
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    website.push(input.action ?? input.name);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/desktop/logins") return res.end(JSON.stringify({ claude: false, codex: false, pi: false, github: false }));
    if (input.action === "awake" && awakeFails) { res.statusCode = 503; return res.end(JSON.stringify({ error: "The website is down." })); }
    if (input.action === "awake") return res.end(JSON.stringify({ sandboxes: awake.map(thread => ({ thread, origin: coreUrl, token: "t".repeat(64) })), recheck_ms: 1_000 }));
    res.end(JSON.stringify({ thread: input.thread, state: "asleep", generation: 1, issue: null }));
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  const count = (action: string) => website.filter(call => call === action).length;
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    const threads = Array.from({ length: 5 }, () => createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" }));
    harness.deps.db.insert(cloudroomThreads).values(threads.map((thread, i) => ({ threadId: thread.id, coreUrl: `sandbox:${thread.id}`, sessionId: `cr_${i}`, startRequestId: `start_${i}`, model: "test-model", reasoning: "medium" }))).run();

    const started = Date.now();
    await new Promise(resolve => setTimeout(resolve, 3_200));
    expect(count("register")).toBe(0);
    expect(count("awake")).toBeGreaterThan(0);
    expect(count("awake")).toBeLessThanOrEqual(Math.ceil((Date.now() - started) / 1_000) + 1);
    expect(streams).toEqual([]);

    awake.push(threads[0]!.id);
    await waitFor(() => streams.some(url => url.includes("cr_0")), "stream for the thread woken elsewhere");
    expect(streams.every(url => url.includes("cr_0"))).toBe(true);
    expect(count("wake")).toBe(0);
    expect(count("register")).toBe(0);

    // A failed check is a connection problem, not proof of sleep: a running thread keeps its status.
    saveStatus(harness.deps.db, threads[1]!.id, "active");
    awakeFails = true;
    const failedFrom = count("awake");
    await new Promise(resolve => setTimeout(resolve, 2_500));
    expect(getThread(harness.deps.db, threads[1]!.id)?.status).toBe("active");
    expect(count("awake") - failedFrom).toBeGreaterThan(0);
    expect(count("awake") - failedFrom).toBeLessThanOrEqual(3);
    expect(count("register")).toBe(0);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
}, 20_000);

it("Windows MCP paths and %VARIABLES% stay on this PC", async () => {
  const { WINDOWS_LOCAL_PATH } = await import("../../src/services/cloudroom/sandboxes.js");
  for (const local of ["C:\\tools\\server.js", "--root=D:/data", "\\\\server\\share", "%USERPROFILE%\\x", "%ProgramFiles(x86)%\\x", "%MCP_HOME2%"])
    expect(WINDOWS_LOCAL_PATH.test(local), local).toBe(true);
  for (const portable of ["npx", "-y", "@acme/mcp", "https://mcp.example.com/mcp", "50%"])
    expect(WINDOWS_LOCAL_PATH.test(portable), portable).toBe(false);
});
