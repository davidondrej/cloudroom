import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cloudroomCommands, cloudroomThreads, createThread, getThread, listQueuedThreadMessages } from "@cloudroom/db";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { binding } from "../../src/services/cloudroom/store.js";
import { resolveDeferredFirstTurnContext } from "../../src/services/threads/deferred-first-turn-context.js";
import { getLastProviderThreadId } from "../../src/services/threads/thread-events.js";
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
const TRIGGERS = [undefined, "retry", "thread_view", "thread_typing", "sidebar_preload"];
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
  const websiteServer = createServer(async (req, res) => {
    const input = await body(req);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/api/desktop/logins") return json({ claude: false, codex: false, pi: false, github: false });
    if (input.action === "awake") return json({ sandboxes: [], recheck_ms: 60_000 });
    if (input.action === "mode") return json({ sandboxes: true, limited: true, plan: "super" });
    if (input.action === "wake" && !TRIGGERS.includes(input.trigger)) return json({ error: "Invalid activity trigger." }, 400);
    if (input.action === "wake") { wakes.push({ thread: input.thread, trigger: input.trigger }); return json({ error: limit, code: "cloud_usage_limit" }, 429); }
    json({ thread: input.thread, state: "asleep", generation: 1, issue: null });
  });
  const websiteUrl = await listen(websiteServer);
  const teleport = (value: Record<string, unknown>) => harness.app.request(`/api/v1/cloudroom/threads/${thread.id}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "claude-code", status: "idle" });
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "sandbox@example.com" }, undefined, websiteUrl, "a".repeat(64));
    seedThreadRuntimeState(harness.deps, { threadId: thread.id, environmentId: null, providerThreadId: "native-orchestrator", inputText: "Run the orchestrator for the main project" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: `sandbox:${thread.id}`, sessionId: "cr_0", startRequestId: "start_0", model: "claude-opus-5-5", reasoning: "high" }).run();
    // Sent after the credits ran out: it never reached the sandbox, and its delivery keeps hitting the limit.
    harness.deps.db.insert(cloudroomCommands).values({ id: "stranded", threadId: thread.id, command: "prompt", input: JSON.stringify({ request_id: "stranded", text: "Out of credits, keep going locally" }), state: "sending", createdAt: Date.now() }).run();
    await waitFor(() => wakes.length > 0, "a delivery wake refused for the limit");

    // The thread now waits out a backoff. Each click on Teleport still asks the website, as a fresh wake.
    for (let click = 1; click <= 2; click++) {
      const before = wakes.length;
      const refused = await teleport({ action: "local" });
      expect(refused.status).toBe(409);
      const error = await refused.json() as { code: string; message: string };
      expect(error.code).toBe("teleport_cloud_unavailable");
      expect(error.message).toContain(limit);
      expect(wakes.slice(before)).toEqual([{ thread: thread.id, trigger: undefined }]);
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
    // The message stuck behind the limit is queued here instead of lost.
    expect(listQueuedThreadMessages(harness.deps.db, thread.id).map(message => JSON.parse(message.content))).toEqual([[{ type: "text", text: "Out of credits, keep going locally", mentions: [] }]]);
    // The local agent starts a fresh session that gets the conversation so far, since the cloud session file stayed behind.
    expect(getLastProviderThreadId(harness.deps, thread.id)).toBeNull();
    const seed = resolveDeferredFirstTurnContext(harness.deps.db, thread.id)?.input ?? [];
    const intro = seed.find(item => item.type === "text");
    expect(intro && "text" in intro ? intro.text : "").toContain("Run the orchestrator for the main project");
  } finally {
    service.stop();
    websiteServer.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 20_000);
