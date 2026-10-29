import { resolveEnvLoader, type EnvLoaderArgs } from "./env.js";
import { validateRequiredUrl } from "./public-url.js";
import {
  BB_LOOPBACK_HOST,
  BB_PROD_HOST_DAEMON_PORT,
  BB_PROD_SERVER_PORT,
  parsePortValue,
  resolveDevInstanceConfig,
} from "./runtime.js";

export interface CliConfig {
  ROOM_HOST_DAEMON_PORT: number;
  ROOM_SERVER_URL: string;
}

interface LoadCliConfigArgs extends EnvLoaderArgs {
  repoRoot?: string;
}

export function loadCliConfig(args: LoadCliConfigArgs = {}): CliConfig {
  const { env, mode, context } = resolveEnvLoader(args);
  const dev =
    mode === "dev" && args.repoRoot !== undefined
      ? resolveDevInstanceConfig({
          homeDir: context.homeDir,
          repoRoot: args.repoRoot,
        })
      : undefined;
  return {
    ROOM_SERVER_URL: validateRequiredUrl(
      "ROOM_SERVER_URL",
      env.ROOM_SERVER_URL ??
        dev?.serverUrl ??
        `http://${BB_LOOPBACK_HOST}:${BB_PROD_SERVER_PORT}`,
    ),
    ROOM_HOST_DAEMON_PORT:
      env.ROOM_HOST_DAEMON_PORT === undefined
        ? (dev?.ports.hostDaemonPort ?? BB_PROD_HOST_DAEMON_PORT)
        : parsePortValue({
            name: "ROOM_HOST_DAEMON_PORT",
            rawPort: env.ROOM_HOST_DAEMON_PORT,
          }),
  };
}
