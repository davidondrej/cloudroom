import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, win32 } from "node:path";

export const ROOM_CLI_REEXEC_ENV = "ROOM_CLI_REEXEC";

interface MaybeReexecViaRoomCliArgs {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  currentExecutablePath?: string;
  reexec?: (args: {
    target: string;
    argv: string[];
    env: NodeJS.ProcessEnv;
  }) => void;
}

interface ResolveRoomCliLaunchArgs {
  argv: string[];
  nodePath: string;
  platform: NodeJS.Platform;
  target: string;
}

export function resolveRoomCliLaunch(args: ResolveRoomCliLaunchArgs): {
  command: string;
  args: string[];
} {
  return args.platform === "win32" && win32.extname(args.target) === ""
    ? { command: args.nodePath, args: [args.target, ...args.argv] }
    : { command: args.target, args: args.argv };
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

export function maybeReexecViaRoomCli(
  options: MaybeReexecViaRoomCliArgs = {},
): void {
  const env = options.env ?? process.env;
  if (env[ROOM_CLI_REEXEC_ENV] === "1") {
    return;
  }

  const targetRaw = env.ROOM_CLI?.trim();
  if (!targetRaw) {
    return;
  }

  const currentRaw = options.currentExecutablePath ?? process.argv[1];
  if (!currentRaw) {
    return;
  }

  const target = tryRealpath(targetRaw);
  const current = tryRealpath(currentRaw);
  if (target === null || current === null || target === current) {
    return;
  }

  const argv = options.argv ?? process.argv.slice(2);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    [ROOM_CLI_REEXEC_ENV]: "1",
  };

  if (options.reexec) {
    options.reexec({ target, argv, env: childEnv });
    return;
  }

  const launch = resolveRoomCliLaunch({
    argv,
    nodePath: process.execPath,
    platform: process.platform,
    target,
  });
  const result = spawnSync(launch.command, launch.args, {
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(
      `room: failed to re-exec ROOM_CLI=${target}: ${result.error.message}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.exit(result.status === null ? 1 : result.status);
}
