import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { waitForProcessExit } from "@cloudroom/config/child-process-exit";
import { resolvePortFromEnv } from "@cloudroom/config/runtime";
import {
  assertArtifacts,
  createDaemonEnv,
  createServerEnv,
  parseLauncherArgs,
  readPackageVersion,
  resolveContext,
  resolveDataDir,
  resolveRuntime,
  resolveWorktreeRuntimePolicy,
  serverListenerUrl,
  type AppContext,
} from "../src/context.js";
import { createJoinEnv, resolveBundledCliLaunch } from "../src/host.js";
import { waitForHostDaemonStatus } from "../src/processes.js";
import type {
  ManagedProcessName,
  ManagedProcessRun,
  NamedProcessExitResult,
  ProcessExitResult,
} from "../src/processes.js";
import { runApp, stopAll, supervise, type Processes } from "../src/start.js";

interface DelayArgs {
  ms: number;
}

interface ControlledDelayCall {
  ms: number;
  resolve(): void;
}

type DelayResult = "timeout";
type ResolveFakeManagedProcessExit = (result: NamedProcessExitResult) => void;
type StartFakeManagedProcess = () => Promise<ManagedProcessRun>;

interface FakeManagedProcessRunArgs {
  id: string;
  processName: ManagedProcessName;
}

interface WaitForProcessReplacementArgs {
  currentRun: () => ManagedProcessRun | null;
  previousRun: ManagedProcessRun;
}

interface WaitForDelayCallArgs {
  delay: ControlledDelay;
  index: number;
}

interface FakeSupervisor {
  daemonRuns: FakeManagedProcessRun[];
  daemonStart: StartFakeManagedProcess;
  processes: Processes;
  serverRuns: FakeManagedProcessRun[];
  serverStart: StartFakeManagedProcess;
  setShutdownRequested(value: boolean): void;
  shutdownRequested(): boolean;
}

const packageMetadataSchema = z.object({
  engines: z.object({
    node: z.string(),
  }),
  files: z.array(z.string()),
  os: z.array(z.string()),
});

type PackageMetadata = z.infer<typeof packageMetadataSchema>;

class FakeManagedProcessRun implements ManagedProcessRun {
  readonly exit: Promise<NamedProcessExitResult>;
  readonly id: string;
  readonly processName: ManagedProcessName;
  readonly terminationSignals: NodeJS.Signals[] = [];
  running = true;
  private resolveExit: ResolveFakeManagedProcessExit = () => undefined;

  constructor(args: FakeManagedProcessRunArgs) {
    this.id = args.id;
    this.processName = args.processName;
    this.exit = new Promise<NamedProcessExitResult>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
  }

  exitWith(result: ProcessExitResult): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.resolveExit({ processName: this.processName, result });
  }

  async terminate(signal: NodeJS.Signals): Promise<void> {
    this.terminationSignals.push(signal);
    this.exitWith({ code: null, signal });
  }
}

class ControlledDelay {
  readonly calls: ControlledDelayCall[] = [];

  async delayMilliseconds(args: { ms: number }): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.calls.push({
        ms: args.ms,
        resolve: resolvePromise,
      });
    });
  }
}

function delay(args: DelayArgs): Promise<DelayResult> {
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      resolvePromise("timeout");
    }, args.ms);
  });
}

const immediateDelay: (ms: number) => Promise<void> = () => {
  return Promise.resolve();
};

function createTestStartContext(): AppContext {
  return {
    appDistDir: "/tmp/bb-app-test/app/dist",
    appVersion: "0.0.0-test",
    daemonBundleDir: "/tmp/bb-app-test/host-daemon/dist",
    daemonEntry: "/tmp/bb-app-test/host-daemon/dist/daemon-bundle.mjs",
    daemonLockDir: "/tmp/bb-app-test/daemon.lock.lock",
    daemonLockFile: "/tmp/bb-app-test/daemon.lock",
    daemonPort: 38887,
    dataDir: "/tmp/bb-app-test",
    dbPath: "/tmp/bb-app-test/bb.db",
    envFile: "/tmp/bb-app-test/env.json",
    logDir: "/tmp/bb-app-test/logs",
    serverEntry: "/tmp/bb-app-test/server/dist/index.js",
    serverPort: 38886,
    serverUrl: "http://127.0.0.1:38886",
  };
}

