import { afterEach, describe, expect, it, vi } from "vitest";
import { OTHER_MAC_PING_MS, hasOfflineMark, reconnectOtherMac, watchOtherMac } from "../src/computers.js";

const offline = () => new Response("", { status: 503, headers: { "x-bb-tunnel-offline": "1" } });

describe("watchOtherMac", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a drop only for the relay's offline mark on the Mac still on screen", async () => {
    vi.useFakeTimers();
    let viewing: string | null = "https://abc.cloudroom.run";
    const answers = [new Response("{}", { status: 200 }), new Response("", { status: 504 }), offline()];
    const onOffline = vi.fn();
    const fetch = vi.fn(async (_url: string, _init: { signal: AbortSignal }) => answers.shift() ?? offline());
    const stop = watchOtherMac({ viewing: () => viewing, fetch, onOffline });

    await vi.advanceTimersByTimeAsync(OTHER_MAC_PING_MS * 2);
    expect(onOffline).not.toHaveBeenCalled(); // healthy, then a slow 504 without the mark
    await vi.advanceTimersByTimeAsync(OTHER_MAC_PING_MS);
    expect(onOffline).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://abc.cloudroom.run/health?from=desktop-ping");

    viewing = null; // back on this Mac: no more pings
    await vi.advanceTimersByTimeAsync(OTHER_MAC_PING_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
  });

  it("reads both relay offline marks", () => {
    expect(hasOfflineMark(503, (name) => (name === "x-cloudroom-offline" ? "1" : null))).toBe(true);
    expect(hasOfflineMark(503, () => null)).toBe(false);
    expect(hasOfflineMark(200, () => "1")).toBe(false);
  });
});

describe("reconnectOtherMac", () => {
  const steps: string[] = [];
  const run = (over: Partial<Parameters<typeof reconnectOtherMac<string>>[0]>) => {
    steps.length = 0;
    return reconnectOtherMac<string>({
      current: () => true,
      deadline: () => Date.now() + 30_000,
      open: async () => (steps.push("open"), "https://air.cloudroom.run"),
      load: async () => (steps.push("load"), true),
      showThisMac: async () => steps.push("this Mac"),
      sleep: async () => {},
      ...over,
    });
  };

  it("puts this Mac back after a failed page load, then keeps trying", async () => {
    let loads = 0;
    const opened = await run({ load: async () => (steps.push("load"), ++loads > 1) });
    expect(opened).toBe(true);
    expect(steps).toEqual(["open", "load", "this Mac", "open", "load"]);
  });

  it("stays on this Mac when the user stops while the page loads", async () => {
    let stopped = false;
    const opened = await run({
      deadline: () => (stopped ? null : Date.now() + 30_000),
      load: async () => {
        steps.push("load");
        stopped = true; // "Use this Mac now" while the other Mac's page was loading
        return true;
      },
    });
    expect(opened).toBe(false);
    expect(steps).toEqual(["open", "load", "this Mac"]);
  });
});
