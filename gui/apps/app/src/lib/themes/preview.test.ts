// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { defaultAppTheme } from "@cloudroom/domain";
import {
  APP_THEME_CSS_STORAGE_KEY,
  applyAppThemeCss,
  applyCachedAppThemeCss,
  clearAppThemePreview,
  getAppThemeEpoch,
  previewAppThemeCss,
  resolveAppThemeCss,
} from "./index";

const COMMITTED = ":root { --canvas: white; }";
const PREVIEW = ":root { --canvas: black; }";

function styleText(): string | null {
  return document.getElementById("bb-app-theme")?.textContent ?? null;
}

afterEach(() => {
  clearAppThemePreview();
  applyAppThemeCss("");
  localStorage.clear();
});

describe("app theme preview", () => {
  it("applies readable default details before the first render without a cached theme", () => {
    applyCachedAppThemeCss();
    const css = resolveAppThemeCss(defaultAppTheme);
    expect(styleText()).toBe(css);
    const light = css.split(":root:not(.dark), .light {")[1];
    expect(light).toContain("--primary: #457500");
    expect(light).toContain("--primary-foreground: #ffffff");
    expect(light).toContain("--primary-text: #3d5600");
    for (const token of ["ring", "skill-mention-foreground"]) {
      expect(light).toContain(`--${token}: var(--primary)`);
    }
    expect(light).toContain("--sidebar-ring: var(--ring)");
  });

  it("preserves a cached non-default theme at startup", () => {
    const css = resolveAppThemeCss({ ...defaultAppTheme, themeId: "nord" });
    localStorage.setItem(APP_THEME_CSS_STORAGE_KEY, css);
    applyCachedAppThemeCss();
    expect(styleText()).toBe(css);
  });

  it("restores the default accent borders and file labels after previewing another palette", () => {
    const defaultCss = resolveAppThemeCss(defaultAppTheme);
    const nordCss = resolveAppThemeCss({ ...defaultAppTheme, themeId: "nord" });
    for (const token of [
      "border",
      "border-hairline",
      "border-seam",
      "sidebar-border",
      "input",
    ]) {
      expect(defaultCss).toContain(
        `--${token}: color-mix(in oklab, var(--primary)`,
      );
    }
    expect(defaultCss).toContain(
      "--input: color-mix(in oklab, var(--primary) 80%, var(--canvas))",
    );
    expect(defaultCss).toContain("--file-accent: var(--timeline-accent)");
    applyAppThemeCss(defaultCss);

    previewAppThemeCss(nordCss);
    expect(styleText()).toBe(nordCss);
    expect(styleText()).not.toContain(
      "--border: color-mix(in oklab, var(--primary)",
    );

    clearAppThemePreview();
    expect(styleText()).toBe(defaultCss);
    expect(localStorage.getItem(APP_THEME_CSS_STORAGE_KEY)).toBe(defaultCss);
  });

  it("applies preview CSS to the document without persisting it", () => {
    applyAppThemeCss(COMMITTED);
    const epochBefore = getAppThemeEpoch();

    previewAppThemeCss(PREVIEW);

    expect(styleText()).toBe(PREVIEW);
    expect(getAppThemeEpoch()).toBe(epochBefore + 1);
    expect(localStorage.getItem(APP_THEME_CSS_STORAGE_KEY)).toBe(COMMITTED);
  });

  it("restores the committed CSS when the preview is cleared", () => {
    applyAppThemeCss(COMMITTED);
    previewAppThemeCss(PREVIEW);

    clearAppThemePreview();

    expect(styleText()).toBe(COMMITTED);
    expect(localStorage.getItem(APP_THEME_CSS_STORAGE_KEY)).toBe(COMMITTED);
  });

  it("lets a committed theme supersede an active preview", () => {
    applyAppThemeCss(COMMITTED);
    previewAppThemeCss(PREVIEW);

    applyAppThemeCss(PREVIEW);
    clearAppThemePreview();

    expect(styleText()).toBe(PREVIEW);
    expect(localStorage.getItem(APP_THEME_CSS_STORAGE_KEY)).toBe(PREVIEW);
  });

  it("does not bump the epoch when clearing without a preview", () => {
    applyAppThemeCss(COMMITTED);
    const epochBefore = getAppThemeEpoch();

    clearAppThemePreview();

    expect(getAppThemeEpoch()).toBe(epochBefore);
  });
});
