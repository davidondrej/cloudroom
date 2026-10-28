import { expect, it, vi } from "vitest";
import { runDaemonSetupToken } from "../../src/services/cloudroom/claude-token.js";

vi.mock("../../src/services/cloudroom/setup-telemetry.js", () => ({
  cliPlace: () => null,
  reportAgentConnect: () => {},
  reportCliInstall: () => {},
  scrub: (text: string) => text,
}));

const LINK = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback";
const running = { state: "running" as const, url: LINK, token: null, screen: ["Paste code here if prompted >"] };

it("Windows Connect Claude saves the daemon's token and ends the daemon's run", async () => {
  const actions: string[] = [];
  const save = vi.fn(async () => {});
  const run = runDaemonSetupToken("req", "claude.exe", save, async (action) => {
    actions.push(action);
    return actions.filter((done) => done === "read").length < 2 ? running : { ...running, token: "sk-ant-oat01-token" };
  });
  await vi.waitFor(() => expect(run.done).toBe(true), { timeout: 5_000 });
  expect(run.url).toBe(LINK);
  expect(run.error).toBeNull();
  expect(save).toHaveBeenCalledWith("sk-ant-oat01-token");
  expect(actions[0]).toBe("start");
  expect(actions).toContain("cancel");
});

it("Windows Connect Claude ends at once when the daemon is lost", async () => {
  const started = Date.now();
  const run = runDaemonSetupToken("req", "claude.exe", async () => {}, async (action) => {
    if (action === "read") throw new Error("host disconnected");
    return running;
  });
  await vi.waitFor(() => expect(run.done).toBe(true), { timeout: 5_000 });
  expect(run.error).toBe("Cloudroom lost this PC's host during Claude sign-in. Try again.");
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("Windows Connect Claude stops when Claude exits without a token", async () => {
  const run = runDaemonSetupToken("req", "claude.exe", async () => {}, async () => ({ ...running, state: "exited" }));
  await vi.waitFor(() => expect(run.done).toBe(true), { timeout: 5_000 });
  expect(run.error).toBe("Claude sign-in did not finish. Try again.");
});
