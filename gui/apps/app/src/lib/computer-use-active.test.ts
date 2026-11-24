// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PluginSignalHandler = (signal: {
  pluginId: string;
  channel: string;
  payload: unknown;
}) => void;
type ConnectedHandler = () => void;
type ChangedHandler = (message: { entity: string; changes: string[] }) => void;

const wsMocks = vi.hoisted(() => {
  const signalHandlers = new Set<PluginSignalHandler>();
  const connectedHandlers = new Set<ConnectedHandler>();
  const changedHandlers = new Set<ChangedHandler>();
  return {
    signalHandlers,
    connectedHandlers,
    changedHandlers,
    wsManager: {
      onPluginSignal: vi.fn((fn: PluginSignalHandler) => {
        signalHandlers.add(fn);
        return () => signalHandlers.delete(fn);
      }),
      onConnected: vi.fn((fn: ConnectedHandler) => {
        connectedHandlers.add(fn);
        return () => connectedHandlers.delete(fn);
      }),
      onChanged: vi.fn((fn: ChangedHandler) => {
        changedHandlers.add(fn);
        return () => changedHandlers.delete(fn);
      }),
    },
    callPluginRpc: vi.fn(),
  };
});

vi.mock("./ws", () => ({ wsManager: wsMocks.wsManager }));
vi.mock("./plugin-sdk-hooks", () => ({
  callPluginRpc: wsMocks.callPluginRpc,
}));

import {
  getComputerUseActivity,
  resetComputerUseActiveForTest,
  subscribeComputerUseActivity,
} from "./computer-use-active";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetComputerUseActiveForTest();
  wsMocks.callPluginRpc.mockReset();
  wsMocks.wsManager.onPluginSignal.mockClear();
  wsMocks.wsManager.onConnected.mockClear();
  wsMocks.wsManager.onChanged.mockClear();
});

afterEach(() => {
  resetComputerUseActiveForTest();
});

describe("computer-use-active store", () => {
  it("hydrates from getActive RPC and applies plugin-signal updates per thread", async () => {
    wsMocks.callPluginRpc.mockResolvedValueOnce({
      active: [{ threadId: "thr_1", appName: "Brave" }],
    });

    const thr1Listener = vi.fn();
    const thr2Listener = vi.fn();
    const unsub1 = subscribeComputerUseActivity("thr_1", thr1Listener);
    const unsub2 = subscribeComputerUseActivity("thr_2", thr2Listener);

    await vi.waitFor(() => {
      expect(getComputerUseActivity("thr_1")).toEqual({ appName: "Brave" });
    });
    expect(getComputerUseActivity("thr_2")).toBeNull();
    expect(thr1Listener).toHaveBeenCalledTimes(1);
    expect(thr2Listener).toHaveBeenCalledTimes(0);

    // Signal updates only thr_2; thr_1 stays referentially stable and is not notified.
    const prevThr1 = getComputerUseActivity("thr_1");
    for (const handler of wsMocks.signalHandlers) {
      handler({
        pluginId: "computer-use",
        channel: "active-changed",
        payload: {
          active: [
            { threadId: "thr_1", appName: "Brave" },
            { threadId: "thr_2", appName: null },
          ],
        },
      });
    }
    expect(getComputerUseActivity("thr_1")).toBe(prevThr1);
    expect(getComputerUseActivity("thr_2")).toEqual({ appName: null });
    expect(thr1Listener).toHaveBeenCalledTimes(1);
    expect(thr2Listener).toHaveBeenCalledTimes(1);

    // Unrelated plugin signal is ignored.
    for (const handler of wsMocks.signalHandlers) {
      handler({
        pluginId: "other-plugin",
        channel: "active-changed",
        payload: { active: [] },
      });
    }
    expect(getComputerUseActivity("thr_1")).toEqual({ appName: "Brave" });

    unsub1();
    unsub2();
    expect(wsMocks.signalHandlers.size).toBe(0);
  });

  it("ignores stale getActive RPC responses that settle after a live signal", async () => {
    const rpc = deferred<{ active: { threadId: string; appName: string | null }[] }>();
    wsMocks.callPluginRpc.mockReturnValueOnce(rpc.promise);

    const listener = vi.fn();
    const unsub = subscribeComputerUseActivity("thr_1", listener);

    for (const handler of wsMocks.signalHandlers) {
      handler({
        pluginId: "computer-use",
        channel: "active-changed",
        payload: {
          active: [{ threadId: "thr_1", appName: "Finder" }],
        },
      });
    }
    expect(getComputerUseActivity("thr_1")).toEqual({ appName: "Finder" });

    // Stale RPC returns empty; must not clobber newer signal state.
    rpc.resolve({ active: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(getComputerUseActivity("thr_1")).toEqual({ appName: "Finder" });

    unsub();
  });

  it("refreshes on reconnect and clears active state if plugin is unavailable", async () => {
    wsMocks.callPluginRpc
      .mockResolvedValueOnce({
        active: [{ threadId: "thr_1", appName: "Safari" }],
      })
      .mockRejectedValueOnce(new Error("plugin disabled"));

    const unsub = subscribeComputerUseActivity("thr_1", vi.fn());
    await vi.waitFor(() => {
      expect(getComputerUseActivity("thr_1")).toEqual({ appName: "Safari" });
    });

    for (const handler of wsMocks.changedHandlers) {
      handler({ entity: "system", changes: ["plugins-changed"] });
    }
    await vi.waitFor(() => {
      expect(getComputerUseActivity("thr_1")).toBeNull();
    });

    unsub();
  });
});
