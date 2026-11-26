import { experimental_compareVersions as compareVersions } from "@get-bb/plugin-sdk/provider-bridge";
import { rolldownVersion, version as viteVersion } from "vite";
import { expect, it } from "vitest";

// GHSA-p4f5-76q4-ffq7 was fixed separately on each release line.
it("loads patched Vite and Rolldown releases for the app dev server", () => {
  const viteFloor = viteVersion.startsWith("8.3.")
    ? "8.3.7"
    : viteVersion.startsWith("8.2.")
      ? "8.2.5"
      : "8.1.7";
  const rolldownFloor = rolldownVersion.startsWith("1.2.") ? "1.2.17" : "1.1.7";

  for (const [name, installed, floor] of [
    ["Vite", viteVersion, viteFloor],
    ["Rolldown", rolldownVersion, rolldownFloor],
  ] as const) {
    expect
      .soft(
        compareVersions(installed, floor),
        `${name} ${installed} needs ${floor} or later`,
      )
      .toBeGreaterThanOrEqual(0);
  }
});
