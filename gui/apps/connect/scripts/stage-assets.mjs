#!/usr/bin/env node
// Stages gui/apps/app/dist into .edge-assets without .br/.gz sidecars so Cloudflare Workers
// Static Assets serves the full PWA fallback bundle cleanly when a user's Mac is offline.
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "../../app/dist");
const outDir = resolve(import.meta.dirname, "../.edge-assets");

try {
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "gui/apps/app"], { encoding: "utf8" }).trim();
  if (dirty) {
    console.warn("WARNING: gui/apps/app has uncommitted changes. For production deploys, build from a clean release commit.");
  }
} catch {
  // Ignore when git is unavailable.
}

if (!existsSync(distDir)) {
  console.error(`Missing ${distDir}. Run: pnpm --filter @cloudroom/app build`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(distDir, outDir, {
  recursive: true,
  filter: (src) => !src.endsWith(".br") && !src.endsWith(".gz") && !src.endsWith(".map"),
});
console.log(`Staged PWA edge assets from ${distDir} to ${outDir}`);
