import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSession } from "@cloudroom/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@cloudroom/host-daemon-contract";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHost,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const OVER_50_MB = 51 * 1024 * 1024;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cloudroom-local-stream-"));
  tempDirs.push(dir);
  return dir;
}

async function seedColocatedThread(
  harness: TestAppHarness,
  workspaceRoot: string,
  rpcCalls: string[],
) {
  const host = seedHost(harness.deps, { id: "host_colocated" });
  seedPrimaryHost(harness.deps, host.id);
  const session = openSession(harness.deps.db, {
    hostId: host.id,
    instanceId: "inst-colocated",
    hostName: "Local Mac",
    dataDir: harness.config.dataDir,
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });
  registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle: (req) => {
      rpcCalls.push(req.command.type);
      if (req.command.type === "host.read_file") {
        return {
          ok: false,
          errorCode: "file_too_large",
          errorMessage: "File size 99999999 bytes exceeds the 50 MB limit",
        };
      }
      return { ok: true, result: {} };
    },
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: workspaceRoot,
  });
  const env = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: workspaceRoot,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: env.id,
  });
  return { env, project, thread };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("colocated local file streaming", () => {
  it("streams large media, supports Range/If-Range/ETag, and caps non-media at 50 MB", async () => {
    const baseDir = await makeTempDir();
    const workspaceRoot = path.join(baseDir, "repo");
    await mkdir(workspaceRoot, { recursive: true });

    const largePng = path.join(workspaceRoot, "large.png");
    await writeFile(largePng, PNG_HEADER);
    await truncate(largePng, OVER_50_MB);

    const largeZip = path.join(workspaceRoot, "archive.zip");
    await writeFile(largeZip, "PK");
    await truncate(largeZip, OVER_50_MB);

    const notePath = path.join(workspaceRoot, "note.txt");
    await writeFile(notePath, "hello utf8");

    await withTestHarness(async (harness) => {
      const rpcCalls: string[] = [];
      const { env, project, thread } = await seedColocatedThread(
        harness,
        workspaceRoot,
        rpcCalls,
      );

      // Media >50 MB streams straight from disk without touching host RPC.
      const mediaRes = await harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/large.png`,
        { headers: { range: "bytes=0-7" } },
      );
      expect(mediaRes.status).toBe(206);
      expect(mediaRes.headers.get("content-type")).toBe("image/png");
      expect(mediaRes.headers.get("content-range")).toBe(
        `bytes 0-7/${OVER_50_MB}`,
      );
      expect(mediaRes.headers.get("x-content-type-options")).toBe("nosniff");
      expect(mediaRes.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(Buffer.from(await mediaRes.arrayBuffer())).toEqual(PNG_HEADER);

      const etag = mediaRes.headers.get("etag") ?? "";
      expect(etag).not.toBe("");

      // If-None-Match returns 304.
      const cachedRes = await harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/large.png`,
        { headers: { "if-none-match": etag } },
      );
      expect(cachedRes.status).toBe(304);

      // Matching If-Range returns 206; mismatched If-Range falls back to full 200.
      const ifRangeMatch = await harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/large.png`,
        { headers: { range: "bytes=0-7", "if-range": etag } },
      );
      expect(ifRangeMatch.status).toBe(206);
      await ifRangeMatch.arrayBuffer();

      const ifRangeMiss = await harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/large.png`,
        { headers: { range: "bytes=0-7", "if-range": '"stale-etag"' } },
      );
      expect(ifRangeMiss.status).toBe(200);
      expect(ifRangeMiss.headers.get("content-length")).toBe(
        String(OVER_50_MB),
      );
      await ifRangeMiss.body?.cancel();

      // Out-of-bounds Range returns 416.
      const badRangeRes = await harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/large.png`,
        { headers: { range: `bytes=${OVER_50_MB}-` } },
      );
      expect(badRangeRes.status).toBe(416);
      expect(badRangeRes.headers.get("content-range")).toBe(
        `bytes */${OVER_50_MB}`,
      );

      // Non-media >50 MB is rejected with 413 instead of buffering into renderer memory.
      const hugeZipRes = await harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/archive.zip`,
      );
      expect(hugeZipRes.status).toBe(413);

      // Normal project text file sets x-bb-content-encoding: utf8.
      const textRes = await harness.app.request(
        `/api/v1/projects/${project.id}/files/content?path=note.txt&environmentId=${env.id}`,
      );
      expect(textRes.status).toBe(200);
      expect(textRes.headers.get("x-bb-content-encoding")).toBe("utf8");
      expect(await textRes.text()).toBe("hello utf8");

      expect(rpcCalls).toEqual([]);
    });
  });

  it("enforces root containment, regular-file checks, and maps diff/file file_too_large to 413", async () => {
    const baseDir = await makeTempDir();
    const workspaceRoot = path.join(baseDir, "repo");
    await mkdir(workspaceRoot, { recursive: true });

    const outsideSecret = path.join(baseDir, "secret.txt");
    await writeFile(outsideSecret, "secret");
    await symlink(outsideSecret, path.join(workspaceRoot, "escape.txt"));

    await withTestHarness(async (harness) => {
      const rpcCalls: string[] = [];
      const { env, thread } = await seedColocatedThread(
        harness,
        workspaceRoot,
        rpcCalls,
      );

      const escapeRes = await harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/escape.txt`,
      );
      expect(escapeRes.status).toBe(400);

      const dirRes = await harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent(workspaceRoot)}`,
      );
      expect(dirRes.status).toBe(400);

      const missingRes = await harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent(path.join(workspaceRoot, "missing.png"))}`,
      );
      expect(missingRes.status).toBe(404);

      if (process.platform !== "win32") {
        const deviceRes = await harness.app.request(
          `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent("/dev/zero")}`,
        );
        expect(deviceRes.status).toBe(400);
      }

      expect(rpcCalls).toEqual([]);

      // diff/file falls back to RPC and remaps file_too_large -> 413 (not 502).
      const diffRes = await harness.app.request(
        `/api/v1/environments/${env.id}/diff/file?target=uncommitted&path=large.png&side=new`,
      );
      expect(diffRes.status).toBe(413);
      expect(rpcCalls).toEqual(["host.read_file"]);
    });
  });
});
