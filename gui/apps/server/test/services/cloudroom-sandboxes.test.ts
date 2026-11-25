import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { binding, command, saveStatus } from "../../src/services/cloudroom/store.js";
import { setCopyLogins, setCopyMacGithub } from "../../src/services/cloudroom/sync.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { seedEnvironment, seedHostSession, seedProjectWithSource, seedThread, seedThreadRuntimeState } from "../helpers/seed.js";
import { cloudroomCommands, cloudroomThreads, createThread, getThread, setProjectGitRemoteUrlIfMissing, threads } from "@cloudroom/db";
import { eq } from "drizzle-orm";

// The Cursor key check runs this computer's Cursor CLI, which rejects the tests' fake keys.
vi.mock("../../src/services/cloudroom/sandboxes.js", async (original) => ({ ...await original<object>(), cursorKeyRejected: async () => false }));

const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return `http://127.0.0.1:${address.port}`;
};
const body = async (req: import("node:http").IncomingMessage) => { let text = ""; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };
const waitFor = async (check: () => boolean, label: string, ms = 5_000) => {
  for (let i = 0; i < ms / 25 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25));
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
  const prompts: string[] = [];
  let state: "new" | "awake" | "asleep" | "archived" = "new";
  let refusal: string | null = null;
  let coreDown: "502" | "storage" | null = null;
  let sandboxThread = "";
  let coreUrl = "";
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    core.push({ path: req.url!, auth: req.headers.authorization });
    if (coreDown === "502") return json({ error: "upstream unreachable" }, 502);
    if (coreDown === "storage") return json({ error: "storage unsafe; new execution is blocked", code: "storage_blocked" }, 409);
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`id: 1\nevent: record\ndata: ${JSON.stringify({ sequence: 1, session_id: "cr_one", kind: "state", data: { state: "running" } })}\n\n`); return; }
    const input = await body(req);
    if (req.url === "/v1/sessions") return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202);
    if (req.url?.startsWith("/v1/sessions/cr_one/prompts")) prompts.push(input.request_id);
    if (req.url?.startsWith("/v1/sessions/cr_one/prompts")) return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "prompt", input, state: "accepted" }, saving: {} }, 202);
    const control = req.url?.match(/^\/v1\/sessions\/cr_one\/(stop|resume|reorder)$/)?.[1];
    if (control) return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: control, input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const input = await body(req);
    website.push({ action: input.action ?? input.name, thread: input.thread, project: input.project, auth: req.headers.authorization, title: input.title, project_name: input.project_name, session: input.session, harness: input.harness, model: input.model, parent: input.parent });
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "threads") return json({ error: "Invalid sandbox request." }, 400);
    if (input.action === "awake") return json({ sandboxes: state === "awake" ? [{ thread: sandboxThread, origin: coreUrl, token: "t".repeat(64) }] : [] });
    if (input.action === "wake" && refusal === "drop") return req.socket.destroy();
    if (input.action === "wake" && refusal === "502") return json({ error: "Upstream unreachable." }, 502);
    if (input.action === "wake" && refusal) return json({ error: "Refused.", code: refusal }, 429);
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

    // Out of credits, the website refuses every wake. Stop still works without one (#553).
    await waitFor(() => getThread(harness.deps.db, thread.id)?.status === "active", "running follow-up");
    state = "asleep";
    refusal = "sandbox_repairing";
    service.sandboxes.forget(thread.id);
    await waitFor(() => getThread(harness.deps.db, thread.id)?.status === "idle", "asleep");
    // The app tags each prompt with its install (#237); these name them by the rest.
    const commandState = (id: string) => harness.deps.db.select().from(cloudroomCommands).all().find(item => item.id.replace(/^app_[a-f0-9]{12}_/, "") === id)?.state;
    const skipBackoff = () => (service.sandboxes as unknown as { backoff: Map<string, unknown> }).backoff.clear();
    // Behind a website 502, out of reach, or awake with its Core not answering (#1699): Stop is saved and says so (its
    // agent may run), and the message never goes out. A refusal is an answer: a repair may come after the sandbox
    // started, and a Core blocking new work keeps it, so Stop fails as before, cancelling nothing. A restore is held.
    const asleep = (wake: string | null) => () => { refusal = wake; coreDown = null; state = "asleep"; service.sandboxes.forget(thread.id); };
    const unreachable: [string, () => void, string, string, boolean, number][] = [
      ["sandbox_repairing", asleep("sandbox_repairing"), "sandbox_repairing", "sending", false, 0],
      ["storage_blocked", () => { refusal = null; coreDown = "storage"; }, "storage_blocked", "sending", false, 1],
      ["502", asleep("502"), "cloudroom_stop_pending", "cancelled", true, 1],
      ["drop", asleep("drop"), "cloudroom_stop_pending", "cancelled", true, 1],
      ["core-down", () => { refusal = null; coreDown = "502"; }, "cloudroom_stop_pending", "cancelled", true, 1],
      ["sandbox_restoring", asleep("sandbox_restoring"), "cloudroom_stop_pending", "cancelled", true, 1],
    ];
    const held = () => harness.deps.db.select().from(cloudroomCommands).all().filter(item => item.command === "stop" && item.state === "sending").length;
    for (const [failure, fail, code, message, paused, holds] of unreachable) {
      fail();
      skipBackoff();
      const before = core.length, attempts = wakes();
      const sent = await request(`/threads/${thread.id}/send`, { requestId: `unreachable-${failure}`, mode: "auto", input: [{ type: "text", text: "Not now", mentions: [] }] });
      expect(sent.status, `${failure}: ${await sent.clone().text()}`).toBe(200);
      await waitFor(() => coreDown ? core.length > before : wakes() > attempts, `${failure}: failed delivery`);
      skipBackoff();
      const holding = held();
      const stopped = await request(`/threads/${thread.id}/stop`, {});
      expect([stopped.status, (await stopped.json()).code, commandState(`unreachable-${failure}`), Boolean(binding(harness.deps.db, thread.id)?.queuePaused), held()], failure)
        .toEqual([503, code, message, paused, holding + holds]);
    }
    // The repair's message was the current turn, which Core may already have had: it was kept, and goes out as before.
    refusal = null;
    coreDown = null;
    skipBackoff();
    await waitFor(() => commandState("unreachable-sandbox_repairing") === "accepted", "kept turn delivered");
    state = "asleep";
    service.sandboxes.forget(thread.id);
    await waitFor(() => getThread(harness.deps.db, thread.id)?.status === "idle", "asleep again");
    // Free's spent daily budget: Stop works without a wake, and the message never goes out.
    refusal = "cloud_budget_limit";
    let refusedAt = wakes();
    skipBackoff();
    expect((await request(`/threads/${thread.id}/send`, { requestId: "over-limit", mode: "auto", input: [{ type: "text", text: "Not now", mentions: [] }] })).status).toBe(200);
    await waitFor(() => wakes() > refusedAt, "refused for the budget");
    harness.deps.db.insert(cloudroomCommands).values({ id: "edit-queued", threadId: thread.id, command: "edit", input: JSON.stringify({ target_request_id: harness.deps.db.select().from(cloudroomCommands).all().find(item => item.id.endsWith("_over-limit"))!.id, expected_revision: 1, text: "Not now, edited" }), createdAt: Date.now() + 1 }).run();
    // A delivery is preparing to wake the sandbox for the message, copying logins first, when Stop lands. Every login is
    // skipped, so no real one is read.
    const allLogins = new Set(["codex", "pi", "opencode", "hermes", "devin", "kimi", "openclaw", "agent-zero", "cursor", "github"]);
    let releaseLogins: (() => void) | null = null;
    service.sandboxes.skipLogins = () => releaseLogins ? Promise.resolve(allLogins) : new Promise(resolve => { releaseLogins = () => resolve(allLogins); });
    await setCopyLogins(harness.deps, true);
    skipBackoff();
    await waitFor(() => releaseLogins !== null, "delivery preparing a wake");
    const stopped = await request(`/threads/${thread.id}/stop`, {});
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    expect(getThread(harness.deps.db, thread.id)?.status).toBe("idle");
    // The message's queue edit goes with it. Other commands that don't run the agent, like a reorder, wait for the next
    // wake with the stop instead of waking the sandbox now.
    expect([commandState("over-limit"), commandState("edit-queued")]).toEqual(["cancelled", "cancelled"]);
    harness.deps.db.insert(cloudroomCommands).values({ id: "reorder-stopped", threadId: thread.id, command: "reorder", input: JSON.stringify({ order: ["follow-up"] }), createdAt: Date.now() + 2 }).run();
    const stoppedAt = wakes();
    skipBackoff();
    (releaseLogins as (() => void) | null)?.();
    await new Promise(resolve => setTimeout(resolve, 3200));
    expect(wakes()).toBe(stoppedAt);
    // Out of credits, the same. A message edit and a goal waiting to go out run the agent too.
    refusal = "cloud_usage_limit";
    refusedAt = wakes();
    skipBackoff();
    harness.deps.db.insert(cloudroomCommands).values([
      { id: "edit-over-limit", threadId: thread.id, command: "rewind", input: JSON.stringify({ before: "checkpoint", replacement: { request_id: "edited", text: "Edited" } }), createdAt: Date.now() + 1 },
      { id: "goal-over-limit", threadId: thread.id, command: "goal", input: JSON.stringify({ status: "active" }), createdAt: Date.now() + 2 },
    ]).run();
    await waitFor(() => wakes() > refusedAt, "refused for the limit");
    expect((await request(`/threads/${thread.id}/stop`, {})).status).toBe(200);
    expect(["edit-over-limit", "goal-over-limit"].map(commandState)).toEqual(["cancelled", "cancelled"]);
    // Once the limit lifts, the next wake sends the stop to Core before the new work. The stopped work never goes out.
    refusal = null;
    skipBackoff();
    const resumed = await request(`/threads/${thread.id}/send`, { requestId: "after-limit", mode: "auto", input: [{ type: "text", text: "Go on", mentions: [] }] });
    expect(resumed.status, await resumed.clone().text()).toBeLessThan(300);
    await waitFor(() => prompts.some(id => id.endsWith("_after-limit")), "prompt after the limit");
    const paths = core.map(call => call.path);
    expect(paths.indexOf("/v1/sessions/cr_one/stop")).toBeGreaterThan(-1);
    expect(paths.indexOf("/v1/sessions/cr_one/stop")).toBeLessThan(paths.lastIndexOf("/v1/sessions/cr_one/prompts"));
    expect(prompts.some(id => /_(over-limit|unreachable-(storage_blocked|502|drop|core-down|sandbox_restoring))$/.test(id))).toBe(false);
    // This Core can't scope a stop to its turn, so the ones held while unreachable never go out.
    expect(harness.deps.db.select().from(cloudroomCommands).all().filter(item => item.command === "stop" && JSON.parse(item.input).guarded).map(item => item.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(paths.filter(path => /\/(rewind|goal)$/.test(path))).toEqual([]);

    // Archive goes to the website, which stops the sandbox even mid-task, so the thread stops showing as running.
    saveStatus(harness.deps.db, thread.id, "active");
    service.sandboxes.forget(thread.id);
    const stops = () => core.filter(call => call.path === "/v1/sessions/cr_one/stop").length;
    const stopsBefore = stops();
    expect((await request(`/threads/${thread.id}/stop`, {})).status).toBe(200);
    expect(stops()).toBeGreaterThan(stopsBefore);
    expect((await harness.app.request(`/api/v1/threads/${thread.id}/archive-all`, { method: "POST" })).status).toBeLessThan(300);
    await waitFor(() => website.some(call => call.action === "archive" && call.thread === thread.id), "archive");
    expect(getThread(harness.deps.db, thread.id)?.status).toBe("idle");
    // Stopping it afterwards has nothing to do.
    expect((await request(`/threads/${thread.id}/stop`, {})).status).toBe(200);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
}, 20_000);

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
    // thread, so the archived parent hears nothing of its new work. A view's wake at the same time sends no second one.
    const [sent] = await Promise.all([
      post(`/threads/${child.id}/send`, { requestId: "follow-up", mode: "auto", input: [{ type: "text", text: "Continue", mentions: [] }] }),
      post(`/cloudroom/threads/${child.id}/wake`, { reason: "view" }),
    ]);
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    await waitFor(() => core.includes("/v1/sessions/cr_child/prompts"), "prompt delivery");
    expect(calls("restore")).toEqual([parent.id, parent.id]);
    expect(core.indexOf("/v1/sessions/cr_child/detach")).toBeGreaterThan(-1);
    expect(core.indexOf("/v1/sessions/cr_child/detach")).toBeLessThan(core.indexOf("/v1/sessions/cr_child/prompts"));

    // Another computer archives it again. The Undo here is done, so a view leaves that archive alone (#2246).
    state = "archived";
    service.sandboxes.forget(parent.id);
    const viewed = calls("wake").length;
    await post(`/cloudroom/threads/${child.id}/wake`, { reason: "view" });
    await waitFor(() => calls("wake").length > viewed, "the view's wake");
    expect(calls("restore")).toEqual([parent.id, parent.id]);

    // Archiving its last active thread archives the sandbox again.
    expect((await post(`/threads/${child.id}/archive-all`)).status).toBe(200);
    await waitFor(() => calls("archive").length === 2, "second sandbox archive");
    expect(calls("archive")).toEqual([parent.id, parent.id]);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
});

