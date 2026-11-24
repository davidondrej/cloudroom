import { EventEmitter } from "node:events";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, expect, it, vi } from "vitest";
import hostEntry, { keepAwakeCommand } from "./host.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));
// Every OS finds a helper, so the restart test runs the same on any machine.
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  existsSync: () => true,
}));

const GNOME = "/usr/bin/gnome-session-inhibit";
const SYSTEMD = "/usr/bin/systemd-inhibit";

afterEach(() => {
  vi.useRealTimers();
});

it("picks the helper for each OS", () => {
  const linux = (desktop: string, installed: string[]) =>
    keepAwakeCommand("linux", 7, false, { XDG_CURRENT_DESKTOP: desktop }, (path) =>
      installed.includes(path),
    )?.[0] ?? null;

  expect(keepAwakeCommand("darwin", 7, false)).toEqual([
    "/usr/bin/caffeinate",
    ["-i", "-s", "-w", "7"],
  ]);
  expect(keepAwakeCommand("darwin", 7, true)?.[1]).toEqual(["-d", "-i", "-s", "-w", "7"]);
  const windows = keepAwakeCommand("win32", 7, false, { SystemRoot: "D:\\Win" });
  expect(windows?.[0]).toBe(
    "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(windows?.[1].at(-1)).toContain("SetThreadExecutionState(2147483649)");
  expect(windows?.[1].at(-1)).toContain("Wait-Process -Id 7");
  expect(keepAwakeCommand("win32", 7, true)?.[1].at(-1)).toContain("SetThreadExecutionState(2147483651)");
  expect(linux("ubuntu:GNOME", [GNOME, SYSTEMD])).toBe(GNOME);
  expect(linux("KDE", [GNOME, SYSTEMD])).toBe(SYSTEMD);
  expect(linux("ubuntu:GNOME", [])).toBeNull();
  expect(keepAwakeCommand("freebsd", 7, false)).toBeNull();
});

it("keeps one helper running, restarts it more slowly each time, swaps it on a new state, and stops it", async () => {
  vi.useFakeTimers();
  const helpers: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = [];
  spawn.mockImplementation(() => {
    helpers.push(Object.assign(new EventEmitter(), { kill: vi.fn() }));
    return helpers.at(-1);
  });
  const harness = experimental_createHostEntryHarness(hostEntry);
  const setState = (state: "off" | "awake" | "display") =>
    harness.experimental_call("setState", { state });

  await expect(setState("awake")).resolves.toEqual({ state: "awake", supported: true });
  await setState("awake");
  expect(spawn).toHaveBeenCalledOnce();
  expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);

  helpers[0].emit("exit");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(spawn).toHaveBeenCalledTimes(2);
  helpers[1].emit("exit");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(spawn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(spawn).toHaveBeenCalledTimes(3);

  await expect(setState("display")).resolves.toEqual({ state: "display", supported: true });
  expect(helpers[2].kill).toHaveBeenCalledWith("SIGTERM");

  await expect(setState("off")).resolves.toEqual({ state: "off", supported: true });
  expect(helpers[3].kill).toHaveBeenCalledWith("SIGTERM");
  expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
});
