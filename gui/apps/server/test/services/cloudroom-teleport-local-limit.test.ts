import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cloudroomCommands, cloudroomThreads, createThread, getThread, listQueuedThreadMessages } from "@cloudroom/db";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { binding, localTeleports } from "../../src/services/cloudroom/store.js";
import { resolveDeferredFirstTurnContext } from "../../src/services/threads/deferred-first-turn-context.js";
import { getLastProviderThreadId } from "../../src/services/threads/thread-events.js";
import { threadMessages } from "../../src/services/threads/thread-transcript.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource, seedThreadRuntimeState } from "../helpers/seed.js";

// The Cursor key check runs this computer's Cursor CLI, which rejects the tests' fake keys.
vi.mock("../../src/services/cloudroom/sandboxes.js", async (original) => ({ ...await original<object>(), cursorKeyRejected: async () => false }));

const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return `http://127.0.0.1:${address.port}`;
};
const body = async (req: import("node:http").IncomingMessage) => { let text = ""; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };
// The wake triggers the website accepts. It refuses any other with a 400, so a new one needs the website first.
const TRIGGERS = [undefined, "retry", "thread_view", "thread_typing", "sidebar_preload", "teleport_local"];
const waitFor = async (check: () => boolean, label: string, ms = 5_000) => {
  for (let i = 0; i < ms / 25 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  if (!check()) throw new Error(`timed out: ${label}`);
};

it("out of credits, Teleport to Local still asks the website, then moves the thread without its cloud session", async () => {
  const harness = await createTestAppHarness();
  const folder = await mkdtemp(join(tmpdir(), "teleport-limit-"));
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: folder });
  const checkout = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: folder });
  const service = cloudroom(harness.deps);
  const limit = "You used your Super plan's 150,000 Cloud Credits for the last 30 days.";
  const wakes: { thread: string; trigger?: string }[] = [];
  const core: string[] = [];
  let refusing = true;
  let coreUrl = "";
  const coreServer = createServer(async (req, res) => {
    core.push(req.url!);
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    const input = await body(req);
    const close = req.url?.match(/^\/v1\/sessions\/(cr_\d)\/close$/)?.[1];
    res.writeHead(close ? 202 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(close ? { session_id: close, receipt: { request_id: input.request_id, command: "close", input, state: "accepted" }, saving: {} } : {}));
  });
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "awake") return json({ sandboxes: [], recheck_ms: 60_000 });
    if (input.action === "mode") return json({ sandboxes: true, limited: true, plan: "super" });
    if (input.action === "wake" && !TRIGGERS.includes(input.trigger)) return json({ error: "Invalid activity trigger." }, 400);
    if (input.action === "wake") wakes.push({ thread: input.thread, trigger: input.trigger });
    if (input.action === "wake" && refusing) return json({ error: limit, code: "cloud_usage_limit" }, 429);
    if (input.action === "wake") return json({ thread: input.thread, state: "awake", generation: 1, issue: null, origin: coreUrl, token: "t".repeat(64) });
    json({ thread: input.thread, state: "asleep", generation: 1, issue: null });
  });
  const websiteUrl = await listen(websiteServer);
  coreUrl = await listen(coreServer);
  const texts = () => threadMessages(harness.deps.db, thread.id).map(message => message.text);
  const teleport = (value: Record<string, unknown>) => harness.app.request(`/api/v1/cloudroom/threads/${thread.id}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "claude-code", status: "idle" });
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: null, providerThreadId: "native-orchestrator", inputText: "Run the orchestrator for the main project" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: `sandbox:${thread.id}`, sessionId: "cr_0", startRequestId: "start_0", model: "claude-opus-5-5", reasoning: "high" }).run();
    // Sent after the credits ran out. With the sandbox's capabilities saved from earlier work, the message is saved and
    // shows as the next turn before any wake (#534), then never reaches the sandbox, since its delivery keeps hitting the limit.
    await writeFile(join(harness.deps.config.dataDir, "cloudroom-capability-cache.json"), JSON.stringify({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, workspaces: true, direct_workspaces: true, harnesses: [{ id: "claude-code", model: "claude-opus-5-5" }] }));
    const sent = await harness.app.request(`/api/v1/threads/${thread.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "stranded", mode: "auto", input: [{ type: "text", text: "Out of credits, keep going locally", mentions: [] }] }) });
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    await waitFor(() => wakes.length > 0, "a delivery wake refused for the limit");
    expect(texts()).toEqual(["Run the orchestrator for the main project", "Out of credits, keep going locally"]);

    // The thread now waits out a backoff. Each click on Teleport still asks the website, as work leaving Cloud, which the
    // website may let past the limit. Here it refuses anyway (say, today's exit is used up).
    for (let click = 1; click <= 2; click++) {
      const before = wakes.length;
      const refused = await teleport({ action: "local" });
      expect(refused.status).toBe(409);
      const error = await refused.json() as { code: string; message: string };
      expect(error.code).toBe("teleport_cloud_unavailable");
      expect(error.message).toContain(limit);
      expect(wakes.slice(before)).toEqual([{ thread: thread.id, trigger: "teleport_local" }]);
    }
    expect(getThread(harness.deps.db, thread.id)?.executionTarget).toBe("cloud");

    // The user chooses to move without the cloud session. It still asks first, since a sandbox that starts hands
    // everything over; refused, the thread runs here, in the project folder.
    const asked = wakes.length;
    const moved = await teleport({ action: "local", withoutCloud: true });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(wakes.length).toBe(asked + 1);
    const local = getThread(harness.deps.db, thread.id)!;
    expect(local.executionTarget).toBe("local");
    expect(local.environmentId).toBe(checkout.id);
    expect(binding(harness.deps.db, thread.id)).toBeFalsy();
    // The message stuck behind the limit is queued here instead of lost, and goes out once, after the conversation so far.
    expect(listQueuedThreadMessages(harness.deps.db, thread.id).map(message => JSON.parse(message.content))).toEqual([[{ type: "text", text: "Out of credits, keep going locally", mentions: [] }]]);
    expect(texts()).toEqual(["Run the orchestrator for the main project"]);
    // The local agent starts a fresh session that gets the conversation so far, since the cloud session file stayed behind.
    expect(getLastProviderThreadId(harness.deps, thread.id)).toBeNull();
    const seed = resolveDeferredFirstTurnContext(harness.deps.db, thread.id)?.input ?? [];
    const intro = seed.find(item => item.type === "text");
    expect(intro && "text" in intro ? intro.text : "").toContain("Run the orchestrator for the main project");
    expect(intro && "text" in intro ? intro.text : "").not.toContain("Out of credits");

    // Credits return and another thread in that sandbox wakes it. Core would resume the left-behind session's work, so
    // the app closes it first, once.
    const neighbor = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "claude-code", status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: neighbor.id, coreUrl: `sandbox:${thread.id}`, sessionId: "cr_1", startRequestId: "start_1", model: "claude-opus-5-5", reasoning: "high" }).run();
    refusing = false;
    (service.sandboxes as unknown as { backoff: Map<string, unknown> }).backoff.clear();
    await service.wakeAhead(neighbor.id, "thread_view");
    expect(core.filter(path => path.startsWith("/v1/sessions/cr_0"))).toEqual(["/v1/sessions/cr_0/close"]);
    expect(core.findIndex(path => path === "/v1/sessions/cr_0/close")).toBe(0);
    await service.wakeAhead(neighbor.id, "thread_view");
    expect(core.filter(path => path === "/v1/sessions/cr_0/close")).toHaveLength(1);
  } finally {
    service.stop();
    coreServer.closeAllConnections(); coreServer.close();
    websiteServer.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 20_000);

