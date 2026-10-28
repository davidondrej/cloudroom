import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { errorMessage } from "../lib/error-log-fields.js";
import { CLOUDROOM_PYTHON_PATH, CLOUDROOM_SYNC_SCRIPT_PATH as script } from "../../cloudroom-workspace-asset.js";

const state = z.enum(["synced", "syncing", "offline", "conflict"]);
const statusSchema = z.object({ state, checkedAt: z.number(), roots: z.record(z.string(), z.object({ state, conflicts: z.number().optional() })).optional() });
type Deps = Pick<AppDeps, "config">;
const folder = (deps: Deps) => join(deps.config.dataDir, "cloudroom-sync");

export async function syncStatus(deps: Deps) {
  try {
    const data = statusSchema.parse(JSON.parse(await readFile(join(folder(deps), "status.json"), "utf8")));
    return { state: Date.now() - data.checkedAt > 30_000 ? "offline" as const : data.state, conflicts: Object.values(data.roots ?? {}).reduce((sum, root) => sum + (root.conflicts ?? 0), 0) };
  } catch { return { state: "offline" as const, conflicts: 0 }; }
}

/** The user's "Copy my logins and model providers" choice (ADR 0130), or null until first-run setup asks. */
const copyLoginsFile = (deps: Deps) => join(deps.config.dataDir, "cloudroom-copy-logins.json");
export async function copyLogins(deps: Deps): Promise<boolean | null> {
  return readFile(copyLoginsFile(deps), "utf8").then((text) => JSON.parse(text).enabled === true, () => null);
}
export async function setCopyLogins(deps: Deps, enabled: boolean): Promise<void> {
  await writeFile(copyLoginsFile(deps), JSON.stringify({ enabled }), { mode: 0o600 });
  // This VM sync needs a VM. Sandbox-only accounts copy logins on wake instead (commands.ts syncLogins).
  const vm = await readFile(join(deps.config.dataDir, "cloudroom.json"), "utf8").then((text) => Boolean(JSON.parse(text).url), () => false);
  if (vm && await readFile(join(folder(deps), "config.json")).then(() => true, () => false)) await setupSync(deps);
}

/** False once the user disconnected GitHub or picked another account in Settings, so this Mac's `gh` login stops replacing it. */
const macGithubFile = (deps: Deps) => join(deps.config.dataDir, "cloudroom-github.json");
export async function copyMacGithub(deps: Deps): Promise<boolean> {
  return readFile(macGithubFile(deps), "utf8").then((text) => JSON.parse(text).mac !== false, () => true);
}
export async function setCopyMacGithub(deps: Deps, mac: boolean): Promise<void> {
  await writeFile(macGithubFile(deps), JSON.stringify({ mac }), { mode: 0o600 });
}

/** Which of this Mac's skills cloud sandboxes get. `chosen` holds the user's clicks; skills never clicked follow `auto`. */
const cloudSkillsSchema = z.object({ auto: z.boolean(), chosen: z.record(z.string(), z.boolean()) });
export type CloudSkillChoice = z.infer<typeof cloudSkillsSchema>;
const cloudSkillsFile = (deps: Deps) => join(deps.config.dataDir, "cloudroom-cloud-skills.json");
export async function cloudSkills(deps: Deps): Promise<CloudSkillChoice> {
  return readFile(cloudSkillsFile(deps), "utf8").then((text) => cloudSkillsSchema.parse(JSON.parse(text)), () => ({ auto: true, chosen: {} }));
}
export async function setCloudSkills(deps: Deps, choice: CloudSkillChoice): Promise<void> {
  await writeFile(cloudSkillsFile(deps), JSON.stringify(choice), { mode: 0o600 });
}
export const skillInCloud = (choice: CloudSkillChoice) => (name: string) => choice.chosen[name] ?? choice.auto;

export async function setupSync(deps: Deps): Promise<void> {
  const choice = await copyLogins(deps);
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", script, "configure", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json"), ...(choice === null ? [] : ["--copy-logins", choice ? "on" : "off"])], { timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch (error) { throw new ApiError(503, "cloudroom_sync_setup", `Skills and settings sync could not start. Cloud sessions are unaffected. Cause: ${errorMessage(error)}`); }
}

export async function importCodexLogin(deps: Deps): Promise<void> {
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", script, "auth", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json")], { timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch (error) { throw new ApiError(503, "codex_auth_unavailable", `Could not check your saved Codex login. Check the cloud connection and try again. Cause: ${errorMessage(error)}`); }
}

/** Copies Pi logins the VM lacks, custom providers, and packages. Never blocks a start: Pi reports a missing key itself. */
export async function importPiLogin(deps: Deps): Promise<void> {
  try {
    await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", script, "pi-auth", folder(deps), "--connection", join(deps.config.dataDir, "cloudroom.json")], { timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch (error) { console.warn(`Cloudroom Pi login import failed: ${errorMessage(error)}`); }
}

/** This Mac's custom Pi providers (keys as the Mac sees them) and packages, or null when there are none to copy. */
export async function macPiSetup(deps: Deps): Promise<{ providers: Record<string, unknown>; packages: unknown[] } | null> {
  const { stdout } = await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", script, "pi-setup", folder(deps)], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const setup = z.object({ providers: z.record(z.string(), z.unknown()), packages: z.array(z.unknown()) }).parse(JSON.parse(stdout));
  return Object.keys(setup.providers).length || setup.packages.length ? setup : null;
}

export async function stopSync(deps: Deps): Promise<void> {
  if (!await readFile(join(folder(deps), "config.json")).then(() => true, () => false)) return;
  try { await promisify(execFile)(CLOUDROOM_PYTHON_PATH, ["-B", "-E", "-s", script, "stop", folder(deps)], { timeout: 15_000, maxBuffer: 64 * 1024 }); }
  catch (error) { console.warn(`Cloudroom sync stop failed: ${errorMessage(error)}`); }
}
