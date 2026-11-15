import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderProgress } from "@get-bb/plugin-sdk/environment-provider";
import { reportHostProgress } from "bb-environment-provider-host/progress";
import { z } from "zod";
import {
  checkoutBranchSelectionSchema,
  checkoutHostContract,
  checkoutHostSignals,
  type CheckoutBranchSelection,
} from "./contract.js";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const ATTACH_TIMEOUT_MS = 15 * 60 * 1000;
// The host's first folder reads hang when macOS blocks or must download the
// folder (#1366). Its first progress signal ends this window: a branch switch
// may then run silently for minutes.
const ATTACH_STALL_MS = 60 * 1000;
const ATTACH_STALLED_MESSAGE =
  "The project folder didn't respond for 60 seconds. If it's on a Mac, Cloudroom may lack access to it (System Settings → Privacy & Security → Files & Folders or Full Disk Access), or its iCloud files may not be downloaded.";
const LIVE_THREAD_STATUSES = new Set([
  "starting",
  "active",
  "idle",
  "stopping",
]);
const LIVE_THREAD_MESSAGE =
  "Cannot checkout branch while another thread is using this workspace";
const DETACHED_MESSAGE = "Checkout blocked while HEAD is detached";
const UNBORN_MESSAGE = "Checkout blocked before the first commit";
const CONFLICTS_MESSAGE = "Checkout blocked by unresolved conflicts";
const DIRTY_MESSAGE = "Checkout blocked by uncommitted changes";

export const checkoutInputsSchema = z.object({
  path: z.string().min(1).optional(),
  branch: checkoutBranchSelectionSchema.optional(),
});

