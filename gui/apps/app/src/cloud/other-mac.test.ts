// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { keepOtherMacOnScreen } from "./other-mac";

vi.mock("@/lib/ws", () => ({
  wsManager: { getConnectionState: () => "connected" },
}));

const offline = () =>
  new Response("", { status: 503, headers: { "x-bb-tunnel-offline": "1" } });

describe("keepOtherMacOnScreen", () => {
  const original = window.fetch;
  afterEach(() => {
    window.fetch = original;
    vi.useRealTimers();
  });

  it("sends a request again when the relay says the Mac is offline, and passes the Mac's own errors on", async () => {
    vi.useFakeTimers();
    const answers = [
      offline(),
      offline(),
      new Response("sent"),
      new Response("", { status: 503 }),
    ];
    const network = vi.fn(async () => answers.shift()!);
    window.fetch = network as never;
    keepOtherMacOnScreen();

    const sent = window.fetch("/api/v1/threads/t1/messages", {
      method: "POST",
      body: "hi",
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await (await sent).text()).toBe("sent");
    expect(network).toHaveBeenCalledTimes(3);

    expect((await window.fetch("/api/v1/projects")).status).toBe(503);
    expect(network).toHaveBeenCalledTimes(4);
  });
});
