import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { configure } from "@testing-library/react";
import { beforeEach } from "vitest";

if (typeof window !== "undefined") installTestPluginRuntime();

configure({ asyncUtilTimeout: 8_000 });

if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
}

// Tiptap asks where text is on screen (placeholder, scroll into view); jsdom has no layout.
if (typeof document !== "undefined" && !document.elementFromPoint) {
  document.elementFromPoint = () => document.body;
}
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
}

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

beforeEach(() => {
  if (typeof window !== "undefined") window.localStorage.clear();
});