it("delivery leaves a sandbox alone while Teleport to Local moves its thread off it", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const wakes: string[] = [];
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "awake") return json({ sandboxes: [], recheck_ms: 60_000 });
    if (input.action === "wake") { wakes.push(input.thread); return json({ error: "Credits are back, but not for this test.", code: "cloud_usage_limit" }, 429); }
    json({ thread: input.thread, state: "asleep", generation: 1, issue: null });
  });
  const websiteUrl = await listen(websiteServer);
  const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "claude-code", status: "idle" });
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: `sandbox:${thread.id}`, sessionId: "cr_0", startRequestId: "start_0", model: "claude-opus-5-5", reasoning: "high" }).run();
    localTeleports.set(thread.id, "switching");
    harness.deps.db.insert(cloudroomCommands).values({ id: "unsent", threadId: thread.id, command: "prompt", input: JSON.stringify({ request_id: "unsent", text: "Not now" }), state: "sending", createdAt: Date.now() }).run();
    await new Promise(resolve => setTimeout(resolve, 3_200));
    expect(wakes).toEqual([]);
    // Once Teleport is done with it (here: gave up), delivery goes on as before.
    localTeleports.delete(thread.id);
    await waitFor(() => wakes.length > 0, "delivery after Teleport");
  } finally {
    localTeleports.delete(thread.id);
    service.stop();
    websiteServer.close();
  }
}, 15_000);