function createFakeSupervisor(): FakeSupervisor {
  let shutdownRequested = false;
  const serverRuns = [
    new FakeManagedProcessRun({ id: "server-1", processName: "server" }),
  ];
  const daemonRuns = [
    new FakeManagedProcessRun({ id: "daemon-1", processName: "daemon" }),
  ];
  const processes: Processes = {
    daemon: daemonRuns[0],
    server: serverRuns[0],
  };
  const serverStart = async (): Promise<ManagedProcessRun> => {
    const run = new FakeManagedProcessRun({
      id: `server-${serverRuns.length + 1}`,
      processName: "server",
    });
    serverRuns.push(run);
    processes.server = run;
    return run;
  };
  const daemonStart = async (): Promise<ManagedProcessRun> => {
    const run = new FakeManagedProcessRun({
      id: `daemon-${daemonRuns.length + 1}`,
      processName: "daemon",
    });
    daemonRuns.push(run);
    processes.daemon = run;
    return run;
  };
  return {
    daemonRuns,
    daemonStart,
    processes,
    serverRuns,
    serverStart,
    setShutdownRequested(value) {
      shutdownRequested = value;
    },
    shutdownRequested() {
      return shutdownRequested;
    },
  };
}

async function waitForProcessReplacement(
  args: WaitForProcessReplacementArgs,
): Promise<ManagedProcessRun> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const currentRun = args.currentRun();
    if (currentRun !== null && currentRun !== args.previousRun) {
      return currentRun;
    }
    await delay({ ms: 1 });
  }
  throw new Error("Timed out waiting for process replacement");
}

async function waitForDelayCall(
  args: WaitForDelayCallArgs,
): Promise<ControlledDelayCall> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const call = args.delay.calls[args.index];
    if (call !== undefined) {
      return call;
    }
    await delay({ ms: 1 });
  }
  throw new Error("Timed out waiting for restart throttle delay");
}

async function stopFakeSupervisor(
  supervisor: FakeSupervisor,
  supervision: Promise<"shutdown" | "stopped">,
): Promise<"shutdown" | "stopped"> {
  supervisor.setShutdownRequested(true);
  await stopAll(supervisor.processes, "SIGTERM");
  return supervision;
}

function readPackageMetadata(): PackageMetadata {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return packageMetadataSchema.parse(
    JSON.parse(readFileSync(resolve(testDir, "..", "package.json"), "utf8")),
  );
}

