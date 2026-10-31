import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");

const NODE_ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join("");

// Inside Cloudroom.app, the Linux app, or the Windows app (Git Bash), run room-cli
// on the app's own runtime, so the computer needs no Node (ADR 0202). Elsewhere,
// use `node`. Line 2 is valid sh and, to JS, a string plus a comment.
export const ROOM_CLI_HASHBANG = [
  "#!/bin/sh",
  '":" //; f=$(realpath "$0" 2>/dev/null || readlink "$0" || echo "$0"); for e in "${f%/Contents/Resources/app.asar.unpacked/*}"/Contents/MacOS/* "${f%/resources/app.asar.unpacked/*}"/gui-cloudroom "${f%/resources/app.asar.unpacked/*}"/gui-cloudroom-nightly "${f%/resources/app.asar.unpacked/*}"/Cloudroom.exe "${f%/resources/app.asar.unpacked/*}/Cloudroom Nightly.exe"; do [ -x "$e" ] && ELECTRON_RUN_AS_NODE=1 exec "$e" "$f" "$@"; done; exec node "$f" "$@"',
].join("\n");

// The same for cmd.exe and PowerShell, from
// <app>\resources\app.asar.unpacked\node_modules\bb-app\host-daemon\dist.
// %* stays outside parentheses: a ")" in an argument would end the block.
const APP_DIR = '"%~dp0..\\..\\..\\..\\..\\..\\';
export const ROOM_CLI_CMD = [
  "@echo off",
  "setlocal",
  'set "ROOM_CLI_APP="',
  `for %%e in (${APP_DIR}Cloudroom.exe" ${APP_DIR}Cloudroom Nightly.exe") do if not defined ROOM_CLI_APP if exist %%e set "ROOM_CLI_APP=%%~fe"`,
  "if defined ROOM_CLI_APP goto app",
  'node "%~dp0room-cli" %*',
  "exit /b %ERRORLEVEL%",
  ":app",
  "set ELECTRON_RUN_AS_NODE=1",
  '"%ROOM_CLI_APP%" "%~dp0room-cli" %*',
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

export const ROOM_CLI_PS1 = [
  "$app = @('Cloudroom.exe', 'Cloudroom Nightly.exe') | ForEach-Object { Join-Path $PSScriptRoot \"..\\..\\..\\..\\..\\..\\$_\" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1",
  "$cli = Join-Path $PSScriptRoot 'room-cli'",
  "$saved = $env:ELECTRON_RUN_AS_NODE, $env:ROOM_CLI_ARGV",
  "try {",
  '  $env:ROOM_CLI_ARGV = ConvertTo-Json -Compress -InputObject @($args | ForEach-Object { "$_" })',
  "  if ($app) { $env:ELECTRON_RUN_AS_NODE = '1' } else { $app = 'node' }",
  "  if ($MyInvocation.ExpectingInput) { $input | & $app $cli } else { & $app $cli }",
  "} finally {",
  "  $env:ELECTRON_RUN_AS_NODE, $env:ROOM_CLI_ARGV = $saved",
  "}",
  "exit $LASTEXITCODE",
  "",
].join("\r\n");

export const bundleTargets = [
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(packageRoot, "src", "index.ts"),
    label: "daemon",
    outfile: resolve(packageRoot, "dist", "daemon-bundle.mjs"),
  },
  {
    // The bootstrap the runtime spawns for EVERY bridge: it imports the
    // bridge module out of a `bb.host` artifact and owns the process
    // boundary.
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(
      workspaceRoot,
      "packages",
      "provider-bridge-protocol",
      "src",
      "bridge-worker-entry.ts",
    ),
    label: "provider bridge worker",
    outfile: resolve(packageRoot, "dist", "bb-provider-bridge-worker.mjs"),
  },
  {
    // Forked child that runs a plugin's `bb.host` entry (plugin-host-manager.ts).
    // Emitted next to the daemon bundle so defaultWorkerEntryPath resolves it as
    // a sibling in the packaged app.
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(packageRoot, "src", "plugin-host-worker.ts"),
    label: "plugin host worker",
    outfile: resolve(packageRoot, "dist", "bb-plugin-host-worker.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(workspaceRoot, "apps", "cli", "src", "index.ts"),
    executable: true,
    hashbang: ROOM_CLI_HASHBANG,
    label: "room-cli",
    outfile: resolve(packageRoot, "dist", "room-cli"),
    // The CLI `import()`s each command group on demand; chunks land in
    // dist/room-cli-chunks, which packages/bb-app ships next to this entry.
    splitting: true,
    // The packaged CLI has no workspace on disk, so `bb plugin types` for a
    // vendored-layout plugin gets the SDK declarations inlined (see
    // packages/templates/src/plugin-sdk-dts.ts). Dev bundles read them from
    // packages/plugin-sdk/bundled-types instead.
    inlinePluginSdkDeclarations: true,
  },
  {
    // Forked child that runs @parcel/watcher in isolation (BB_WATCHER_SUBPROCESS=1).
    // Emitted next to the daemon bundle so fork-channel resolves it as a sibling.
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(
      workspaceRoot,
      "packages",
      "host-watcher",
      "src",
      "parcel-subprocess",
      "parcel-child-entry.ts",
    ),
    label: "parcel watcher child",
    outfile: resolve(packageRoot, "dist", "bb-parcel-watcher-child.mjs"),
  },
];