it("viewing a thread open here never restores an archive without an Undo here, and the list then archives it here (#2246)", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const website: { action: string; thread?: string }[] = [];
  const [done, parent, child] = [null, null, "parent"].map(() => createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" }));
  harness.deps.db.update(threads).set({ parentThreadId: parent!.id }).where(eq(threads.id, child!.id)).run();
  harness.deps.db.insert(cloudroomThreads).values([[done!, done!, "cr_done"], [parent!, parent!, "cr_parent"], [child!, parent!, "cr_child"]].map(([thread, sandbox, session]) =>
    ({ threadId: (thread as typeof done)!.id, coreUrl: `sandbox:${(sandbox as typeof done)!.id}`, sessionId: session as string, startRequestId: session as string, model: "test-model", reasoning: "medium" }))).run();
  // The list already took the parent's archive and is still applying it, so the parent and its shared child are open here.
  const account = "11111111-1111-4111-8111-111111111111";
  await writeFile(join(harness.deps.config.dataDir, "cloudroom-thread-sync.json"), JSON.stringify({ account, archived: [parent!.id] }));
  const at = new Date().toISOString();
  // `done`'s agent archived it when its turn ended; the list shows that only after the view.
  const archivedRow = { thread: done!.id, session: "cr_done", project: project.id, project_name: project.name, repository: null, title: null, state: "archived", sandbox: null, harness: "codex", model: "test-model", reasoning: "medium", parent: null, parent_state: null, loop: false, created_at: at, woke_at: null, updated_at: at };
  const websiteServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const input = await body(req);
    website.push({ action: input.action, thread: input.thread });
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "threads") return json({ threads: website.some(call => call.action === "wake" && call.thread === done!.id) ? [archivedRow] : [], next: `${new Date().toISOString()}~`, more: false });
    if (input.action === "awake") return json({ sandboxes: [], recheck_ms: 60_000 });
    if (input.action === "wake") return json({ error: "This thread is archived. Restore it to continue.", code: "sandbox_archived" }, 409);
    return json({ thread: input.thread, state: "archived", generation: 1, issue: null });
  });
  const websiteUrl = await listen(websiteServer);
  try {
    await service.configure(null, { id: account, email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    // Each view's wake finds its sandbox archived (the parent's second from the website's refusal, kept a while) and
    // keeps the archive: it asks for the list instead of restoring.
    const kept = vi.spyOn(service.sync, "changed");
    for (const viewed of [done!, parent!, child!]) {
      const before = kept.mock.calls.length;
      await harness.app.request(`/api/v1/cloudroom/threads/${viewed.id}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "view" }) });
      await waitFor(() => kept.mock.calls.length > before || website.some(call => call.action === "restore"), "the view's wake");
    }
    await waitFor(() => getThread(harness.deps.db, done!.id)?.archivedAt != null, "the list to archive the thread here", 10_000);
    expect(website.map(call => call.action)).not.toContain("restore");
  } finally {
    service.stop();
    websiteServer.close();
  }
}, 20_000);

it("archiving a working child whose parent, even a hidden fork, keeps the sandbox open stops the child's agent, and only it", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const website: string[] = [];
  const core: string[] = [];
  let coreUrl = "", sandbox = "";
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    core.push(req.url!);
    const input = await body(req);
    const command = req.url?.match(/^\/v1\/sessions\/cr_child\/(stop|sleep)$/)?.[1];
    if (command) return json({ session_id: "cr_child", receipt: { request_id: input.request_id, command, input: {}, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const input = await body(req);
    website.push(input.action ?? input.name);
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "awake") return json({ sandboxes: [{ thread: sandbox, origin: coreUrl, token: "t".repeat(64) }] });
    return json({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64) });
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    // A hidden fork still keeps its own sandbox; only side chats sharing their source's sandbox don't (#2210).
    const source = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    const parent = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "active", visibility: "hidden", originKind: "fork", sourceThreadId: source.id });
    const child = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", parentThreadId: parent.id, status: "active" });
    sandbox = parent.id;
    harness.deps.db.insert(cloudroomThreads).values([
      { threadId: parent.id, coreUrl: `sandbox:${parent.id}`, sessionId: "cr_parent", startRequestId: "parent", model: "test-model", reasoning: "medium" },
      { threadId: child.id, coreUrl: `sandbox:${parent.id}`, sessionId: "cr_child", startRequestId: "child", model: "test-model", reasoning: "medium" },
    ]).run();

    expect((await harness.app.request(`/api/v1/threads/${child.id}/archive-all`, { method: "POST" })).status).toBe(200);
    await waitFor(() => core.includes("/v1/sessions/cr_child/sleep"), "child stop and sleep");
    expect(core.filter(path => /\/(stop|sleep)$/.test(path))).toEqual(["/v1/sessions/cr_child/stop", "/v1/sessions/cr_child/sleep"]);
    expect(website).not.toContain("archive");
    expect(getThread(harness.deps.db, child.id)?.status).toBe("idle");
    expect(binding(harness.deps.db, child.id)?.queuePaused).toBe(true);
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

it("Connect Claude writes its token only to the Cloudroom sign-in it started under (#1924)", async () => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const a = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.com" }, b = { id: "22222222-2222-4222-8222-222222222222", email: "b@example.com" };
  const vmWrites: string[] = [];
  let switchBack = false, uploads = 0;
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    // ...then back to A while B's VM answers.
    if (req.url === "/v1/capabilities" && switchBack && req.headers.authorization === `Bearer ${"b".repeat(64)}`) await service.configure({ url: coreUrl, token: "a".repeat(64) }, a, undefined, websiteUrl, "a".repeat(64));
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, claude_auth: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url === "/v1/accounts/claude/token") { vmWrites.push(String(req.headers.authorization)); return json({ state: "connected", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null }, 202); }
    json({});
  });
  const coreUrl = await listen(coreServer);
  let switchOnUpload = false;
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    if (input.name === "claude") uploads += 1;
    // The user switches to B while A's upload is in flight...
    if (input.name === "claude" && switchOnUpload) await service.configure({ url: coreUrl, token: "b".repeat(64) }, b, undefined, websiteUrl, "b".repeat(64));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(input.action === "mode" ? { sandboxes: true } : { saved: true, claude: false, codex: false, pi: false, github: false }));
  });
  const websiteUrl = await listen(websiteServer);
  const token = "sk-ant-oat01-fake-token";
  try {
    // Older VM accounts have no sandbox sign-in: A's token never reaches B's VM.
    await service.configure({ url: coreUrl, token: "a".repeat(64) }, a);
    const ownerA = await service.loginOwner();
    await service.configure({ url: coreUrl, token: "b".repeat(64) }, b);
    await expect(service.claudeAuth("token", "req-1", token, undefined, false, ownerA)).rejects.toThrow("The Cloudroom account changed");
    expect(vmWrites).toEqual([]);
    await service.claudeAuth("token", "req-2", token, undefined, false, await service.loginOwner());
    expect(vmWrites).toEqual([`Bearer ${"b".repeat(64)}`]);
    // Started signed out: nothing is written anywhere.
    await expect(service.claudeAuth("token", "req-3", token, undefined, false, null)).rejects.toThrow("Sign in");
    // Signing in again to the same account rotates its tokens; the pending sign-in still saves to it.
    vmWrites.length = 0;
    await service.configure({ url: coreUrl, token: "a".repeat(64) }, a, undefined, websiteUrl, "a".repeat(64));
    const ownerA2 = await service.loginOwner();
    await service.configure({ url: coreUrl, token: "c".repeat(64) }, a, undefined, websiteUrl, "c".repeat(64));
    await service.claudeAuth("token", "req-4", token, undefined, false, ownerA2);
    expect(uploads).toBe(1);
    expect(vmWrites).toEqual([`Bearer ${"c".repeat(64)}`]);
    // A to B during A's website upload, back to A while B's VM answers: B's VM never gets A's token.
    vmWrites.length = 0;
    await service.configure({ url: coreUrl, token: "a".repeat(64) }, a, undefined, websiteUrl, "a".repeat(64));
    switchOnUpload = switchBack = true;
    await service.claudeAuth("token", "req-5", `${token}-2`, undefined, false, await service.loginOwner());
    expect(uploads).toBe(2);
    expect(vmWrites).toEqual([]);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
});

it("a login copy started under one Cloudroom account never finishes under the next (#1940)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "login-switch-"));
  const { SandboxDirectory, cloudClaudeEnvironment } = await import("../../src/services/cloudroom/sandboxes.js");
  // This Mac: Claude signed out, and Codex and Pi signed in (one fake file for both). HOME is empty.
  await writeFile(join(dir, "claude"), "#!/bin/sh\necho '{\"loggedIn\":false}'\n", { mode: 0o755 });
  await writeFile(join(dir, "auth.json"), "{}");
  for (const [name, value] of [["PATH", `${dir}:${process.env.PATH}`], ["HOME", dir], ["CODEX_HOME", dir], ["PI_CODING_AGENT_DIR", dir]]) vi.stubEnv(name, value);
  const a = { userId: "a", token: "a".repeat(64) }, b = { userId: "b", token: "b".repeat(64) };
  let signedIn = a, switchOn = "", resetOn = "", resetOnRead = false;
  const toB: string[] = [], reads: typeof a[] = [];
  const website = createServer(async (req, res) => {
    const input = await body(req);
    if (req.headers.authorization?.includes(Buffer.from(`b:${b.token}`).toString("base64"))) toB.push(`${input.action ?? "save"} ${input.name ?? ""}`);
    // The user switches to B while A's request is in flight.
    if (switchOn && `${input.action ?? "save"} ${input.name}` === switchOn) { switchOn = ""; signedIn = b; directory.reset(); }
    // A to B and back to A, both resets landing on the next account read.
    if (resetOn && `${input.action ?? "save"} ${input.name}` === resetOn) { resetOn = ""; resetOnRead = true; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(input.action === "status" ? { claude: true, codex: true, pi: false, github: false } : { value: JSON.stringify({ token: "sk-ant-oat01-fake-a" }), saved: true }));
  });
  const url = await listen(website);
  const directory = new SandboxDirectory(async () => {
    if (resetOnRead) { resetOnRead = false; directory.reset(); }
    return { website: url, ...(reads.shift() ?? signedIn) };
  });
  const asA = () => ({ account: { website: url, ...a }, signal: AbortSignal.timeout(5_000) });
  try {
    // Cloud → Mac: A's Claude login never becomes this Mac's while B is signed in.
    switchOn = "get claude";
    await expect(directory.copyCloudLogins(true)).rejects.toThrow("account changed");
    expect(cloudClaudeEnvironment()).toEqual([]);
    // Mac → cloud: a copy A started stops at the switch, so B gets nothing from it.
    signedIn = a; switchOn = "save codex";
    directory.skipLogins = async () => new Set(["claude", "opencode", "hermes", "devin", "kimi", "openclaw", "agent-zero", "cursor", "github"]);
    await expect(directory.copyMacLogins(true)).rejects.toThrow("account changed");
    expect(toB).toEqual([]);
    // A → B → A between two account reads: A's login is never sent as B.
    signedIn = a; reads.push(b, a);
    await expect(directory.saveLogin("cursor", "{}", asA())).rejects.toThrow("account changed");
    expect(toB).toEqual([]);
    // Switched to B during A's own save: B's save of the same value still uploads.
    reads.length = 0; switchOn = "save cursor";
    await directory.saveLogin("cursor", "{}", asA());
    await directory.saveLogin("cursor", "{}");
    expect(toB).toEqual(["save cursor"]);
    // A → B → A just before the Codex write: the copy stops and this Mac gets no Codex login.
    signedIn = a; resetOn = "get codex";
    vi.stubEnv("CODEX_HOME", join(dir, "codex"));
    directory.skipLogins = async () => new Set(["claude"]);
    await expect(directory.copyCloudLogins(true)).rejects.toThrow("account changed");
    await expect(readFile(join(dir, "codex", "auth.json"))).rejects.toThrow("ENOENT");
  } finally {
    vi.unstubAllEnvs();
    website.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  { mode: { sandboxes: true, plan: "free" }, plan: "free", usage: true, queue: null },
  { mode: { sandboxes: true, plan: "free", queue: { position: 3, total: 9 } }, plan: "free", usage: false, queue: { position: 3, total: 9, regionBlocked: false } },
])("a sandbox-only account with no Cloud threads loads its plan, usage and queue from status alone (#864) %#", async ({ mode, plan, usage, queue }) => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const asked: string[] = [];
  const website = createServer(async (req, res) => {
    const input = await body(req);
    asked.push(input.action);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(input.action === "mode" ? mode : input.action === "usage" ? { plan: "free", credits: 5, credits_limit: 10 } : {}));
  });
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, await listen(website), "a".repeat(64));
    await vi.waitFor(async () => expect(await service.status()).toMatchObject({ plan, cloudQueue: queue, planUsage: usage ? expect.objectContaining({ plan: "free", credits: 5 }) : null }));
    await service.status();
    expect(asked.filter(action => action === "mode")).toHaveLength(1);
  } finally { service.stop(); website.close(); await harness.cleanup(); }
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
  // Workspace lookups: the copy plan, then the `room-cli files wait` status, then the copy itself starting. The copy's
  // heartbeat (#2168) starts at once and moves no files.
  const copyStarted = () => core.filter(path => path.startsWith("/v1/workspaces/") && !path.endsWith("/alive")).length >= 3;
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

it("tells Core a new thread's project copy is coming, so its agent starts in the copied folder (ADR 0209)", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cloudroom-copy-coming-"));
  await writeFile(join(folder, "AGENTS.md"), "small project not on GitHub");
  for (const supported of [true, false]) {
    const harness = await createTestAppHarness();
    const { host } = seedHostSession(harness.deps);
    const copied = seedProjectWithSource(harness.deps, { hostId: host.id, path: folder, name: "Copied" }).project;
    // No folder on the Mac and no GitHub remote: nothing to copy.
    const empty = seedProjectWithSource(harness.deps, { hostId: host.id, path: join(folder, "missing"), name: "Empty" }).project;
    const service = cloudroom(harness.deps);
    const core: { path: string; input?: Record<string, unknown> }[] = [];
    let coreUrl = "";
    const coreServer = createServer(async (req, res) => {
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, command_guard: true, project_copy: supported, harnesses: [{ id: "codex", model: "test-model" }] });
      if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
      const input = await body(req);
      core.push({ path: req.url!, input });
      if (req.url === "/v1/sessions") return json({ session_id: `cr_${input.request_id}`, receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202);
      if (req.url?.includes("/prompts")) return json({ session_id: "cr_x", receipt: { request_id: input.request_id, command: "prompt", input, state: "accepted" }, saving: {} }, 202);
      return json({}, 404);
    });
    const websiteServer = createServer(async (req, res) => {
      const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      const input = await body(req);
      if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
      if (input.action === "secrets") return json({ secrets: null });
      json({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64) });
    });
    coreUrl = await listen(coreServer);
    const websiteUrl = await listen(websiteServer);
    try {
      await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
      const threads: Record<string, string> = {};
      // A child of a Cloud thread gets its parent's code, even where its project has nothing to copy.
      for (const [requestId, project, parent] of [["copy-coming", copied], ["nothing-to-copy", empty], ["child", empty, "nothing-to-copy"]] as const) {
        const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId, projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, ...(parent ? { parentThreadId: threads[parent] } : {}), input: [{ type: "text", text: "test", mentions: [] }] }) });
        expect(created.status, await created.clone().text()).toBe(201);
        threads[requestId] = (await created.json() as { id: string }).id;
        await waitFor(() => core.some(call => call.path === "/v1/sessions" && call.input?.request_id === requestId), `start ${requestId}`);
      }
      const start = (requestId: string) => core.find(call => call.path === "/v1/sessions" && call.input?.request_id === requestId)!;
      expect(start("copy-coming").input?.project_copy).toBe(supported ? true : undefined);
      expect(start("nothing-to-copy").input?.project_copy).toBeUndefined();
      expect(start("child").input?.project_copy).toBe(supported ? true : undefined);
      // The copy is planned before the start says it is coming.
      if (supported) expect(core.findIndex(call => call.path.startsWith("/v1/workspaces/"))).toBeLessThan(core.indexOf(start("copy-coming")));
    } finally {
      service.stop();
      coreServer.close(); websiteServer.close();
      await harness.cleanup();
    }
  }
  await rm(folder, { recursive: true, force: true });
});

// #816: an existing checkout (a project template) needs only its branch; a fresh folder gets a clone first. A failed or
// killed branch switch ends as failed. A failed check or status write holds the first message until a retry marks it,
// and one that keeps failing fails the start. A Personal child's folder comes from its session.
it.each([
  ["existing checkout", null], ["fresh clone", null], ["existing checkout", "index.lock"], ["existing checkout", "terminated"],
  ["existing checkout", "checkout probe"], ["personal child", "checkout probe"], ["existing checkout", "status write"], ["existing checkout", "status write x3"],
  ["existing checkout", "agent branch"], ["child", null], ["child", "agent branch"], ["fresh clone", "clone 504"], ["existing checkout", "branch dropped"], ["existing checkout", "workspace slow"], ["child", "workspace late"],
] as const)("`room-cli files wait` reads a new thread's %s as copying until its branch and files are ready (#816, fault: %s)", async (kind, fault) => {
  const root = await mkdtemp(join(tmpdir(), "cloudroom-files-ready-"));
  const folder = join(root, "project"), origin = join(root, "origin.git"), mac = join(root, "mac");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=A", ...args], { cwd, encoding: "utf8" }).trim();
  await mkdir(folder); await mkdir(mac);
  git(root, "init", "-q", "-b", "main", "seed");
  for (let i = 0; i < 20; i++) await writeFile(join(root, "seed", `file${i}.txt`), `${i}\n`);
  git(join(root, "seed"), "add", "-A"); git(join(root, "seed"), "commit", "-q", "-m", "Base");
  git(root, "clone", "-q", "--bare", "seed", origin);
  if (kind !== "fresh clone") git(root, "clone", "-q", origin, folder);
  // A Cloud child in a sandbox of its own gets its parent's code, committed here, once its copy lands.
  const source = join(root, "parent");
  if (kind === "child") { git(root, "clone", "-q", origin, source); await writeFile(join(source, "file0.txt"), "parent\n"); git(source, "commit", "-qam", "Parent work"); }
  if (fault === "index.lock") await writeFile(join(folder, ".git", "index.lock"), "");
  let faults = fault === "status write x3" || fault === "clone 504" ? 99 : 1;
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project: own } = seedProjectWithSource(harness.deps, { hostId: host.id, path: mac });
  const project = kind === "personal child" ? { id: PERSONAL_PROJECT_ID } : own;
  const parent = kind.endsWith("child") ? createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" }) : null;
  if (parent) harness.deps.db.insert(cloudroomThreads).values({ threadId: parent.id, coreUrl: `sandbox:${parent.id}`, sessionId: kind === "child" ? "cr_parent" : null, startRequestId: "parent", model: "test-model", reasoning: "medium" }).run();
  setProjectGitRemoteUrlIfMissing(harness.db, harness.deps.hub, project.id, "https://github.com/example/project");
  await setCopyMacGithub(harness.deps, false);
  const service = cloudroom(harness.deps);
  const marker = () => readFile(`${folder}.cloudroom-files`, "utf8").catch(() => null);
  const checkout = () => ({ branch: spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: folder, encoding: "utf8" }).stdout.trim(), status: spawnSync("git", ["status", "--porcelain"], { cwd: folder, encoding: "utf8" }).stdout.trim() });
  let atFirstPrompt: string | null | undefined, atDone: { marker: string } & ReturnType<typeof checkout> | undefined, coreUrl = "";
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, root_workspace: true, command_guard: true, harnesses: [{ id: "codex", model: "test-model" }] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    if (req.url?.startsWith("/v1/workspaces/")) return json({ id: decodeURIComponent(req.url.split("/")[3]!), path: folder });
    if (req.url === "/v1/sessions/cr_parent/workspace") return json({ path: source, branch: "main", head: "head" });
    // A child's code is uploaded raw, in pieces.
    if (req.url?.startsWith("/v1/vm/run/raw?")) {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const result = spawnSync("/bin/bash", ["-c", new URL(req.url, "http://core").searchParams.get("command")!], { input: Buffer.concat(chunks) });
      return json({ code: result.status, stdout: result.stdout.toString("hex"), stderr: result.stderr.toString("hex"), truncated: false });
    }
    // Branch setup's workspace read outlasts the client's own deadline once, shortened below (#2023).
    if (req.url === "/v1/sessions/cr_one/workspace" && fault?.startsWith("workspace") && await marker() === "copying" && faults-- > 0) await new Promise(resolve => setTimeout(resolve, 3_000));
    if (req.url === "/v1/sessions/cr_one/workspace") return fault === "checkout probe" && faults-- > 0 ? json({ error: "busy" }, 500) : json({ path: folder, branch: null, head: checkout().branch ? "head" : null });
    const input = await body(req);
    if (req.url?.split("?")[0] === "/v1/vm/run") {
      // Core runs it in bash; the "GitHub" clone comes from a local repository. The thread's branch setup is slow.
      const command = String(input.command).replaceAll("https://github.com/example/project", origin);
      if (fault?.startsWith("status write") && command.includes(".cloudroom-files") && faults-- > 0) return json({ code: 1, stdout: "", stderr: Buffer.from("disk full").toString("hex"), truncated: false });
      // The agent made its own branch before the thread's branch setup ran: it must stay there (#1377).
      if (fault === "agent branch" && command.includes("git checkout -q -b")) { git(folder, "checkout", "-q", "-b", "feature"); await writeFile(join(folder, "agent.txt"), "agent\n"); git(folder, "add", "-A"); git(folder, "commit", "-qm", "Agent work"); }
      if (command.includes("git checkout -q -b")) await new Promise(resolve => setTimeout(resolve, 800));
      // A proxy's 504 cuts off every clone's answer. Core keeps only a clone it was asked to keep (#1970), which lands a
      // moment later (#1524); any other dies with its request.
      if (fault === "clone 504" && command.includes("git clone") && faults-- > 0) {
        if (req.url.endsWith("?keep=true")) spawn("/bin/bash", ["-c", command.replace("git clone", "sleep 2 && git clone")], { cwd: root, stdio: "ignore" });
        await new Promise(resolve => setTimeout(resolve, 300));
        return void res.writeHead(504).end("Gateway Timeout");
      }
      // Killed mid-setup (say, SIGTERM): no exit code, no output.
      if (fault === "terminated" && command.includes("git checkout -q -b")) return json({ code: null, stdout: "", stderr: "", truncated: false });
      const result = spawnSync("/bin/bash", ["-c", command], { cwd: input.cwd ?? root, input: Buffer.from(input.stdin ?? "", "hex") });
      // The branch switch ran, but its answer is lost with the connection (#1524).
      if (fault === "branch dropped" && command.includes("git checkout -q -b") && faults-- > 0) return void req.socket.destroy();
      const state = await marker();
      if (state && state !== "copying") atDone ??= { marker: state, ...checkout() };
      return json({ code: result.status, stdout: result.stdout.toString("hex"), stderr: result.stderr.toString("hex"), truncated: false });
    }
    // Only this thread starts here; the Personal child's parent stays without a session, so it has no code to bring.
    if (req.url === "/v1/sessions" && input.request_id !== "files-ready") return json({ error: "other thread" }, 400);
    if (req.url === "/v1/sessions") return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "start", input, state: "accepted" }, saving: {} }, 202);
    if (req.url?.startsWith("/v1/sessions/cr_one/prompts")) {
      if (atFirstPrompt === undefined) atFirstPrompt = await marker();
      return json({ session_id: "cr_one", receipt: { request_id: input.request_id, command: "prompt", input, state: "accepted" }, saving: {} }, 202);
    }
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const input = await body(req);
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    json({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64), secrets: [] });
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  // `workspace late`: the retry window (3.5 of the copy's 9 minutes) closes before the read times out, so a retry that
  // would answer just before the deadline, and then switch the branch after it, never starts.
  const later = setTimeout, short: Record<number, number> = fault === "workspace late" ? { 30_000: 2_000, 210_000: 1_000 } : { 30_000: 2_000 };
  if (fault?.startsWith("workspace")) vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(short[ms] ?? ms));
  if (fault === "workspace late") vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms?: number, ...args: unknown[]) => later(run, ms === 9 * 60_000 ? 8_000 : ms, ...args)) as typeof setTimeout);
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    const created = await harness.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionTarget: "cloud", requestId: "files-ready", title: "Files ready", projectId: project.id, parentThreadId: parent?.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: [{ type: "text", text: "test", mentions: [] }] }) });
    expect(created.status, await created.clone().text()).toBe(201);
    if (fault === "status write x3") {
      const thread = (await created.json()) as { id: string };
      await waitFor(() => command(harness.deps.db, `first_${thread.id}`)?.state === "failed", "failed start", 20_000);
      expect({ prompt: atFirstPrompt, error: binding(harness.deps.db, thread.id)?.error }).toEqual({ prompt: undefined, error: expect.stringContaining("could not prepare the project folder: disk full") });
      return;
    }
    await waitFor(() => atFirstPrompt !== undefined, "first message");
    // The agent's first `room-cli files wait` must wait: with no status, a folder with files reads as nothing running.
    expect(atFirstPrompt).toBe("copying");
    if (fault === "workspace late") {
      for (let i = 0; i < 400 && !(await marker())?.startsWith("failed"); i++) await new Promise(resolve => later(resolve, 25));
      // It fails at once, as main does, and nothing changes the branch or the marker after the deadline.
      await new Promise(resolve => later(resolve, 8_000));
      expect({ marker: await marker(), branch: checkout().branch }).toEqual({ marker: expect.stringMatching(/^failed: Cloudroom could not set up the thread's branch .*: Cloudroom request cancelled or timed out$/), branch: "main" });
      return;
    }
    await waitFor(() => atDone !== undefined, "ready or failed", 15_000);
    if (fault === "index.lock" || fault === "terminated") expect(atDone).toMatchObject({ marker: expect.stringMatching(fault === "index.lock" ? /^failed: Cloudroom could not switch the folder to the thread's branch room\/.*, so it is still on main\. Git said: .*index\.lock/s : /^failed: .*Git said: exit code null$/), branch: "main" });
    // The child's parent has no folder, so its code (none) ends as failed, after the branch.
    // The agent's own branch keeps its commit; a child's code lands only on the thread's branch (#1377).
    else if (fault === "agent branch") expect({ ...atDone, log: git(folder, "log", "--format=%s", "feature") }).toEqual({ marker: kind === "child" ? expect.stringMatching(/^failed: The folder was already on the agent's own branch feature/) : "ready", branch: "feature", status: "", log: "Agent work\nBase" });
    else expect(atDone).toEqual({ marker: kind === "personal child" ? expect.stringMatching(/^failed: The source thread's code was not copied/) : "ready", branch: expect.stringMatching(/^room\//), status: "" });
    if (kind === "child" && !fault) expect(git(folder, "log", "-1", "--format=%s")).toBe("Parent work");
    expect(await readdir(folder)).toContain("file19.txt");
  } finally {
    vi.restoreAllMocks();
    service.stop();
    coreServer.close(); websiteServer.close();
    await harness.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("tells the user to remove forced API login when Codex refuses ChatGPT sign-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-forced-api-"));
  const path = process.env.PATH, codexHome = process.env.CODEX_HOME;
  try {
    // Same output and exit code as the real `codex login` with `forced_login_method = "api"`.
    await writeFile(join(dir, "codex"), "#!/bin/sh\necho 'ChatGPT login is disabled. Use API key login instead.' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${dir}:${path}`;
    process.env.CODEX_HOME = dir;
    const { macCodexLogin, startMacCodexLogin } = await import("../../src/services/cloudroom/sandboxes.js");
    // Codex is found, so the install deps go unused.
    const run = startMacCodexLogin({} as never);
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

    const deliveries = vi.spyOn((service as unknown as { delivery: { deliverPending: (id: string) => Promise<void> } }).delivery, "deliverPending");
    const failing = count("awake");
    await waitFor(() => count("awake") > failing, "another failed awake check");
    await new Promise(resolve => setTimeout(resolve, 1_600));
    expect(deliveries.mock.calls.some(([id]) => id === threads[2]!.id)).toBe(true);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
}, 20_000);

it("a sleeping thread costs no delivery work until it wakes, opening it connects without waiting for the awake list, and a refused wake keeps its reason", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const streams: import("node:http").ServerResponse[] = [];
  const cursors: number[] = [];
  let coreUrl = "";
  const coreServer = createServer((req, res) => {
    if (req.url === "/v1/sessions/cr_0") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ session: { session_id: "cr_0", harness: "codex", state: "idle", native_id: null, current_request: null, last_sequence: 0, queue: [], receipts: {} } }));
    }
    if (req.url?.includes("/stream?")) {
      cursors.push(Number(new URL(req.url, "http://localhost").searchParams.get("after")));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.push(res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}");
  });
  const limit = "You used the Free plan's 25 hours. Upgrade at cloudroom.dev/billing, or wait.";
  let refused = "";
  const exits: unknown[] = [];
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    if (input.action === "wake" && input.thread === refused) exits.push(input.trigger);
    res.writeHead(input.action === "wake" && input.thread === refused ? 429 : 200, { "Content-Type": "application/json" });
    if (req.url === "/api/desktop/logins") return res.end(JSON.stringify({ claude: false, codex: false, pi: false, github: false }));
    if (input.action === "awake") return res.end(JSON.stringify({ sandboxes: [], recheck_ms: 60_000 }));
    if (input.action === "wake" && input.thread === refused) return res.end(JSON.stringify({ error: limit, code: "cloud_usage_limit" }));
    if (input.action === "wake") return res.end(JSON.stringify({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64) }));
    res.end(JSON.stringify({ thread: input.thread, state: "asleep", generation: 1, issue: null }));
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  const cursor = (threadId: string) => harness.deps.db.select().from(cloudroomThreads).all().find(row => row.threadId === threadId)?.cursor;
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    const threads = Array.from({ length: 3 }, () => createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" }));
    harness.deps.db.insert(cloudroomThreads).values(threads.map((thread, i) => ({ threadId: thread.id, coreUrl: `sandbox:${thread.id}`, sessionId: `cr_${i}`, startRequestId: `start_${i}`, model: "test-model", reasoning: "medium" }))).run();
    const deliveries = vi.spyOn((service as unknown as { delivery: { deliverPending: (id: string) => Promise<void> } }).delivery, "deliverPending");

    await new Promise(resolve => setTimeout(resolve, 4_000));
    expect(deliveries.mock.calls.map(([id]) => id).sort()).toEqual(threads.map(thread => thread.id).sort());
    expect(streams).toEqual([]);

    await service.wakeAhead(threads[0]!.id, "thread_view");
    await waitFor(() => streams.length === 1, "stream for the thread opened here");
    streams[0]!.write(`id: 1\nevent: record\ndata: ${JSON.stringify({ sequence: 1, session_id: "cr_0", kind: "state", data: { state: "idle" } })}\n\n`);
    await waitFor(() => cursor(threads[0]!.id) === 1, "the stream's record to be saved");
    const settled = deliveries.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 3_200));
    expect(deliveries.mock.calls.length).toBe(settled);
    expect(streams).toHaveLength(1);

    streams[0]!.destroy();
    await waitFor(() => streams.length === 2, "the dropped stream to reconnect");
    expect(cursors).toEqual([0, 1]);

    refused = threads[2]!.id;
    for (let i = 0; i < 2; i++) {
      const run = await harness.app.request("/api/v1/cloudroom/vm/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "true", threadId: refused }) });
      expect([run.status, (await run.json()).message]).toEqual([429, limit]);
    }
    // Work leaving Cloud skips the backoff and asks as an exit, so the website can let it past the limit.
    const asked = exits.length;
    await expect(service.threadClient(refused, true, "teleport_local")).rejects.toThrow(limit);
    expect(exits.slice(asked)).toEqual(["teleport_local"]);
  } finally {
    service.stop();
    coreServer.closeAllConnections(); coreServer.close(); websiteServer.close();
  }
}, 25_000);

