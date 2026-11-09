const { execFileSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { chmod, cp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const { installLinuxLauncher } = require("./linux-launcher.cjs");

const desktopPackageRoot = path.resolve(__dirname, "..");

const NODE_MODULES_DIRECTORY = "node_modules";
const NODE_PTY_PACKAGE_NAME = "node-pty";
const BETTER_SQLITE3_PACKAGE_NAME = "better-sqlite3";
const PARCEL_WATCHER_PACKAGE_NAME = "@parcel/watcher";
const PACKAGED_NATIVE_PACKAGE_NAMES = [
  NODE_PTY_PACKAGE_NAME,
  BETTER_SQLITE3_PACKAGE_NAME,
  PARCEL_WATCHER_PACKAGE_NAME,
];

const NODE_PTY_PREBUILD_PLATFORMS = ["darwin-arm64", "darwin-x64"];
const NODE_PTY_SPAWN_HELPER_RELATIVE_PATHS = [
  path.join("build", "Release", "spawn-helper"),
  ...NODE_PTY_PREBUILD_PLATFORMS.map((platform) =>
    path.join("prebuilds", platform, "spawn-helper"),
  ),
];
const NODE_PTY_ASAR_HELPER_PATH_REWRITE =
  "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";
const NODE_PTY_IDEMPOTENT_ASAR_HELPER_PATH_REWRITE =
  "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked');";

async function isDirectory(directoryPath) {
  try {
    const entry = await readdir(directoryPath, { withFileTypes: true });
    return Array.isArray(entry);
  } catch {
    return false;
  }
}

function packageNameForNodeModulesDirectory(directoryPath) {
  const parentDirectory = path.dirname(directoryPath);
  if (path.basename(parentDirectory) === NODE_MODULES_DIRECTORY) {
    return path.basename(directoryPath);
  }

  const nodeModulesDirectory = path.dirname(parentDirectory);
  if (
    path.basename(nodeModulesDirectory) === NODE_MODULES_DIRECTORY &&
    path.basename(parentDirectory).startsWith("@")
  ) {
    return `${path.basename(parentDirectory)}/${path.basename(directoryPath)}`;
  }

  return undefined;
}

async function findPackageDirectories(rootPath, packageNames) {
  const packageNameSet = new Set(packageNames);
  const matches = new Map(packageNames.map((packageName) => [packageName, []]));
  const pending = [rootPath];

  while (pending.length > 0) {
    const directoryPath = pending.pop();
    if (directoryPath === undefined) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const childPath = path.join(directoryPath, entry.name);
      const packageName = packageNameForNodeModulesDirectory(childPath);
      if (packageName !== undefined && packageNameSet.has(packageName)) {
        matches.get(packageName).push(childPath);
        continue;
      }
      pending.push(childPath);
    }
  }

  return matches;
}

async function chmodIfPresent(filePath, mode) {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function patchNodePtyHelperPath(packageDirectory) {
  const unixTerminalPath = path.join(
    packageDirectory,
    "lib",
    "unixTerminal.js",
  );
  const source = await readFile(unixTerminalPath, "utf8");

  if (source.includes(NODE_PTY_IDEMPOTENT_ASAR_HELPER_PATH_REWRITE)) {
    return;
  }
  if (!source.includes(NODE_PTY_ASAR_HELPER_PATH_REWRITE)) {
    throw new Error(
      `Unable to patch ${NODE_PTY_PACKAGE_NAME} helper path rewrite in ${unixTerminalPath}`,
    );
  }

  await writeFile(
    unixTerminalPath,
    source.replace(
      NODE_PTY_ASAR_HELPER_PATH_REWRITE,
      NODE_PTY_IDEMPOTENT_ASAR_HELPER_PATH_REWRITE,
    ),
  );
}

async function prepareNodePtyPackageDirectory(packageDirectory) {
  await patchNodePtyHelperPath(packageDirectory);

  await Promise.all(
    NODE_PTY_SPAWN_HELPER_RELATIVE_PATHS.map((relativePath) =>
      chmodIfPresent(path.join(packageDirectory, relativePath), 0o755),
    ),
  );
}

function resolveBetterSqlite3PrebuildArguments({
  electronVersion,
  arch,
  platform,
}) {
  return [
    "--runtime=electron",
    `--target=${electronVersion}`,
    `--arch=${arch}`,
    `--platform=${platform}`,
  ];
}

async function runPrebuildInstall(packageDirectory, prebuildArguments) {
  const requireFromPackage = createRequire(
    path.join(packageDirectory, "package.json"),
  );
  const prebuildInstallBinPath = requireFromPackage.resolve(
    "prebuild-install/bin.js",
  );

  const exitCode = await new Promise((resolveExitCode) => {
    const child = spawn(
      process.execPath,
      [prebuildInstallBinPath, ...prebuildArguments],
      {
        cwd: packageDirectory,
        stdio: "inherit",
      },
    );
    child.on("error", () => resolveExitCode(1));
    child.on("close", resolveExitCode);
  });

  if (exitCode !== 0) {
    throw new Error(
      `prebuild-install for ${BETTER_SQLITE3_PACKAGE_NAME} exited with code ${
        exitCode ?? "null"
      } (arguments: ${prebuildArguments.join(" ")}). The packaged app needs the ` +
        "Electron-ABI binary; refusing to ship a mismatched build.",
    );
  }
}

async function prepareBetterSqlite3PackageDirectory(packageDirectory, options) {
  const packageJson = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const supportsLegacyPrebuild =
    typeof packageJson.dependencies?.["prebuild-install"] === "string";
  const canVerify =
    options.platform === process.platform &&
    options.arch === process.arch &&
    options.electronVersion === resolveElectronVersion();
  const electron = createRequire(path.join(desktopPackageRoot, "package.json"))(
    "electron",
  );
  const verify = () =>
    execFileSync(
      electron,
      [
        "-e",
        "const Database = require(process.argv[1]); const db = new Database(':memory:'); if (db.prepare('SELECT 1 AS value').get().value !== 1) throw new Error('SQLite verification failed'); db.close();",
        packageDirectory,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "pipe",
        timeout: 30_000,
      },
    );
  if (canVerify) {
    try {
      verify();
      return;
    } catch (error) {
      if (!supportsLegacyPrebuild) throw error;
    }
  }
  await runPrebuildInstall(
    packageDirectory,
    resolveBetterSqlite3PrebuildArguments(options),
  );
  if (canVerify) verify();
}

// electron-builder leaves out @parcel/watcher-win32-x64, so the file watcher
// can't start (BB #4662). Copy it from the workspace and load it once.
async function prepareParcelWatcherPackageDirectory(packageDirectory, options) {
  const platformPackageName = `${PARCEL_WATCHER_PACKAGE_NAME}-${options.platform}-${options.arch}`;
  const packagedPlatformDirectory = path.join(
    path.dirname(packageDirectory),
    path.basename(platformPackageName),
  );
  if (!(await isDirectory(packagedPlatformDirectory))) {
    const resolveFrom = (packageName, directory) =>
      path.dirname(
        createRequire(path.join(directory, "package.json")).resolve(
          `${packageName}/package.json`,
        ),
      );
    const workspaceWatcherDirectory = resolveFrom(
      PARCEL_WATCHER_PACKAGE_NAME,
      path.join(desktopPackageRoot, NODE_MODULES_DIRECTORY, "bb-app"),
    );
    await cp(
      resolveFrom(platformPackageName, workspaceWatcherDirectory),
      packagedPlatformDirectory,
      { dereference: true, recursive: true },
    );
  }
  if (
    options.platform !== process.platform ||
    options.arch !== process.arch ||
    options.electronVersion !== resolveElectronVersion()
  ) {
    return;
  }
  const electron = createRequire(path.join(desktopPackageRoot, "package.json"))(
    "electron",
  );
  execFileSync(
    electron,
    ["-e", "require(process.argv[1]);", packagedPlatformDirectory],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "pipe",
      timeout: 30_000,
    },
  );
}

async function preparePackagedNativeModules(appOutDir, options = {}) {
  if (!(await isDirectory(appOutDir))) {
    throw new Error(`Packaged app output does not exist: ${appOutDir}`);
  }

  const packageDirectories = await findPackageDirectories(
    appOutDir,
    PACKAGED_NATIVE_PACKAGE_NAMES,
  );
  const nodePtyDirectories = packageDirectories.get(NODE_PTY_PACKAGE_NAME);
  if (nodePtyDirectories.length === 0) {
    throw new Error(
      `Unable to find ${NODE_PTY_PACKAGE_NAME} under ${appOutDir}`,
    );
  }
  await Promise.all(nodePtyDirectories.map(prepareNodePtyPackageDirectory));

  // The Electron target is only known on the real afterPack path. Standalone
  // invocations (e.g. tests, manual node-pty repair) omit it and skip the fetch.
  if (options.electronVersion === undefined) {
    return { betterSqlite3Directories: [], nodePtyDirectories };
  }

  const betterSqlite3Directories = packageDirectories.get(
    BETTER_SQLITE3_PACKAGE_NAME,
  );
  if (betterSqlite3Directories.length === 0) {
    throw new Error(
      `Unable to find ${BETTER_SQLITE3_PACKAGE_NAME} under ${appOutDir}`,
    );
  }
  await Promise.all(
    betterSqlite3Directories.map((packageDirectory) =>
      prepareBetterSqlite3PackageDirectory(packageDirectory, {
        arch: options.arch,
        electronVersion: options.electronVersion,
        platform: options.platform,
      }),
    ),
  );

  if (options.platform === "win32") {
    const parcelWatcherDirectories = packageDirectories.get(
      PARCEL_WATCHER_PACKAGE_NAME,
    );
    if (parcelWatcherDirectories.length === 0) {
      throw new Error(
        `Unable to find ${PARCEL_WATCHER_PACKAGE_NAME} under ${appOutDir}`,
      );
    }
    for (const packageDirectory of parcelWatcherDirectories) {
      await prepareParcelWatcherPackageDirectory(packageDirectory, options);
    }
  }

  return { betterSqlite3Directories, nodePtyDirectories };
}

function resolveElectronVersion() {
  const requireFromDesktop = createRequire(
    path.join(desktopPackageRoot, "package.json"),
  );
  return requireFromDesktop("electron/package.json").version;
}

function resolveArchName(context) {
  try {
    const { Arch } = require("electron-builder");
    const archName = Arch[context.arch];
    if (typeof archName === "string") {
      return archName;
    }
  } catch {
    // electron-builder is only resolvable inside the build process; fall back to
    // the host architecture, which matches single-arch builds on a native host.
  }
  return process.arch;
}

async function stampBbAppVersion(appOutDir, version) {
  const directories = (await findPackageDirectories(appOutDir, ["bb-app"])).get("bb-app");
  if (directories.length === 0) {
    throw new Error(`Unable to find bb-app under ${appOutDir}`);
  }
  for (const directory of directories) {
    const packageJsonPath = path.join(directory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    await writeFile(packageJsonPath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
  }
}

// bb-app depends on these only for its SDK's type declarations; the app's code has them bundled.
const BUNDLED_PACKAGE_NAMES = new Set(["hono", "picocolors", "zod"]);

// Deletes top-level packages that nothing reaches from bb-app's runtime dependencies: ones bundled into dist
// (the desktop's own, zod, hono) and, on Windows, a second copy of npm's bundled packages. Each file costs the
// Windows installer time, because Defender scans it on install and on every update.
async function pruneUnreachablePackages(bbAppDirectory) {
  const root = path.dirname(bbAppDirectory);
  const resolvePackage = (from, name) => {
    for (let directory = from; directory.startsWith(root + path.sep); directory = path.dirname(directory)) {
      const candidate = path.join(directory, NODE_MODULES_DIRECTORY, name);
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    const candidate = path.join(root, name);
    return existsSync(path.join(candidate, "package.json")) ? candidate : undefined;
  };
  const reached = new Set();
  const pending = [bbAppDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (reached.has(directory)) continue;
    reached.add(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const names = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies });
    for (const name of names) {
      if (directory === bbAppDirectory && BUNDLED_PACKAGE_NAMES.has(name)) continue;
      const found = resolvePackage(directory, name);
      if (found !== undefined) pending.push(found);
    }
  }
  for (const entry of await readdir(root)) {
    if (entry.startsWith(".")) continue;
    const scoped = entry.startsWith("@");
    const names = scoped ? (await readdir(path.join(root, entry))).map((name) => path.join(entry, name)) : [entry];
    const unreached = names.filter((name) => !reached.has(path.join(root, name)));
    if (scoped && unreached.length === names.length) unreached.splice(0, unreached.length, entry);
    await Promise.all(unreached.map((name) => rm(path.join(root, name), { recursive: true, force: true })));
  }
}

// Each file costs the Windows install time (Defender scans it), and Windows ships x64 only. So drop what these
// packages never load there: other platforms' prebuilt binaries, and the C/C++ sources and headers they ship for
// building from source (better-sqlite3's sqlite3.c alone is 9 MB).
const NATIVE_SOURCE_PACKAGE_NAMES = [...PACKAGED_NATIVE_PACKAGE_NAMES, "fs-native-extensions", "node-addon-api"];
const BUILD_ONLY_DIRECTORIES = new Set(["deps", "include", "src"]);
const BUILD_ONLY_FILE = /\.(c|cc|cpp|h|hh|hpp|gyp|gypi)$|^CMakeLists\.txt$/;

async function pruneNativeBuildFiles(appOutDir, target) {
  const packages = await findPackageDirectories(appOutDir, NATIVE_SOURCE_PACKAGE_NAMES);
  for (const directory of [...packages.values()].flat()) {
    const doomed = (await readdir(directory)).filter((name) => BUILD_ONLY_DIRECTORIES.has(name) || BUILD_ONLY_FILE.test(name));
    const prebuilds = path.join(directory, "prebuilds");
    if (await isDirectory(prebuilds)) {
      const names = await readdir(prebuilds);
      if (!names.some((name) => name.replace(/\.node$/, "") === target)) {
        throw new Error(`${directory} has no ${target} prebuild, so the app couldn't load it`);
      }
      doomed.push(...names.filter((name) => name.replace(/\.node$/, "") !== target).map((name) => path.join("prebuilds", name)));
    }
    await Promise.all(doomed.map((name) => rm(path.join(directory, name), { recursive: true, force: true })));
  }
}

async function afterPack(context) {
  const arch = resolveArchName(context);
  const platform = context.electronPlatformName ?? process.platform;
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error("Packaged npm verification requires a native target host");
  }
  await stampBbAppVersion(context.appOutDir, context.packager.appInfo.version);
  for (const directory of (await findPackageDirectories(context.appOutDir, ["bb-app"])).get("bb-app")) {
    await pruneUnreachablePackages(directory);
  }
  if (platform === "win32") await pruneNativeBuildFiles(context.appOutDir, `${platform}-${arch}`);
  await preparePackagedNativeModules(context.appOutDir, {
    arch,
    electronVersion: resolveElectronVersion(),
    platform,
  });
  const { smokePackagedNpm } = await import("./smoke-packaged-npm.mjs");
  const productName = context.packager.appInfo.productFilename;
  const appBinary =
    platform === "darwin"
      ? path.join(
          context.appOutDir,
          `${productName}.app`,
          "Contents",
          "MacOS",
          productName,
        )
      : platform === "win32"
        ? path.join(context.appOutDir, `${productName}.exe`)
        : path.join(context.appOutDir, context.packager.executableName);
  await smokePackagedNpm(appBinary);
  if (platform === "linux") {
    await installLinuxLauncher(context.appOutDir, context.packager.executableName);
  }
}

function parseStandaloneArguments(argv) {
  const options = {};
  let appOutDir;

  for (const argument of argv) {
    const electronVersionMatch = argument.match(/^--electron-version=(.+)$/);
    if (electronVersionMatch) {
      options.electronVersion = electronVersionMatch[1];
      continue;
    }
    const archMatch = argument.match(/^--arch=(.+)$/);
    if (archMatch) {
      options.arch = archMatch[1];
      continue;
    }
    const platformMatch = argument.match(/^--platform=(.+)$/);
    if (platformMatch) {
      options.platform = platformMatch[1];
      continue;
    }
    appOutDir = argument;
  }

  if (options.arch === undefined) {
    options.arch = process.arch;
  }
  if (options.platform === undefined) {
    options.platform = process.platform;
  }

  return { appOutDir, options };
}

async function main() {
  const { appOutDir, options } = parseStandaloneArguments(
    process.argv.slice(2),
  );
  if (appOutDir === undefined || appOutDir.length === 0) {
    throw new Error(
      "Usage: node apps/desktop/scripts/prepare-native-modules.cjs <appOutDir> " +
        "[--electron-version=<version>] [--arch=<arch>] [--platform=<platform>]",
    );
  }

  await preparePackagedNativeModules(path.resolve(appOutDir), options);
}

module.exports = afterPack;
module.exports.parseStandaloneArguments = parseStandaloneArguments;
module.exports.resolveBetterSqlite3PrebuildArguments =
  resolveBetterSqlite3PrebuildArguments;

if (require.main === module) {
  main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
