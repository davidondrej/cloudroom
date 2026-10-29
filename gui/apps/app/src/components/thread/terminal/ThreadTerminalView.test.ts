import { TERMINAL_DATA_MAX_BYTES } from "@cloudroom/domain";
import type { ILink, ILinkProvider } from "ghostty-web";
import { describe, expect, it, vi } from "vitest";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import {
  buildTerminalThemeFromCssColors,
  applyTerminalFontFamily,
  captureTerminalContextMenuState,
  encodeTerminalInputChunks,
  forceTerminalFontMeasurement,
  focusTerminalFromTouchRelease,
  observeTerminalFontLoading,
  shouldFocusTerminalAfterAsyncMount,
  startTerminalTouchFocusGesture,
  TERMINAL_FONT_FAMILY,
  resolveTerminalFontFamily,
  updateTerminalTouchFocusGesture,
} from "./ThreadTerminalView";
import { requestTerminalLinkOpen, routeTerminalLinks } from "./terminal-links";

function routedLink(
  uri: string,
  source: "detected-url" | "osc8",
  handlers: Parameters<typeof routeTerminalLinks>[2],
): ILink {
  const provider: ILinkProvider = {
    provideLinks: (_y, callback) =>
      callback([
        {
          text: uri,
          range: { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } },
          activate: () => {
            throw new Error("Ghostty's own link opener must not run");
          },
        },
      ]),
  };
  let link: ILink | undefined;
  routeTerminalLinks(provider, source, handlers).provideLinks(0, (links) => {
    link = links?.[0];
  });
  if (link === undefined) {
    throw new Error("Expected a routed link");
  }
  return link;
}

