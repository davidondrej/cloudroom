import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
  makeTurnFailedEvent,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import plugin, {
  GAVE_UP_MESSAGE,
  MAX_WAIT_MS,
  NETWORK_RETRY_REASON,
  REASK_MS,
  WAITING_REASON,
  createDispatchPolicy,
  networkFailureKind,
  proxyConfigured,
} from "./server.js";
import { CHECK_EVERY_MS, WATCH_MS, createInternetMonitor } from "./src/monitor.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");

function networkRetryRow(id: string, attempt = 2, createdAt = NOW) {
  return makeQueueEntry({
    id,
    createdAt,
    payload: {
      kind: "retry",
      retryOfTurnRequestId: "creq_aaaaaaaaaa",
      attempt,
      reason: NETWORK_RETRY_REASON,
    },
  });
}

function dispatchOf(row: ReturnType<typeof makeQueueEntry>) {
  return makeMessageDispatchHookContext({
    queuedMessages: [row],
    queuedMessage: row,
  });
}

function fakeMonitor(stableForMs: number, checkedRecently = true) {
  return { stableForMs: () => stableForMs, checkedRecently: () => checkedRecently, watch: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("internet monitor", () => {
  it("counts unbroken good checks, starts over on a bad one, and reports each step", async () => {
    vi.useFakeTimers({ now: NOW });
    const answers = [true, false, true, true];
    const onStable = vi.fn();
    const monitor = createInternetMonitor({
      onStable,
      probe: async () => answers.shift() ?? true,
      addresses: () => "192.168.1.20",
    });

    monitor.reportNetworkFailure();
    await vi.advanceTimersByTimeAsync(1_000 + CHECK_EVERY_MS);
    // Good, then bad: the streak starts over.
    expect(monitor.stableForMs()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * CHECK_EVERY_MS);
    expect(monitor.stableForMs()).toBe(CHECK_EVERY_MS);
    expect(onStable).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it("stops checking once nothing asks, and ignores a check that ends after stop", async () => {
    vi.useFakeTimers({ now: NOW });
    let finish: (ok: boolean) => void = () => {};
    const probe = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const onStable = vi.fn();
    const monitor = createInternetMonitor({ onStable, probe, addresses: () => "a" });

    monitor.watch();
    await vi.advanceTimersByTimeAsync(1_000);
    monitor.stop();
    finish(true);
    await vi.advanceTimersByTimeAsync(WATCH_MS);
    expect(monitor.watching()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onStable).not.toHaveBeenCalled();
  });
});

describe("dispatch policy", () => {
  it("lets other messages through and holds a retry, re-asking every minute", () => {
    const monitor = fakeMonitor(0);
    const policy = createDispatchPolicy(monitor, { now: () => NOW });

    expect(policy(makeMessageDispatchHookContext())).toEqual({ action: "proceed" });
    expect(policy(dispatchOf(networkRetryRow("q1")))).toEqual({
      action: "wait",
      reason: WAITING_REASON,
      sendAt: NOW + REASK_MS,
    });
    expect(monitor.watch).toHaveBeenCalledTimes(1);
  });

  it("needs a longer stable internet for each later attempt", () => {
    const policy = createDispatchPolicy(fakeMonitor(10_000), { now: () => NOW });

    expect(policy(dispatchOf(networkRetryRow("q1", 2)))).toEqual({ action: "proceed" });
    expect(policy(dispatchOf(networkRetryRow("q2", 3)))).toMatchObject({ action: "wait" });
  });

  it("gives up after 6 hours only on a fresh failed check, so a waking Mac checks first", () => {
    const old = networkRetryRow("q1", 2, NOW - MAX_WAIT_MS);
    const justWoke = createDispatchPolicy(fakeMonitor(0, false), { now: () => NOW });
    const checked = createDispatchPolicy(fakeMonitor(0, true), { now: () => NOW });

    expect(justWoke(dispatchOf(old))).toMatchObject({ action: "wait" });
    expect(checked(dispatchOf(old))).toEqual({ action: "reject", message: GAVE_UP_MESSAGE });
  });

  it("never holds anything when a proxy is set", () => {
    const policy = createDispatchPolicy(fakeMonitor(0), { now: () => NOW, proxied: true });

    expect(policy(dispatchOf(networkRetryRow("q1")))).toEqual({ action: "proceed" });
    expect(proxyConfigured({ HTTPS_PROXY: "http://proxy:8080" })).toBe(true);
    expect(proxyConfigured({})).toBe(false);
    // Node follows the proxy too, so the checks take the agents' route.
    expect(
      proxyConfigured({ HTTPS_PROXY: "http://proxy:8080", NODE_USE_ENV_PROXY: "1" }),
    ).toBe(false);
  });

  it("treats Claude's bare server_error as a maybe, and a real 500 as not ours", () => {
    expect(
      networkFailureKind({ category: "connection-failed", providerCode: null, httpStatusCode: null }),
    ).toBe("sure");
    expect(
      networkFailureKind({ category: "internal", providerCode: "server_error", httpStatusCode: null }),
    ).toBe("maybe");
    expect(
      networkFailureKind({ category: "internal", providerCode: "server_error", httpStatusCode: 500 }),
    ).toBeNull();
  });
});

describe("internet watch plugin", () => {
  function createHost(
    executionTarget: "local" | "cloud",
    queued: ReturnType<typeof makeQueueEntry>[] = [],
  ) {
    const retries: unknown[] = [];
    const sdk: CreateFakePluginHostOptions["sdk"] = {
      threads: {
        get: async () => makeThreadResponse({ executionTarget }),
        queue: { list: async () => queued },
        retry: async (args: { sendAt?: number }) => {
          retries.push(args);
          return {
            ok: true,
            delivery: "queued",
            turnRequestId: "creq_aaaaaaaaaa",
            attempt: 2,
            queuedMessageId: "queued_1",
            waitingOn: { kind: "time" },
            sendAt: args.sendAt ?? null,
          };
        },
      },
    };
    return {
      ...createFakePluginHost({ pluginId: "internet-watch", sdk }),
      retries,
    };
  }

  function failure(category: string, providerCode: string | null) {
    return makeTurnFailedEvent({
      threadId: "thread-1",
      requestId: "creq_aaaaaaaaaa",
      errorInfo: {
        category: category as "connection-failed",
        providerCode,
        httpStatusCode: null,
      },
    });
  }

  it("retries a Local thread's network failure, never a Cloud thread's", async () => {
    for (const target of ["local", "cloud"] as const) {
      const host = createHost(target);
      plugin(host.bb, { probe: async () => true });
      const { errors } = await host.harness.behavior.emitThreadEvent(
        "turn.failed",
        failure("connection-failed", "server_error"),
      );
      expect(errors).toEqual([]);
      expect(host.retries).toEqual(
        target === "local"
          ? [expect.objectContaining({ threadId: "thread-1", reason: NETWORK_RETRY_REASON })]
          : [],
      );
      await host.harness.dispose();
    }
  });

  it("retries a maybe-network failure only when the check finds no internet", async () => {
    for (const online of [true, false]) {
      const host = createHost("local");
      plugin(host.bb, { probe: async () => online });
      await host.harness.behavior.emitThreadEvent(
        "turn.failed",
        failure("stream-disconnected", "responseStreamDisconnected"),
      );
      expect(host.retries).toHaveLength(online ? 0 : 1);
      await host.harness.dispose();
    }
  });

  it("checks again at startup when retries were held before a restart", async () => {
    vi.useFakeTimers({ now: NOW });
    const host = createHost("local", [networkRetryRow("q1")]);
    plugin(host.bb, { probe: async () => true });

    await vi.advanceTimersByTimeAsync(1_000 + CHECK_EVERY_MS);

    expect(host.harness.inspection.recheckCount).toBe(1);
    await host.harness.dispose();
  });
});
