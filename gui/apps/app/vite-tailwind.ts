/**
 * @license
 * The Vite plugin below is ported from @tailwindcss/vite 4.3.0
 * (https://github.com/tailwindlabs/tailwindcss).
 *
 * MIT License
 *
 * Copyright (c) Tailwind Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Tailwind CSS for the app's Vite builds, dev server, tests, and story viewer:
// each CSS root is compiled by @tailwindcss/node with the class names that
// @tailwindcss/oxide scans from its sources.
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  compile,
  Features,
  normalizePath,
  optimize,
  toSourceMap,
} from "@tailwindcss/node";
import { clearRequireCache } from "@tailwindcss/node/require-cache";
import { Scanner } from "@tailwindcss/oxide";
import {
  createIdResolver,
  type Environment,
  type EnvironmentModuleNode,
  type InternalResolveOptions,
  type Plugin,
  type ResolvedConfig,
} from "vite";

type Root = ReturnType<typeof createRoot>;
type Resolver = (id: string, base: string) => Promise<string | undefined>;

const SPECIAL_QUERY = /[?&](?:worker|sharedworker|raw|url)\b/;
const COMMONJS_PROXY = /\?commonjs-proxy/;
const INLINE_STYLE_ID = /[?&]index=\d+\.css$/;

export function tailwindcss(): Plugin {
  let config: ResolvedConfig;
  let minify = true;
  // CSS roots by environment name, then module id.
  const environments = new Map<string, Map<string, Root>>();
  const rootsOf = (name: string) => {
    let roots = environments.get(name);
    if (!roots) environments.set(name, (roots = new Map()));
    return roots;
  };

  return {
    name: "room:tailwind",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
      minify = resolved.build.cssMinify !== false;
    },
    transform: {
      filter: {
        id: {
          exclude: [/\/\.vite\//, SPECIAL_QUERY, COMMONJS_PROXY],
          include: [/\.css(?:\?.*)?$/, /&lang\.css/, INLINE_STYLE_ID],
        },
      },
      async handler(code, id) {
        if (!isPotentialCssRoot(id)) return;
        const roots = rootsOf(this.environment.name);
        let root = roots.get(id);
        if (!root) {
          root = createRoot(this.environment, id, config);
          roots.set(id, root);
        }
        const result = await root.generate(code, (file) =>
          this.addWatchFile(file),
        );
        if (!result) {
          roots.delete(id);
          return code;
        }
        if (config.command !== "build") return result;
        return optimize(result.code, { minify, map: result.map });
      },
    },
    // A change to a file only Tailwind watches (no JS imports it) reloads the
    // page when a CSS root scanned it: Vite would otherwise do nothing.
    hotUpdate({ file, modules, timestamp, server }) {
      if (!modules.length || modules.some(({ type }) => type !== "asset"))
        return;
      for (const environment of Object.values(server.environments)) {
        if (environment.name === this.environment.name) continue;
        const others = environment.moduleGraph.getModulesByFile(file);
        if ([...(others ?? [])].some(({ type }) => type !== "asset")) return;
      }
      for (const name of new Set([this.environment.name, "client"])) {
        const roots = rootsOf(name);
        if (roots.size === 0 || !isScannedFile(file, modules, roots)) continue;
        const invalidated = new Set<EnvironmentModuleNode>();
        for (const module of modules)
          this.environment.moduleGraph.invalidateModule(
            module,
            invalidated,
            timestamp,
            true,
          );
        const hot =
          name === this.environment.name ? this.environment.hot : server.hot;
        hot.send({ type: "full-reload" });
        return [];
      }
    },
  };
}

function isPotentialCssRoot(id: string) {
  if (id.includes("/.vite/") || SPECIAL_QUERY.test(id)) return false;
  if (COMMONJS_PROXY.test(id)) return false;
  const [file = ""] = id.split("?", 2);
  return (
    path.extname(file) === ".css" ||
    id.includes("&lang.css") ||
    INLINE_STYLE_ID.test(id)
  );
}

function idToPath(id: string) {
  return path.resolve(id.replace(/\?.*$/, ""));
}

// Resolves @import (CSS) and @plugin/@config (JS) ids the way Vite resolves
// imports in this environment: aliases first, then everything.
function resolverFor(
  environment: Environment,
  options: Partial<InternalResolveOptions>,
  accepts: (file: string) => boolean,
): Resolver {
  const { config, name } = environment;
  const compatResolve = config.createResolver(options);
  let resolve: ReturnType<typeof createIdResolver> | undefined;
  return async (id, base) => {
    const importer = path.resolve(base, "__placeholder__.css");
    for (const aliasOnly of [true, false]) {
      let resolved =
        name === "client" || name === "ssr"
          ? await compatResolve(id, importer, aliasOnly, name === "ssr")
          : await (resolve ??= createIdResolver(config, options))(
              environment,
              id,
              importer,
              aliasOnly,
            );
      if (!resolved || resolved === id) continue;
      if (resolved.startsWith(".")) resolved = path.resolve(base, resolved);
      if (accepts(resolved) && path.isAbsolute(resolved)) return resolved;
    }
    return undefined;
  };
}

function createRoot(
  environment: Environment,
  id: string,
  config: ResolvedConfig,
) {
  const base = config.root;
  const sourceMaps = config.css.devSourcemap ?? false;
  const { resolve } = environment.config;
  const customCssResolver = resolverFor(
    environment,
    {
      ...resolve,
      extensions: [".css"],
      mainFields: ["style"],
      conditions: ["style", "development|production"],
      tryIndex: false,
      preferRelative: true,
    },
    (file) => file.endsWith(".css"),
  );
  const customJsResolver = resolverFor(
    environment,
    resolve,
    (file) => !file.endsWith(".css"),
  );
  let compiler: Awaited<ReturnType<typeof compile>> | undefined;
  let scanner: Scanner | undefined;
  const candidates = new Set<string>();
  // Files the compiler read, with their mtime (null: could not stat).
  const dependencies = new Map<string, number | null>();

  async function addDependency(file: string) {
    let mtime: number | null = null;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {}
    dependencies.set(file, mtime);
  }

  async function changed() {
    for (const [file, mtime] of dependencies) {
      if (mtime === null) return true;
      try {
        if ((await stat(file)).mtimeMs > mtime) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  return {
    get scannedFiles() {
      return scanner?.files ?? [];
    },

    async generate(css: string, watch: (file: string) => void) {
      const input = idToPath(id);
      const addWatchFile = (file: string) => {
        // Vite crashes on a watched .svg path with a # or ? in it.
        if (file !== input && !/[#?].*\.svg$/.test(file)) watch(file);
      };
      if (!compiler || !scanner || (await changed())) {
        clearRequireCache([...dependencies.keys()]);
        dependencies.clear();
        const pending = [addDependency(input)];
        compiler = await compile(css, {
          from: sourceMaps ? id : undefined,
          base: path.dirname(input),
          shouldRewriteUrls: true,
          onDependency(file) {
            addWatchFile(file);
            pending.push(addDependency(file));
          },
          customCssResolver,
          customJsResolver,
        });
        await Promise.all(pending);
        const { root } = compiler;
        const sources =
          root === "none"
            ? []
            : root === null
              ? [{ base, pattern: "**/*", negated: false }]
              : [{ ...root, negated: false }];
        scanner = new Scanner({ sources: [...sources, ...compiler.sources] });
      } else {
        for (const file of dependencies.keys()) addWatchFile(file);
      }

      const { features, root } = compiler;
      const generates =
        Features.AtApply |
        Features.JsPluginCompat |
        Features.ThemeFunction |
        Features.Utilities |
        Features.Variants;
      if (!(features & generates)) return false;
      if (features & Features.Utilities) {
        for (const candidate of scanner.scan()) candidates.add(candidate);
        for (const file of scanner.files) addWatchFile(file);
        for (const glob of scanner.globs) {
          if (glob.pattern[0] === "!") continue;
          let relative = path.relative(base, glob.base);
          if (relative[0] !== ".") relative = `./${relative}`;
          addWatchFile(path.posix.join(normalizePath(relative), glob.pattern));
          if (root === "none" || root === null) continue;
          const source = normalizePath(path.resolve(root.base, root.pattern));
          const isDirectory = await stat(source).then(
            (stats) => stats.isDirectory(),
            () => false,
          );
          if (!isDirectory)
            throw new Error(
              `The path given to \`source(…)\` must be a directory but got \`source(${source})\` instead.`,
            );
        }
      }
      return {
        code: compiler.build([...candidates]),
        map: sourceMaps
          ? toSourceMap(compiler.buildSourceMap()).raw
          : undefined,
      };
    },
  };
}

// Whether a CSS root that imports one of these modules, directly or not,
// scanned the file.
function isScannedFile(
  file: string,
  modules: EnvironmentModuleNode[],
  roots: Map<string, Root>,
) {
  let realpath: string | null | undefined;
  const seen = new Set<EnvironmentModuleNode>();
  const queue = [...modules];
  for (let module = queue.shift(); module; module = queue.shift()) {
    if (seen.has(module)) continue;
    seen.add(module);
    const root = module.id ? roots.get(module.id) : undefined;
    if (root?.scannedFiles.includes(file)) return true;
    if (root) {
      realpath ??= tryRealpath(file);
      if (realpath && root.scannedFiles.includes(realpath)) return true;
    }
    queue.push(...module.importers);
  }
  return false;
}

function tryRealpath(file: string) {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}
