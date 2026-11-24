// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  saveNewThreadMachine,
  startingExecutionTarget,
} from "./useStartingMachine";

const HOUR = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("starting machine (default: a picked Local sticks for 24 hours)", () => {
  it("ignores a stale pick saved under the old key", () => {
    localStorage.setItem("cloudroom.executionTarget", "local");
    expect(startingExecutionTarget(true)).toBe("cloud");
  });

  it("keeps a picked Local in its project for 24 hours, then goes back to Cloud", () => {
    vi.useFakeTimers();
    saveNewThreadMachine("a", false, "local", "local", true);
    expect(startingExecutionTarget(true, "a")).toBe("local");
    expect(startingExecutionTarget(true, "new")).toBe("cloud");
    vi.advanceTimersByTime(23 * HOUR);
    // Neither a thread on the remembered Local nor another Local pick extends the 24 hours.
    saveNewThreadMachine("a", false, "local", "local", false);
    saveNewThreadMachine("a", false, "local", "local", true);
    expect(startingExecutionTarget(true, "a")).toBe("local");
    vi.advanceTimersByTime(2 * HOUR);
    expect(startingExecutionTarget(true, "a")).toBe("cloud");
    // Once they end, a new pick starts a new 24 hours.
    saveNewThreadMachine("a", false, "local", "local", true);
    expect(startingExecutionTarget(true, "a")).toBe("local");
  });

  it("goes back to Cloud after a Cloud thread, and on a Local saved before the 24-hour rule", () => {
    saveNewThreadMachine("a", false, "local", "local", true);
    saveNewThreadMachine("a", false, "cloud", "cloud", false);
    expect(startingExecutionTarget(true, "a")).toBe("cloud");
    localStorage.setItem("cloudroom.lastStartedMachine:b", "local");
    expect(startingExecutionTarget(true, "b")).toBe("cloud");
    // A pick time the clock left more than 24 hours in the future.
    localStorage.setItem("cloudroom.lastStartedMachine:c", `local:${Date.now() + 25 * HOUR}`);
    expect(startingExecutionTarget(true, "c")).toBe("cloud");
  });

  it("saves nothing when the app chose the machine", () => {
    saveNewThreadMachine("a", false, "cloud", "local", false);
    saveNewThreadMachine("a", true, "local", "local", true);
    expect(startingExecutionTarget(true, "a")).toBe("cloud");
  });
});