describe("terminal hyperlinks", () => {
  it("preserves OSC-8 provenance through hover and primary activation", () => {
    const onActivate = vi.fn();
    const onHover = vi.fn();
    const link = routedLink("https://example.com/authorize", "osc8", {
      onActivate,
      onHover,
    });

    link.hover?.(true);
    link.activate({ button: 0 } as MouseEvent);
    link.hover?.(false);

    expect(onActivate).toHaveBeenCalledWith({
      source: "osc8",
      uri: "https://example.com/authorize",
    });
    expect(onHover).toHaveBeenNthCalledWith(1, {
      source: "osc8",
      uri: "https://example.com/authorize",
    });
    expect(onHover).toHaveBeenNthCalledWith(2, null);
  });

  it("does not activate links from a secondary click", () => {
    const onActivate = vi.fn();
    const link = routedLink("https://example.com/right-click", "osc8", {
      onActivate,
      onHover: vi.fn(),
    });

    link.activate({ button: 2 } as MouseEvent);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("opens detected URLs with a plain click", () => {
    const onActivate = vi.fn();
    const link = routedLink("https://example.com/visible", "detected-url", {
      onActivate,
      onHover: vi.fn(),
    });

    link.activate({ button: 0 } as MouseEvent);

    expect(onActivate).toHaveBeenCalledWith({
      source: "detected-url",
      uri: "https://example.com/visible",
    });
  });

  it("confirms concealed targets and directly opens detected URLs", () => {
    const openLink = vi.fn();
    const requestConfirmation = vi.fn();

    requestTerminalLinkOpen({
      openLink,
      requestConfirmation,
      target: { source: "osc8", uri: "https://example.com/concealed" },
    });
    requestTerminalLinkOpen({
      openLink,
      requestConfirmation,
      target: {
        source: "detected-url",
        uri: "https://example.com/visible",
      },
    });

    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(requestConfirmation).toHaveBeenCalledWith({
      source: "osc8",
      uri: "https://example.com/concealed",
    });
    expect(openLink).toHaveBeenCalledOnce();
    expect(openLink).toHaveBeenCalledWith("https://example.com/visible");
  });

  it("preserves link actions while copying the exact xterm selection", () => {
    const getSelection = vi.fn(() => "  wrapped terminal selection\n");
    const link = {
      source: "detected-url" as const,
      uri: "https://example.com/visible",
    };

    expect(
      captureTerminalContextMenuState({
        link,
        terminal: { getSelection },
      }),
    ).toEqual({
      link,
      selectionText: "  wrapped terminal selection\n",
    });
    expect(getSelection).toHaveBeenCalledOnce();
  });
});

function startTouchFocusGesture() {
  const gesture = startTerminalTouchFocusGesture(
    [{ identifier: 1, x: 40, y: 80 }],
    100,
  );
  if (gesture === null) {
    throw new Error("Expected one touch to start a focus gesture");
  }
  return gesture;
}

describe("terminal async mount focus", () => {
  it("preserves focus that moved to the composer while xterm loaded", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("does not let an explicit request override a newer focus target", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("focuses an opened terminal when focus stayed on its trigger", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: false,
        isPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("preserves a composer that was focused before xterm started mounting", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: false,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("focuses the terminal when its initiating trigger unmounted", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: false,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("does not focus a terminal after its panel closes", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: false,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: false,
        isPanelOpen: false,
      }),
    ).toBe(false);
  });
});

describe("terminal touch focus", () => {
  it("focuses the terminal after a tap", () => {
    const focus = vi.fn();

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 43, y: 84 }],
        focus,
        gesture: startTouchFocusGesture(),
        releasedAt: 200,
        remainingTouchCount: 0,
      }),
    ).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not focus after a drag returns near its start", () => {
    const focus = vi.fn();
    const gesture = updateTerminalTouchFocusGesture(startTouchFocusGesture(), [
      { identifier: 1, x: 40, y: 120 },
    ]);

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 40, y: 81 }],
        focus,
        gesture,
        releasedAt: 200,
        remainingTouchCount: 0,
      }),
    ).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not focus after a long press", () => {
    const focus = vi.fn();

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 40, y: 80 }],
        focus,
        gesture: startTouchFocusGesture(),
        releasedAt: 800,
        remainingTouchCount: 0,
      }),
    ).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("invalidates the gesture when another touch starts", () => {
    expect(
      updateTerminalTouchFocusGesture(startTouchFocusGesture(), [
        { identifier: 1, x: 40, y: 80 },
        { identifier: 2, x: 80, y: 80 },
      ]),
    ).toBeNull();
  });
});

describe("terminal output encoding", () => {
  it("splits large paste input at the wire limit without losing UTF-8 bytes", () => {
    const input = `${"a".repeat(TERMINAL_DATA_MAX_BYTES - 1)}🙂tail`;
    const chunks = encodeTerminalInputChunks(input);
    const decoded = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk, "base64")),
    );

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) =>
          Buffer.from(chunk, "base64").byteLength <= TERMINAL_DATA_MAX_BYTES,
      ),
    ).toBe(true);
    expect(decoded.toString("utf8")).toBe(input);
  });

  it("keeps UTF-8 bytes intact when a glyph spans output chunks", () => {
    const encoded = new TextEncoder().encode("🙂");
    const first = decodeBase64Bytes(
      Buffer.from(encoded.subarray(0, 2)).toString("base64"),
    );
    const second = decodeBase64Bytes(
      Buffer.from(encoded.subarray(2)).toString("base64"),
    );
    const decoder = new TextDecoder();

    expect(
      decoder.decode(first, { stream: true }) + decoder.decode(second),
    ).toBe("🙂");
  });

  it("prefers installed Nerd Font families before system monospace fallbacks", () => {
    expect(TERMINAL_FONT_FAMILY).toContain("Nerd Font");
    expect(TERMINAL_FONT_FAMILY).toContain("ui-monospace");
  });
});

describe("buildTerminalThemeFromCssColors", () => {
  it("paints the terminal canvas and cursor cutout with the sidebar surface", () => {
    const get = vi.fn((name: string) => name);

    const theme = buildTerminalThemeFromCssColors(get);

    expect(theme.background).toBe("--sidebar");
    expect(theme.cursorAccent).toBe("--sidebar");
  });
});

