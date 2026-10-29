import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { cloudroomThreads, events, getThread } from "@cloudroom/db";
import { command } from "../../src/services/cloudroom/store.js";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import { advanceThreadProvisioning } from "../../src/services/threads/thread-provisioning.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";

it.each([false, true])("routes Pi through the core and replays messages without a native host (provider selection: %s)", async (providerSelection) => {
  const selectedProvider = providerSelection ? "openai-codex" : "openrouter";
  const selectedModel = providerSelection ? "family/test-model" : "test-model";
  const model = `${selectedProvider}/${selectedModel}`;
  const app = await createTestAppHarness();
  const { host } = seedHostSession(app.deps);
  const { project } = seedProjectWithSource(app.deps, { hostId: host.id });
  const service = cloudroom(app.deps);
  const records: object[] = [];
  const streams = new Set<ServerResponse>();
  let starts = 0;
  let finishStartup!: () => void;
  const startupReady = new Promise<void>(resolve => { finishStartup = resolve; });
  const prompts: object[] = [];
  const sid = "cr_pi-start";
  const record = (kind: string, data: object, native?: object) => {
    const value = { sequence: records.length + 1, timestamp_ms: 1700000000000 + records.length, session_id: sid, kind, data, ...(native ? { native: JSON.stringify(native) } : {}) };
    records.push(value);
    for (const stream of streams) stream.write(`id: ${value.sequence}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, prompt_reasoning: true, harnesses: [{ id: "pi", provider: "openrouter", provider_selection: providerSelection, model: "test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.startsWith("/v1/sessions/cr_child_example")) {
      if (req.url.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); return; }
      return json({ session: { session_id: "cr_child_example", harness: "pi", state: "running", native_id: null, current_request: null, last_sequence: 0, queue: [],
        receipts: { child_example: { request_id: "child_example", command: "start", state: "completed", input: { harness: "pi", parent_session: sid, prompt: "Check the tests", reasoning: "high" } } } } });
    }
    if (req.url?.includes("/stream?")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(new URL(req.url, "http://fixture").searchParams.get("after"));
      for (const [index, value] of records.entries()) if (index + 1 > after) res.write(`id: ${index + 1}\nevent: record\ndata: ${JSON.stringify(value)}\n\n`);
      res.flushHeaders(); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url !== "/v1/sessions") prompts.push(body);
    if (req.url === "/v1/sessions") {
      starts++;
      expect(body).toEqual({ request_id: "pi-start", harness: "pi", model: selectedModel, reasoning: "high", command_guard_enabled: true, workspace: `bb_${project.id}`, workspace_name: "Test-Project", ...(providerSelection ? { provider: selectedProvider } : {}) });
      record("native_identity", { id: "pi-native" });
      record("state", { state: "starting" });
      return json({ session_id: sid, receipt: { request_id: body.request_id, command: "start", state: "completed", input: {} }, saving: {} }, 202);
    }
    const receipt = { request_id: body.request_id, command: "prompt", state: "accepted", input: { text: body.text } };
    record("receipt", receipt);
    await startupReady;
    record("state", { state: "starting_turn", request_id: body.request_id });
    record("native_event", { harness: "pi", type: "message_start" }, { type: "message_start", message: { role: "assistant", content: [], timestamp: 10 } });
    record("text_delta", { harness: "pi" }, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Cloud Pi result" } });
    record("item_started", { harness: "pi" }, { type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "pwd" } });
    for (const output of ["/code", "/code/test"]) record("tool_snapshot", { harness: "pi" }, { type: "tool_execution_update", toolCallId: "tool", toolName: "bash", partialResult: { content: [{ type: "text", text: output }] } });
    record("item_completed", { harness: "pi" }, { type: "tool_execution_end", toolCallId: "tool", toolName: "bash", result: { content: [{ type: "text", text: "/code/test" }] }, isError: false });
    record("native_event", { harness: "pi" }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Cloud Pi result" }], stopReason: "stop" } });
    record("native_event", { harness: "pi" }, { type: "agent_end", willRetry: true });
    record("receipt", { ...receipt, state: "completed" });
    record("usage", { contextUsage: { tokens: 128, contextWindow: 100000 }, tokens: { input: 100, output: 28, cacheRead: 0, cacheWrite: 0, total: 128 }, lastUsage: { input: 100, output: 28, totalTokens: 128 } });
    record("state", { state: "idle" });
    json({ session_id: sid, receipt, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const input = { executionTarget: "cloud", requestId: "pi-start", projectId: project.id, providerId: "pi", origin: "app", model, reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "check", mentions: [] }] };
    const response = await app.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status, await response.clone().text()).toBe(201);
    const thread = await response.json();
    expect(JSON.parse(command(app.db, `first_${thread.id}`)!.input).provider).toBe(providerSelection ? selectedProvider : undefined);
    await expect.poll(() => getThread(app.db, thread.id)?.status).toBe("active");
    await runThreadLifecycleSweep(app.deps);
    expect(getThread(app.db, thread.id)?.status).toBe("active");
    await advanceThreadProvisioning(app.deps, { threadId: thread.id });
    expect(getThread(app.db, thread.id)?.status).toBe("active");
    expect(app.db.select().from(events).all().filter(e => e.type === "system/error")).toEqual([]);
    finishStartup();
    await expect.poll(() => getThread(app.db, thread.id)?.status).toBe("idle");
    expect(getThread(app.db, thread.id)?.providerId).toBe("pi");
    expect(getThread(app.db, thread.id)?.environmentId).toBeNull();
    await expect.poll(() => app.db.select().from(events).all().filter(e => e.type === "turn/completed").length).toBe(1);
    const projected = app.db.select().from(events).all().map(e => JSON.parse(e.data));
    expect(projected.filter(e => e.type === "turn/started")).toHaveLength(1);
    expect(projected.find(e => e.type === "client/turn/requested").execution).toMatchObject({ model, reasoningLevel: "high" });
    expect(projected.find(e => e.type === "thread/contextWindowUsage/updated").contextWindowUsage).toEqual({ usedTokens: 128, modelContextWindow: 100000, estimated: true });
    expect(projected.find(e => e.type === "thread/tokenUsage/updated").tokenUsage.total.totalTokens).toBe(128);
    expect(projected.find(e => e.type === "item/agentMessage/delta").delta).toBe("Cloud Pi result");
    expect(projected.find(e => e.type === "item/completed" && e.item.type === "agentMessage").item.text).toBe("Cloud Pi result");
    expect(projected.filter(e => e.type === "item/toolCall/progress").map(e => e.message)).toEqual(["/code", "/code/test"]);
    expect(projected.find(e => e.type === "item/completed" && e.item.type === "toolCall").item.result.content[0].text).toBe("/code/test");
    const timeline = await app.app.request(`/api/v1/threads/${thread.id}/timeline`);
    expect(timeline.status).toBe(200);
    const conversation = JSON.stringify(await timeline.json());
    expect(conversation).toContain("Cloud Pi result");
    expect(conversation).not.toContain("Provisioning thread failed");
    const follow = await app.app.request(`/api/v1/threads/${thread.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "pi-follow", mode: "auto", model, reasoningLevel: "xhigh", input: [{ type: "text", text: "again", mentions: [] }] }) });
    expect(follow.status, await follow.clone().text()).toBe(200);
    await expect.poll(() => app.db.select().from(events).all().filter(e => e.type === "client/turn/requested").length).toBe(2);
    const turns = app.db.select().from(events).all().filter(e => e.type === "client/turn/requested").map(e => JSON.parse(e.data).execution.reasoningLevel);
    expect(turns).toEqual(["high", "xhigh"]);
    await expect.poll(() => prompts.at(-1)).toMatchObject({ text: "again", reasoning: "xhigh" });
    expect(service.threadStatus(thread.id)?.reasoning).toBe("xhigh");
    const locked = await app.app.request(`/api/v1/threads/${thread.id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "auto", model: "other-model", reasoningLevel: "high", input: [{ type: "text", text: "no", mentions: [] }] }) });
    expect(locked.status).toBe(409);
    const replayed = app.db.select().from(events).all().length;
    service.stop(); service.start(); await new Promise(r => setTimeout(r, 1700));
    expect(app.db.select().from(events).all()).toHaveLength(replayed);
    const invalid = await app.app.request("/api/v1/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, requestId: "wrong-provider", model: providerSelection ? "missing-provider" : "anthropic/test-model" }) });
    expect(invalid.status).toBe(400);
    expect(starts).toBe(1);
    record("child", { id: "cr_child_example", request_id: "pi-follow", state: "started", tool_call_id: "child-tool" });
    record("child", { id: "cr_child_example", request_id: "pi-follow", state: "completed", tool_call_id: "child-tool", result: { result: "Child result" } });
    await expect.poll(() => app.db.select().from(cloudroomThreads).all().find(row => row.sessionId === "cr_child_example")?.threadId).toBeDefined();
    const childId = app.db.select().from(cloudroomThreads).all().find(row => row.sessionId === "cr_child_example")!.threadId;
    expect(getThread(app.db, childId)).toMatchObject({ parentThreadId: thread.id, providerId: "pi", executionTarget: "cloud", titleFallback: "Check the tests" });
    await expect.poll(() => app.db.select().from(events).all().filter(e => e.type === "item/delegation/completed").map(e => JSON.parse(e.data).item)).toEqual([expect.objectContaining({ childRef: childId, status: "completed", summary: "Child result" })]);
    record("usage", { contextUsage: { tokens: null, contextWindow: 100000 } });
    await expect.poll(() => app.db.select().from(events).all().filter(e => e.type === "thread/contextWindowUsage/updated").map(e => JSON.parse(e.data).contextWindowUsage).at(-1)).toEqual({ usedTokens: null, modelContextWindow: 100000, estimated: true });
  } finally { finishStartup(); service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await app.cleanup(); }
}, 15000);

it.each(["pi", "codex"])("sends selected skills in Cloud %s starts and follow-ups without enabling other mentions", async (providerId) => {
  const app = await createTestAppHarness();
  const { host } = seedHostSession(app.deps);
  const { project } = seedProjectWithSource(app.deps, { hostId: host.id });
  const service = cloudroom(app.deps);
  const prompts: string[] = [];
  const sid = "cr_skill-test";
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, direct_workspaces: true, command_guard: true, harnesses: [{ id: providerId, provider: "fixture", model: "test-model" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const command = req.url === "/v1/sessions" ? "start" : "prompt";
    if (command === "prompt") prompts.push(body.text);
    json({ session_id: sid, receipt: { request_id: body.request_id, command, state: "accepted", input: {} }, saving: {} }, 202);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
  const resource = { kind: "command", trigger: "/", name: "file-tree", source: "skill", origin: "user", label: "file-tree", argumentHint: null };
  const tagged = { type: "text", text: "show /file-tree please", mentions: [{ start: 5, end: 15, resource }] };
  const request = (path: string, body: unknown) => app.app.request(`/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await service.configure({ url: `http://127.0.0.1:${address.port}`, token: "x".repeat(40), projectId: project.id });
    const body = { executionTarget: "cloud", requestId: "skill-test", projectId: project.id, providerId, origin: "app", model: providerId === "pi" ? "fixture/test-model" : "test-model", reasoningLevel: "medium", environment: { type: "project-default" }, input: [tagged] };
    const created = await request("/threads", body);
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = await created.json();
    await expect.poll(() => prompts).toEqual([providerId === "pi" ? "/skill:file-tree show  please" : tagged.text]);
    expect((await request("/threads", body)).status).toBe(201);
    expect(prompts).toHaveLength(1);
    const follow = await request(`/threads/${thread.id}/send`, { requestId: "skill-follow", mode: "auto", input: [{ type: "text", text: "again", mentions: [] }, { type: "text", text: "/file-tree", mentions: [{ start: 0, end: 10, resource }] }] });
    expect(follow.status, await follow.clone().text()).toBe(200);
    await expect.poll(() => prompts.at(-1)).toBe(providerId === "pi" ? "/skill:file-tree again\n" : "again\n/file-tree");
    for (const input of [
      [{ ...tagged, mentions: [{ start: 0, end: 10, resource }] }],
      [{ ...tagged, mentions: [{ start: 5, end: 15, resource: { ...resource, source: "command" } }] }],
      [{ ...tagged, mentions: [{ start: 5, end: 15, resource: { kind: "path", source: "workspace", entryKind: "file", path: "secret.txt", label: "secret.txt" } }] }],
      [{ type: "localFile", path: "/tmp/secret.txt" }],
    ]) expect((await request(`/threads/${thread.id}/send`, { mode: "auto", input })).status).toBe(400);
    expect(prompts).toHaveLength(2);
  } finally { service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await app.cleanup(); }
});
