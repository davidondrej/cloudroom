import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePluginNpmCli(): string {
  const self = fileURLToPath(import.meta.url);
  // The desktop app packs npm inside app.asar (1 file to install instead of ~1,700); Electron's Node runs it there.
  const packed = self.replace(/app\.asar\.unpacked(?=[\\/])/u, "app.asar");
  let manifest: string;
  try {
    manifest = createRequire(self).resolve("npm/package.json");
  } catch (error) {
    if (packed === self) throw error;
    manifest = createRequire(packed).resolve("npm/package.json");
  }
  return join(dirname(manifest), "bin", "npm-cli.js");
}
