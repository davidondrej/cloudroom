import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveContextThreadId, resolveExplicitIdFlag } from "../../context-env.js";
import { resolveLocalHostId } from "../../daemon.js";
import { outputJson } from "../helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await exec("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;

/** Changed, deleted, and new files, relative to the thread's folder. A rename shows both names. */
async function uncommittedFiles(cwd: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", "--no-renames", "--relative", "-z", "HEAD"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
}

const covers = (carried: string, file: string) =>
  file === carried || file.startsWith(`${carried.replace(/\/+$/u, "")}/`);

// Moving keeps the thread's ID and chat in a Cloudroom-managed worktree, which Cloudroom deletes later.
// Hand-made `git worktree add` folders are never cleaned up. Forking stays in `room-cli thread fork`.
export function registerWorktreeCommand(parent: Command, getUrl: () => string): void {
  parent
    .command("worktree [thread-id]")
    .description(
      "Move a Local thread (default: this one) into a new Cloudroom-managed worktree from its current commit. It keeps its ID and chat; the move happens when its current turn ends",
    )
    .option(
      "--carry <paths...>",
      "Uncommitted files or folders to bring along, relative to the thread's folder. Pick only the ones this thread changed: other agents may share the checkout",
    )
    .option("--allow-dirty", "Leave the other uncommitted files behind instead of refusing")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadIdValue: string | undefined,
          opts: { carry?: string[]; allowDirty?: boolean; json?: boolean },
        ) => {
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
          let dirty: string[];
          try {
            dirty = await uncommittedFiles(environment.path);
          } catch {
            throw new Error(`${environment.path} is not a Git checkout with commits.`);
          }
          const carry = opts.carry ?? [];
          const left = dirty.filter((file) => !carry.some((carried) => covers(carried, file)));
          if (left.length > 0 && !opts.allowDirty)
            throw new Error(
              [
                `${left.length} uncommitted file(s) in ${environment.path} would stay behind:`,
                ...left.slice(0, 50).map((file) => `  ${file}`),
                ...(left.length > 50 ? [`  …and ${left.length - 50} more`] : []),
                "Other agents may share this checkout. Pass --carry with only the files this thread changed, and --allow-dirty to leave the rest.",
              ].join("\n"),
            );
          const result = await sdk.threads.worktree({ threadId, carry });
          if (outputJson(opts, result)) return;
          console.log(
            `This thread moves to a new worktree when its current turn ends${carry.length > 0 ? `, with ${carry.length} carried path(s)` : ""}.`,
          );
          console.log(
            `End your turn now. From the next turn on, work only in the new worktree; never edit ${result.previousPath}.`,
          );
        },
      ),
    );
}
