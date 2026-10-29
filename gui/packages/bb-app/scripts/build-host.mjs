import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNodeEsmEntry,
  copyDirectory,
  pruneUnreferencedChunks,
} from "../../../scripts/build-utils.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const hostPackageRoot = resolve(packageRoot, "host-package");
const hostDaemonSource = resolve(workspaceRoot, "apps", "host-daemon", "dist");
const hostDaemonTarget = resolve(hostPackageRoot, "host-daemon", "dist");
const dependencyNames = [
  "@parcel/watcher",
  "fs-native-extensions",
  "node-pty",
  "pino",
  "pino-pretty",
  "pino-roll",
];
const hostDaemonFiles = [
  "bb-parcel-watcher-child.mjs",
  "bb-plugin-host-worker.mjs",
  "bb-provider-bridge-worker.mjs",
  "daemon-bundle.mjs",
];

const sourcePackageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const dependencies = Object.fromEntries(
  dependencyNames.map((name) => {
    const version = sourcePackageJson.dependencies?.[name];
    if (typeof version !== "string") {
      throw new Error(`Missing bb host dependency ${name}`);
    }
    return [name, version];
  }),
);

await rm(hostPackageRoot, { force: true, recursive: true });
await buildNodeEsmEntry({
  cleanDist: true,
  entryPoint: resolve(packageRoot, "src", "bin", "bb-app.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "bb-app.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "bin", "room-cli.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "room-cli.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});
await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "bin", "bb-host-daemon.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "bb-host-daemon.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});

await mkdir(hostDaemonTarget, { recursive: true });
await copyFile(
  resolve(hostDaemonSource, "room-cli"),
  resolve(hostDaemonTarget, "room-cli"),
);
await chmod(resolve(hostDaemonTarget, "room-cli"), 0o755);
await copyFile(
  resolve(hostDaemonSource, "room-cli.cmd"),
  resolve(hostDaemonTarget, "room-cli.cmd"),
);
await copyDirectory({
  from: resolve(hostDaemonSource, "room-cli-chunks"),
  to: resolve(hostDaemonTarget, "room-cli-chunks"),
});
await pruneUnreferencedChunks({
  chunkDir: resolve(hostDaemonTarget, "room-cli-chunks"),
  entry: resolve(hostDaemonTarget, "room-cli"),
});
for (const fileName of hostDaemonFiles) {
  await copyFile(
    resolve(hostDaemonSource, fileName),
    resolve(hostDaemonTarget, fileName),
  );
}

await copyFile(
  resolve(packageRoot, "README.md"),
  resolve(hostPackageRoot, "README.md"),
);
await writeFile(
  resolve(hostPackageRoot, "package.json"),
  `${JSON.stringify(
    {
      name: sourcePackageJson.name,
      version: sourcePackageJson.version,
      description: "Cloudroom enrolled host runtime",
      type: "module",
      os: sourcePackageJson.os,
      bin: {
        "room-cli": "dist/room-cli.js",
        "bb-app": "dist/bb-app.js",
        "bb-host-daemon": "dist/bb-host-daemon.js",
      },
      files: ["dist", "host-daemon", "README.md"],
      engines: sourcePackageJson.engines,
      dependencies,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write("bb-app: built enrolled host package\n");