it("a thread cut off mid-turn is archived when the website archived its sandbox, as after its agent archived it while this computer slept", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const lookups: string[] = [];
  let archived = "";
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/desktop/logins") return res.end(JSON.stringify({ claude: false, codex: false, pi: false, github: false }));
    if (input.action === "awake") return res.end(JSON.stringify({ sandboxes: [], recheck_ms: 60_000 }));
    if (input.action === "lookup") lookups.push(input.thread);
    res.end(JSON.stringify({ thread: input.thread, state: input.thread === archived ? "archived" : "asleep", generation: 1, issue: null }));
  });
  const websiteUrl = await listen(websiteServer);
  try {
    // Three turns were running when this computer went to sleep. All three sandboxes are gone when it wakes.
    const [done, slept, old, idle] = ["active", "active", "active", "idle"].map(status => createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: status as "active" | "idle" }));
    archived = done!.id;
    harness.deps.db.insert(cloudroomThreads).values([done!, slept!, old!, idle!].map((thread, i) => ({ threadId: thread.id, coreUrl: `sandbox:${thread.id}`, sessionId: `cr_${i}`, startRequestId: `start_${i}`, model: "test-model", reasoning: "medium" }))).run();
    harness.deps.db.update(threads).set({ updatedAt: Date.now() - 7 * 86_400_000 }).where(eq(threads.id, old!.id)).run();
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));

    // The one whose sandbox the website archived is archived here too. The one that only sleeps stays, idle.
    await waitFor(() => Boolean(getThread(harness.deps.db, done!.id)?.archivedAt), "the finished thread to be archived");
    await waitFor(() => getThread(harness.deps.db, slept!.id)?.status === "idle" && getThread(harness.deps.db, old!.id)?.status === "idle", "the others to go idle");
    expect(getThread(harness.deps.db, slept!.id)?.archivedAt).toBeNull();
    // Last heard from a week ago, its sandbox may be archived as an old run: it stays, and nothing is asked.
    // A thread that was idle already costs no lookup either.
    await new Promise(resolve => setTimeout(resolve, 3_200));
    expect(lookups.sort()).toEqual([done!.id, slept!.id].sort());
    expect([old!, idle!].map(thread => getThread(harness.deps.db, thread.id)?.archivedAt)).toEqual([null, null]);
  } finally {
    service.stop();
    websiteServer.close();
  }
}, 20_000);

