import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUDROOM_UPDATE_BASE_URL,
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";
import {
  cloudroomBundleVersion,
  readCloudroomVersion,
  stampRequested,
} from "./cloudroom-version.mjs";

import { prepareRuntimes } from "./prepare-runtimes.mjs";
import { unregisterBundle } from "./macos-bundle.mjs";
import notarizeHook from "./notarize.cjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const baseConfigPath = resolve(
  desktopPackageRoot,
  "electron-builder.config.json",
);
const generatedConfigPath = resolve(
  desktopPackageRoot,
  ".electron-builder.generated.json",
);
const electronBuilderBin = resolve(
  desktopPackageRoot,
  "node_modules",
  ".bin",
  "electron-builder",
);
// On Windows .bin/electron-builder is a .cmd shim that spawn can't run.
const electronBuilderCli = resolve(
  desktopPackageRoot,
  "node_modules",
  "electron-builder",
  "cli.js",
);

const codeSigningKeys = ["CSC_LINK", "CSC_KEY_PASSWORD"];
const notarizationKeys = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];
const requiredSigningEnvironmentKeys = [
  ...codeSigningKeys,
  ...notarizationKeys,
];

const printConfigFlag = "--print-config";
// Same as BB_CLOUDROOM_STAMP=1, for package scripts that run in cmd.exe.
const stampFlag = "--stamp";

