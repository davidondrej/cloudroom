import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  findCliExecutable,
  installSafeProcessDiagnostics,
  isPathWithinDirectory,
  officialCodexPath,
  resolveContainedPath,
  sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess,
  spawnPortablePipedProcess,
  writeSafeProcessDiagnosticReport,
} from "../src/index.js";

async function readProcessOutput() {
  const child = spawnPortablePipedProcess({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("stdout"); process.stderr.write("stderr");',
    ],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const [exitCode] = await once(child, "exit");
  return {
    exitCode,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  };
}

describe("process utils", () => {
  it("installs safe diagnostics without enabling Node process reports", () => {
    const originalDirectory = process.report.directory;
    const originalReportOnFatalError = process.report.reportOnFatalError;
    const originalReportOnUncaughtException =
      process.report.reportOnUncaughtException;
    const originalListenerCount = process.listenerCount(
      "uncaughtExceptionMonitor",
    );
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );

    const dispose = installSafeProcessDiagnostics({
      logsDir,
      processName: "test-process",
    });

    try {
      expect(existsSync(logsDir)).toBe(true);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
        originalListenerCount + 1,
      );
      expect(process.report.directory).toBe(originalDirectory);
      expect(process.report.reportOnFatalError).toBe(
        originalReportOnFatalError,
      );
      expect(process.report.reportOnUncaughtException).toBe(
        originalReportOnUncaughtException,
      );
    } finally {
      dispose();
    }

    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
      originalListenerCount,
    );
  });

  it("writes env-safe diagnostic reports", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const secretValue = "sk-test-secret-that-must-not-leak";
    process.env.OPENAI_API_KEY = secretValue;

    try {
      const reportPath = writeSafeProcessDiagnosticReport({
        kind: "startupFailure",
        logsDir,
        processName: "test-process",
        error: new Error("startup failed"),
        now: () => new Date("2026-06-01T12:00:00.000Z"),
        createReportId: () => "report-id",
      });
      const reportText = readFileSync(reportPath, "utf8");

      expect(reportText).toContain('"kind": "startupFailure"');
      expect(reportText).toContain('"processName": "test-process"');
      expect(reportText).toContain('"message": "startup failed"');
      expect(reportText).not.toContain("OPENAI_API_KEY");
      expect(reportText).not.toContain(secretValue);
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      }
    }
  });

  it("writes nested error causes", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const connectionError = new Error("connect ECONNREFUSED 127.0.0.1:38886");
    Object.defineProperty(connectionError, "code", {
      value: "ECONNREFUSED",
    });
    const reportPath = writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir,
      processName: "host-daemon",
      error: new TypeError("fetch failed", { cause: connectionError }),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      createReportId: () => "report-id",
    });

    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      error: {
        name: "TypeError",
        message: "fetch failed",
        cause: {
          name: "Error",
          message: "connect ECONNREFUSED 127.0.0.1:38886",
          code: "ECONNREFUSED",
        },
      },
    });
  });

  it("truncates cyclic error causes", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const firstError = new Error("first");
    const secondError = new Error("second");
    firstError.cause = secondError;
    secondError.cause = firstError;

    const reportPath = writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir,
      processName: "host-daemon",
      error: firstError,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      createReportId: () => "report-id",
    });

    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      error: {
        message: "first",
        cause: {
          message: "second",
          cause: {
            name: "TruncatedErrorCause",
            truncationReason: "cycle",
          },
        },
      },
    });
  });

  it("truncates error causes that exceed the depth limit", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const rootError = new Error("cause-0");
    let currentError = rootError;
    for (let index = 1; index < 32; index += 1) {
      const cause = new Error(`cause-${index}`);
      currentError.cause = cause;
      currentError = cause;
    }

    const reportPath = writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir,
      processName: "host-daemon",
      error: rootError,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      createReportId: () => "report-id",
    });
    const reportText = readFileSync(reportPath, "utf8");

    expect(reportText).toContain('"name": "TruncatedErrorCause"');
    expect(reportText).toContain('"truncationReason": "depth"');
    expect(reportText).not.toContain("cause-31");
  });

  it("writes bounded AggregateError details", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const connectionErrors = Array.from({ length: 10 }, (_, index) => {
      const error = new Error(`connect ECONNREFUSED address-${index}`);
      Object.defineProperty(error, "code", { value: "ECONNREFUSED" });
      return error;
    });
    const reportPath = writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir,
      processName: "host-daemon",
      error: new AggregateError(connectionErrors, "fetch failed"),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      createReportId: () => "report-id",
    });
    const reportText = readFileSync(reportPath, "utf8");

    expect(reportText).toContain('"errors"');
    expect(reportText).toContain('"code": "ECONNREFUSED"');
    expect(reportText).toContain("connect ECONNREFUSED address-7");
    expect(reportText).toContain('"errorsTruncated": 2');
    expect(reportText).not.toContain("connect ECONNREFUSED address-8");
  });

  it("spawns a process with piped stdio", async () => {
    await expect(readProcessOutput()).resolves.toEqual({
      exitCode: 0,
      stdout: "stdout",
      stderr: "stderr",
    });
  });

  it("spawns a process with stdin closed and output piped", async () => {
    const child = spawnPortableOutputProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdin.on("error", () => {}); process.stdin.on("end", () => process.stdout.write("closed")); process.stdin.resume();',
      ],
    });

    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));

    const [exitCode] = await once(child, "exit");

    expect(exitCode).toBe(0);
    expect(child.stdin).toBeNull();
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toBe("closed");
  });

  it("resolves paths that stay within the configured root", () => {
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root/child/file.txt",
      }),
    ).toBe(resolve("/tmp/root/child/file.txt"));
  });

  it("rejects root and escaped paths", () => {
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root",
      }),
    ).toBeNull();
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root/../escape",
      }),
    ).toBeNull();
  });

  it("keeps children whose names start with two dots inside the directory", () => {
    const root = join(tmpdir(), "root");
    expect(isPathWithinDirectory(root, root)).toBe(true);
    expect(
      isPathWithinDirectory(root, join(root, "..assets", "logo.svg")),
    ).toBe(true);
    expect(isPathWithinDirectory(root, join(root, "..."))).toBe(true);
    expect(isPathWithinDirectory(root, join(root, ".."))).toBe(false);
    expect(isPathWithinDirectory(root, join(root, "..", "escape"))).toBe(false);
    expect(isPathWithinDirectory(root, join(tmpdir(), "root-sibling"))).toBe(
      false,
    );
  });

  it("scrubs inherited bb runtime env vars and node mode", () => {
    const env: NodeJS.ProcessEnv = {
      BB_DATA_DIR: "/tmp/bb-data",
      BB_HOST_DAEMON_PORT: "38887",
      ROOM_SERVER_URL: "http://127.0.0.1:39886",
      ROOM_THREAD_ID: "parent_thread",
      ROOM_CLI_REEXEC: "1",
      NODE_ENV: "development",
      NODE_OPTIONS: "--enable-source-maps",
      OPENAI_API_KEY: "external-secret",
      PATH: "/bin",
      SKIP_ME: undefined,
    };

    const sanitizedEnv = sanitizeInheritedChildProcessEnv({ env });
    expect(sanitizedEnv).toEqual({
      NODE_OPTIONS: "--enable-source-maps",
      OPENAI_API_KEY: "external-secret",
      PATH: "/bin",
    });
    expect("SKIP_ME" in sanitizedEnv).toBe(false);
  });

  it("keeps provider credentials a nested bb server needs and drops the pool marker", () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:38886/pool/http",
      ANTHROPIC_AUTH_TOKEN: "parent-hub-token",
      CODEX_OPENAI_BASE_URL: "http://127.0.0.1:38886/pool/http/v1",
      CODEX_POOL_AUTH_TOKEN: "parent-hub-token",
      ENABLE_TOOL_SEARCH: "true",
      BB_ACCOUNT_POOL_PARENT_URL: "http://127.0.0.1:38886/pool/http",
      BB_ACCOUNT_POOL_PARENT_TOKEN: "parent-hub-token",
      PATH: "/bin",
    };

    expect(sanitizeInheritedChildProcessEnv({ env })).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:38886/pool/http",
      ANTHROPIC_AUTH_TOKEN: "parent-hub-token",
      CODEX_OPENAI_BASE_URL: "http://127.0.0.1:38886/pool/http/v1",
      CODEX_POOL_AUTH_TOKEN: "parent-hub-token",
      ENABLE_TOOL_SEARCH: "true",
      PATH: "/bin",
    });
  });

  it("does not mutate the inherited env", () => {
    const env: NodeJS.ProcessEnv = {
      BB_DATA_DIR: "/tmp/bb-data",
      NODE_ENV: "development",
      PATH: "/bin",
    };
    const originalEnv: NodeJS.ProcessEnv = { ...env };

    expect(sanitizeInheritedChildProcessEnv({ env })).toEqual({
      PATH: "/bin",
    });
    expect(env).toEqual(originalEnv);
  });

  it("prefers OpenAI's official Codex over a codex on PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-pick-"));
    // Windows only runs a file with a PATHEXT extension.
    const extension = process.platform === "win32" ? ".exe" : "";
    const pathCodex = join(home, "bin", `codex${extension}`);
    mkdirSync(join(home, "bin"));
    writeFileSync(pathCodex, "", { mode: 0o755 });
    const env = { HOME: home, PATH: join(home, "bin") };
    expect(findCliExecutable("codex", env)).toBe(pathCodex);
    const official = `${officialCodexPath(env)}${extension}`;
    mkdirSync(join(official, ".."), { recursive: true });
    writeFileSync(official, "", { mode: 0o755 });
    expect(findCliExecutable("codex", env)).toBe(official);
  });

  // #96: running a binary inside a flagged Codex.app gets the whole app moved to the Bin.
  it.skipIf(process.platform === "win32")(
    "never resolves the Codex inside Codex.app or ChatGPT.app, even through PATH",
    () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", {
        ...platform,
        value: "darwin",
      });
      try {
        const home = mkdtempSync(join(tmpdir(), "codex-app-"));
        const bin = join(home, "bin");
        mkdirSync(bin);
        const env = { HOME: home, PATH: bin };
        // A codex this machine keeps in /usr/local/bin or Homebrew; null on a clean Mac.
        const elsewhere = findCliExecutable("codex", env);
        const bundled = ["ChatGPT.app", "Codex.app"].flatMap((app) => {
          const resources = join(
            home,
            "Applications",
            app,
            "Contents",
            "Resources",
          );
          return [
            join(resources, "codex-cli", "bin", "codex"),
            join(resources, "codex"),
          ];
        });
        for (const file of bundled) {
          mkdirSync(join(file, ".."), { recursive: true });
          writeFileSync(file, "", { mode: 0o755 });
        }
        expect(findCliExecutable("codex", env)).toBe(elsewhere);
        symlinkSync(bundled[0]!, join(bin, "codex"));
        expect(findCliExecutable("codex", env)).toBe(elsewhere);

        // A real PATH install, then OpenAI's official one, still win as before.
        rmSync(join(bin, "codex"));
        writeFileSync(join(bin, "codex"), "", { mode: 0o755 });
        expect(findCliExecutable("codex", env)).toBe(join(bin, "codex"));
        const official = officialCodexPath(env);
        mkdirSync(join(official, ".."), { recursive: true });
        writeFileSync(official, "", { mode: 0o755 });
        expect(findCliExecutable("codex", env)).toBe(official);
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    },
  );
});
