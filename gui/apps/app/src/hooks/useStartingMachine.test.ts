// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  saveNewThreadMachine,
  startingExecutionTarget,
} from "./useStartingMachine";

afterEach(() => localStorage.clear());

describe("starting machine (default: last used)", () => {
  it("ignores a stale pick saved under the old key", () => {
    localStorage.setItem("cloudroom.executionTarget", "local");
    expect(startingExecutionTarget(true)).toBe("cloud");
  });

  it("follows the machine the last new thread started on", () => {
    saveNewThreadMachine(null, false, "local", "local");
    expect(startingExecutionTarget(true)).toBe("local");
  });

  it("remembers the machine per project, with the last one as a new project's default", () => {
    saveNewThreadMachine("a", false, "local", "local");
    saveNewThreadMachine("b", false, "cloud", "cloud");
    expect(startingExecutionTarget(true, "a")).toBe("local");
    expect(startingExecutionTarget(true, "b")).toBe("cloud");
    expect(startingExecutionTarget(true, "new")).toBe("cloud");
  });

  it("saves nothing when the app chose the machine", () => {
    saveNewThreadMachine(null, false, "cloud", "local");
    saveNewThreadMachine(null, true, "local", "local");
    expect(startingExecutionTarget(true)).toBe("cloud");
  });
});
