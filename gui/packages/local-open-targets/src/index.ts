import path from "node:path";
import type { WorkspaceOpenTarget } from "@cloudroom/host-daemon-contract";
import { findApp } from "./apps.js";
import {
  cliInvocation,
  hasCli,
  listCliTargets,
  sshInvocation,
} from "./commands.js";
import {
  DESKTOP_PREFIX,
  defaultOpener,
  desktopAppInvocation,
  fileManagerOpener,
  listLinuxTargets,
  terminalInvocation,
  terminalSshInvocation,
} from "./linux.js";
import { listMacTargets, openOnMac } from "./mac.js";
import {
  fail,
  launch,
  requireOpenablePath,
  type Invocation,
  type ListWorkspaceOpenTargetsOptions,
  type OpenPathInTargetArgs,
  type WorkspaceOpenTargetRuntime,
} from "./system.js";
import { listWindowsTargets, windowsInvocation } from "./windows.js";

export {
  createWorkspaceOpenTargetRuntime,
  WorkspaceOpenTargetError,
} from "./system.js";
export type {
  ListWorkspaceOpenTargetsOptions,
  OpenPathInTargetArgs,
  WorkspaceOpenTargetRuntime,
  WorkspaceOpenTargetRuntimeOptions,
} from "./system.js";

export async function listWorkspaceOpenTargetsWithRuntime(
  runtime: WorkspaceOpenTargetRuntime,
  options: ListWorkspaceOpenTargetsOptions = {},
): Promise<WorkspaceOpenTarget[]> {
  switch (runtime.platform) {
    case "darwin":
      return listMacTargets(runtime, options);
    case "win32":
      return [
        ...(await listCliTargets(runtime)),
        ...(await listWindowsTargets(runtime)),
      ];
    case "linux":
      return [
        ...(await listCliTargets(runtime)),
        ...(await listLinuxTargets(runtime)),
      ];
    default:
      return [];
  }
}

async function linuxOrWindowsInvocation(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<Invocation> {
  if (runtime.platform !== "linux" && runtime.platform !== "win32") {
    fail(
      "unsupported_platform",
      "Workspace open targets are not supported on this platform",
    );
  }
  const desktopId = args.targetId.startsWith(DESKTOP_PREFIX)
    ? args.targetId.slice(DESKTOP_PREFIX.length)
    : null;
  const app = findApp(args.targetId);

  if (args.context.kind === "remote-ssh") {
    const request = { ...args, sshAuthority: args.context.sshAuthority };
    if (desktopId === null && args.targetId === "terminal") {
      return terminalSshInvocation(request, runtime);
    }
    if (desktopId === null && app?.ssh) {
      return sshInvocation(app, request, runtime);
    }
    return fail(
      "remote_target_unsupported",
      `${args.targetId} cannot open remote SSH paths`,
    );
  }

  const existing = await requireOpenablePath(args.path);
  if (desktopId !== null)
    return desktopAppInvocation(desktopId, existing, runtime);
  if (app && (await hasCli(app, runtime))) {
    return cliInvocation(app, existing, args, runtime);
  }
  if (runtime.platform === "win32") {
    const invocation = await windowsInvocation(
      args.targetId,
      existing,
      runtime,
    );
    if (invocation !== null) return invocation;
  }
  if (args.targetId === "default-app") {
    const exe =
      (await defaultOpener(runtime)) ??
      fail("target_unavailable", "Default app opener is unavailable");
    return { file: exe, args: [existing.path], env: runtime.env };
  }
  if (args.targetId === "file-manager") {
    const exe =
      (await fileManagerOpener(runtime)) ??
      fail("target_unavailable", "File manager opener is unavailable");
    const target =
      existing.type === "file" ? path.dirname(existing.path) : existing.path;
    return { file: exe, args: [target], env: runtime.env };
  }
  if (args.targetId === "terminal")
    return terminalInvocation(existing, args, runtime);
  return fail(
    "target_unavailable",
    `Workspace open target is unavailable: ${args.targetId}`,
  );
}

export async function openPathInTargetWithRuntime(
  args: OpenPathInTargetArgs,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<void> {
  if (runtime.platform === "darwin") return openOnMac(args, runtime);
  await launch(await linuxOrWindowsInvocation(args, runtime), runtime);
}
