// Blocks retired BB prefixes from sneaking back into gui/ after the Room rename.
// Only the explicit compat shims below (third-party BB plugins, older remote servers, stale cleanup) are allowed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const BANNED =
  /bb-browser-automation-|bb-desktop:|bb:log-viewer:|\b(?:bbDesktop|bbLogViewer|BbDesktopApi)\b|--bb-[a-z0-9-]+|\bbb-zoom\b|data-bb-[a-z0-9-]+|bb-(?:provider-bridge-worker|plugin-host-worker|parcel-watcher-child|pi-extension)|bb:(?:font-preload|tailwind|bundle-stats|shared-ui-env-seam|dump-module-graph)|bbGuide|bb-guide-/g;

// Per-file allowlist of intentional compatibility tokens (keep this list shrinking, never growing).
const ALLOWED = new Map([
  [
    "apps/desktop/src/desktop-browser-view.ts",
    new Set(["bb-browser-automation-"]),
  ],
  [
    "apps/desktop/test/desktop-browser-view-manager.test.ts",
    new Set(["bb-browser-automation-"]),
  ],
  ["apps/desktop/src/preload.ts", new Set(["bbDesktop"])],
  ["apps/desktop/test/preload-browser-api.test.ts", new Set(["bbDesktop"])],
  ["apps/app/src/types/room-desktop.d.ts", new Set(["bbDesktop"])],
  ["apps/app/src/lib/room-desktop.ts", new Set(["bbDesktop"])],
  ["apps/app/src/lib/app-surface.ts", new Set(["bbDesktop"])],
  ["plugins/push-notifications/client.ts", new Set(["bbDesktop"])],
  [
    "apps/app/src/components/plugin/PluginSlotMount.tsx",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "apps/app/src/components/plugin/PluginPanelHeader.tsx",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "apps/app/src/lib/portal-scope.ts",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "packages/shared-ui/src/lib/portal-scope.ts",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "packages/plugin-registry/r/portal-scope.json",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  ["packages/plugin-api-map/src/product-map.tsx", new Set(["data-bb-plugin"])],
  [
    "packages/plugin-build/src/scope-plugin-utilities.ts",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "packages/plugin-build/src/build-plugin-app.test.ts",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "apps/cli/src/__tests__/plugin-build.test.ts",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "apps/server/test/services/plugins/plugin-app-bundle.test.ts",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "packages/plugin-registry/src/__tests__/vendor-all-items.test.ts",
    new Set(["data-bb-plugin-root", "data-bb-plugin"]),
  ],
  [
    "apps/app/src/components/ui/theme.css",
    new Set([
      "--bb-sidebar-row-height",
      "--bb-sidebar-row-height-coarse",
      "data-bb-portaled-overlay",
    ]),
  ],
  [
    "apps/app/src/components/ui/theme.test.ts",
    new Set(["data-bb-portaled-overlay"]),
  ],
  [
    "packages/shared-ui/src/components/ui/responsive-overlay.tsx",
    new Set(["data-bb-portaled-overlay"]),
  ],
  [
    "packages/plugin-registry/r/responsive-overlay.json",
    new Set(["data-bb-portaled-overlay"]),
  ],
]);

const SKIP =
  /(^|\/)(dist|node_modules|__fixtures__|recordings)\/|\/fixtures\/|scripts\/check-no-legacy-bb-names\.mjs$/;
const EXT = /\.(?:[cm]?[jt]sx?|css|json|md|html|ya?ml|sh|ps1)$/;

const files = execFileSync(
  "git",
  [
    "ls-files",
    "-z",
    "apps",
    "packages",
    "plugins",
    "scripts",
    "docs",
    "turbo.json",
    ".gitignore",
  ],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(
    (f) =>
      f &&
      existsSync(f) &&
      !SKIP.test(f) &&
      (EXT.test(f) || f === ".gitignore"),
  );

const violations = [];
for (const file of files) {
  const allowed = ALLOWED.get(file);
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const [token] of lines[i].matchAll(BANNED)) {
      if (!allowed?.has(token))
        violations.push(`${file}:${i + 1}: retired BB name "${token}"`);
    }
  }
}

for (const v of violations) console.error(v);
if (violations.length > 0) process.exit(1);
console.log(
  `legacy BB name check: ${files.length} files clean (${ALLOWED.size} compat allowlist entries)`,
);
