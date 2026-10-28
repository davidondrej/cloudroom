import { resolveCurrentDevProcessEnv } from "@cloudroom/config/runtime";
import { runScriptProcess } from "../lib/process-helpers.js";
import { repoRoot, runMainIfEntrypoint } from "../lib/script-entry.js";

interface CliExecution {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function resolveCliExecution(
  cliArgs: string[] = process.argv.slice(2),
): CliExecution {
  const forwardedArgs = cliArgs[0] === "--" ? cliArgs.slice(1) : cliArgs;
  const env = { ...process.env };
  delete env.ROOM_CLI;
  delete env.ROOM_CLI_REEXEC;
  let args = ["apps/cli/dist/index.js", ...forwardedArgs];
  if (process.env.NODE_ENV !== "production") {
    const devEnv = resolveCurrentDevProcessEnv(repoRoot, process.env);
    env.ROOM_SERVER_URL = process.env.ROOM_SERVER_URL ?? devEnv.BB_SERVER_URL;
    env.ROOM_HOST_DAEMON_PORT =
      process.env.ROOM_HOST_DAEMON_PORT ?? devEnv.BB_HOST_DAEMON_PORT;
    env.ROOM_DATA_DIR = process.env.ROOM_DATA_DIR ?? devEnv.BB_DATA_DIR;
    args = [
      "--conditions=source",
      "--import",
      "tsx",
      "apps/cli/src/index.ts",
      ...forwardedArgs,
    ];
  }
  return {
    args,
    command: process.execPath,
    cwd: repoRoot,
    env,
  };
}

async function main(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const execution = resolveCliExecution(cliArgs);
  process.exitCode = await runScriptProcess({
    args: execution.args,
    command: execution.command,
    cwd: execution.cwd,
    env: execution.env,
    stdio: "inherit",
  });
}

runMainIfEntrypoint(import.meta.url, main);
