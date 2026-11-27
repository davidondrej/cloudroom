import { execFile } from "node:child_process";

// Codex's own list of user-namespace failures (codex-rs/sandboxing/src/bwrap.rs).
const USER_NAMESPACE_FAILURES = [
  "loopback: Failed RTM_NEWADDR",
  "loopback: Failed RTM_NEWLINK",
  "setting up uid map: Permission denied",
  "No permissions to create a new namespace",
];

// The same sandbox a Cloudroom workspace thread gets (network on).
const PROBE_ARGS = [
  "sandbox",
  "-c",
  'sandbox_mode="workspace-write"',
  "-c",
  "sandbox_workspace_write.network_access=true",
  "--",
  "true",
];

// Ubuntu's AppArmor can block the bubblewrap sandbox Codex runs commands in,
// so every command fails and the thread dies quietly. On Linux only, run
// `true` in Codex's own sandbox first. Only a probe that exits with an error
// and one of Codex's known user-namespace errors blocks the thread; success,
// timeouts, and launch errors start it as before.
export async function codexLinuxSandboxError(args: {
  codexCommand: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (process.platform !== "linux" || process.env.VITEST) return null;
  const stderr = await new Promise<string>((resolve) => {
    execFile(
      args.codexCommand,
      PROBE_ARGS,
      { cwd: args.cwd, env: args.env, timeout: 10_000, killSignal: "SIGKILL" },
      (error, _stdout, output) =>
        resolve(typeof error?.code === "number" ? String(output) : ""),
    );
  });
  const failure = userNamespaceFailure(stderr);
  if (failure === undefined) return null;
  return `Codex can't start its command sandbox on this Linux computer (${failure}). Follow Codex's Linux setup at ${LINUX_SETUP_URL}, or switch this thread to Full access.`;
}

// Codex 0.172 reads AGENTS.md in a network-isolated sandbox whenever
// Cloudroom's deny profile is on, in every permission mode (#2828). A host that
// can't set up loopback passes the probe above, then fails thread creation with
// the raw error. Full access hits it too, so the guidance leaves it out.
export function codexLinuxThreadStartError(message: string): string | null {
  const failure = userNamespaceFailure(message);
  if (failure === undefined) return null;
  // Link first: batched parent notices keep only 300 characters.
  return `Codex can't start its sandbox on this Linux computer. Follow Codex's Linux setup at ${LINUX_SETUP_URL}. Cause: ${failure}`;
}

const LINUX_SETUP_URL =
  "https://developers.openai.com/codex/concepts/sandboxing#prerequisites";

function userNamespaceFailure(output: string): string | undefined {
  return output
    .split("\n")
    .find((line) =>
      USER_NAMESPACE_FAILURES.some((known) => line.includes(known)),
    )
    ?.trim();
}
