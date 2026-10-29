import { spawn } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createDesktopReleaseInfo } from "../src/desktop-update-provider.js";

const desktopPackageRoot = process.cwd();
const require = createRequire(resolve(desktopPackageRoot, "package.json"));
const nativeModulesScript: {
  parseStandaloneArguments(argv: string[]): {
    appOutDir: string | undefined;
    options: {
      arch: string;
      electronVersion?: string;
      platform: string;
    };
  };
  resolveBetterSqlite3PrebuildArguments(options: {
    arch: string;
    electronVersion: string;
    platform: string;
  }): string[];
} = require("./scripts/prepare-native-modules.cjs");

const macConfigSchema = z
  .object({
    entitlements: z.string().min(1),
    entitlementsInherit: z.string().min(1),
    gatekeeperAssess: z.literal(false),
    hardenedRuntime: z.literal(true),
    icon: z.string().min(1),
    identity: z.string().nullable().optional(),
    notarize: z.boolean(),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("dmg"),
        })
        .passthrough(),
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("zip"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const linuxConfigSchema = z
  .object({
    category: z.literal("Development"),
    executableName: z.enum(["gui-cloudroom", "gui-cloudroom-nightly"]),
    icon: z.string().min(1),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("x64")]),
          target: z.literal("AppImage"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const electronBuilderFileSetSchema = z
  .object({
    filter: z.array(z.string().min(1)),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .passthrough();

const electronBuilderFilePatternSchema = z.union([
  z.string().min(1),
  electronBuilderFileSetSchema,
]);

const electronBuilderConfigSchema = z
  .object({
    directories: z.object({ output: z.literal("release.noindex") }).passthrough(),
    afterPack: z.string().min(1),
    asarUnpack: z.array(z.string().min(1)),
    dmg: z
      .object({
        sign: z.boolean(),
      })
      .passthrough(),
    files: z.array(electronBuilderFilePatternSchema),
    linux: linuxConfigSchema,
    mac: macConfigSchema,
    npmRebuild: z.literal(false),
    appId: z.string().min(1),
    artifactName: z.string().min(1),
    productName: z.string().min(1),
    publish: z
      .object({ provider: z.literal("generic"), url: z.string(), channel: z.literal("latest") })
      .nullable(),
    toolsets: z.object({
      appimage: z.literal("1.0.3"),
    }),
  })
  .passthrough();

const desktopPackageJsonSchema = z
  .object({
    main: z.literal("dist/main.js"),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    type: z.never().optional(),
  })
  .passthrough();

const workspacePackageJsonSchema = z
  .object({
    pnpm: z.object({
      supportedArchitectures: z.object({
        cpu: z.array(z.string().min(1)),
        os: z.array(z.string().min(1)),
      }),
    }),
  })
  .passthrough();

const signingEnvironmentKeys = [
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "CSC_NAME",
];
const audioInputEntitlementPattern =
  /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/u;

type ElectronBuilderConfig = z.infer<typeof electronBuilderConfigSchema>;
type EnvironmentOverrides = Record<string, string | undefined>;
type ScriptRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};
type ReadResolvedConfigResult = {
  config: ElectronBuilderConfig;
};
type CreateScriptEnvironment = (
  overrides: EnvironmentOverrides,
) => NodeJS.ProcessEnv;
type RunConfigScript = (
  overrides: EnvironmentOverrides,
  args?: string[],
  packageRoot?: string,
) => Promise<ScriptRunResult>;
type ReadResolvedConfig = (
  overrides: EnvironmentOverrides,
) => Promise<ReadResolvedConfigResult>;
type RunNativePrepScript = (
  appOutDir: string,
  args?: string[],
) => Promise<ScriptRunResult>;

const createScriptEnvironment: CreateScriptEnvironment = (overrides) => {
  const env = { ...process.env };

  for (const key of signingEnvironmentKeys) {
    delete env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
};

const runConfigScript: RunConfigScript = async (
  overrides,
  args = [],
  packageRoot = desktopPackageRoot,
) => {
  const child = spawn(
    process.execPath,
    ["scripts/run-electron-builder.mjs", "--print-config", ...args],
    {
      cwd: packageRoot,
      env: createScriptEnvironment(overrides),
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const runNativePrepScript: RunNativePrepScript = async (
  appOutDir,
  args = [],
) => {
  const child = spawn(
    process.execPath,
    ["scripts/prepare-native-modules.cjs", appOutDir, ...args],
    {
      cwd: desktopPackageRoot,
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const readResolvedConfig: ReadResolvedConfig = async (overrides) => {
  const result = await runConfigScript(overrides);

  expect(result.exitCode).toBe(0);
  return {
    config: electronBuilderConfigSchema.parse(JSON.parse(result.stdout)),
  };
};

describe("electron-builder signing config", () => {
  it("keeps package metadata compatible with electron universal's CJS entry asar", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.main).toBe("dist/main.js");
    expect(packageJson).not.toHaveProperty("type");
  });

  it("ships no plugin build toolchain binaries", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(Object.keys(packageJson.optionalDependencies ?? {})).not.toEqual(
      expect.arrayContaining(["@esbuild/darwin-arm64", "@esbuild/darwin-x64"]),
    );
  });

  it("unpacks the ESM bb-app bridge with an explicit module extension", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.asarUnpack).toContain("dist/bb-app-bridge.mjs");
    expect(config.asarUnpack).not.toContain("dist/bb-app-bridge.js");
  });

  it("runs a native module preparation hook after packaging", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const hookPath = "scripts/prepare-native-modules.cjs";

    expect(config.afterPack).toBe(hookPath);
    await expect(
      access(resolve(desktopPackageRoot, hookPath)),
    ).resolves.toBeUndefined();
  });

  it("passes the standalone platform through to better-sqlite3 prebuild-install", () => {
    const { options } = nativeModulesScript.parseStandaloneArguments([
      "/tmp/linux-unpacked",
      "--electron-version=44.3.0",
      "--arch=x64",
      "--platform=linux",
    ]);
    const electronVersion = options.electronVersion;
    if (electronVersion === undefined) {
      throw new Error("Expected the standalone Electron version argument");
    }

    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: options.arch,
        electronVersion,
        platform: options.platform,
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=44.3.0",
      "--arch=x64",
      "--platform=linux",
    ]);
  });

  it("preserves the macOS better-sqlite3 prebuild-install arguments", () => {
    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: "arm64",
        electronVersion: "44.3.0",
        platform: "darwin",
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=44.3.0",
      "--arch=arm64",
      "--platform=darwin",
    ]);
  });

  it("installs native plugin build packages for arm64 and x64", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "..", "..", "package.json"),
      "utf8",
    );
    const packageJson = workspacePackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.pnpm.supportedArchitectures).toEqual({
      cpu: ["arm64", "x64"],
      os: ["current"],
    });
  });

  it("disables in-place native rebuilds so the shared pnpm store is not mutated", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.npmRebuild).toBe(false);
  });

  it("excludes source maps before any file set, where electron-builder keeps the order", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const fileSetIndex = config.files.findIndex((entry) => typeof entry !== "string");
    const firstFileSet = fileSetIndex === -1 ? config.files.length : fileSetIndex;

    expect(config.files.indexOf("!**/*.map")).toBeGreaterThan(-1);
    expect(config.files.indexOf("!**/*.map")).toBeLessThan(firstFileSet);
  });

  it("copies the app scaffold template as a dedicated file set", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContainEqual({
      filter: ["**/*"],
      from: "node_modules/bb-app/server/dist/app-scaffold-template",
      to: "node_modules/bb-app/server/dist/app-scaffold-template",
    });
  });

  it("patches packaged node-pty helper path handling", async () => {
    const appOutDir = await mkdtemp(
      resolve(tmpdir(), "bb-desktop-native-modules-"),
    );
    const nodePtyPackageDir = resolve(
      appOutDir,
      "bb.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    );
    const rebuiltNativeDir = resolve(nodePtyPackageDir, "build", "Release");
    const unixTerminalPath = resolve(
      nodePtyPackageDir,
      "lib",
      "unixTerminal.js",
    );
    const helperPath = resolve(
      nodePtyPackageDir,
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    );
    const rebuiltHelperPath = resolve(rebuiltNativeDir, "spawn-helper");

    try {
      await mkdir(rebuiltNativeDir, { recursive: true });
      await writeFile(resolve(rebuiltNativeDir, "pty.node"), "rebuilt");
      await writeFile(rebuiltHelperPath, "rebuilt-helper");
      await chmod(rebuiltHelperPath, 0o644);
      await mkdir(dirname(unixTerminalPath), { recursive: true });
      await writeFile(
        unixTerminalPath,
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await mkdir(dirname(helperPath), { recursive: true });
      await writeFile(helperPath, "helper");
      await chmod(helperPath, 0o644);
      const result = await runNativePrepScript(appOutDir);

      expect(result.exitCode).toBe(0);
      await expect(
        access(resolve(rebuiltNativeDir, "pty.node")),
      ).resolves.toBeUndefined();
      await expect(readFile(unixTerminalPath, "utf8")).resolves.toContain(
        "helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked')",
      );
      expect((await stat(helperPath)).mode & 0o777).toBe(0o755);
      expect((await stat(rebuiltHelperPath)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(appOutDir, { force: true, recursive: true });
    }
  });

  it("validates bundled N-API SQLite without using the legacy prebuild installer", async () => {
    const appOutDir = await mkdtemp(resolve(tmpdir(), "bb-desktop-napi-"));
    const nodeModules = resolve(appOutDir, "node_modules");
    const requireFromRuntime = createRequire(
      resolve(desktopPackageRoot, "../../packages/bb-app/package.json"),
    );
    // Verification only runs against the installed Electron, so pass its version.
    const electronVersion = createRequire(
      resolve(desktopPackageRoot, "package.json"),
    )("electron/package.json").version;
    try {
      const ptyLib = resolve(nodeModules, "node-pty/lib");
      await mkdir(ptyLib, { recursive: true });
      await writeFile(
        resolve(ptyLib, "unixTerminal.js"),
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await cp(
        dirname(requireFromRuntime.resolve("better-sqlite3/package.json")),
        resolve(nodeModules, "better-sqlite3"),
        { recursive: true },
      );
      const result = await runNativePrepScript(appOutDir, [
        `--electron-version=${electronVersion}`,
      ]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const binaryPath = resolve(
        nodeModules,
        "better-sqlite3/prebuilds",
        `${process.platform}-${process.arch}.node`,
      );
      await writeFile(binaryPath, "invalid native binary");
      const invalidResult = await runNativePrepScript(appOutDir, [
        `--electron-version=${electronVersion}`,
      ]);
      expect(invalidResult.exitCode).not.toBe(0);
      expect(invalidResult.stderr).toContain(binaryPath);
      expect(invalidResult.stderr).not.toContain("prebuild-install");
    } finally {
      await rm(appOutDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("points mac signing entitlements at checked-in plist files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac.entitlementsInherit).toBe(
      "build/entitlements.mac.inherit.plist",
    );

    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlements)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlementsInherit)),
    ).resolves.toBeUndefined();
  });

  it("packages macOS artifacts for arm64 only", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.target).toEqual([
      { arch: ["arm64"], target: "dmg" },
      { arch: ["arm64"], target: "zip" },
    ]);
  });

  it("packages a Linux AppImage for x64", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.linux).toMatchObject({
      category: "Development",
      executableName: "gui-cloudroom",
      target: [{ arch: ["x64"], target: "AppImage" }],
    });
    expect(config.toolsets.appimage).toBe("1.0.3");
    await expect(
      access(resolve(desktopPackageRoot, config.linux.icon)),
    ).resolves.toBeUndefined();
  });

  it("packages a per-user NSIS installer for Windows x64 in a Cloudroom folder", async () => {
    const win = await runConfigScript({}, ["--win", "--x64"]);
    const linux = await runConfigScript({}, ["--linux", "--x64"]);
    expect(win.exitCode).toBe(0);
    const config = JSON.parse(win.stdout);

    expect(config.win.target).toEqual([{ arch: ["x64"], target: "nsis" }]);
    expect(config.nsis).toEqual({ include: "build/installer.nsh", oneClick: true, perMachine: false });
    expect(config.win.extraResources[0].to).toBe(
      "app.asar.unpacked/node_modules/bb-app/server/dist/assets/python",
    );
    expect(config.extraMetadata.name).toBe("Cloudroom");
    expect(JSON.parse(linux.stdout).extraMetadata.name).toBeUndefined();
  });

  it("stops the preview helper in the NSIS hooks without quoting the install path into PowerShell", async () => {
    const script = await readFile(resolve(desktopPackageRoot, "build", "installer.nsh"), "utf8");
    const powershell = script.split("\n").find((line) => line.includes("powershell.exe"));

    expect(script).toMatch(/!macro customInit\s+!insertmacro stopPreviewHelper/);
    expect(script).toMatch(/!macro customUnInit\s+!insertmacro stopPreviewHelper/);
    expect(powershell).toContain("$$env:CLOUDROOM_INSTALL_DIR");
    expect(powershell).not.toContain("$INSTDIR");
    // Windows PowerShell 5.1: a lone match unrolls to one object, so count through @(...).
    expect(powershell?.match(/@\(& \$\$left\)\.Count/g)).toHaveLength(2);
    expect(powershell).not.toMatch(/[^@]\(& \$\$left\)\.Count/);
    expect(script).toContain("${If} $0 == 1");
  });

  it("signs Windows-only builds with CSC_LINK without asking for Apple credentials", async () => {
    const env = { CSC_LINK: "base64-pfx", CSC_KEY_PASSWORD: "secret" };
    const win = await runConfigScript(env, ["--win", "--x64"]);
    const mac = await runConfigScript(env, ["--mac", "--arm64"]);

    expect(win.exitCode).toBe(0);
    expect(mac.exitCode).not.toBe(0);
    expect(mac.stderr).toContain("Incomplete macOS signing/notarization environment");
  });

  it("grants audio input to the signed app and helper processes", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const entitlementPaths = [
      config.mac.entitlements,
      config.mac.entitlementsInherit,
    ];

    for (const entitlementPath of entitlementPaths) {
      const entitlements = await readFile(
        resolve(desktopPackageRoot, entitlementPath),
        "utf8",
      );

      expect(entitlements).toMatch(audioInputEntitlementPattern);
    }
  });

  it("keeps the fork isolated from BB identity and publication feeds", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.appId).toBe("dev.cloudroom.gui");
    expect(config.productName).toBe("Cloudroom");
    expect(config.publish).toBeNull();
    const generated = await readResolvedConfig({});
    expect(generated.config.appId).toBe(config.appId);
    expect(generated.config.productName).toBe(config.productName);
    expect(generated.config.publish).toBeNull();
  });

  it("creates a separate nightly fork identity without enabling publication", async () => {
    const { config } = await readResolvedConfig({
      BB_DESKTOP_RELEASE_CHANNEL: "nightly",
    });
    const nightlyRelease = createDesktopReleaseInfo("nightly");

    expect(config.appId).toBe("dev.cloudroom.gui.nightly");
    expect(config.productName).toBe(nightlyRelease.applicationName);
    expect(config.artifactName).toBe(
      "gui-cloudroom-nightly-${version}-${arch}.${ext}",
    );
    expect(config.linux.icon).toBe("assets/icon-nightly.png");
    expect(config.linux.executableName).toBe("gui-cloudroom-nightly");
    expect(config.mac.icon).toBe("assets/icon-nightly.icns");
    await expect(
      access(resolve(desktopPackageRoot, config.mac.icon)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, "assets/icon-nightly.png")),
    ).resolves.toBeUndefined();
    expect(config.publish).toBeNull();
  });

  it("names installers with the corner version while keeping macOS bundle versions numeric", async () => {
    const packageRoot = await mkdtemp(resolve(tmpdir(), "cloudroom-version-"));
    try {
      await cp(resolve(desktopPackageRoot, "scripts"), resolve(packageRoot, "scripts"), { recursive: true });
      await cp(resolve(desktopPackageRoot, "electron-builder.config.json"), resolve(packageRoot, "electron-builder.config.json"));
      await writeFile(resolve(packageRoot, ".cloudroom-version"), "v17\n");
      for (const channel of ["latest", "nightly"]) {
        const result = await runConfigScript({
          BB_CLOUDROOM_STAMP: "1",
          BB_DESKTOP_RELEASE_CHANNEL: channel,
        }, ["--ad-hoc"], packageRoot);
        expect(result.exitCode).toBe(0);
        const config = JSON.parse(result.stdout);
        expect(config.extraMetadata.version).toBe("17.0.0");
        expect(config.buildVersion).toBe("17.0.0");
        expect(config.artifactName).toBe(channel === "latest"
          ? "${productName}-v17-${arch}.${ext}"
          : "gui-cloudroom-nightly-v17-${arch}.${ext}");
        expect(config.publish).toBeNull();
      }
      const release = await runConfigScript({ BB_CLOUDROOM_STAMP: "1" }, [], packageRoot);
      expect(release.exitCode).toBe(0);
      expect(JSON.parse(release.stdout).publish).toEqual({
        provider: "generic",
        url: "https://github.com/davidondrej/cloudroom/releases/latest/download/",
        channel: "latest",
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects unknown desktop release channels", async () => {
    const result = await runConfigScript({
      BB_DESKTOP_RELEASE_CHANNEL: "canary",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "BB_DESKTOP_RELEASE_CHANNEL must be latest or nightly",
    );
  });

  it("signs local builds via keychain auto-discovery when signing secrets are absent", async () => {
    const { config } = await readResolvedConfig({});

    expect(config.mac).not.toHaveProperty("identity");
    expect(config.mac.notarize).toBe(false);
    expect(config.dmg.sign).toBe(false);
  });

  it("keeps builds unsigned when keychain auto-discovery is explicitly disabled", async () => {
    const { config } = await readResolvedConfig({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });

    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
  });

  it("prepares an explicitly ad-hoc beta with bundled Python and no Apple signing", async () => {
    const result = await runConfigScript({ APPLE_ID: "unused@example.invalid" }, ["--ad-hoc"]);
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(result.stdout);
    expect(config.mac.identity).toBe("-");
    expect(config.mac.notarize).toBe(false);
    expect(config.mac.extraResources).toContainEqual({
      from: ".bundled-runtimes/python",
      to: "app.asar.unpacked/node_modules/bb-app/server/dist/assets/python",
      filter: ["**/*", "!**/__pycache__/**", "!**/*.pyc"],
    });
    expect(config.mac.extraResources).toContainEqual({ from: ".bundled-runtimes/git", to: "git" });
    expect(config.publish).toBeNull();
  });

  it("rejects partial signing secret sets", async () => {
    const partialAppleCredentials = await runConfigScript({
      APPLE_ID: "sawyer@example.com",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
    });

    expect(partialAppleCredentials.exitCode).toBe(1);
    expect(partialAppleCredentials.stderr).toContain(
      "Incomplete macOS signing/notarization environment.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Present: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Missing: APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.",
    );
  });

  it("enables app signing and notarization when signing and Apple credentials are complete", async () => {
    const completeAppleCredentials = await readResolvedConfig({
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_ID: "sawyer@example.com",
      APPLE_TEAM_ID: "TEAMID1234",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
      CSC_NAME: "Sawyer Hood (TEAMID1234)",
    });

    expect(completeAppleCredentials.config.mac.identity).toBe(
      "Sawyer Hood (TEAMID1234)",
    );
    expect(completeAppleCredentials.config.mac.notarize).toBe(false);
    expect(completeAppleCredentials.config.afterSign).toBe("scripts/notarize.cjs");
    expect(completeAppleCredentials.config.dmg.sign).toBe(true);
  });
});
