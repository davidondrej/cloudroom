import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { searchSettings } from "./settings-search";
import { SETTINGS_NAV_SECTIONS } from "./settings-sections";

const settingsDir = new URL("./", import.meta.url);
const SECTION_TITLE = /<(?:Card|SettingsSection)\b[^>]*?\stitle="([^"]+)"/g;

function visibleSectionTitles(): string[] {
  return readdirSync(settingsDir)
    .filter((file) => file.endsWith(".tsx") && !/\.(test|stories)\./.test(file))
    .flatMap((file) =>
      [...readFileSync(new URL(file, settingsDir), "utf8").matchAll(SECTION_TITLE)].map(
        (match) => match[1]!,
      ),
    );
}

describe("searchSettings", () => {
  const state = {
    activePluginId: null,
    activeSection: null,
    pluginEntries: [],
    sections: SETTINGS_NAV_SECTIONS,
  };

  it("finds every settings card and section by its title", () => {
    const titles = visibleSectionTitles();
    expect(titles.length).toBeGreaterThan(20);
    const missing = titles.filter(
      (title) => !searchSettings(title, state).some((result) => result.label === title),
    );
    expect(missing).toEqual([]);
  });

  it("leaves out DeepAPI when its section is hidden", () => {
    const hidden = { ...state, deepapiShown: false };
    expect(searchSettings("deepapi", hidden)).toEqual([]);
    const labels = searchSettings("credits", hidden).map((result) => result.label);
    expect(labels).toContain("Cloud Credits");
    expect(labels).not.toContain("Pay with Cloud Credits");
  });
});
