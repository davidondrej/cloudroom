import { describe, expect, it } from "vitest";
import type { AppKeybindings } from "@cloudroom/domain";
import { findDesktopBrowserShortcutCandidates } from "../src/desktop-browser-shortcuts.js";

type Binding = AppKeybindings[number];

function binding(
  command: Binding["command"],
  key: string,
  when: Binding["when"],
  shortcut: Partial<Binding["shortcut"]> = {},
): Binding {
  return {
    command,
    desktopOnly: false,
    shortcut: {
      key,
      mod: true,
      meta: false,
      control: false,
      alt: false,
      shift: false,
      ...shortcut,
    },
    when,
  };
}

const main = {
  all: ["mainSurface"],
  none: ["modalOpen"],
} satisfies Binding["when"];

const keybindings: AppKeybindings = [
  binding("panel.toggle", "j", main),
  binding("file.quickOpen", "p", main),
  binding("thread.jump.1", "1", main),
  binding("pane.focus.1", "1", {
    all: ["mainSurface", "splitActive"],
    none: ["modalOpen"],
  }),
  binding("browser.reload", "r", {
    all: ["mainSurface", "browserFocus"],
    none: ["modalOpen"],
  }),
  binding("thread.lastPinned", "e", {
    all: ["mainSurface"],
    none: ["modalOpen", "browserFocus"],
  }),
  binding("thread.jump.2", "2", {
    all: ["mainSurface", "webSurface"],
    none: [],
  }),
  binding("thread.pin", "c", main),
  binding("thread.archive", "z", main, { shift: true }),
  binding("app.back", "Escape", main, { mod: false }),
  binding("plugin:example/open", "i", main),
  binding("browser.focusLocation", "l", {
    all: ["mainSurface", "browserFocus"],
    none: ["modalOpen"],
  }),
  binding("thread.search", "k", {
    all: ["mainSurface", "promptAvailable"],
    none: [],
  }),
];

function candidates(
  key: string,
  code: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
  isMac = true,
) {
  return findDesktopBrowserShortcutCandidates({
    input: {
      altKey: false,
      code,
      ctrlKey: false,
      key,
      metaKey: isMac,
      shiftKey: false,
      ...modifiers,
    },
    isMac,
    keybindings,
  });
}

describe("findDesktopBrowserShortcutCandidates", () => {
  it("sends unambiguous shortcuts as commands older UIs understand", () => {
    expect(candidates("l", "KeyL")).toEqual({
      command: "browser.focusLocation",
    });
    expect(candidates("j", "KeyJ")).toEqual({ command: "panel.toggle" });
    expect(candidates("p", "KeyP")).toEqual({ command: "file.quickOpen" });
    expect(candidates("r", "KeyR")).toEqual({ command: "browser.reload" });
    expect(candidates("j", "KeyJ", { ctrlKey: true }, false)).toEqual({
      command: "panel.toggle",
    });
  });

  it("forwards the key press when only the renderer can pick the command", () => {
    expect(candidates("1", "Digit1")).toEqual({
      input: expect.objectContaining({ key: "1", metaKey: true }),
    });
    expect(candidates("k", "KeyK")).toEqual({
      input: expect.objectContaining({ key: "k" }),
    });
    expect(candidates("i", "KeyI")).toEqual({
      input: expect.objectContaining({ key: "i" }),
    });
  });

  it("keeps page-owned keys and browser-excluded bindings in the page", () => {
    for (const [key, code, modifiers] of [
      ["c", "KeyC", {}],
      ["Z", "KeyZ", { shiftKey: true }],
      ["e", "KeyE", {}],
      ["2", "Digit2", {}],
      ["Escape", "Escape", { metaKey: false }],
      ["j", "KeyJ", { metaKey: false, ctrlKey: true }],
    ] as const) {
      expect(candidates(key, code, modifiers)).toBeNull();
    }
  });
});
