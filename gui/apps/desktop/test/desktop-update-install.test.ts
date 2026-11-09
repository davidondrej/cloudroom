import { afterEach, describe, expect, it } from "vitest";
import {
  IDLE_INSTALL_AFTER_MS,
  startIdleInstall,
  type IdleInstallArgs,
} from "../src/desktop-update-install.js";

const MINUTE = 60_000;
let stop: () => void = () => {};

// A Mac with a downloaded update: `time` is the clock, `lastInput` the last keyboard or mouse use.
function mac(overrides: Partial<IdleInstallArgs> = {}) {
  const state = { time: 0, lastInput: 0, running: false, installs: 0, reports: [] as Array<number | null> };
  const idleInstall = startIdleInstall({
    isUpdateDownloaded: () => true,
    systemIdleSeconds: () => (state.time - state.lastInput) / 1000,
    hasRunningThreads: async () => state.running,
    report: async (installAt) => {
      state.reports.push(installAt);
      return false;
    },
    install: async () => {
      state.installs += 1;
    },
    now: () => state.time,
    ...overrides,
  });
  stop = idleInstall.stop;
  return { state, check: idleInstall.check };
}

afterEach(() => stop());

describe("idle update install", () => {
  it("installs once, 10 minutes after the last keyboard or mouse use", async () => {
    const { state, check } = mac();
    state.time = 5 * MINUTE;
    state.lastInput = 5 * MINUTE;
    await check();
    expect(state.reports).toEqual([5 * MINUTE + IDLE_INSTALL_AFTER_MS]);

    state.time = 15 * MINUTE - 1;
    await check();
    expect(state.installs).toBe(0);

    state.time = 15 * MINUTE;
    await check();
    state.time = 30 * MINUTE;
    await check();
    expect(state.installs).toBe(1);
  });

  it("waits while Local agents run, and 10 minutes after they stop", async () => {
    const { state, check } = mac();
    state.running = true;
    state.time = 60 * MINUTE;
    await check();
    expect(state.reports).toEqual([null]);
    expect(state.installs).toBe(0);

    state.running = false;
    state.time = 69 * MINUTE;
    await check();
    expect(state.installs).toBe(0);
    state.time = 70 * MINUTE;
    await check();
    expect(state.installs).toBe(1);
  });

  it("waits while an idle thread's background job runs, and 10 minutes after its last end (#1114)", async () => {
    let background = true;
    const { state, check } = mac({ hasBackgroundWork: async () => background });
    // Checks every 15 s; `at` flips the job at those minutes, until the install or `until`.
    async function run(until: number, at: Record<number, boolean> = {}) {
      for (; state.time <= until && state.installs === 0; state.time += 15_000) {
        background = at[state.time / MINUTE] ?? background;
        await check();
      }
    }
    state.time = 10 * MINUTE;
    // Ends at 11, starts again during the grace at 12, ends for good at 20:45.
    await run(32 * MINUTE, { 11: false, 12: true, 20.75: false });
    expect(state.installs).toBe(1);
    expect(state.time - 15_000).toBe(30.75 * MINUTE);
  });

  it("installs as before when the background work check fails", async () => {
    const { state, check } = mac({ hasBackgroundWork: () => Promise.reject(new Error("list timed out")) });
    state.time = 10 * MINUTE;
    await check();
    expect(state.installs).toBe(1);
  });

  it("stops waiting 24 h after the first wait, even when the work flaps or a check fails", async () => {
    let calls = 0;
    // Mostly running, but one check in 40 says it ended and one in 40 fails: neither may restart the 24 h.
    const { state, check } = mac({
      hasBackgroundWork: async () => {
        calls += 1;
        if (calls % 40 === 0) return false;
        if (calls % 40 === 20) throw new Error("list timed out");
        return true;
      },
    });
    for (state.time = 10 * MINUTE; state.time < (24 * 60 + 10) * MINUTE; state.time += 15_000) await check();
    expect(state.installs).toBe(0);
    await check();
    expect(state.installs).toBe(1);
  });

  it("treats a failed agent check as busy", async () => {
    const { state, check } = mac({ hasRunningThreads: () => Promise.reject(new Error("server down")) });
    state.time = 60 * MINUTE;
    await check();
    expect(state.installs).toBe(0);
  });

  it("installs at once when a window asks to restart", async () => {
    const { state, check } = mac({ report: async () => true });
    state.running = true;
    await check();
    expect(state.installs).toBe(1);
  });

  it("after a failed restart, still reports the update but installs only when a window asks", async () => {
    let asked = false;
    const { state, check } = mac({
      autoInstall: false,
      report: async (installAt) => {
        state.reports.push(installAt);
        return asked;
      },
    });
    state.time = 60 * MINUTE;
    await check();
    expect(state.reports).toEqual([null]);
    expect(state.installs).toBe(0);
    asked = true;
    await check();
    expect(state.installs).toBe(1);
  });

  it("installs only once when a slow check overlaps the next one", async () => {
    let answer: (running: boolean) => void = () => {};
    const slow = new Promise<boolean>((resolve) => (answer = resolve));
    const { state, check } = mac({ hasRunningThreads: () => slow, report: async () => true });
    const first = check();
    const second = check();
    answer(false);
    await Promise.all([first, second]);
    expect(state.installs).toBe(1);
  });
});