it("a message to a stopped thread is saved first, then resumes it once its restoring sandbox wakes (#534)", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const core: string[] = [];
  let restoring = true;
  let wakes = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let coreUrl = "";
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    core.push(req.url!);
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    // Live Core is newer than the app's saved capabilities: it has a fast tier and queue reordering.
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, queue_reorder: true, harnesses: [{ id: "codex", model: "test-model", service_tier: true }] });
    const input = await body(req);
    const command = req.url?.match(/^\/v1\/sessions\/cr_0\/(prompts|resume|reorder)/)?.[1];
    if (command) return json({ session_id: "cr_0", receipt: { request_id: input.request_id, command: command === "prompts" ? "prompt" : command, input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "awake") return json({ sandboxes: [], recheck_ms: 60_000 });
    // Wakes find the big saved copy still restoring until the test says it's done. The first answer waits for the test.
    if (input.action === "wake" && wakes++ === 0) await held;
    if (input.action === "wake" && restoring) return json({ error: "This thread is still coming back from its saved copy. It continues on its own.", code: "sandbox_restoring" }, 429);
    if (input.action === "wake") return json({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64) });
    json({ thread: input.thread, state: "asleep", generation: 1, issue: null });
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: `sandbox:${thread.id}`, sessionId: "cr_0", startRequestId: "start_0", model: "test-model", reasoning: "medium", queuePaused: true }).run();
    const send = (requestId: string, serviceTier?: "fast") => harness.app.request(`/api/v1/threads/${thread.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, mode: "auto", serviceTier, input: [{ type: "text", text: "Continue", mentions: [] }] }) });
    const sentTo = () => core.filter(path => /\/(prompts|resume|reorder)/.test(path)).map(path => path.split("/").at(-1)!.split("?")[0]);

    // Without saved capabilities the app must ask the sandbox first. Two attempts wait on its slow wake: a first try and a
    // new message.
    const asked = vi.spyOn((service as unknown as { rt: { liveCapabilities: () => Promise<unknown> } }).rt, "liveCapabilities");
    const slow = send("after-stop"), other = send("no-capabilities");
    await waitFor(() => asked.mock.calls.length === 2 && wakes === 1, "both attempts asking the sandbox");
    // Meanwhile a retry of the first, with saved capabilities, saves the message at once.
    await writeFile(join(harness.deps.config.dataDir, "cloudroom-capability-cache.json"), JSON.stringify({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, harnesses: [{ id: "codex", model: "test-model" }] }));
    const sent = await send("after-stop");
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    // The wake is refused: the slow first try says its message is saved, and only the new message says it was not sent.
    release();
    const [first, second] = await Promise.all([slow, other]);
    expect([first.status, (await first.json()).message]).toEqual([503, "This thread is still coming back from its saved copy. It continues on its own. This message is already saved (sending). Retry with the same request ID; don't send it as a new message."]);
    expect([second.status, (await second.json()).message]).toEqual([503, "This thread is still coming back from its saved copy. It continues on its own. Your message was not sent. Send it again in a moment."]);
    expect(core).toEqual([]);
    restoring = false;
    for (let i = 0; i < 60 && !core.some(path => path.startsWith("/v1/sessions/cr_0/resume")); i++) await new Promise(resolve => setTimeout(resolve, 250));
    expect(sentTo()).toEqual(["prompts", "resume"]);

    // The stale saved capabilities reject the fast tier, so the app asks live Core, and uses its answer for the queue too:
    // the new message jumps the prompt still waiting in the paused queue.
    expect((await send("fast", "fast")).status).toBeLessThan(300);
    await waitFor(() => sentTo().length === 5, "fast prompt, reorder and resume");
    expect(sentTo().slice(2)).toEqual(["prompts", "reorder", "resume"]);

    // A retry of that saved message, while the sandbox restores again, must not tell the user to send it as new.
    restoring = true;
    service.sandboxes.forget(thread.id);
    const retried = await send("fast", "fast");
    expect([retried.status, (await retried.json()).message]).toEqual([503, "This thread is still coming back from its saved copy. It continues on its own. This message is already saved (accepted). Retry with the same request ID; don't send it as a new message."]);
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
}, 20_000);

it("a saved message that meets a sandbox already gone (404) wakes it again instead of failing (#534)", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const core: string[] = [];
  let gone = true;
  let wakes = 0;
  let coreUrl = "";
  const coreServer = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    const input = await body(req);
    // An unarchive right after an archive: the first wakes get the old box's address, which is gone by the time the prompt lands (twice: #1076).
    if (gone) return json({ error: "preview not found" }, 404);
    core.push(req.url!);
    const command = req.url?.match(/^\/v1\/sessions\/cr_0\/(prompts|resume)/)?.[1];
    if (command) return json({ session_id: "cr_0", receipt: { request_id: input.request_id, command: command === "prompts" ? "prompt" : command, input, state: "accepted" }, saving: {} }, 202);
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "awake") return json({ sandboxes: [], recheck_ms: 60_000 });
    if (input.action === "wake") {
      if (++wakes > 2) gone = false;
      return json({ thread: input.thread, state: "awake", generation: wakes, issue: null, origin: coreUrl, token: "t".repeat(64) });
    }
    json({ thread: input.thread, state: "asleep", generation: 1, issue: null });
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    await writeFile(join(harness.deps.config.dataDir, "cloudroom-capability-cache.json"), JSON.stringify({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, harnesses: [{ id: "codex", model: "test-model" }] }));
    const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: `sandbox:${thread.id}`, sessionId: "cr_0", startRequestId: "start_0", model: "test-model", reasoning: "medium", queuePaused: true }).run();
    const sent = await harness.app.request(`/api/v1/threads/${thread.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "after-unarchive", mode: "auto", input: [{ type: "text", text: "Continue", mentions: [] }] }) });
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    await waitFor(() => core.some(path => path.startsWith("/v1/sessions/cr_0/resume")), "prompt and resume on the woken sandbox");
    expect(core.map(path => path.split("/").at(-1)!.split("?")[0])).toEqual(["prompts", "resume"]);
    expect(harness.deps.db.select().from(cloudroomCommands).all().find(row => row.id.endsWith("_after-unarchive"))?.state).toBe("accepted");
  } finally {
    service.stop();
    coreServer.close(); websiteServer.close();
  }
}, 20_000);

