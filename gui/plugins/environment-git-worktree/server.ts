import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderProgress } from "@get-bb/plugin-sdk/environment-provider";
import { reportHostProgress } from "bb-environment-provider-host/progress";
import { z } from "zod";
import {
  worktreeBaseBranchSchema,
  worktreeHostContract,
  worktreeHostSignals,
} from "./contract.js";
import { GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const CREATE_TIMEOUT_MS = 15 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 15 * 60 * 1000;

export const worktreeInputsSchema = z
  .object({
    branch: worktreeBaseBranchSchema.default({ kind: "default" }),
    // A fork of a thread working in another Git checkout starts there, not in the project checkout (#971).
    sourcePath: z.string().min(1).optional(),
    diffBase: worktreeBaseBranchSchema.optional(),
  })
  .default({ branch: { kind: "default" } });
export type WorktreeInputs = z.infer<typeof worktreeInputsSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function worktreePlugin(room: BbPluginApi): Promise<void> {
  const host = room.hosts.experimental_client({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
  });
  const reports = new Map<string, PluginEnvironmentProviderProgress>();

  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report !== undefined) reportHostProgress(report, event.payload);
  });

  room.experimental_environments.register({
    id: GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
    displayName: "Worktree",
    description: "Create an isolated Git worktree for your changes.",
    icon: "FolderGit",
    requires: { gitCheckout: true },
    inputs: worktreeInputsSchema,
    policy: { pathKeys: "per-attempt" },
    async create(context) {
      const hostId = context.host.id;
      const operationId = `create#${context.pathKey}#${context.attempt}`;
      const previous = context.previous?.environment;
      // Rebuilding under the same key (a parked worktree) returns to its saved folder (#1213).
      const folderName =
        context.rebuild &&
        previous?.path &&
        (previous.environmentProviderInstanceKey ?? previous.id) ===
          context.pathKey
          ? previous.path.split(/[\\/]/u).filter(Boolean).pop()
          : undefined;
      reports.set(operationId, context.report);
      try {
        const result = await host.call(
          "create",
          {
            operationId,
            sourcePath:
              context.inputs.sourcePath ?? context.projectCheckout.path,
            pathKey: context.pathKey,
            branchName: context.rebuild
              ? (context.previous?.environment.branchName ??
                context.suggestedBranchName)
              : context.suggestedBranchName,
            baseBranch: context.inputs.branch,
            ...(context.inputs.diffBase
              ? { diffBase: context.inputs.diffBase }
              : {}),
            branchMode: context.rebuild ? "reuse-existing" : "reset",
            ...(folderName === undefined ? {} : { folderName }),
          },
          { hostId, signal: context.signal, timeoutMs: CREATE_TIMEOUT_MS },
        );
        if (result.status === "failed") {
          return {
            status: "failed",

            message: result.message,
          };
        }
        return {
          status: "created",
          path: result.path,
          ownsPath: true,
          ...(result.baseBranch === null
            ? {}
            : { mergeBaseBranch: result.baseBranch }),
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return {
          status: "failed",

          message: errorMessage(error),
        };
      } finally {
        reports.delete(operationId);
      }
    },
    async remove(context) {
      if (context.hostId === null) {
        return { status: "failed", message: "The worktree machine is unknown" };
      }
      const operationId = `remove#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        const result = await host.call(
          "remove",
          {
            operationId,
            pathKey: context.pathKey,
            path: context.path,
          },
          {
            hostId: context.hostId,
            signal: context.signal,
            timeoutMs: REMOVE_TIMEOUT_MS,
          },
        );
        return result;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },
  });
}
