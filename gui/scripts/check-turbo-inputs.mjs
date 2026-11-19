// CI keeps Turbo's cache, so a package's typecheck is skipped while the files Turbo hashes for it are unchanged: its own
// files, its workspace dependencies' files, and the `inputs` of its `typecheck` and `topo` tasks in turbo.json. A
// relative import that leaves the package for any other file would keep an old "pass" after that file breaks. This
// fails on such an import. It reads relative imports only, not tsconfig `include` or `paths`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix as path } from "node:path";

const tracked = new Set(execFileSync("git", ["ls-files", "-z", "--", ".", "../core"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter((f) => f && existsSync(f)));
const packages = new Map(); // folder -> { name, deps }
for (const file of tracked) {
  if (!file.endsWith("/package.json")) continue;
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (!json.scripts?.typecheck) continue;
  packages.set(path.dirname(file), { name: json.name, deps: Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies }) });
}
const folderOf = new Map([...packages].map(([folder, { name }]) => [name, folder]));
const owner = (file) => {
  for (let folder = path.dirname(file); folder !== "."; folder = path.dirname(folder)) if (packages.has(folder)) return folder;
};
const dependencies = (folder, seen = new Set()) => {
  for (const name of packages.get(folder).deps) {
    const dep = folderOf.get(name);
    if (dep && !seen.has(dep)) dependencies(dep, seen.add(dep));
  }
  return seen;
};

const { tasks } = JSON.parse(readFileSync("turbo.json", "utf8").replace(/^\s*\/\/.*$/gm, ""));
// A package's `inputs` for a task, as patterns from this folder: `$TURBO_ROOT$/` is this folder, anything else is in
// the package. A `package#task` entry replaces the general one.
const inputs = (task, folder) => ((tasks[`${packages.get(folder).name}#${task}`] ?? tasks[task]).inputs ?? []).filter((glob) => glob !== "$TURBO_DEFAULT$")
  .map((glob) => new RegExp("^" + (glob.startsWith("$TURBO_ROOT$/") ? glob.slice("$TURBO_ROOT$/".length) : path.join(folder, glob))
    .replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replaceAll("\u0000", ".*") + "$"));

// The tracked file an import names: TypeScript writes `./x.js` for `./x.ts`, and may leave out the ending or `/index`.
const resolve = (target) => [target, ...[".ts", ".tsx", ".mts", ".d.mts", "/index.ts", "/index.tsx"]
  .flatMap((ending) => [target + ending, target.replace(/\.[cm]?jsx?$/, "") + ending])].find((file) => tracked.has(file));

const untracked = new Set();
for (const [folder, { name }] of packages) {
  const deps = dependencies(folder);
  const hashed = [...inputs("typecheck", folder), ...[folder, ...deps].flatMap((dep) => inputs("topo", dep))];
  for (const file of tracked) {
    if (!/\.[cm]?tsx?$/.test(file) || owner(file) !== folder) continue;
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:from|import|require\()\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(path.normalize(path.join(path.dirname(file), specifier)));
      if (!target || !/\.([cm]?[jt]sx?|json)$/.test(target)) continue; // Pictures and styles have no types.
      const home = owner(target);
      if (home === folder || deps.has(home) || hashed.some((pattern) => pattern.test(target))) continue;
      untracked.add(`${file}: imports ${target}, which Turbo does not hash for ${name}`);
    }
  }
}
for (const line of untracked) console.error(line);
if (untracked.size > 0) {
  console.error(`\nAdd the file to "inputs" of the package's "#typecheck" task in gui/turbo.json, or make its package a dependency.`);
  process.exit(1);
}
console.log(`turbo inputs: ${packages.size} packages, every import that leaves its package is hashed`);
