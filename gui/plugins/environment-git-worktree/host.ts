import {
  experimental_defineHostEntry,
  experimental_sanitizeInheritedChildProcessEnv,
} from "@get-bb/plugin-sdk/host";
import { readdir } from "node:fs/promises";
import { hasRef } from "bb-environment-provider-host/git";
import { createHostProgress } from "bb-environment-provider-host/progress";
import { worktreeHostContract, worktreeHostSignals } from "./contract.js";
import { resolveWorktreeBaseBranch } from "./host/base-branch.js";
import {
  deriveRepoDirName,
  resolveSpareWorktreePath,
  resolveWorktreeChildPath,
  resolveWorktreesRoot,
  resolveWorktreeAttemptRoot,
  resolveWorktreeTargetPath,
} from "./host/paths.js";
import {
  buildSpareWorktree,
  claimSpareWorktree,
  removeUnusedSpares,
  settleSpareBuilds,
} from "./host/spare.js";
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

/** `spares: false` builds every worktree from scratch, which keeps tests free of background work. */
export function createWorktreeHostEntry({ spares = true } = {}) {
  return experimental_defineHostEntry({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
    dispose: settleSpareBuilds,
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
          const worktreesRoot = resolveWorktreesRoot(
            context.experimental_paths.dataDir,
          );
          const sparePath = spares
            ? resolveSpareWorktreePath({
                dataDir: context.experimental_paths.dataDir,
                sourcePath: input.sourcePath,
              })
            : undefined;
          const created = await createWorktree({
            sourcePath: input.sourcePath,
            targetPath,
            completionPath: completionPathForWorktree(targetPath),
            claimSpare:
              sparePath === undefined
                ? undefined
                : (startPoint) =>
                    claimSpareWorktree({
                      sourcePath: input.sourcePath,
                      sparePath,
                      targetPath,
                      branchName: input.branchName,
                      startPoint,
                      signal: context.signal,
                    }),
            ownWorktreesRoot: worktreesRoot,
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
          // A fork starts from a snapshot of uncommitted work, which the
          // next thread's spare must not be built from.
          if (
            sparePath !== undefined &&
            created.startPoint !== undefined &&
            input.diffBase === undefined
          ) {
            // The build outlives this call, so it keeps the worker and a
            // copy of the call's environment.
            const lease = context.experimental_retainWorker();
            void buildSpareWorktree({
              sourcePath: input.sourcePath,
              sparePath,
              startPoint: created.startPoint,
              worktreePath: created.path,
              worktreesRoot,
              env: experimental_sanitizeInheritedChildProcessEnv({
                env: process.env,
              }),
              signal: context.lifecycle.signal,
            }).finally(() => lease.dispose());
          }
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
              // An environment's recorded folder may be a checkout in use (#1284).
              owner:
                input.path === null
                  ? undefined
                  : {
                      dataDir: context.experimental_paths.dataDir,
                      pathKey: input.pathKey,
                    },
              onProgress: createHostProgress({
                operationId: input.operationId,
                emit: (payload) =>
                  context.experimental_emitSignal("progress", payload),
              }),
              signal: context.signal,
            });
          }
          if (spares)
            await removeUnusedSpares(
              resolveWorktreesRoot(context.experimental_paths.dataDir),
            );
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