describe("bb-app launcher", () => {
  it("waits for the expected host daemon identity and connection", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/status") {
        response.writeHead(404).end();
        return;
      }
      statusRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          connected: statusRequests >= 2,
          hostId: "host-expected",
          serverUrl: "http://127.0.0.1:38886/",
        }),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected status test server to have a TCP address");
    }

    try {
      await waitForHostDaemonStatus({
        childProcess: null,
        expectedHostId: "host-expected",
        expectedServerUrl: "http://localhost:38886",
        port: address.port,
        timeoutMs: 1_000,
      });
      expect(statusRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("does not accept another daemon's successful health response", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.url === "/health"
          ? JSON.stringify({ ok: true })
          : JSON.stringify({
              connected: true,
              hostId: "host-other",
              serverUrl: "https://other.example.test",
            }),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected status test server to have a TCP address");
    }

    try {
      await expect(
        waitForHostDaemonStatus({
          childProcess: null,
          expectedHostId: "host-expected",
          expectedServerUrl: "https://bb.example.test",
          port: address.port,
          timeoutMs: 25,
        }),
      ).rejects.toThrow("Timed out waiting for host daemon host-expected");
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("resolves production defaults for npx startup", () => {
    const context = resolveContext(pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href, {}, "/home/tester");

    expect(context.dataDir).toBe("/home/tester/.gui-cloudroom");
    expect(context.envFile).toBe("/home/tester/.gui-cloudroom/env.json");
    expect(context.serverPort).toBe(39886);
    expect(context.daemonPort).toBe(39887);
    expect(context.serverUrl).toBe("http://127.0.0.1:39886");
    expect(context.serverEntry).toBe(
      "/repo/packages/bb-app/server/dist/index.js",
    );
    expect(context.daemonEntry).toBe(
      "/repo/packages/bb-app/host-daemon/dist/daemon-bundle.mjs",
    );
    expect(context.appVersion).toBe("0.0.0-dev");
  });

  it("uses workspace build outputs when run from a source checkout", () => {
    const context = resolveContext(pathToFileURL("/repo/packages/bb-app/src/start.ts")
        .href, {}, "/home/tester");
    expect(context.appDistDir).toBe("/repo/apps/app/dist");
    expect(context.serverEntry).toBe("/repo/apps/server/dist/index.js");
    expect(context.daemonBundleDir).toBe("/repo/apps/host-daemon/dist");
    expect(context.daemonEntry).toBe(
      "/repo/apps/host-daemon/dist/daemon-bundle.mjs",
    );
  });

  it("reads appVersion from the package.json next to the resolved package root", () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const expectedVersion = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      ).version;
    expect(readPackageVersion(packageRoot)).toBe(expectedVersion);
  });

  it("falls back to the dev sentinel when package.json is missing", () => {
    expect(readPackageVersion("/nonexistent/bb-app/path")).toBe(
      "0.0.0-dev",
    );
  });

  it("honors explicit production ports and data directory", () => {
    const env = {
      BB_DATA_DIR: "~/custom-bb",
      BB_HOST_DAEMON_PORT: "48887",
      BB_SERVER_PORT: "48886",
    };

    expect(resolveDataDir(env, "/home/tester")).toBe(
      "/home/tester/custom-bb",
    );
    expect(
      resolvePortFromEnv({ defaultPort: 1, env, name: "BB_SERVER_PORT" }),
    ).toBe(48886);
    expect(
      resolvePortFromEnv({ defaultPort: 1, env, name: "BB_HOST_DAEMON_PORT" }),
    ).toBe(48887);
  });

  it("parses launcher flags separately from commands", () => {
    expect(
      parseLauncherArgs([
        "host-daemon",
        "join",
        "--data-dir",
        "~/bb-data",
        "--server-url",
        "https://bb.example.test",
        "--join-code",
        "bbde_supplied",
        "--host-id",
        "host_remote",
        "--host-daemon-port",
        "48887",
        "--auto-update",
      ]),
    ).toEqual({
      options: {
        autoUpdate: true,
        dataDir: "~/bb-data",
        hostDaemonPort: "48887",
        hostId: "host_remote",
        joinCode: "bbde_supplied",
        serverUrl: "https://bb.example.test",
      },
      positionals: ["host-daemon", "join"],
    });
  });

  it("reports the server bind host separately from the loopback connection URL", async () => {
    const parsedArgs = parseLauncherArgs(["--server-bind-host", "0.0.0.0"]);
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-bind-host-"));
    const runtime = await resolveRuntime({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: parsedArgs.options,
      mode: "local",
    });

    expect(parsedArgs.options.serverBindHost).toBe("0.0.0.0");
    expect(runtime.serverEnv.BB_SERVER_BIND_HOST).toBe("0.0.0.0");
    expect(
      serverListenerUrl(runtime.serverEnv.BB_SERVER_BIND_HOST, runtime.context.serverPort),
    ).toBe("http://0.0.0.0:39886");
    expect(runtime.context.serverUrl).toBe("http://127.0.0.1:39886");
  });

  it("strips parent thread context from the production server without stripping the CLI", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-thread-context-"));
    const runtime = await resolveRuntime({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {
        BB_DATA_DIR: dataDir,
        BB_ENVIRONMENT_ID: "env_parent",
        BB_PROJECT_ID: "proj_parent",
        BB_THREAD_ID: "thr_parent",
        BB_THREAD_STORAGE: "/home/tester/.bb/thread-storage/thr_parent",
      },
      homeDir: "/home/tester",
      options: { help: false },
      mode: "local",
    });

    expect(runtime.serverEnv.BB_ENVIRONMENT_ID).toBeUndefined();
    expect(runtime.serverEnv.BB_THREAD_ID).toBeUndefined();
    expect(runtime.serverEnv.BB_THREAD_STORAGE).toBeUndefined();
    expect(runtime.serverEnv.BB_PROJECT_ID).toBe("proj_parent");

    const daemonEnv = createDaemonEnv(runtime.context, runtime.env, runtime.context.serverUrl);
    expect(daemonEnv.BB_ENVIRONMENT_ID).toBeUndefined();
    expect(daemonEnv.BB_THREAD_ID).toBeUndefined();
    expect(daemonEnv.BB_THREAD_STORAGE).toBeUndefined();
    expect(daemonEnv.BB_PROJECT_ID).toBe("proj_parent");

    expect(runtime.env.BB_ENVIRONMENT_ID).toBe("env_parent");
    expect(runtime.env.BB_THREAD_ID).toBe("thr_parent");
    expect(runtime.env.BB_THREAD_STORAGE).toBe(
      "/home/tester/.bb/thread-storage/thr_parent",
    );

  });

  it("rejects an invalid server bind host before launcher startup", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-invalid-bind-host-"));

    await expect(
      runApp(["--data-dir", dataDir, "--server-bind-host", "localhost"]),
    ).rejects.toThrow('BB_SERVER_BIND_HOST must be "127.0.0.1" or "0.0.0.0"');
  });

  it("uses a supplied join code without requesting a loopback enroll key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-remote-join-"));
    const context = { ...createTestStartContext(), dataDir };

    const env = await createJoinEnv(context, {
        BB_HOST_ENROLL_KEY: "bbde_supplied",
        BB_HOST_ID: "host_remote",
        BB_CONNECT_MACHINE_CREDENTIAL: "bbcm_machine",
        BB_CONNECT_MACHINE_ID: "machine-1",
      }, "https://bb.example.test");

    expect(env).toMatchObject({
      BB_HOST_ENROLL_KEY: "bbde_supplied",
      BB_HOST_ID: "host_remote",
    });
    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toMatchObject({
      machineCredential: "bbcm_machine",
      connectMachineId: "machine-1",
      serverUrl: "https://bb.example.test",
    });
  });

  it("requires the join-code host ID on a fresh machine", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-remote-join-"));

    await expect(
      createJoinEnv({ ...createTestStartContext(), dataDir }, { BB_HOST_ENROLL_KEY: "bbde_supplied" }, "https://bb.example.test"),
    ).rejects.toThrow("--host-id is required when --join-code is supplied");
  });

  it("uses managed config server URL when env and flags omit it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://bb.example.test" }),
      "utf8",
    );

    const context = (
      await resolveRuntime({
        entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js")
          .href,
        env: { BB_DATA_DIR: dataDir },
        homeDir: "/home/tester",
        options: { help: false },
        mode: "remote",
      })
    ).context;

    expect(context.serverUrl).toBe("https://bb.example.test");
  });

  it("uses managed config server URL over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-server-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveRuntime({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {
        BB_DATA_DIR: dataDir,
        BB_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: { help: false },
      mode: "remote",
    });

    expect(runtime.context.serverUrl).toBe("https://stored.example.test");
    expect(runtime.env.BB_SERVER_URL).toBe("https://stored.example.test");
  });

  it("keeps the machine's server access headers out of every process environment", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-headers-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        serverUrl: "https://bb.example.test",
        serverHeaders: { "x-bb-connect-machine": "private-relay-key" },
        machineCredential: "private-legacy-key",
      }),
      "utf8",
    );

    const runtime = await resolveRuntime({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: { help: false },
      mode: "remote",
    });
    const daemonEnv = createDaemonEnv(runtime.context, {
        ...runtime.env,
        BB_SERVER_HEADERS: '{"x-bb-connect-machine":"private-inherited"}',
        BB_CONNECT_MACHINE_CREDENTIAL: "private-legacy-join",
      }, runtime.context.serverUrl);

    expect(JSON.stringify([runtime.env, daemonEnv])).not.toContain("private-");
  });

  it("keeps full-stack startup local even when managed config has a server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-local-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://bb.example.test" }),
      "utf8",
    );

    const context = (
      await resolveRuntime({
        entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js")
          .href,
        env: { BB_DATA_DIR: dataDir },
        homeDir: "/home/tester",
        options: { help: false },
        mode: "local",
      })
    ).context;

    expect(context.serverUrl).toBe("http://127.0.0.1:39886");
  });

  it("applies managed config environment values over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-env-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        config: {
          BB_APP_URL: "https://bb.example.test",
          BB_LOG_LEVEL: "debug",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );

    const runtime = await resolveRuntime({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir, OPENAI_API_KEY: "ambient-openai-key" },
      homeDir: "/home/tester",
      options: { help: false },
      mode: "local",
    });

    expect(runtime.env.BB_APP_URL).toBe("https://bb.example.test");
    expect(runtime.env.BB_LOG_LEVEL).toBe("debug");
    expect(runtime.env.OPENAI_API_KEY).toBe("stored-openai-key");
    expect(runtime.serverEnv.BB_LOG_LEVEL).toBe("debug");
    expect(runtime.serverEnv.OPENAI_API_KEY).toBe("stored-openai-key");
  });

  it.each([true, false])(
    "isolates packaged desktop settings without changing dev startup (packaged=%s)",
    async (packaged) => {
      const homeDir = mkdtempSync(join(tmpdir(), "cloudroom-desktop-policy-"));
      const dataDir = join(homeDir, ".gui-cloudroom");
      mkdirSync(dataDir);
      const stored = JSON.stringify({
        env: {
          BB_DATA_DIR: join(homeDir, ".bb"),
          BB_SERVER_PORT: "38886",
          BB_HOST_DAEMON_PORT: "38887",
          BB_SERVER_BIND_HOST: "0.0.0.0",
          BB_HOST_ID: "host_bb",
          BB_HOST_ENROLL_KEY: "bb-enroll-key",
          ROOM_SERVER_URL: "http://127.0.0.1:38886",
          ROOM_HOST_DAEMON_PORT: "38887",
          OPENAI_API_KEY: "stored-provider-key",
        },
      });
      writeFileSync(join(dataDir, "env.json"), stored);
      try {
        const runtime = await resolveRuntime({
          entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js")
            .href,
          env: {
            BB_APP_SURFACE: "desktop",
            ...(packaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
            BB_DATA_DIR: dataDir,
            BB_SERVER_PORT: "38886",
            BB_HOST_DAEMON_PORT: "38887",
          },
          homeDir,
          options: { help: false },
          mode: "local",
        });
        expect(runtime.context).toMatchObject({
          daemonPort: packaged ? 39887 : 38887,
          dataDir: packaged ? dataDir : join(homeDir, ".bb"),
          serverPort: packaged ? 39886 : 38886,
          serverUrl: `http://127.0.0.1:${packaged ? 39886 : 38886}`,
        });
        for (const env of [runtime.env, runtime.serverEnv]) {
          expect(env.OPENAI_API_KEY).toBe("stored-provider-key");
          expect(env.BB_SERVER_BIND_HOST).toBe(
            packaged ? "127.0.0.1" : "0.0.0.0",
          );
          expect(env.BB_HOST_ID).toBe(packaged ? undefined : "host_bb");
          expect(env.BB_HOST_ENROLL_KEY).toBe(
            packaged ? undefined : "bb-enroll-key",
          );
        }
        expect(readFileSync(join(dataDir, "env.json"), "utf8")).toBe(stored);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it("applies the worktree policy after conflicting saved environment values", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-worktree-policy-"));
    const storedDataDir = join(dataDir, "stored-data");
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          BB_DATA_DIR: storedDataDir,
          BB_DEV_APP_PORT: "4173",
          BB_HOST_DAEMON_PORT: "48887",
          BB_INHERITED_SKILLS_ROOTS: "/stored/skills",
          BB_SERVER_BIND_HOST: "0.0.0.0",
          BB_SERVER_PORT: "48886",
          BB_TELEMETRY: "true",
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );
    const worktreeEnv: NodeJS.ProcessEnv = {
      BB_DATA_DIR: dataDir,
      BB_HOST_DAEMON_PORT: "47887",
      BB_INHERITED_SKILLS_ROOTS: "/worktree/skills",
      BB_SERVER_PORT: "47886",
    };

    const runtime = await resolveRuntime({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: worktreeEnv,
      homeDir: "/home/tester",
      options: { help: false },
      mode: "local",
      worktreePolicy: resolveWorktreeRuntimePolicy(worktreeEnv, "/home/tester"),
    });

    expect(runtime.context).toMatchObject({
      daemonPort: 47887,
      dataDir,
      serverPort: 47886,
      serverUrl: "http://127.0.0.1:47886",
    });
    for (const env of [runtime.env, runtime.serverEnv]) {
      expect(env).toMatchObject({
        BB_DATA_DIR: dataDir,
        BB_HOST_DAEMON_PORT: "47887",
        BB_INHERITED_SKILLS_ROOTS: "/worktree/skills",
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: "47886",
        BB_TELEMETRY: "false",
        OPENAI_API_KEY: "stored-openai-key",
      });
      expect(env.BB_DEV_APP_PORT).toBeUndefined();
    }
  });

  it("uses launcher flags over managed config and ambient server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-flag-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveRuntime({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {
        BB_DATA_DIR: dataDir,
        BB_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: {
        help: false,
        serverUrl: "https://flag.example.test",
      },
      mode: "remote",
    });

    expect(runtime.context.serverUrl).toBe("https://flag.example.test");
    expect(runtime.env.BB_SERVER_URL).toBe("https://flag.example.test");
  });

  it("observes child processes that exited before wait registration", async () => {
    const childProcess = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", () => {
        resolvePromise();
      });
    });

    await expect(
      Promise.race([waitForProcessExit(childProcess), delay({ ms: 100 })]),
    ).resolves.toEqual({ code: 7, signal: null });
  });

  it("keeps daemon running and starts only a new server after server exit", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = supervise({
      context: createTestStartContext(),
      wait: immediateDelay,
      isServerAnswering: async () => false,
      isShuttingDown: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    initialServerRun.exitWith({ code: 1, signal: null });
    const nextServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.server,
      previousRun: initialServerRun,
    });

    expect(initialServerRun.running).toBe(false);
    expect(initialDaemonRun.running).toBe(true);
    expect(supervisor.processes.daemon).toBe(initialDaemonRun);
    expect(supervisor.daemonRuns).toHaveLength(1);
    expect(supervisor.serverRuns).toHaveLength(2);
    expect(nextServerRun).toBe(supervisor.serverRuns[1]);
    expect(supervisor.serverRuns[1]?.running).toBe(true);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("keeps server running and starts only a new daemon after daemon exit", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = supervise({
      context: createTestStartContext(),
      wait: immediateDelay,
      isServerAnswering: async () => false,
      isShuttingDown: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    initialDaemonRun.exitWith({ code: 1, signal: null });
    const nextDaemonRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.daemon,
      previousRun: initialDaemonRun,
    });

    expect(initialDaemonRun.running).toBe(false);
    expect(initialServerRun.running).toBe(true);
    expect(supervisor.processes.server).toBe(initialServerRun);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.daemonRuns).toHaveLength(2);
    expect(nextDaemonRun).toBe(supervisor.daemonRuns[1]);
    expect(supervisor.daemonRuns[1]?.running).toBe(true);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("terminates both children without restarting during shutdown", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = supervise({
      context: createTestStartContext(),
      wait: immediateDelay,
      isServerAnswering: async () => false,
      isShuttingDown: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    supervisor.setShutdownRequested(true);
    await stopAll(supervisor.processes, "SIGINT");

    await expect(supervision).resolves.toBe("shutdown");
    expect(initialServerRun.running).toBe(false);
    expect(initialDaemonRun.running).toBe(false);
    expect(initialServerRun.terminationSignals).toEqual(["SIGINT"]);
    expect(initialDaemonRun.terminationSignals).toEqual(["SIGINT"]);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.daemonRuns).toHaveLength(1);
  });

  it("throttles repeated healthy child exits before restarting", async () => {
    const restartThrottle = new ControlledDelay();
    const supervisor = createFakeSupervisor();
    const firstServerRun = supervisor.serverRuns[0];
    const supervision = supervise({
      context: createTestStartContext(),
      wait: (ms) => restartThrottle.delayMilliseconds({ ms }),
      isServerAnswering: async () => false,
      isShuttingDown: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    firstServerRun.exitWith({ code: 1, signal: null });
    const firstDelay = await waitForDelayCall({
      delay: restartThrottle,
      index: 0,
    });
    expect(firstDelay.ms).toBe(1_000);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.processes.server).toBeNull();
    firstDelay.resolve();

    const secondServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.server,
      previousRun: firstServerRun,
    });
    expect(supervisor.serverRuns).toHaveLength(2);

    supervisor.serverRuns[1]?.exitWith({ code: 1, signal: null });
    const secondDelay = await waitForDelayCall({
      delay: restartThrottle,
      index: 1,
    });
    expect(secondDelay.ms).toBe(1_000);
    expect(supervisor.serverRuns).toHaveLength(2);
    expect(supervisor.processes.server).toBeNull();
    secondDelay.resolve();

    const thirdServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.server,
      previousRun: secondServerRun,
    });
    expect(thirdServerRun).toBe(supervisor.serverRuns[2]);
    expect(supervisor.serverRuns).toHaveLength(3);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it.each(["win32", "linux", "darwin"] as const)("runs the bundled JavaScript CLI through Node on %s without execute permission", (platform) => {
    const root = mkdtempSync(join(tmpdir(), "cloudroom-bundled-cli-"));
    const cliPath = join(root, "room-cli");
    try {
      writeFileSync(cliPath, "console.log(process.argv[2]);\n", { mode: 0o644 });
      const launch = resolveBundledCliLaunch({
        args: ["CLI_OK"], cliPath, nodePath: process.execPath, platform, bundled: true,
      });
      expect(launch.command).toBe(process.execPath);
      expect(execFileSync(launch.command, launch.args, { encoding: "utf8" }).trim()).toBe("CLI_OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the extensionless CLI override through Node on Windows", () => {
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        cliPath: "C:\\cloudroom\\host-daemon\\dist\\room-cli",
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\cloudroom\\host-daemon\\dist\\room-cli", "status"],
    });
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        cliPath: "C:\\tools\\room-cli.exe",
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toEqual({ command: "C:\\tools\\room-cli.exe", args: ["status"] });
    expect(
      resolveBundledCliLaunch({
        args: ["status"],
        cliPath: "/opt/cloudroom/host-daemon/dist/room-cli",
        nodePath: "/usr/bin/node",
        platform: "linux",
      }),
    ).toEqual({ command: "/opt/cloudroom/host-daemon/dist/room-cli", args: ["status"] });
  });

  it("limits npm package metadata to documented runtimes", () => {
    const metadata = readPackageMetadata();

    expect(metadata.engines.node).toBe("^22.19.0 || ^24.0.0 || ^26.0.0");
    expect(metadata.files).toContain(
      "host-daemon/dist/bb-plugin-host-worker.mjs",
    );
    expect(metadata.files).toContain("host-daemon/dist/room-cli");
    expect(metadata.files).toContain("host-daemon/dist/room-cli.cmd");
    expect(metadata.files).toContain("host-daemon/dist/room-cli-chunks");
    expect(metadata.os).toEqual(["darwin", "linux"]);
  });

  it("requires the bundled CLI's chunk directory next to host-daemon/dist/room-cli", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "bb-app-artifacts-"));
    try {
      const context = resolveContext(pathToFileURL(join(packageRoot, "dist", "room.js")).href, {}, join(packageRoot, "home"));
      for (const artifact of [
        context.serverEntry,
        context.daemonEntry,
        join(context.daemonBundleDir, "room-cli"),
        join(context.daemonBundleDir, "bb-provider-bridge-worker.mjs"),
        join(context.daemonBundleDir, "bb-parcel-watcher-child.mjs"),
        join(context.daemonBundleDir, "bb-plugin-host-worker.mjs"),
        join(context.appDistDir, "index.html"),
      ]) {
        mkdirSync(dirname(artifact), { recursive: true });
        writeFileSync(artifact, "");
      }

      const missingChunks =
        /^Missing bundled room CLI chunks at .*\/host-daemon\/dist\/room-cli-chunks\. Rebuild bb-app/;
      expect(() => assertArtifacts(context, "app")).toThrow(missingChunks);

      const chunkDir = join(context.daemonBundleDir, "room-cli-chunks");
      mkdirSync(chunkDir);
      expect(() => assertArtifacts(context, "app")).toThrow(missingChunks);

      writeFileSync(join(chunkDir, "chunk-AAAAAAAA.js"), "");
      expect(() => assertArtifacts(context, "app")).not.toThrow();

      rmSync(context.serverEntry);
      rmSync(join(context.appDistDir, "index.html"));
      expect(() => assertArtifacts(context, "host")).not.toThrow();
      expect(() => assertArtifacts(context, "app")).toThrow(
        /^Missing server entry/u,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("prunes stale bb CLI chunks from package build output", () => {
    const pruneScript = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "prune-cli-chunks.mjs",
    );
    const packageRoot = mkdtempSync(join(tmpdir(), "bb-app-prune-"));
    try {
      const chunkDir = join(packageRoot, "host-daemon", "dist", "room-cli-chunks");
      mkdirSync(chunkDir, { recursive: true });
      writeFileSync(
        join(packageRoot, "host-daemon", "dist", "room-cli"),
        'import"./room-cli-chunks/chunk-LIVE.js";\n',
      );
      writeFileSync(join(chunkDir, "chunk-LIVE.js"), "export var a=1;\n");
      writeFileSync(join(chunkDir, "chunk-STALE.js"), "export var s=1;\n");
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "bb-app-prune-fixture",
          version: "0.0.1",
          files: ["host-daemon/dist/room-cli", "host-daemon/dist/room-cli-chunks"],
        }),
      );

      execFileSync("node", [pruneScript], { cwd: packageRoot });
      expect(readdirSync(chunkDir)).toEqual(["chunk-LIVE.js"]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("keeps the desktop app surface the desktop shell passes to the server", () => {
    const context = createTestStartContext();

    const desktopServerEnv = createServerEnv(context, { BB_APP_SURFACE: "desktop" });
    const webServerEnv = createServerEnv(context, {});
    const invalidSurfaceServerEnv = createServerEnv(context, { BB_APP_SURFACE: "bogus" });

    expect(desktopServerEnv.BB_APP_SURFACE).toBe("desktop");
    expect(webServerEnv.BB_APP_SURFACE).toBe("web");
    expect(invalidSurfaceServerEnv.BB_APP_SURFACE).toBe("web");
  });
});

