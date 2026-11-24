import { describe, expect, it } from "vitest";
import { createAltChordMenuGuard } from "../src/desktop-alt-chord-menu-guard.js";

// "+Shift +Alt -Alt -Shift" → the key releases the guard swallows.
// A second "+Alt" while Alt is held is a repeat Chromium didn't flag.
function swallowed(sequence: string): string[] {
  const guard = createAltChordMenuGuard();
  const held = new Set<string>();
  const result: string[] = [];
  for (const step of sequence.split(" ")) {
    if (step === "blur") {
      guard.reset();
      held.clear();
      continue;
    }
    const key = step.slice(1);
    const type = step.startsWith("+") ? "keyDown" : "keyUp";
    if (type === "keyDown") held.add(key);
    else held.delete(key);
    const input = {
      alt: held.has("Alt"),
      control: held.has("Control"),
      isAutoRepeat: false,
      key,
      meta: false,
      shift: held.has("Shift"),
      type,
    };
    if (guard.shouldSwallow(input)) result.push(step);
  }
  return result;
}

describe("createAltChordMenuGuard", () => {
  it("lets a bare Alt tap reach the menu", () => {
    expect(swallowed("+Alt -Alt")).toEqual([]);
  });

  it("swallows the Alt release of every Alt+Shift order", () => {
    expect(swallowed("+Alt +Shift -Shift -Alt")).toEqual(["-Alt"]);
    expect(swallowed("+Alt +Shift -Alt -Shift")).toEqual(["-Alt"]);
    expect(swallowed("+Shift +Alt -Shift -Alt")).toEqual(["-Alt"]);
    expect(swallowed("+Shift +Alt -Alt -Shift")).toEqual(["-Alt"]);
  });

  it("keeps the chord through Alt repeats until Alt is released", () => {
    expect(swallowed("+Shift +Alt -Shift +Alt +Alt -Alt")).toEqual(["-Alt"]);
  });

  it("treats AltGraph as part of a chord", () => {
    expect(swallowed("+AltGraph -AltGraph")).toEqual(["-AltGraph"]);
  });

  it("forgets the chord once Alt is released or the page loses focus", () => {
    expect(swallowed("+Shift +Alt -Alt -Shift +Alt -Alt")).toEqual(["-Alt"]);
    expect(swallowed("+Shift +Alt blur +Alt -Alt")).toEqual([]);
  });
});
