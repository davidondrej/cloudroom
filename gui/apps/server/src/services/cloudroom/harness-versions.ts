import { execPortableFile, findCliExecutable } from "@cloudroom/process-utils";
import type { AppDeps } from "../../types.js";
import { claudeBinary } from "./claude-token.js";
import type { CloudroomClient } from "./client.js";

/** The Mac's Codex, Claude Code, OpenCode, fx, and OpenClaw versions. Cloud runs what ran locally (ADR 0133). */
export type HarnessVersions = { codex?: string; claude?: string; opencode?: string; fx?: string; openclaw?: string };

/** One CLI's version. Background callers run only the binary they need, never every agent CLI (#96). */
export function versionOf(binary: string | null | undefined): Promise<string | undefined> {
  if (!binary) return Promise.resolve(undefined);
  // A spawn error (an Intel binary on a Mac without Rosetta) rejects too.
  return execPortableFile(binary, ["--version"], { timeoutMs: 10_000, maxBuffer: 1024 * 1024 })
    .then(({ stdout }) => /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(stdout)?.[1], () => undefined);
}

let cached: { at: number; versions: Promise<HarnessVersions> } | undefined;
/** Read at most once a minute, from the same binaries Local threads run. Runs every agent CLI, so only user actions call it (#96). */
export function macHarnessVersions(): Promise<HarnessVersions> {
  if (!cached || Date.now() - cached.at > 60_000) {
    const versions = Promise.all([versionOf(findCliExecutable("codex") ?? undefined), versionOf(claudeBinary()), versionOf(findCliExecutable("opencode") ?? undefined), versionOf(findCliExecutable("fx") ?? undefined), versionOf(findCliExecutable("openclaw") ?? undefined)])
      .then(([codex, claude, opencode, fx, openclaw]) => ({ ...(codex ? { codex } : {}), ...(claude ? { claude } : {}), ...(opencode ? { opencode } : {}), ...(fx ? { fx } : {}), ...(openclaw ? { openclaw } : {}) }));
    cached = { at: Date.now(), versions };
  }
  return cached.versions;
}

/** What the last user action read, or nothing: launch, focus, timers, and prewarms never run another app's binary (#96). */
export const lastMacHarnessVersions = (): Promise<HarnessVersions> => cached?.versions ?? Promise.resolve({});

/** Accounts on a shared VM (not sandboxes) keep its Claude Code on the Mac's version. vm() reads the saved connection and
 *  throws for everyone else, so nothing runs before sign-in, and then only `claude --version` (#96). */
export function startClaudeVersionSync(deps: AppDeps, vm: () => Promise<CloudroomClient>): void {
  let reported: string | undefined;
  const sync = async () => {
    try {
      const client = await vm();
      const version = await versionOf(claudeBinary());
      if (!version) return;
      const result = await client.matchClaudeVersion(version);
      const problem = result.error ? `${result.state}: ${result.error}` : undefined;
      if (problem && problem !== reported) deps.logger?.warn({ target: version, state: result.state, error: result.error }, "Cloud Claude Code version could not match this Mac");
      reported = problem;
    } catch {
      return;
    }
  };
  setTimeout(() => void sync(), 30_000).unref();
  setInterval(() => void sync(), 5 * 60_000).unref();
}
