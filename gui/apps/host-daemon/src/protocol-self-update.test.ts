import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@cloudroom/host-daemon-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonLogger } from "./logger.js";
import {
  createProtocolSelfUpdater,
  SELF_UPDATE_INITIAL_RETRY_DELAY_MS,
  SELF_UPDATE_MAX_RETRY_DELAY_MS,
} from "./protocol-self-update.js";

const roots: string[] = [];

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies HostDaemonLogger;
}

async function createFixture(
  args: {
    enabled?: boolean;
    protocolVersion?: number;
    installFailure?: Error;
    now?: () => number;
    serverUrl?: string;
    useDefaultInstaller?: boolean;
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-self-update-test-"));
  roots.push(dataDir);
  const installTarball = vi.fn(async () => {
    if (args.installFailure) throw args.installFailure;
  });
  const runProcess = vi.fn(async (): Promise<void> => undefined);
  const fetchFn = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/install/version")) {
        return Response.json({
          version: "9.0.0-test",
          protocolVersion:
            args.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION + 1,
        });
      }
      if (url.endsWith("/install/bb-app.tgz")) {
        return new Response("tarball");
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  );
  const testLogger = logger();
  const updater = createProtocolSelfUpdater({
    dataDir,
    enabled: args.enabled ?? true,
    fetchFn,
    ...(args.useDefaultInstaller ? { runProcess } : { installTarball }),
    logger: testLogger,
    now: args.now,
    serverUrl: args.serverUrl ?? "https://server.example.test",
  });
  return {
    dataDir,
    fetchFn,
    installTarball,
    logger: testLogger,
    runProcess,
    updater,
  };
}

