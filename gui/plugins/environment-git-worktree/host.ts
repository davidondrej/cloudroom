import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { readdir } from "node:fs/promises";
import { hasRef } from "bb-environment-provider-host/git";
import { createHostProgress } from "bb-environment-provider-host/progress";
import { worktreeHostContract, worktreeHostSignals } from "./contract.js";
import { resolveWorktreeBaseBranch } from "./host/base-branch.js";
import {
  deriveRepoDirName,
  resolveWorktreeChildPath,
  resolveWorktreesRoot,
  resolveWorktreeAttemptRoot,
  resolveWorktreeTargetPath,
} from "./host/paths.js";
import {
  createWorktree,
  hasUncommittedWork,
  removeCompletionMarker,
  removeWorktree,
} from "./host/worktree.js";

function completionPathForWorktree(worktreePath: string): string {
  return `${worktreePath}.completed`;
}

async function worktreePathsForPathKey(args: {
  dataDir: string;
  pathKey: string;
}): Promise<string[]> {
  const root = resolveWorktreeAttemptRoot(args);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        resolveWorktreeChildPath({
          dataDir: args.dataDir,
          pathKey: args.pathKey,
          childName: entry.name,
        }),
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function createWorktreeHostEntry() {
  return experimental_defineHostEntry({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
    handlers: {
      async create(input, context) {
        const targetPath =
          input.folderName === undefined
            ? resolveWorktreeTargetPath({
                dataDir: context.experimental_paths.dataDir,
                pathKey: input.pathKey,
                sourcePath: input.sourcePath,
              })
            : resolveWorktreeChildPath({
                dataDir: context.experimental_paths.dataDir,
                pathKey: input.pathKey,
                childName: input.folderName,
              });
        try {
          // A checkout cloned again under a new name lacks the saved branch: fail, so the thread stays parked (#1213).
          if (
            input.folderName !== undefined &&
            input.folderName !== deriveRepoDirName(input.sourcePath) &&
            !(await hasRef(input.sourcePath, `refs/heads/${input.branchName}`))
          ) {
            return {
              status: "failed",
              message: `The saved branch ${input.branchName} isn't in ${input.sourcePath}. This thread's work is still in the checkout it was made from (folder "${input.folderName}"). Fetch that branch into this checkout, then send again.`,
            } as const;
          }
          const baseBranch = await resolveWorktreeBaseBranch(
            input.sourcePath,
            input.baseBranch,
          );
          const created = await createWorktree({
            sourcePath: input.sourcePath,
            targetPath,
            completionPath: completionPathForWorktree(targetPath),
            ownWorktreesRoot: resolveWorktreesRoot(
              context.experimental_paths.dataDir,
            ),
            branchName: input.branchName,
            baseBranch,
            branchMode: input.branchMode,
            onProgress: createHostProgress({
              operationId: input.operationId,
              emit: (payload) =>
                context.experimental_emitSignal("progress", payload),
            }),
            signal: context.signal,
          });
          const diffBase = input.diffBase
            ? await resolveWorktreeBaseBranch(input.sourcePath, input.diffBase)
            : baseBranch;
          return {
            status: "created",
            path: created.path,
            baseBranch: diffBase,
          } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },

      async remove(input, context) {
        try {
          const paths =
            input.path === null
              ? await worktreePathsForPathKey({
                  dataDir: context.experimental_paths.dataDir,
                  pathKey: input.pathKey,
                })
              : [input.path];
          for (const path of paths) {
            // A remove without a path is for an attempt that never got its
            // folder. A folder under its key with changes may be a live
            // thread's work, so keep it (#576).
            if (
              input.path === null &&
              (await hasUncommittedWork(path, context.signal))
            )
              continue;
            await removeCompletionMarker(completionPathForWorktree(path));
            await removeWorktree({
              path,
              onProgress: createHostProgress({
                operationId: input.operationId,
                emit: (payload) =>
                  context.experimental_emitSignal("progress", payload),
              }),
              signal: context.signal,
            });
          }
          return { status: "removed" } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },
    },
  });
}

export default createWorktreeHostEntry();
