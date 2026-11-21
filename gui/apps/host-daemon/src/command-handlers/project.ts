import fs from "node:fs/promises";
import path from "node:path";
import {
  runGit,
  WorkspaceError,
  type GitProcessOptions,
} from "@cloudroom/host-workspace";
import {
  stripGitUrlCredentials,
  stripTextGitUrlCredentials,
} from "@cloudroom/domain";
import { ExpectedCommandDispatchError } from "../command-dispatch-support.js";

const PROJECT_CLONE_TIMEOUT_MS = 20 * 60 * 1000;

function normalizeProjectSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
  return slug || "project";
}

export function resolveProjectCloneDefaultPath(
  dataDir: string,
  projectSlug: string,
): string {
  return path.resolve(dataDir, "checkouts", normalizeProjectSlug(projectSlug));
}

async function requireEmptyOrMissingTarget(targetPath: string): Promise<void> {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory() || (await fs.readdir(targetPath)).length > 0) {
      throw new ExpectedCommandDispatchError(
        "target_not_empty",
        `Clone target is not empty: ${targetPath}`,
      );
    }
  } catch (error) {
    if (error instanceof ExpectedCommandDispatchError) {
      throw error;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function inspectProjectPath(
  projectPath: string,
  options: GitProcessOptions = {},
): Promise<{
  path: string;
  gitRemoteUrl: string | null;
}> {
  const resolvedPath = path.resolve(projectPath);
  const result = await runGit(["remote", "get-url", "origin"], {
    cwd: resolvedPath,
    ...options,
    allowFailure: true,
  });
  const gitRemoteUrl = result.exitCode === 0 ? result.stdout.trim() : "";
  return {
    path: resolvedPath,
    // A token in the remote stays in the repo's own config, never leaves this machine (#2190).
    gitRemoteUrl: stripGitUrlCredentials(gitRemoteUrl) || null,
  };
}

export async function cloneProject(args: {
  dataDir: string;
  projectSlug: string;
  remoteUrl: string;
  env?: NodeJS.ProcessEnv;
  targetPath?: string;
  shellPath?: string;
  onProgress?: (line: string) => void;
}): Promise<{ path: string; gitRemoteUrl: string | null }> {
  const targetPath = path.resolve(
    args.targetPath ??
      resolveProjectCloneDefaultPath(args.dataDir, args.projectSlug),
  );
  await requireEmptyOrMissingTarget(targetPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  let pendingProgress = "";
  const onStderr =
    args.onProgress === undefined
      ? undefined
      : (chunk: string): void => {
          pendingProgress += chunk;
          for (;;) {
            const match = /\r\n|\r|\n/u.exec(pendingProgress);
            if (match === null) return;
            args.onProgress?.(
              stripTextGitUrlCredentials(pendingProgress.slice(0, match.index)),
            );
            pendingProgress = pendingProgress.slice(
              match.index + match[0].length,
            );
          }
        };
  try {
    await runGit(["clone", "--progress", args.remoteUrl, targetPath], {
      cwd: path.dirname(targetPath),
      env: args.env,
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
      timeoutMs: PROJECT_CLONE_TIMEOUT_MS,
      // A new clone has no config of its own: the user's global and template
      // hooks run, as in their own `git clone`.
      hooks: true,
      ...(onStderr === undefined ? {} : { onStderr }),
    });
  } catch (error) {
    // The message repeats git's argv, so the remote's token too. Redact that exact
    // URL first: free-text parsing stops at whitespace, but userinfo can contain spaces.
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = stripTextGitUrlCredentials(
      rawMessage.replaceAll(args.remoteUrl, () =>
        stripGitUrlCredentials(args.remoteUrl),
      ),
    );
    if (error instanceof WorkspaceError) {
      throw new ExpectedCommandDispatchError(error.code, message);
    }
    throw new Error(message);
  } finally {
    if (pendingProgress.length > 0)
      args.onProgress?.(stripTextGitUrlCredentials(pendingProgress));
  }
  return inspectProjectPath(
    targetPath,
    args.shellPath === undefined ? {} : { shellPath: args.shellPath },
  );
}