beforeEach(() => {
  vi.stubEnv("BB_APP_NPM_PREFIX", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("protocol self-update", () => {
  it("installs exactly once when the server protocol is newer and enabled", async () => {
    const test = await createFixture();
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.fetchFn).toHaveBeenCalledTimes(2);
    expect(test.installTarball).toHaveBeenCalledOnce();
  });

  it("verifies and persists the server artifact digest", async () => {
    const test = await createFixture();
    const bytes = new TextEncoder().encode("verified-tarball");
    const digest = createHash("sha256").update(bytes).digest("hex");
    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/install/version")) {
        return Response.json({
          version: "9.0.0-test",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
        });
      }
      return new Response(bytes, {
        headers: { "x-bb-artifact-sha256": digest },
      });
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    await expect(
      readFile(join(test.dataDir, "host-artifact.sha256"), "utf8"),
    ).resolves.toBe(`${digest}\n`);
    expect(test.installTarball).toHaveBeenCalledOnce();
  });

  it("rejects a downloaded artifact whose digest does not match", async () => {
    const test = await createFixture();
    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/install/version")) {
        return Response.json({
          version: "9.0.0-test",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
        });
      }
      return new Response("tampered", {
        headers: { "x-bb-artifact-sha256": "a".repeat(64) },
      });
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    expect(test.installTarball).not.toHaveBeenCalled();
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("self-update failed"),
    );
  });

  it("skips downloading and reinstalling an identical installed artifact", async () => {
    const test = await createFixture();
    const digest = "b".repeat(64);
    await writeFile(join(test.dataDir, "host-artifact.sha256"), `${digest}\n`);
    test.fetchFn.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/install/version")) {
          return Response.json({
            version: "9.0.0-test",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
          });
        }
        expect(init?.headers).toEqual({
          "if-none-match": `"sha256-${digest}"`,
        });
        return new Response(null, {
          headers: { "x-bb-artifact-sha256": digest },
          status: 304,
        });
      },
    );

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.installTarball).not.toHaveBeenCalled();
    expect(test.logger.info).toHaveBeenCalledWith(
      { artifactDigest: digest },
      expect.stringContaining("already installed"),
    );
  });

  it("finds npm beside the running Node executable when the service PATH omits it", async () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const test = await createFixture({ useDefaultInstaller: true });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );

    expect(test.runProcess).toHaveBeenCalledOnce();
    expect(test.runProcess).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "-g",
        "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher",
        expect.stringContaining("bb-app-update-"),
      ],
      {
        env: expect.objectContaining({
          PATH: `${dirname(process.execPath)}${delimiter}/usr/bin:/bin`,
        }),
      },
    );
  });

  it("updates an installer-managed bb-app inside its machine-specific prefix", async () => {
    const test = await createFixture({ useDefaultInstaller: true });
    const prefix = join(test.dataDir, "npm");
    const cli = join(
      prefix,
      "lib/node_modules/bb-app/host-daemon/dist/room-cli",
    );
    vi.stubEnv("BB_APP_NPM_PREFIX", prefix);
    test.runProcess.mockImplementationOnce(async () => {
      await mkdir(dirname(cli), { recursive: true });
      await writeFile(cli, "// installed CLI\n", { mode: 0o640 });
      await chmod(cli, 0o640);
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );

    expect(test.runProcess).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "-g",
        "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher",
        "--prefix",
        prefix,
        expect.stringContaining("bb-app-update-"),
      ],
      expect.any(Object),
    );
    if (process.platform !== "win32") {
      expect((await stat(cli)).mode & 0o777).toBe(0o740);
    }
  });

  it.skipIf(process.platform === "win32")(
    "repairs a cached installed CLI without reinstalling",
    async () => {
      const test = await createFixture();
      const prefix = join(test.dataDir, "npm");
      const cli = join(
        prefix,
        "lib/node_modules/bb-app/host-daemon/dist/room-cli",
      );
      vi.stubEnv("BB_APP_NPM_PREFIX", prefix);
      await mkdir(dirname(cli), { recursive: true });
      await writeFile(cli, "// cached CLI\n", { mode: 0o640 });
      await chmod(cli, 0o640);
      await writeFile(
        join(test.dataDir, "host-artifact.sha256"),
        "b".repeat(64),
      );
      test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/install/version")) {
          return Response.json({
            version: "9.0.0-test",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
          });
        }
        return new Response(null, { status: 304 });
      });

      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "updated",
      );
      expect((await stat(cli)).mode & 0o777).toBe(0o740);
      expect(test.installTarball).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "reinstalls a cached artifact on retry when its bundled CLI is missing",
    async () => {
      const test = await createFixture({ useDefaultInstaller: true });
      const prefix = join(test.dataDir, "npm");
      const cli = join(
        prefix,
        "lib/node_modules/bb-app/host-daemon/dist/room-cli",
      );
      const digest = createHash("sha256").update("tarball").digest("hex");
      const digestPath = join(test.dataDir, "host-artifact.sha256");
      vi.stubEnv("BB_APP_NPM_PREFIX", prefix);
      await writeFile(digestPath, digest);
      test.fetchFn.mockImplementation(async (input, init) => {
        if (String(input).endsWith("/install/version")) {
          return Response.json({
            version: "9.0.0-test",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
          });
        }
        if (new Headers(init?.headers).has("if-none-match")) {
          return new Response(null, { status: 304 });
        }
        return new Response("tarball", {
          headers: { "x-bb-artifact-sha256": digest },
        });
      });
      test.runProcess.mockImplementationOnce(async () => {
        await mkdir(dirname(cli), { recursive: true });
        await writeFile(cli, "// reinstalled CLI\n", { mode: 0o644 });
      });

      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "failed",
      );
      await expect(readFile(digestPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        test.updater.handleProtocolMismatch({ force: true }),
      ).resolves.toBe("updated");
      expect(test.runProcess).toHaveBeenCalledOnce();
      expect((await stat(cli)).mode & 0o100).toBe(0o100);
      await expect(readFile(digestPath, "utf8")).resolves.toBe(`${digest}\n`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails an update when the installed CLI is missing",
    async () => {
      const test = await createFixture({ useDefaultInstaller: true });
      vi.stubEnv("BB_APP_NPM_PREFIX", join(test.dataDir, "npm"));

      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "failed",
      );
      expect(test.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({ code: "ENOENT" }),
        }),
        expect.stringContaining("self-update failed"),
      );
    },
  );

  it("keeps legacy global updates when the installer prefix is blank", async () => {
    vi.stubEnv("BB_APP_NPM_PREFIX", " ");
    const test = await createFixture({ useDefaultInstaller: true });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );

    expect(test.runProcess).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "-g",
        "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher",
        expect.stringContaining("bb-app-update-"),
      ],
      expect.any(Object),
    );
  });

  it("does nothing when auto-update is disabled", async () => {
    const test = await createFixture({ enabled: false });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(test.fetchFn).not.toHaveBeenCalled();
    expect(test.installTarball).not.toHaveBeenCalled();
  });

  it("refuses auto-update over non-loopback HTTP", async () => {
    const test = await createFixture({
      serverUrl: "http://server.example.test",
    });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    expect(test.fetchFn).not.toHaveBeenCalled();
    expect(test.installTarball).not.toHaveBeenCalled();
    expect(test.logger.error).toHaveBeenCalledWith(
      { serverUrl: "http://server.example.test" },
      expect.stringContaining("insecure transport"),
    );
  });

  it("allows auto-update over loopback HTTP", async () => {
    const test = await createFixture({ serverUrl: "http://127.0.0.1:38886" });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.installTarball).toHaveBeenCalledOnce();
  });

  it("refuses equal protocol reinstalls and downgrades", async () => {
    for (const protocolVersion of [
      HOST_DAEMON_PROTOCOL_VERSION,
      HOST_DAEMON_PROTOCOL_VERSION - 1,
    ]) {
      const test = await createFixture({ protocolVersion });
      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "skipped",
      );
      expect(test.installTarball).not.toHaveBeenCalled();
    }
  });

  it("persists a short exponential retry backoff capped at five minutes", async () => {
    let now = 10_000;
    const test = await createFixture({ now: () => now });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    now += SELF_UPDATE_INITIAL_RETRY_DELAY_MS - 1;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(test.installTarball).toHaveBeenCalledOnce();

    now += 1;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.installTarball).toHaveBeenCalledTimes(2);

    for (let attemptCount = 2; attemptCount < 8; attemptCount += 1) {
      now += Math.min(
        SELF_UPDATE_INITIAL_RETRY_DELAY_MS * 2 ** (attemptCount - 1),
        SELF_UPDATE_MAX_RETRY_DELAY_MS,
      );
      await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
        "updated",
      );
    }

    now += SELF_UPDATE_MAX_RETRY_DELAY_MS - 1;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
  });

  it("contains install failures and rate-limits their retry", async () => {
    const test = await createFixture({
      installFailure: new Error("npm failed"),
      now: () => 25_000,
    });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );
    expect(test.installTarball).toHaveBeenCalledOnce();
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("self-update failed"),
    );
  });

  it("lets a user-requested retry bypass and reset the current backoff", async () => {
    let now = 25_000;
    const test = await createFixture({
      installFailure: new Error("download failed"),
      now: () => now,
    });
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "skipped",
    );

    await expect(
      test.updater.handleProtocolMismatch({ force: true }),
    ).resolves.toBe("failed");
    expect(test.installTarball).toHaveBeenCalledTimes(2);

    now += SELF_UPDATE_INITIAL_RETRY_DELAY_MS;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe("failed");
    expect(test.installTarball).toHaveBeenCalledTimes(3);
  });

  it("tries immediately when the server advances to another protocol", async () => {
    let now = 30_000;
    let protocolVersion = HOST_DAEMON_PROTOCOL_VERSION + 1;
    const test = await createFixture({ now: () => now });
    test.fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/install/version")) {
        return Response.json({ version: "test", protocolVersion });
      }
      return new Response("tarball");
    });

    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    protocolVersion += 1;
    await expect(test.updater.handleProtocolMismatch()).resolves.toBe(
      "updated",
    );
    expect(test.installTarball).toHaveBeenCalledTimes(2);
  });
});
