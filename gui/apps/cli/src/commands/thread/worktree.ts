import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveContextThreadId, resolveExplicitIdFlag } from "../../context-env.js";
import { resolveLocalHostId } from "../../daemon.js";
import { outputJson } from "../helpers.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// Moving = forking into a Cloudroom-managed worktree, so Cloudroom deletes the folder later.
// Hand-made `git worktree add` folders are never cleaned up.
export function registerWorktreeCommand(parent: Command, getUrl: () => string): void {
  parent
    .command("worktree [thread-id]")
    .description("Move a Local thread (default: this one) into a new Cloudroom-managed worktree, starting from its current commit")
    .option("--allow-dirty", "Leave uncommitted changes behind instead of refusing")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadIdValue: string | undefined, opts: { allowDirty?: boolean; json?: boolean }) => {
        const threadId =
          resolveExplicitIdFlag({ flagName: "thread ID", value: threadIdValue }) ?? resolveContextThreadId();
        if (!threadId) throw new Error("Pass a thread ID, or run this inside a Cloudroom thread.");
        const sdk = createCliBbSdk(getUrl());
        const source = await sdk.threads.get({ threadId });
        if (source.executionTarget === "cloud")
          throw new Error("Cloud threads already run in their own sandbox.");
        if (source.environmentId === null) throw new Error("This thread has no folder yet.");
        const environment = await sdk.environments.get({ environmentId: source.environmentId });
        if (!environment.path || environment.hostId !== (await resolveLocalHostId()))
          throw new Error("Run this on the computer the thread runs on.");
        let head: string;
        try {
          head = git(environment.path, ["rev-parse", "HEAD"]);
        } catch {
          throw new Error(`${environment.path} is not a Git checkout with commits.`);
        }
        const dirty = git(environment.path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
        if (dirty > 0 && !opts.allowDirty)
          throw new Error(
            `${dirty} uncommitted file(s) in ${environment.path} would stay behind. Commit your own changes first, or pass --allow-dirty to leave them.`,
          );
        const thread = await sdk.threads.fork({
          sourceThreadId: threadId,
          origin: "cli",
          environment: {
            type: "host",
            hostId: environment.hostId,
            workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: head } },
          },
          ...(source.title ? { title: source.title } : {}),
          agentContextSeed: [
            {
              type: "text",
              text: `This thread moved from ${environment.path} into a new worktree. Work only in the current folder; never edit ${environment.path}.`,
              mentions: [],
              visibility: "agent-only",
            },
          ],
        });
        if (outputJson(opts, thread)) return;
        console.log(`Moved to a new worktree: ${thread.id} (from commit ${head.slice(0, 9)})`);
        console.log(`Stop now and tell the user to continue in @thread:${thread.id}, then archive ${threadId}.`);
      }),
    );
}