function envValueIsSet(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function missingEnvironmentKeys(keys, env) {
  return keys.filter((key) => !envValueIsSet(env[key]));
}

function presentEnvironmentKeys(keys, env) {
  return keys.filter((key) => envValueIsSet(env[key]));
}

function formatEnvironmentKeyList(keys) {
  if (keys.length === 0) {
    return "none";
  }

  return keys.join(", ");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function logWarning(message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.warn(`::warning::${message}`);
    return;
  }

  console.warn(message);
}

function logSigningPlan(signingPlan) {
  if (signingPlan.mode === "ad-hoc") {
    console.log("macOS beta: ad-hoc signing only; no Apple identity or notarization.");
  } else if (signingPlan.mode === "environment") {
    if (signingPlan.identityName) {
      console.log(
        `macOS code signing enabled with CSC_NAME identity "${signingPlan.identityName}".`,
      );
    } else {
      console.log(
        "macOS code signing enabled; electron-builder will derive the identity from CSC_LINK.",
      );
    }
  } else if (signingPlan.mode === "keychain") {
    console.log(
      `macOS code signing via keychain auto-discovery; artifacts stay unsigned if no identity is installed. ${
        signingPlan.notarizationEnabled ? "Notarizing with APPLE_KEYCHAIN_PROFILE." : "Notarization skipped."
      }`,
    );
  } else {
    logWarning(
      "macOS signing skipped: CSC_IDENTITY_AUTO_DISCOVERY=false and no signing secrets found. Artifacts will be unsigned.",
    );
  }

  if (signingPlan.notarizationEnabled) {
    console.log("macOS notarization enabled.");
  }
}

function autoDiscoveryExplicitlyDisabled(env) {
  return (
    envValueIsSet(env.CSC_IDENTITY_AUTO_DISCOVERY) &&
    env.CSC_IDENTITY_AUTO_DISCOVERY.trim() === "false"
  );
}

/**
 * Resolves one of three signing modes:
 *
 * - "environment": all CI signing/notarization secrets are set — sign with the
 *   provided certificate and notarize (the published-release path).
 * - "keychain": no secrets — sign with an auto-discovered keychain identity and
 *   skip notarization. Locally built apps never get the quarantine xattr, so
 *   notarization is unnecessary, but a valid signature is not optional: an
 *   unsigned bundle is provenance-tracked by macOS, which forces syspolicyd to
 *   evaluate every exec in the app's process tree and can stall execs
 *   system-wide. Machines without a signing identity fall back to unsigned
 *   artifacts inside electron-builder.
 * - "disabled": no secrets and CSC_IDENTITY_AUTO_DISCOVERY=false — explicitly
 *   unsigned (the CI path for workflow-artifact-only builds).
 */
function createSigningPlan(env) {
  const presentSigningKeys = presentEnvironmentKeys(
    requiredSigningEnvironmentKeys,
    env,
  );
  const missingSigningKeys = missingEnvironmentKeys(
    requiredSigningEnvironmentKeys,
    env,
  );
  const hasAnySigningKeys = presentSigningKeys.length > 0;
  const hasAllSigningKeys = missingSigningKeys.length === 0;

  if (hasAnySigningKeys && !hasAllSigningKeys) {
    throw new Error(
      `Incomplete macOS signing/notarization environment. Present: ${formatEnvironmentKeyList(
        presentSigningKeys,
      )}. Missing: ${formatEnvironmentKeyList(
        missingSigningKeys,
      )}. Set all required keys or unset all of them for a keychain-signed local build.`,
    );
  }

  if (hasAllSigningKeys) {
    return {
      mode: "environment",
      identityName: envValueIsSet(env.CSC_NAME)
        ? env.CSC_NAME.trim()
        : undefined,
      notarizationEnabled: true,
    };
  }

  const disabled = autoDiscoveryExplicitlyDisabled(env);
  return {
    mode: disabled ? "disabled" : "keychain",
    identityName: undefined,
    // Local release builds: Developer ID from the Keychain, plus a
    // `xcrun notarytool store-credentials` profile.
    notarizationEnabled: !disabled && envValueIsSet(env.APPLE_KEYCHAIN_PROFILE),
  };
}

function resolveElectronBuilderConfig(
  baseConfig,
  env,
  adHoc = false,
  cloudroomVersion,
  windows = false,
) {
  // Windows signs with WIN_CSC_* or CSC_* itself; the Apple signing rules don't apply.
  const signingPlan = windows === "only"
    ? { mode: "windows", identityName: undefined, notarizationEnabled: false }
    : adHoc
      ? { mode: "ad-hoc", identityName: "-", notarizationEnabled: false }
      : createSigningPlan(env);
  const releaseChannel = resolveDesktopReleaseChannel(env);
  const releaseConfig = createDesktopReleaseConfig(releaseChannel);
  const config = cloneJson(baseConfig);
  const mac = {
    ...config.mac,
    icon: releaseConfig.macIconPath,
    // Our afterSign hook notarizes instead, with retries (scripts/notarize.cjs).
    notarize: false,
  };
  if (signingPlan.notarizationEnabled) config.afterSign = "scripts/notarize.cjs";

  if (signingPlan.mode === "disabled") {
    mac.identity = null;
  } else if (signingPlan.identityName) {
    mac.identity = signingPlan.identityName;
  } else {
    // Let electron-builder resolve the identity (CSC_LINK or keychain).
    delete mac.identity;
  }

  config.mac = mac;
  config.dmg = { ...config.dmg, sign: signingPlan.notarizationEnabled };
  config.linux = {
    ...config.linux,
    executableName: releaseConfig.linuxExecutableName,
    icon: "assets/" + releaseConfig.iconFileName,
  };
  if (windows) {
    config.win = { ...config.win, icon: "assets/" + releaseConfig.iconFileName };
    // The one-click per-user installer names %LOCALAPPDATA%\Programs\<folder> after the package.
    config.extraMetadata = { ...config.extraMetadata, name: releaseConfig.windowsInstallName };
  }
  config.appId = releaseConfig.appId;
  config.artifactName = releaseConfig.artifactName;
  config.productName = releaseConfig.applicationName;
  config.extraMetadata = {
    ...config.extraMetadata,
    desktopName: releaseConfig.linuxDesktopName,
  };
  config.publish =
    releaseChannel === "latest" && cloudroomVersion !== undefined && signingPlan.mode !== "ad-hoc"
      ? { provider: "generic", url: CLOUDROOM_UPDATE_BASE_URL, channel: "latest" }
      : null;
  if (cloudroomVersion !== undefined) {
    const bundleVersion = cloudroomBundleVersion(cloudroomVersion);
    config.artifactName = config.artifactName.replace("${version}", cloudroomVersion);
    config.buildVersion = bundleVersion;
    config.extraMetadata = {
      ...config.extraMetadata,
      version: bundleVersion,
    };
  }

  return {
    config,
    releaseChannel,
    signingPlan,
  };
}

function createElectronBuilderEnv(signingPlan) {
  const childEnv = {
    ...process.env,
  };
  if (signingPlan.mode === "windows") {
    return childEnv;
  }

  childEnv.CSC_IDENTITY_AUTO_DISCOVERY =
    signingPlan.mode !== "disabled" && !signingPlan.identityName
      ? "true"
      : "false";
  if (signingPlan.mode === "ad-hoc") {
    for (const key of [...requiredSigningEnvironmentKeys, "CSC_NAME"]) delete childEnv[key];
  }

  return childEnv;
}

// The afterSign hook notarizes and staples only the app. Notarize the DMG too, so
// Gatekeeper trusts the download itself, even offline.
async function notarizeDmgs(outputDirectory, builtAfterMs) {
  for (const name of await readdir(outputDirectory)) {
    const dmgPath = join(outputDirectory, name);
    if (!name.endsWith(".dmg") || (await stat(dmgPath)).mtimeMs < builtAfterMs) continue;
    console.log(`Notarizing ${name}...`);
    await notarizeHook.notarize(dmgPath);
  }
}

async function readBaseConfig() {
  const configText = await readFile(baseConfigPath, "utf8");
  return JSON.parse(configText);
}

async function writeGeneratedConfig(config) {
  await writeFile(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeGeneratedConfig() {
  await rm(generatedConfigPath, { force: true });
}

async function runElectronBuilder(args, signingPlan) {
  const builderArgs = ["--config", generatedConfigPath, ...args];
  const child = spawn(
    process.platform === "win32" ? process.execPath : electronBuilderBin,
    process.platform === "win32" ? [electronBuilderCli, ...builderArgs] : builderArgs,
    {
      cwd: desktopPackageRoot,
      env: createElectronBuilderEnv(signingPlan),
      stdio: "inherit",
    },
  );

  const exitCode = await new Promise((resolveExitCode) => {
    child.on("error", () => {
      resolveExitCode(1);
    });
    child.on("close", resolveExitCode);
  });

  if (typeof exitCode === "number") {
    process.exitCode = exitCode;
    return;
  }

  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const printConfig = args.includes(printConfigFlag);
  const adHoc = args.includes("--ad-hoc");
  const electronBuilderArgs = args.filter(
    (arg) => arg !== printConfigFlag && arg !== "--ad-hoc" && arg !== stampFlag,
  );
  const windows = !electronBuilderArgs.includes("--win")
    ? false
    : electronBuilderArgs.includes("--mac") ? "with-mac" : "only";
  const baseConfig = await readBaseConfig();
  const cloudroomVersion = stampRequested(process.env) || args.includes(stampFlag)
    ? await readCloudroomVersion()
    : undefined;
  const { config, signingPlan } = resolveElectronBuilderConfig(
    baseConfig,
    process.env,
    adHoc,
    cloudroomVersion,
    windows,
  );

  if (printConfig) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (
    electronBuilderArgs.includes("--linux") &&
    !electronBuilderArgs.includes("--mac")
  ) {
    console.log("macOS signing is not applicable for Linux-only builds.");
  } else if (windows === "only") {
    console.log(
      process.env.WIN_CSC_LINK?.trim()
        ? "Windows code signing enabled with WIN_CSC_LINK."
        : "Windows installer is unsigned; SmartScreen warns before it runs.",
    );
  } else {
    logSigningPlan(signingPlan);
  }
  if (!electronBuilderArgs.includes("--linux") && !electronBuilderArgs.includes("--prepackaged")) {
    await prepareRuntimes();
  }
  await mkdir(dirname(generatedConfigPath), { recursive: true });
  await writeGeneratedConfig(config);
  const buildStartedMs = Date.now();
  try {
    await runElectronBuilder(electronBuilderArgs, signingPlan);
    if (process.exitCode === 0 && signingPlan.notarizationEnabled && !electronBuilderArgs.includes("--dir")) {
      await notarizeDmgs(resolve(desktopPackageRoot, config.directories.output), buildStartedMs);
    }
    if (process.platform === "darwin") {
      await unregisterBundle(resolve(desktopPackageRoot, config.directories.output));
    }
  } finally {
    await removeGeneratedConfig();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }

    process.exitCode = 1;
  });
}
