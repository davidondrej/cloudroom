// Every declared `__NAME__` build constant (`declare const`) must be filled in by a build script's `define`.
// Renames can't see these: build scripts match them by text, so a renamed reader silently gets undefined.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mts", "*.mjs", "*.js", "*.cjs"], { encoding: "utf8" })
  .split("\n").filter((f) => f && !/(^|\/)(dist|node_modules)\/|\.(test|spec)\.|\/__tests__\//.test(f));
const declared = new Map();
const defined = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [, name] of text.matchAll(/declare const (__[A-Z0-9_]+__)\b/g)) declared.set(name, file);
  // Object keys only (`{ __X__: …` or a `__X__: …` line), not `? __X__ :` in a ternary.
  for (const [, name] of text.matchAll(/(?:^|[{,])\s*["']?(__[A-Z0-9_]+__)["']?\s*:/gm)) {
    defined.set(name, [...(defined.get(name) ?? []), file]);
  }
}
const missing = [...declared].filter(([name, file]) => !(defined.get(name) ?? []).some((f) => f !== file));
for (const [name, file] of missing) console.error(`${file}: ${name} is declared but no build script defines it`);
if (missing.length > 0) process.exit(1);
console.log(`build constants: ${declared.size} declared, all defined`);
