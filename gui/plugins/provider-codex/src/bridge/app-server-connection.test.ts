import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import * as providerBridge from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CodexAppServerExitedError,
  createCodexAppServerConnection,
  type CodexAppServerConnection,
  type CodexAppServerExitInfo,
} from "./app-server-connection.js";

const EPIPE_PAYLOAD_SIZE = 1024 * 1024;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...actual,
    experimental_spawnPortableProcess: vi.fn(
      actual.experimental_spawnPortableProcess,
    ),
    experimental_killPortableProcess: vi.fn(
      actual.experimental_killPortableProcess,
    ),
  };
});

afterEach(() => vi.resetAllMocks());

function stubChildProcess() {
  const child = new childProcess.ChildProcess();
  const stdin = (child.stdin = new PassThrough());
  const stdout = (child.stdout = new PassThrough());
  const stderr = (child.stderr = new PassThrough());
  vi.mocked(childProcess.spawn).mockReturnValue(child);
  vi.mocked(providerBridge.experimental_spawnPortableProcess).mockReturnValue(
    child,
  );
  const kill = vi.mocked(
    providerBridge.experimental_killPortableProcess,
  ).mockResolvedValue({
    treeTermination: "unverified",
  });
  return { child, stdin, stdout, stderr, kill };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

async function stopConnection(
  connection: CodexAppServerConnection,
  exit: Promise<CodexAppServerExitInfo>,
): Promise<void> {
  await connection.kill();
  await exit;
}

function childRequestLine(): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id: "child-request",
    method: "fixture/approval",
    params: {},
  })}\n`;
}

describe("codex app-server connection", () => {
  it("preserves final output and exit details while stdio drains", async () => {
    // Windows cannot keep this pipe open by inheriting stdout in a descendant.
    // Control exit and close separately to exercise the drain on every platform.
    const { child, stdin, stdout, stderr, kill } = stubChildProcess();
    const exited = deferred<CodexAppServerExitInfo>();
    const lateResponseLine = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { thread: { id: "thread-from-final-output" } },
    })}\n`;
    let respond: (() => void) | undefined;
    const connection = createCodexAppServerConnection({
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      env: process.env,
      recordThreadId: null,
      onNotification: () => undefined,
      onRequest: (_method, _params, responder) => {
        respond = () => responder.result({ decision: "accept" });
      },
      onExit: exited.resolve,
    });

    try {
      const pendingRequest = connection.request({
        method: "thread/start",
        resultSchema: z.object({
          thread: z.object({ id: z.string() }),
        }),
      });
      stderr.write("fixture stderr\n");
      stdout.write(childRequestLine());
      child.emit("exit", 7, null);
      expect(connection.exited).toBe(false);
      respond!();
      stdin.emit(
        "error",
        Object.assign(new Error("closed pipe"), { code: "EPIPE" }),
      );
      stdout.write(lateResponseLine);
      child.emit("close", 7, null);
      await expect(pendingRequest).resolves.toEqual({
        thread: { id: "thread-from-final-output" },
      });
      await expect(exited.promise).resolves.toEqual({
        code: 7,
        signal: null,
        stderrTail: "fixture stderr",
        spawnFailed: false,
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      child.emit("close", 7, null);
      await stopConnection(connection, exited.promise);
    }
  }, 30_000);

  it("reads a real child's final response before its natural exit", async () => {
    const exited = deferred<CodexAppServerExitInfo>();
    const responseLine = `${JSON.stringify({ id: 1, result: { ok: true } })}\n`;
    const connection = createCodexAppServerConnection({
      command: process.execPath,
      args: [
        "-e",
        `process.stdin.once("data", () => process.stdout.write(${JSON.stringify(responseLine)}, () => process.exit(7)));`,
      ],
      cwd: process.cwd(),
      env: process.env,
      recordThreadId: null,
      onNotification: () => undefined,
      onRequest: () => undefined,
      onExit: exited.resolve,
    });

    try {
      await expect(
        connection.request({
          method: "fixture/final-response",
          resultSchema: z.object({ ok: z.boolean() }),
        }),
      ).resolves.toEqual({ ok: true });
      await expect(exited.promise).resolves.toEqual({
        code: 7,
        signal: null,
        stderrTail: "",
        spawnFailed: false,
      });
    } finally {
      await stopConnection(connection, exited.promise);
    }
  }, 30_000);

  it("preserves a natural exit status when EPIPE precedes exit", async () => {
    const exited = deferred<CodexAppServerExitInfo>();
    const connection = createCodexAppServerConnection({
      command: process.execPath,
      args: [
        "-e",
        'process.stderr.write("fixture stderr\\n"); process.exit(7);',
      ],
      cwd: process.cwd(),
      env: process.env,
      recordThreadId: null,
      onNotification: () => undefined,
      onRequest: () => undefined,
      onExit: exited.resolve,
    });

    try {
      await expect(
        connection.request({
          method: "thread/start",
          params: { payload: "x".repeat(EPIPE_PAYLOAD_SIZE) },
          resultSchema: z.unknown(),
        }),
      ).rejects.toThrow(/codex app-server exited \(code 7, signal null\)/);
      await expect(exited.promise).resolves.toMatchObject({
        code: 7,
        signal: null,
        stderrTail: expect.stringContaining("fixture stderr"),
        spawnFailed: false,
      });
    } finally {
      await stopConnection(connection, exited.promise);
    }
  }, 30_000);

  it.each([
    "EPIPE",
    "ERR_STREAM_DESTROYED",
    ...(process.platform === "win32" ? ["EOF"] : []),
  ])("makes a broken child stdin immediately terminal (%s)", async (code) => {
    // closeSync(0) does not close Node's Windows pipe handle. Inject the error
    // the parent actually receives, independently of child fd/signal behavior.
    const { child, stdin, kill } = stubChildProcess();
    const exited = deferred<CodexAppServerExitInfo>();
    const connection = createCodexAppServerConnection({
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      env: process.env,
      recordThreadId: null,
      onNotification: () => undefined,
      onRequest: () => undefined,
      onExit: exited.resolve,
    });

    try {
      const pendingRequest = connection.request({
        method: "thread/start",
        params: { payload: "x".repeat(EPIPE_PAYLOAD_SIZE) },
        resultSchema: z.unknown(),
      });
      stdin.emit("error", Object.assign(new Error("closed pipe"), { code }));
      expect(connection.exited).toBe(true);
      await expect(
        connection.request({
          method: "thread/resume",
          resultSchema: z.unknown(),
        }),
      ).rejects.toBeInstanceOf(CodexAppServerExitedError);
      expect(kill).toHaveBeenCalledExactlyOnceWith(child, "SIGKILL");
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      await expect(pendingRequest).rejects.toBeInstanceOf(
        CodexAppServerExitedError,
      );
      await expect(exited.promise).resolves.toMatchObject({
        code: null,
        signal: "SIGKILL",
        stderrTail: expect.stringContaining(`stdin failed (${code})`),
        spawnFailed: false,
      });
    } finally {
      child.emit("close", null, "SIGKILL");
      await stopConnection(connection, exited.promise);
    }
  }, 30_000);
});