export default async function checkoutPlugin(room: BbPluginApi): Promise<void> {
  const host = room.hosts.experimental_client({
    contract: checkoutHostContract,
    experimental_signals: checkoutHostSignals,
  });
  const reports = new Map<
    string,
    { report: PluginEnvironmentProviderProgress; progressed: () => void }
  >();

  host.experimental_onSignal("progress", (event) => {
    const attach = reports.get(event.payload.operationId);
    if (attach === undefined) return;
    attach.progressed();
    reportHostProgress(attach.report, event.payload);
  });

  async function otherLiveThreadUsesPath(args: {
    hostId: string;
    path: string;
    threadId: string | null;
  }): Promise<boolean> {
    const rows = await room.sdk.environments.list({
      hostId: args.hostId,
      path: args.path,
    });
    for (const row of rows) {
      const threads = await room.sdk.threads.list({
        environmentId: row.id,
        archived: false,
      });
      if (
        threads.some(
          (thread) =>
            thread.id !== args.threadId &&
            LIVE_THREAD_STATUSES.has(thread.status),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  async function branchSwitchBlocker(args: {
    hostId: string;
    path: string;
    branch: CheckoutBranchSelection;
  }): Promise<string | null> {
    let inspection;
    try {
      inspection = await host.call(
        "inspectCheckout",
        { path: args.path },
        { hostId: args.hostId },
      );
    } catch {
      return null;
    }
    if (!inspection.isGitRepo) {
      return null;
    }
    const { checkout, operation } = inspection;
    if (
      args.branch.kind === "existing" &&
      (checkout.kind === "branch" || checkout.kind === "unborn") &&
      checkout.branchName === args.branch.name
    ) {
      return null;
    }
    switch (checkout.kind) {
      case "branch":
        break;
      case "detached":
        return DETACHED_MESSAGE;
      case "unborn":
        return UNBORN_MESSAGE;
      case "unknown":
        return null;
    }
    if (operation.kind !== "none" && operation.hasConflicts) {
      return CONFLICTS_MESSAGE;
    }
    if (operation.kind !== "none") {
      return `Checkout blocked by an in-progress ${operation.kind}`;
    }
    if (inspection.hasUncommittedChanges) {
      return DIRTY_MESSAGE;
    }
    return null;
  }

  async function foreignEnvironmentAtPath(args: {
    hostId: string;
    path: string;
  }): Promise<string | null> {
    const rows = await room.sdk.environments.list({
      hostId: args.hostId,
      path: args.path,
    });
    const environment = rows.find(
      (row) =>
        row.status !== "destroyed" &&
        row.environmentProviderId !== null &&
        row.environmentProviderId !== PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    );
    return environment?.id ?? null;
  }

  room.experimental_environments.register({
    id: PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    displayName: "Project checkout",
    description: "Work in a project checkout on this machine.",
    icon: "Laptop",
    requires: { projectCheckout: true },
    inputs: checkoutInputsSchema,
    policy: { retireGraceMs: null },
    async validate(context) {
      const branch = context.inputs.branch;
      const path = context.inputs.path ?? context.projectCheckout.path;
      const foreignEnvironmentId = await foreignEnvironmentAtPath({
        hostId: context.host.id,
        path,
      });
      if (foreignEnvironmentId !== null) {
        return {
          action: "refuse",
          message: `This directory belongs to environment ${foreignEnvironmentId}; reuse that environment instead.`,
        };
      }
      if (branch === undefined) {
        return { action: "accept" };
      }
      if (
        await otherLiveThreadUsesPath({
          hostId: context.host.id,
          path,
          threadId: null,
        })
      ) {
        return { action: "refuse", message: LIVE_THREAD_MESSAGE };
      }
      const blocker = await branchSwitchBlocker({
        hostId: context.host.id,
        path,
        branch,
      });
      return blocker === null
        ? { action: "accept" }
        : { action: "refuse", message: blocker };
    },
    async create(context) {
      const hostId = context.host.id;
      const path = context.inputs.path ?? context.projectCheckout.path;
      const branchInput = context.inputs.branch;
      const claimDeadline = Date.now() + ATTACH_TIMEOUT_MS;
      while (!(await context.experimental_claimPath(path))) {
        context.signal.throwIfAborted();
        if (branchInput !== undefined || Date.now() >= claimDeadline) {
          return {
            status: "failed",
            message: "Workspace is being prepared by another thread",
          };
        }
        await delay(50, undefined, { signal: context.signal });
      }
      if (
        branchInput !== undefined &&
        (await otherLiveThreadUsesPath({
          hostId,
          path,
          threadId: context.thread.id,
        }))
      ) {
        return {
          status: "failed",

          message: LIVE_THREAD_MESSAGE,
        };
      }
      const branch =
        branchInput === undefined
          ? null
          : branchInput.kind === "existing"
            ? { kind: "existing" as const, name: branchInput.name }
            : {
                kind: "new" as const,
                name: context.suggestedBranchName,
                baseBranch: branchInput.baseBranch,
              };
      const operationId = `${context.pathKey}#${context.attempt}`;
      const stall = new AbortController();
      const stallTimer = setTimeout(() => stall.abort(), ATTACH_STALL_MS);
      reports.set(operationId, {
        report: context.report,
        progressed: () => clearTimeout(stallTimer),
      });
      try {
        const result = await host.call(
          "attach",
          { operationId, path, branch },
          {
            hostId,
            signal: AbortSignal.any([context.signal, stall.signal]),
            timeoutMs: ATTACH_TIMEOUT_MS,
          },
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
          ownsPath:
            result.path === context.projectCheckout.path &&
            context.projectCheckout.experimental_ownsPath === true,
        };
      } catch (error) {
        // Only a stall cancel the host confirmed (an AbortError) is a known
        // stop. Any other error, such as a connection that drops before or
        // after the cancel, may leave a branch switch running, so it throws
        // and the engine keeps the folder claimed (#1366).
        if (
          context.signal.aborted ||
          !stall.signal.aborted ||
          !(error instanceof Error && error.name === "AbortError")
        )
          throw error;
        return { status: "failed", message: ATTACH_STALLED_MESSAGE };
      } finally {
        clearTimeout(stallTimer);
        reports.delete(operationId);
      }
    },
    async remove() {
      return { status: "removed" };
    },
  });
}