describe("terminal font family", () => {
  it("uses the theme terminal font family when it is set", () => {
    expect(
      resolveTerminalFontFamily((name) =>
        name === "--font-terminal" ? '"Berkeley Mono", monospace' : undefined,
      ),
    ).toBe('"Berkeley Mono", monospace');
  });

  it("keeps the default stack when the theme does not set a font family", () => {
    expect(resolveTerminalFontFamily(() => undefined)).toBe(
      TERMINAL_FONT_FAMILY,
    );
  });

  it("keeps the default stack when the theme font family is blank", () => {
    expect(resolveTerminalFontFamily(() => "  ")).toBe(TERMINAL_FONT_FAMILY);
  });

  it("updates the xterm font family and schedules a refit only when it changes", () => {
    const terminal = { options: { fontFamily: "Old Font" } } as Parameters<
      typeof applyTerminalFontFamily
    >[0];
    const scheduleFit = vi.fn();

    expect(
      applyTerminalFontFamily(terminal, '"New Font", monospace', scheduleFit),
    ).toBe(true);
    expect(terminal.options.fontFamily).toBe('"New Font", monospace');
    expect(scheduleFit).toHaveBeenCalledOnce();

    scheduleFit.mockClear();
    expect(
      applyTerminalFontFamily(terminal, '"New Font", monospace', scheduleFit),
    ).toBe(false);
    expect(scheduleFit).not.toHaveBeenCalled();
  });

  it("remeasures glyphs after a font loads by setting the font again", () => {
    const fontFamily = '"New Font", monospace';
    let currentFontFamily = fontFamily;
    const fontFamilyChanges: string[] = [];
    const terminal = {
      options: {
        get fontFamily() {
          return currentFontFamily;
        },
        set fontFamily(value: string) {
          fontFamilyChanges.push(value);
          currentFontFamily = value;
        },
      },
    } as Parameters<typeof forceTerminalFontMeasurement>[0];

    forceTerminalFontMeasurement(terminal);

    expect(fontFamilyChanges).toEqual([`${fontFamily} `, fontFamily]);
    expect(terminal.options.fontFamily).toBe(fontFamily);
  });
});

function createTerminalFontSet() {
  const events = new EventTarget();
  let finishLoading = () => {};
  const ready = new Promise<FontFaceSet>((resolve) => {
    finishLoading = () => resolve(fontSet as FontFaceSet);
  });
  const fontSet = Object.assign(events, { ready });
  return { fontSet, finishLoading };
}

describe("terminal font loading", () => {
  it("refreshes fonts imported after the initial ready promise resolves", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    finishLoading();
    await fontSet.ready;
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);
    await fontSet.ready;
    expect(refresh).toHaveBeenCalledOnce();

    fontSet.dispatchEvent(new Event("loadingdone"));
    expect(refresh).toHaveBeenCalledTimes(2);

    fontSet.dispatchEvent(new Event("loadingdone"));
    expect(refresh).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("ignores a pending ready callback after the terminal is disposed", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);

    dispose();
    finishLoading();
    await fontSet.ready;
    fontSet.dispatchEvent(new Event("loadingdone"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("removes the font listener when the terminal is disposed", async () => {
    const { fontSet, finishLoading } = createTerminalFontSet();
    const removeEventListener = vi.spyOn(fontSet, "removeEventListener");
    const refresh = vi.fn();
    const dispose = observeTerminalFontLoading(fontSet, refresh);
    finishLoading();
    await fontSet.ready;
    refresh.mockClear();

    dispose();
    fontSet.dispatchEvent(new Event("loadingdone"));

    expect(refresh).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith(
      "loadingdone",
      expect.any(Function),
    );
    removeEventListener.mockRestore();
  });
});
