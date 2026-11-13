import { access, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildNodeEsmEntry,
  copyDirectory,
} from "../../../scripts/build-utils.mjs";

const execFileAsync = promisify(execFile);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");

async function assertPathExists(pathToCheck, label) {
  try {
    await access(pathToCheck);
  } catch {
    throw new Error(
      `Missing ${label} at ${pathToCheck}. Build @cloudroom/app, @cloudroom/server, and @cloudroom/host-daemon before packaging bb-app.`,
    );
  }
}

async function copyBuildOutput({ from, label, to }) {
  await assertPathExists(from, label);
  await copyDirectory({ from, to });
}

const entrypoints = [
  ["bb-app", "bb-app.js"],
  ["room-cli", "room-cli.js"],
];

for (const [sourceName, outputName] of entrypoints) {
  await buildNodeEsmEntry({
    cleanDist: sourceName === "bb-app",
    entryPoint: resolve(packageRoot, "src", "bin", `${sourceName}.ts`),
    executable: true,
    outfile: resolve(packageRoot, "dist", outputName),
    packageRoot,
  });
}

await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(scriptsDir, "prune-cli-chunks.mjs"),
  outfile: resolve(packageRoot, "dist", "prune-cli-chunks.mjs"),
  packageRoot,
});

await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "app", "dist"),
  label: "@cloudroom/app dist",
  to: resolve(packageRoot, "app", "dist"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "server", "dist"),
  label: "@cloudroom/server dist",
  to: resolve(packageRoot, "server", "dist"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "packages", "bundled-plugins", "dist"),
  label: "@cloudroom/bundled-plugins dist",
  to: resolve(packageRoot, "server", "dist", "builtin-plugins"),
});
// Built-in plugin servers share the server's one zod (zod-runtime.js). A
// bundle that carries its own copy again costs every user 500 KB and a slower
// start, and nothing else would notice.
const builtinPluginsDir = resolve(packageRoot, "server", "dist", "builtin-plugins");
await assertPathExists(
  resolve(packageRoot, "server", "dist", "zod-runtime.js"),
  "shared zod runtime",
);
for (const plugin of await readdir(builtinPluginsDir, { withFileTypes: true })) {
  if (!plugin.isDirectory()) continue;
  const server = await readFile(
    resolve(builtinPluginsDir, plugin.name, "dist", "server.js"),
    "utf8",
  );
  if (server.includes("node_modules/zod/")) {
    throw new Error(
      `Built-in plugin "${plugin.name}" bundles its own zod instead of importing the shared one (HOST_ZOD_SPECIFIER in @cloudroom/plugin-build).`,
    );
  }
}

await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "host-daemon", "dist"),
  label: "@cloudroom/host-daemon dist",
  to: resolve(packageRoot, "host-daemon", "dist"),
});
// The bb CLI is code-split into host-daemon/dist/room-cli-chunks. A turbo cache hit
// restores apps/host-daemon/dist without clearing it first, so the copy can
// carry an earlier build's hashed chunks; ship only the ones `bb` reaches.
await assertPathExists(
  resolve(packageRoot, "host-daemon", "dist", "room-cli-chunks"),
  "bundled room CLI chunks",
);
const pruneRun = await execFileAsync(
  "node",
  [resolve(packageRoot, "dist", "prune-cli-chunks.mjs")],
  { cwd: packageRoot },
);
process.stderr.write(pruneRun.stderr);

process.stdout.write("bb-app: built package assets\n");
