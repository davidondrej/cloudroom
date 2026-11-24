import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorkspaceDiffTarget } from "@cloudroom/domain";
import { sanitizeInheritedChildProcessEnv } from "@cloudroom/process-utils";
import { WorkspaceError, type GitProcessOptions } from "./git.js";

const BINARY = process.platform === "win32" ? "cloudroom.exe" : "cloudroom";
/** The OS and CPU a Core build runs on, as a joined machine's host package names its folder. */
export const CORE_PLATFORM = `${process.platform}-${process.arch}`;
/** Under the server's 30 s limit for host commands, so a slow read fails with Git's own message. */
const TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Core's binary: an explicit path, the app's bundled copy beside the server, or a source checkout's own build. */
export function coreBinary(): string | null {
  const candidates = [
    process.env.CLOUDROOM_HELPER_BINARY,
    // The packaged host: host-daemon/dist/daemon-bundle.mjs, with the server's assets beside it.
    new URL(`../../server/dist/assets/cloudroom-core/${BINARY}`, import.meta.url),
    // A joined machine's host package (services/install/host-artifact.ts): only a build for this OS and CPU.
    new URL(`../cloudroom-core/${CORE_PLATFORM}/${BINARY}`, import.meta.url),
    // Source checkouts: this file or the daemon's dev build sit four levels below the repository, `pnpm start`'s
    // launcher bundle five.
    ...["../../../../", "../../../../../"].flatMap((up) =>
      ["release", "debug"].map((profile) => new URL(`${up}core/target/${profile}/${BINARY}`, import.meta.url))),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = typeof candidate === "string" ? candidate : fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

const coreFeatures = new Map<string, Set<string>>();

/** Core's binary if it has `feature` (`cloudroom --features`), so a stale build is never asked for a command it lacks.
 *  Windows builds list no features: they have only `git` and `fs`, and the app uses only `git` there for now. */
export function coreWith(feature: string): string | null {
  const binary = coreBinary();
  if (!binary) return null;
  let features = coreFeatures.get(binary);
  if (!features) {
    try {
      features = new Set(execFileSync(binary, ["--features"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).split("\n"));
    } catch {
      features = new Set();
    }
    coreFeatures.set(binary, features);
  }
  return features.has(feature) ? binary : null;
}

export function coreGitTarget(target: WorkspaceDiffTarget): string {
  switch (target.type) {
    case "uncommitted": return "uncommitted";
    case "branch_committed": return `branch:${target.mergeBaseBranch}`;
    case "all": return `all:${target.mergeBaseBranch}`;
    case "commit": return `commit:${target.sha}`;
  }
}

/** Runs `cloudroom git ARGS` in `cwd` (see core/src/git.rs) and parses its JSON. */
export function coreGit<T>(
  cwd: string,
  args: (string | number)[],
  options: GitProcessOptions & { stdin?: string; timeoutMs?: number } = {},
): Promise<T> {
  const binary = coreBinary();
  if (!binary) {
    return Promise.reject(new WorkspaceError(
      "git_command_failed",
      `The Git panel isn't available here: Cloudroom has no Git reader for ${CORE_PLATFORM} on this computer. In a source checkout, build it: cargo build --release --manifest-path core/Cargo.toml`,
    ));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ["git", ...args.map(String)], {
      cwd,
      encoding: "utf8",
      env: sanitizeInheritedChildProcessEnv({ env: process.env, ...(options.shellPath !== undefined ? { shellPath: options.shellPath } : {}) }),
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: options.timeoutMs ?? TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        try { resolve(JSON.parse(stdout) as T); } catch (cause) { reject(new WorkspaceError("git_command_failed", "Cloudroom's Git reader printed no JSON", { cause })); }
        return;
      }
      const code = typeof error.code === "number" ? error.code : null;
      reject(new WorkspaceError(
        code === 3 ? "not_git_repo" : code === 4 ? "no_changes" : "git_command_failed",
        stderr.trim() || error.message,
        { cause: error },
      ));
    });
    child.stdin?.end(options.stdin ?? "");
  });
}
