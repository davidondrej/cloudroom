import { expect, it, vi } from "vitest";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

vi.mock("../../src/services/cloudroom/teleport-local.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/services/cloudroom/teleport-local.js")>(),
  teleportingToLocal: () => true,
}));

it("lets tab and read-state writes through while Teleport to Local runs", async () => {
  await withTestHarness(async (harness) => {
    const { thread } = seedThreadFixture(harness);
    const request = (path: string, method: string, body?: unknown) => harness.app.request(`/api/v1/threads/${thread.id}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect((await request("/tabs", "PUT", { expectedRevision: 0, tabs: [{ id: "git-diff", kind: "git-diff" }] })).status).toBe(200);
    expect((await request("/read", "POST", {})).status).not.toBe(409);
    expect((await request("", "PATCH", { title: "Renamed" })).status).toBe(200);
    const send = await request("/stop", "POST", {});
    expect(send.status).toBe(409);
    expect(await send.json()).toMatchObject({ code: "teleport_in_progress", message: "Teleport to Local is in progress." });
  });
});
