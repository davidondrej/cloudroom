import { expect, it } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";

it("rejects Ultrafast at each Cloud service entry point before delivery", async () => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      providerId: "codex",
    });
    const input = [{ type: "text" as const, text: "test", mentions: [] }];
    const error = {
      status: 400,
      body: {
        code: "cloudroom_unsupported",
        message: expect.stringContaining("Cloud supports Standard and Fast"),
      },
    };
    await expect(
      service.create({
        projectId: project.id,
        providerId: "codex",
        origin: "app",
        input,
        environment: { type: "project-default" },
        serviceTier: "ultrafast",
        originKind: null,
        startedOnBehalfOf: null,
      }),
    ).rejects.toMatchObject(error);
    await expect(
      service.send(thread, { input, mode: "auto", serviceTier: "ultrafast" }),
    ).rejects.toMatchObject(error);
    await expect(
      service.editMessage(thread, {
        input,
        operationId: "ultrafast-edit",
        serviceTier: "ultrafast",
      }),
    ).rejects.toMatchObject(error);
  } finally {
    service.stop();
    await harness.cleanup();
  }
});
