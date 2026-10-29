import type { SystemVersionResponse } from "@cloudroom/server-contract";
import type { ServerRuntimeConfig } from "../../types.js";

export interface AppVersionService {
  getSystemVersion(args?: { forceRefresh?: boolean }): Promise<SystemVersionResponse>;
}

interface CreateAppVersionServiceArgs {
  config: Pick<ServerRuntimeConfig, "appVersion" | "isDevelopment">;
  desktopVersion?: string;
}

export function createAppVersionService(
  args: CreateAppVersionServiceArgs,
): AppVersionService {
  return {
    async getSystemVersion(): Promise<SystemVersionResponse> {
      return {
        currentVersion: args.config.appVersion,
        latestVersion: null,
        source: "npm",
        updateAvailable: false,
        isDevelopment: args.config.isDevelopment,
        upgradeCommand: "",
        desktopVersion: args.desktopVersion,
      };
    },
  };
}