it("a Teleport check whose cached sandbox address stopped answering wakes it again and checks once more (#1840)", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id });
  const thread = seedThread(harness.deps, { projectId: project.id, environmentId: environment.id });
  seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: environment.id, providerThreadId: "native-1", model: "test-model" });
  const service = cloudroom(harness.deps);
  // The relay in front of a VPS sandbox, then a hosted one: what the old address answers once the sandbox slept or its Core stopped.
  const answers: [number, string][] = [[502, "cloudroom: tunnel client aborted: Error: connect ECONNREFUSED 127.0.0.1:20042"], [404, "{}"]];
  let [status, text] = answers[0]!, asleep = false, wakeHelps = true, wakes = 0, checks = 0;
  const relay = createServer((req, res) => {
    if (asleep) { res.writeHead(status, { "Content-Type": "text/plain" }); return void res.end(text); }
    if (req.url === "/v1/teleports/check") checks++;
    res.writeHead(202, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
  });
  const relayUrl = await listen(relay);
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/desktop/logins") return res.end(JSON.stringify({ claude: false, codex: false, pi: false, github: false }));
    if (input.action === "awake") return res.end(JSON.stringify({ sandboxes: [], recheck_ms: 60_000 }));
    if (input.action === "wake") { wakes++; asleep &&= !wakeHelps; }
    res.end(JSON.stringify({ thread: input.thread, state: "awake", generation: wakes, issue: null, origin: relayUrl, token: "t".repeat(64) }));
  });
  const websiteUrl = await listen(websiteServer);
  const check = () => harness.app.request(`/api/v1/cloudroom/threads/${thread.id}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "check" }) });
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    expect((await check()).status).toBe(200);
    expect({ wakes, checks }).toEqual({ wakes: 1, checks: 1 });
    for (const [i, answer] of answers.entries()) {
      [status, text] = answer; asleep = true;
      const response = await check();
      expect({ status: response.status, wakes, checks }, await response.text()).toEqual({ status: 200, wakes: i + 2, checks: i + 2 });
    }
    // A sandbox that stays unreachable is woken once, not again and again: the check fails as before.
    asleep = true; wakeHelps = false;
    const failed = await check();
    expect({ status: failed.status, wakes }).toEqual({ status: 409, wakes: 4 });
    expect(await failed.text()).toContain("Teleport would not start.");
  } finally {
    service.stop();
    relay.close(); websiteServer.close();
  }
}, 20_000);

it("Windows MCP paths and %VARIABLES% stay on this PC", async () => {
  const { WINDOWS_LOCAL_PATH } = await import("../../src/services/cloudroom/sandboxes.js");
  for (const local of ["C:\\tools\\server.js", "--root=D:/data", "\\\\server\\share", "%USERPROFILE%\\x", "%ProgramFiles(x86)%\\x", "%MCP_HOME2%"])
    expect(WINDOWS_LOCAL_PATH.test(local), local).toBe(true);
  for (const portable of ["npx", "-y", "@acme/mcp", "https://mcp.example.com/mcp", "50%"])
    expect(WINDOWS_LOCAL_PATH.test(portable), portable).toBe(false);
});

it("Mac-only MCP programs like xcrun stay on this Mac (#1244)", async () => {
  const { macMcpServers } = await import("../../src/services/cloudroom/sandboxes.js");
  const dir = await mkdtemp(join(tmpdir(), "mac-mcp-"));
  const stdio = (command: string, args: string[] = []) => ({ type: "stdio", command, args, env: {} });
  const servers = { xcode: stdio("xcrun", ["mcpbridge"]), build: stdio("xcodebuild"), apple: stdio("osascript", ["-e", "x"]), npx: stdio("npx", ["-y", "@acme/mcp"]), xcrunner: stdio("xcrunner"), remote: { type: "http", url: "https://mcp.example.com/mcp" } };
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ mcpServers: servers }));
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
  try {
    const found = Object.fromEntries((await macMcpServers()).filter(({ name }) => name in servers).map(({ name, server }) => [name, !server]));
    expect(found).toEqual({ xcode: true, build: true, apple: true, npx: false, xcrunner: false, remote: false });
  } finally { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
});
