import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameIntoPlace } from "./rename-into-place.js";
import { createPluginArtifactMeta } from "./plugin-artifact-meta.js";
import {
  isRecord,
  readPluginPackageJsonFile,
  resolveManifestEntryFile,
  validatePluginBuildManifest,
} from "./plugin-manifest.js";
import {
  describeUnresolvedSdkImport,
  PLUGIN_SDK_PACKAGE_NAME,
} from "./plugin-sdk-install.js";
import {
  NODE_ESM_REQUIRE_BANNER,
  type PluginBuildToolchain,
} from "./toolchain.js";

const LEGACY_PLUGIN_SDK_SPECIFIER = "@bb/plugin-sdk";

export const PLUGIN_SERVER_EXTERNALS: readonly string[] = [
  PLUGIN_SDK_PACKAGE_NAME,
  LEGACY_PLUGIN_SDK_SPECIFIER,
  "better-sqlite3",
];

/**
 * What a built-in plugin's server bundle imports instead of its own copy of
 * zod. The server's resolve hook (plugin-runtime.ts) points it at the one
 * `zod-runtime.js` the app ships, so 30+ plugins share a single zod instead of
 * each loading 500 KB of it.
 */
export const HOST_ZOD_SPECIFIER = "cloudroom:zod";
const HOST_ZOD_RESOLVE_MARK = "bb-server-host-zod";

export interface PluginServerBuildOptions {
  /**
   * Folder of the package whose zod the host serves as `zod-runtime.js` (the
   * app's server). An import that resolves to that same zod becomes
   * {@link HOST_ZOD_SPECIFIER}; any other zod (another version a dependency
   * brings) stays in the bundle. Only for plugins that ship inside the app:
   * they can never meet a different host.
   */
  shareZodWith?: string;
}

const PLUGIN_SDK_ROOT_FILTER = /^@get-bb\/plugin-sdk$|^@bb\/plugin-sdk$/;
const PLUGIN_SDK_SUBPATH_FILTER = /^@get-bb\/plugin-sdk\//;
const PLUGIN_SDK_SUBPATH_RESOLVE_MARK = "bb-server-sdk-subpath";

interface PluginServerConfig {
  serverEntry: string;
  packageName: string;
  pluginVersion: string;
}

async function readPluginServerConfig(
  rootDir: string,
): Promise<PluginServerConfig> {
  const packageJsonPath = join(rootDir, "package.json");
  const json = await readPluginPackageJsonFile(packageJsonPath);
  if (!isRecord(json) || !isRecord(json.bb) || json.bb.server === undefined) {
    throw new Error(
      `no server entry: ${packageJsonPath} has no "bb": { "server": "./server.ts" } field`,
    );
  }
  const manifest = await validatePluginBuildManifest(
    json,
    rootDir,
    packageJsonPath,
  );
  const serverEntry = await resolveManifestEntryFile(
    rootDir,
    manifest.bb.server,
    "bb.server",
  );
  return {
    serverEntry,
    packageName: manifest.name,
    pluginVersion: manifest.version,
  };
}

interface PluginServerBuildResult {
  jsPath: string;
  mapPath: string;
  metaPath: string;
}

export async function buildPluginServer(
  rootDir: string,
  roomVersion: string,
  toolchain: PluginBuildToolchain,
  options: PluginServerBuildOptions = {},
): Promise<PluginServerBuildResult> {
  const { shareZodWith } = options;
  const { serverEntry, packageName, pluginVersion } =
    await readPluginServerConfig(rootDir);
  const distDir = join(rootDir, "dist");
  await mkdir(distDir, { recursive: true });
  const jsPath = join(distDir, "server.js");
  const mapPath = join(distDir, "server.js.map");
  const metaPath = join(distDir, "server.meta.json");

  const stageDir = await mkdtemp(join(distDir, ".stage-"));
  try {
    const stagedJsPath = join(stageDir, "server.js");
    const stagedMetaPath = join(stageDir, "server.meta.json");

    const esbuild = (await import(
      toolchain.esbuild
    )) as typeof import("esbuild");
    await esbuild.build({
      entryPoints: [serverEntry],
      outfile: stagedJsPath,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      sourcemap: true,
      banner: { js: NODE_ESM_REQUIRE_BANNER },
      external: PLUGIN_SERVER_EXTERNALS.filter(
        (specifier) => !PLUGIN_SDK_ROOT_FILTER.test(specifier),
      ),
      plugins: [
        {
          name: "bb-plugin-sdk-resolution",
          setup(build) {
            build.onResolve({ filter: PLUGIN_SDK_ROOT_FILTER }, (args) => ({
              path: args.path,
              external: true,
            }));
            if (shareZodWith !== undefined) {
              let hostZod: Promise<string> | undefined;
              build.onResolve({ filter: /^zod$/ }, async (args) => {
                if (
                  args.kind !== "import-statement" ||
                  args.pluginData === HOST_ZOD_RESOLVE_MARK
                ) {
                  return undefined;
                }
                const resolveFrom = (resolveDir: string) =>
                  build.resolve(args.path, {
                    resolveDir,
                    kind: args.kind,
                    pluginData: HOST_ZOD_RESOLVE_MARK,
                  });
                hostZod ??= resolveFrom(shareZodWith).then(({ path }) => path);
                const installed = await resolveFrom(args.resolveDir);
                return installed.path !== "" && installed.path === (await hostZod)
                  ? { path: HOST_ZOD_SPECIFIER, external: true }
                  : installed;
              });
            }
            build.onResolve(
              { filter: PLUGIN_SDK_SUBPATH_FILTER },
              async (args) => {
                if (args.pluginData === PLUGIN_SDK_SUBPATH_RESOLVE_MARK) {
                  return undefined;
                }
                const installed = await build.resolve(args.path, {
                  resolveDir: args.resolveDir,
                  kind: args.kind,
                  importer: args.importer,
                  pluginData: PLUGIN_SDK_SUBPATH_RESOLVE_MARK,
                });
                if (installed.errors.length === 0 && installed.path !== "") {
                  return { path: installed.path };
                }
                return {
                  errors: [
                    {
                      text: await describeUnresolvedSdkImport({
                        specifier: args.path,
                        resolveDir: args.resolveDir,
                        need: `a server entry's "${args.path}" import is bundled from the plugin's own SDK install (bb serves only the bare "${PLUGIN_SDK_PACKAGE_NAME}" at load time), so the plugin needs`,
                        esbuildErrors: installed.errors,
                      }),
                    },
                  ],
                };
              },
            );
          },
        },
      ],
      logLevel: "error",
    });
    await writeFile(
      stagedMetaPath,
      JSON.stringify(
        createPluginArtifactMeta({ packageName, pluginVersion, bbVersion: roomVersion }),
        null,
        2,
      ) + "\n",
    );

    await renameIntoPlace(stagedJsPath, jsPath);
    await renameIntoPlace(join(stageDir, "server.js.map"), mapPath);
    await renameIntoPlace(stagedMetaPath, metaPath);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
  return { jsPath, mapPath, metaPath };
}
