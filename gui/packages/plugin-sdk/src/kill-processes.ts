import { killProcessesWithCwdUnder } from "@cloudroom/process-utils";

/**
 * Kills every process whose working directory is at or under any of `directories`,
 * SIGTERM first and SIGKILL after the grace, for a provider tearing down a
 * workspace it made. Plugins built against SDK 0.6.26 or earlier that still pass
 * `{ directory }` keep working at runtime. Experimental: see docs/api_to_audit.md.
 */
export async function experimental_killProcessesWithCwdUnder(
  args:
    | { directories: readonly string[]; graceMs?: number }
    | { directory: string; graceMs?: number },
): Promise<{ pid: number; cwd: string }[]> {
  const directories = "directories" in args ? args.directories : [args.directory];
  const killed = [];
  for (const directory of directories)
    killed.push(...(await killProcessesWithCwdUnder({ directory, graceMs: args.graceMs })));
  return killed;
}
