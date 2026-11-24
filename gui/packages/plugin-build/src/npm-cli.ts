import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePluginNpmCli(): string {
  const self = fileURLToPath(import.meta.url);
  const node = dirname(process.execPath);
  const from = new Set([
    self,
    // The desktop app packs npm inside app.asar (1 file to install instead of ~1,700); Electron's Node runs it there.
    self.replace(/app\.asar\.unpacked(?=[\\/])/u, "app.asar"),
    // Plain Node, a launcher's fallback (#1583), can't read app.asar: use the npm installed with it,
    // beside node.exe on Windows, in <prefix>/lib on Mac and Linux (#2124).
    join(node, "noop.js"),
    join(node, "..", "lib", "noop.js"),
  ]);
  for (const path of from) {
    try {
      const manifest = createRequire(path).resolve("npm/package.json");
      return join(dirname(manifest), "bin", "npm-cli.js");
    } catch {
      // Not here; try the next place.
    }
  }
  throw new Error(
    `Cannot find npm: ${process.execPath} can't read the npm inside Cloudroom's app.asar and has no npm of its own. Install Node.js with npm, then retry.`,
  );
}
