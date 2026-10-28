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
