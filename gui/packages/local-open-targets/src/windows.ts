import path from "node:path";
import type { WorkspaceOpenTarget } from "@cloudroom/host-daemon-contract";
import {
  BASIC,
  hasExecutable,
  type ExistingPath,
  type Invocation,
  type WorkspaceOpenTargetRuntime,
} from "./system.js";

interface WindowsOpenArgs {
  env: NodeJS.ProcessEnv | undefined;
  existingPath: ExistingPath;
}

const PATH_VARIABLE = "WORKSPACE_OPEN_TARGET_PATH";
const OPEN_PATH = `$env:${PATH_VARIABLE}`;
const LITERAL_OPEN_PATH = `([WildcardPattern]::Escape(${OPEN_PATH}))`;

const hasWindowsTerminal = (runtime: WorkspaceOpenTargetRuntime) =>
  hasExecutable("wt", runtime);

export async function listWindowsTargets(
  runtime: WorkspaceOpenTargetRuntime,
): Promise<WorkspaceOpenTarget[]> {
  const target = (
    id: string,
    label: string,
    kind: "default-app" | "file-manager" | "terminal",
  ): WorkspaceOpenTarget => ({
    id,
    label,
    kind,
    icon: { kind: "symbol", name: kind },
    capabilities: BASIC,
  });
  return [
    target("default-app", "Default App", "default-app"),
    target("file-manager", "File Explorer", "file-manager"),
    target(
      "terminal",
      (await hasWindowsTerminal(runtime)) ? "Windows Terminal" : "PowerShell",
      "terminal",
    ),
  ];
}

function powerShell(
  env: NodeJS.ProcessEnv | undefined,
  openPath: string,
  script: string,
): Invocation {
  const rootKey = Object.keys(env ?? {}).find(
    (key) => key.toUpperCase() === "SYSTEMROOT",
  );
  const systemRoot = rootKey === undefined ? undefined : env?.[rootKey];
  return {
    file: systemRoot
      ? path.win32.join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
    env: { ...env, [PATH_VARIABLE]: openPath },
  };
}

export const buildWindowsDefaultOpenInvocation = (args: WindowsOpenArgs) =>
  powerShell(
    args.env,
    args.existingPath.path,
    `Invoke-Item -LiteralPath ${OPEN_PATH}`,
  );

export const buildWindowsFileManagerOpenInvocation = (args: WindowsOpenArgs) =>
  powerShell(
    args.env,
    path.win32.normalize(args.existingPath.path),
    args.existingPath.type === "file"
      ? `Start-Process -FilePath explorer.exe -ArgumentList ('/select,"' + ${OPEN_PATH} + '"')`
      : `Invoke-Item -LiteralPath ${OPEN_PATH}`,
  );

export const buildWindowsTerminalOpenInvocation = (
  args: WindowsOpenArgs & { terminal: "windows-terminal" | "powershell" },
) =>
  powerShell(
    args.env,
    args.existingPath.type === "file"
      ? path.win32.dirname(args.existingPath.path)
      : args.existingPath.path,
    args.terminal === "windows-terminal"
      ? `Start-Process -FilePath wt.exe -ArgumentList '-d','.' -WorkingDirectory ${LITERAL_OPEN_PATH}`
      : `Start-Process -FilePath powershell.exe -ArgumentList '-NoExit','-NoLogo' -WorkingDirectory ${LITERAL_OPEN_PATH}`,
  );

export async function windowsInvocation(
  targetId: string,
  existing: ExistingPath,
  runtime: WorkspaceOpenTargetRuntime,
): Promise<Invocation | null> {
  const args = { env: runtime.env, existingPath: existing };
  if (targetId === "default-app")
    return buildWindowsDefaultOpenInvocation(args);
  if (targetId === "file-manager")
    return buildWindowsFileManagerOpenInvocation(args);
  if (targetId !== "terminal") return null;
  return buildWindowsTerminalOpenInvocation({
    ...args,
    terminal: (await hasWindowsTerminal(runtime))
      ? "windows-terminal"
      : "powershell",
  });
}
