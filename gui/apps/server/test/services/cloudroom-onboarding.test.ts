import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { createThread, cloudroomThreads, cloudroomCommands } from "@cloudroom/db";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";

vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), platform: () => "darwin" }));

it("persists project selection, retries reporting after restart, and never counts an unaccepted message", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const account = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.invalid" };
  const token = "synthetic-core-token".repeat(3);
  const reports: { connected: boolean; projectSelected: boolean; firstMessage?: { sessionId: string; requestId: string } }[] = [];
  let unavailable = true;
  const fixture = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/desktop/onboarding") {
      expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`${account.id}:${token}`).toString("base64")}`);
      let body = ""; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); reports.push(input);
      return json({ macConnectedAt: "2026-09-20T12:00:00+00:00", projectSelectedAt: input.projectSelected ? "2026-09-20T12:00:00+00:00" : null, firstMessageAt: input.firstMessage ? "2026-09-20T12:00:00+00:00" : null }, unavailable ? 503 : 200);
    }
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code/test", stop: true, resume: true, launch_settings: true, harnesses: [] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); return; }
    json({}, 404);
  });
  fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const url = `http://127.0.0.1:${address.port}`;
  const saved = async () => JSON.parse(await readFile(join(harness.deps.config.dataDir, "cloudroom.json"), "utf8"));
  try {
    await service.configure({ url, token }, account, undefined, url);
    await service.selectOnboardingProject(project.id);
    await expect.poll(async () => (await saved()).onboarding?.projectSelected).toBe(true);
    await expect.poll(() => reports.length).toBeGreaterThan(0);
    expect((await saved()).onboarding.reported).toBeUndefined();
    expect(reports.every(report => !report.firstMessage)).toBe(true);
    service.stop(); unavailable = false; service.start();
    await expect.poll(async () => (await saved()).onboarding?.reported).toEqual(["connected", "project"]);
    service.stop();
    const thread = createThread(harness.db, harness.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    harness.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: url, startRequestId: "fixture", sessionId: "cr_fixture", model: "test", reasoning: "medium" }).run();
    harness.db.insert(cloudroomCommands).values({ id: "first_fixture", threadId: thread.id, command: "prompt", input: JSON.stringify({ text: "fixture" }), state: "failed", createdAt: Date.now() }).run();
    service.start();
    await service.selectOnboardingProject(project.id);
    expect(reports.every(report => !report.firstMessage)).toBe(true);
    service.stop();
    harness.db.update(cloudroomCommands).set({ state: "accepted" }).where(eq(cloudroomCommands.id, "first_fixture")).run();
    service.start();
    await expect.poll(() => reports.some(report => report.firstMessage?.requestId === "first_fixture"), { timeout: 5000 }).toBe(true);
    await expect.poll(async () => (await saved()).onboarding?.reported).toEqual(["connected", "project", "message"]);
    expect((await service.status()).account).toEqual(account);
    expect(JSON.stringify(await service.status())).not.toContain(token);
    await service.disconnect();
    expect((await saved()).token).toBeUndefined();
    expect((await saved()).onboarding.reported).toEqual(["connected", "project", "message"]);
  } finally {
    service.stop(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); await harness.cleanup();
  }
}, 15000);
