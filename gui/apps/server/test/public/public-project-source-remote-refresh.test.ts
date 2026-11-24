import { eq } from "drizzle-orm";
import { getProject, projects } from "@cloudroom/db";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { ANONYMOUS_CALLER, withTestHarness } from "../helpers/test-app.js";

describe("public project source remote refresh", () => {
  it("backfills a missing remote when a local source is updated", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-source-remote-refresh",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source-remote-refresh",
      });
      expect(project.gitRemoteUrl).toBeNull();

      const updatePromise = harness.app.request(
        `/api/v1/projects/${project.id}/sources/${source.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "local_path",
            path: source.path,
          }),
        },
      );
      const inspection = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "project.inspect" && command.path === source.path,
      );
      await reportQueuedCommandSuccess(harness, inspection, {
        path: source.path,
        gitRemoteUrl: "ssh://git.example.test/team/project.git",
      });

      const updateResponse = await updatePromise;
      expect(updateResponse.status).toBe(200);
      const projectResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
      );
      await expect(readJson(projectResponse)).resolves.toMatchObject({
        gitRemoteUrl: "ssh://git.example.test/team/project.git",
      });
    });
  });

  it("saves and returns a remote without its username or token (#2190)", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-remote-creds",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-remote-creds",
      });
      const updatePromise = harness.app.request(
        `/api/v1/projects/${project.id}/sources/${source.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "local_path", path: source.path }),
        },
      );
      const inspection = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "project.inspect" && command.path === source.path,
      );
      // An older daemon still reports the raw remote.
      await reportQueuedCommandSuccess(harness, inspection, {
        path: source.path,
        gitRemoteUrl:
          "https://alice:FAKE_TOKEN@git.example.test/team/project.git",
      });
      expect((await updatePromise).status).toBe(200);

      const clean = "https://git.example.test/team/project.git";
      expect(getProject(harness.deps.db, project.id)?.gitRemoteUrl).toBe(clean);
      const response = await harness.app.request(
        `/api/v1/projects/${project.id}`,
      );
      await expect(readJson(response)).resolves.toMatchObject({
        gitRemoteUrl: clean,
      });

      // A row saved before the fix is cleaned in an open read (no caller token).
      const legacyUrl = "https://alice:FAKE_TOKEN@git.example.test/x.git";
      harness.deps.db
        .update(projects)
        .set({ gitRemoteUrl: legacyUrl })
        .where(eq(projects.id, project.id))
        .run();
      const legacy = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        { headers: ANONYMOUS_CALLER },
      );
      expect(legacy.status).toBe(200);
      await expect(readJson(legacy)).resolves.toMatchObject({
        gitRemoteUrl: "https://git.example.test/x.git",
      });

      // An older daemon's clone error repeats the legacy URL.
      const target = seedHostSession(harness.deps, { id: "host-creds-clone" });
      const clonePromise = harness.app.request(
        `/api/v1/projects/${project.id}/sources`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "clone", hostId: target.host.id }),
        },
      );
      const clone = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "project.clone",
      );
      await reportQueuedCommandError(harness, clone, {
        errorCode: "git_command_failed",
        errorMessage: `git clone --progress ${legacyUrl} /t failed`,
      });
      const failed = await clonePromise;
      expect(failed.status).toBe(502);
      await expect(readJson(failed)).resolves.toMatchObject({
        message:
          "git clone --progress https://git.example.test/x.git /t failed",
      });
    });
  });
});
