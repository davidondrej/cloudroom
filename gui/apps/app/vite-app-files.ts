import type { Plugin } from "vite";

const APP_FILE = /^assets\/[^/]+$/;
const COMPRESSED_OR_MAP = /\.(?:br|gz|map)$/;

export function appFiles(): Plugin {
  return {
    name: "cloudroom-app-files",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter(
          (fileName) =>
            APP_FILE.test(fileName) && !COMPRESSED_OR_MAP.test(fileName),
        )
        .sort()
        .map((fileName) => `/${fileName}`);
      this.emitFile({
        type: "asset",
        fileName: "app-files.json",
        source: JSON.stringify(files),
      });
    },
  };
}
