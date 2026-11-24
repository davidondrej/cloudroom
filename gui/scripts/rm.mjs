// `node scripts/rm.mjs PATH...` deletes each file or folder with all it holds, on
// every OS. A missing path is fine. It replaced rimraf, and like rimraf it never
// deletes a drive's root.
import { rm } from "node:fs/promises";
import { parse, resolve } from "node:path";

const paths = process.argv.slice(2).map((path) => resolve(path));
if (paths.length === 0 || paths.some((path) => path === parse(path).root)) {
  process.stderr.write("Usage: rm.mjs PATH... (never a drive's root)\n");
  process.exit(1);
}
// Windows can hold a file for a moment after a build: retry there, as rimraf did.
const maxRetries = process.platform === "win32" ? 10 : 0;
await Promise.all(
  paths.map((path) => rm(path, { recursive: true, force: true, maxRetries })),
);
