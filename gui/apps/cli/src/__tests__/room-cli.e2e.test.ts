import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeThread } from "./helpers/command-output-fixtures.js";

const execFileAsync = promisify(execFile);
const cliRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("Cloudroom CLI isolation and message delivery", () => {
  let directory: string;
  let server: Server;
  let serverUrl: string;
  let officialCli: string;
  const sends: Array<{ id: string; mode: string }> = [];
  const requests: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "room-cli-"));
    officialCli = join(directory, "bb");
    await writeFile(
      officialCli,
      '#!/bin/sh\nprintf "WRONG_BB_EXECUTABLE\\n"\n',
      { mode: 0o755 },
    );
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://fixture").pathname;
      requests.push(path);
      const reply = (body: object, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/api/v1/system/config")
        return reply({ dataDir: directory });
      if (path === "/api/v1/plugins") return reply({ plugins: [] });
      if (path === "/api/v1/threads") return reply([]);
      if (path === "/api/v1/threads/thr_cloud/timeline")
        return reply({ pendingTodos: null });
      const match = /^\/api\/v1\/threads\/(thr_cloud|thr_local)(\/send)?$/.exec(
        path,
      );
      if (!match) return reply({ message: `Unexpected request: ${path}` }, 404);
      const id = match[1];
      if (!match[2])
        return reply(
          makeThread({
            id,
            projectId: "proj_fixture",
            providerId: "codex",
            executionTarget: id === "thr_cloud" ? "cloud" : "local",
          }),
        );
      let input = "";
      for await (const chunk of request) input += chunk;
      const payload = JSON.parse(input);
      sends.push({ id, mode: payload.mode });
      if (id === "thr_cloud" && payload.mode === "steer-if-active") {
        return reply(
          {
            code: "cloudroom_unsupported",
            message: "Cloud steering is not enabled. Use --mode queue.",
          },
          409,
        );
      }
      return reply({ ok: true, delivery: "sent" });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture did not listen");
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const run = (args: string[], context: NodeJS.ProcessEnv = {}) =>
    execFileAsync(
      process.execPath,
      ["--conditions=source", "--import", "tsx", "src/index.ts", ...args],
      {
        cwd: cliRoot,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("ROOM_"),
            ),
          ),
          ROOM_SERVER_URL: serverUrl,
          BB_CLI: officialCli,
          BB_SERVER_URL: "http://127.0.0.1:1",
          BB_HOST_DAEMON_PORT: "1",
          BB_PROJECT_ID: "official_project",
          BB_THREAD_ID: "official_thread",
          BB_ENVIRONMENT_ID: "official_environment",
          BB_THREAD_STORAGE: "/official/thread-storage",
          BB_DATA_DIR: "/official/data",
          CR_CLI: officialCli,
          CR_SERVER_URL: "http://127.0.0.1:1",
          CR_HOST_DAEMON_PORT: "1",
          CR_PROJECT_ID: "retired_project",
          CR_THREAD_ID: "retired_thread",
          CR_ENVIRONMENT_ID: "retired_environment",
          CR_THREAD_STORAGE: "/retired/thread-storage",
          CR_DATA_DIR: "/retired/data",
          ...context,
        },
      },
    );

  it("ignores official BB and retired CR routing, executable, and thread context", async () => {
    const result = await run(["status", "--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      serverUrl,
      dataDir: directory,
      project: null,
      thread: null,
    });
    expect(requests.some((path) => /official_|retired_/.test(path))).toBe(false);
  });

  it("advertises the room-cli command without renaming Cloudroom", async () => {
    const result = await run(["--help"]);
    expect(result.stdout).toContain("Usage: room-cli");
    expect(result.stdout).toContain("Cloudroom CLI - manage your local and cloud agents");
    expect(result.stdout).toContain("ROOM_SERVER_URL");
  });

  it("accepts ROOM_THREAD_ID for a Cloud thread without a Local environment", async () => {
    const result = await run(["status", "--json"], {
      ROOM_THREAD_ID: "thr_cloud",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      serverUrl,
      thread: { id: "thr_cloud", environment: null },
    });
  });

  it("queues Cloud follow-ups without an extra flag", async () => {
    const result = await run([
      "thread",
      "tell",
      "thr_cloud",
      "Continue",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      delivery: "sent",
      mode: "queue",
    });
    expect(sends.at(-1)).toEqual({ id: "thr_cloud", mode: "queue-if-active" });
  });

  it("keeps Local steering as the default", async () => {
    const result = await run([
      "thread",
      "tell",
      "thr_local",
      "Continue",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      delivery: "sent",
      mode: "steer",
    });
    expect(sends.at(-1)).toEqual({ id: "thr_local", mode: "steer-if-active" });
  });

  it("rejects explicit Cloud steering instead of silently changing intent", async () => {
    await expect(
      run(["thread", "tell", "thr_cloud", "Interrupt", "--mode", "steer"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Cloud steering is not enabled"),
    });
    expect(sends.at(-1)).toEqual({ id: "thr_cloud", mode: "steer-if-active" });
  });
});
