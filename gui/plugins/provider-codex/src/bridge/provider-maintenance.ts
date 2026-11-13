import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import {
  type ProviderHealthResult,
  type ProviderInstallationCommand,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsage,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  experimental_clampPercent as clampPercent,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_findCliExecutable as findCliExecutable,
  experimental_formatCommand as formatCommand,
  experimental_npmCommand as npmCommand,
  experimental_installationRunUnavailable as installationRunUnavailable,
  experimental_installationVerification as installationVerification,
  experimental_npmGlobalInstallCommand as npmGlobalInstallCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_npmLatestVersion as npmLatestVersion,
  experimental_probeCliVersion as probeCliVersion,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { fetchChatGpt } from "../ai/chatgpt-fetch.js";
import {
  readCodexAuthFile,
  type CodexAuthCredentials,
} from "../ai/codex-auth.js";
import { fetchWithProxyFallback } from "./proxy-fallback.js";

const CODEX_MINIMUM_SUPPORTED_VERSION = "0.136.0";
const CODEX_REWIND_MINIMUM_SUPPORTED_VERSION = "0.143.0";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const CODEX_NPM_PACKAGE = "@openai/codex";
// OpenAI's official installer, run the way `codex update` runs it. It needs no Node, never
// prompts, and installs to ~/.codex/packages/standalone, which Cloudroom then prefers.
const CODEX_OFFICIAL_INSTALL =
  "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh";
// Windows has no sh, and most Windows PCs have no Node, so npm fails there (#475). OpenAI's
// PowerShell installer needs neither. PowerShell gets it as one argument, never through cmd.exe.
const CODEX_WINDOWS_INSTALL =
  "$env:CODEX_NON_INTERACTIVE='1'; irm https://chatgpt.com/codex/install.ps1 | iex";
// install.ps1 rewrites the user Path as REG_SZ, which expands entries like %NVM_HOME% for good,
// and has no flag to skip that. So save the raw Path and its kind, run the installer in its own
// PowerShell (it can `exit`), write Path back as it was, add only Codex's bin folder, and
// broadcast the change so new terminals see it.
const CODEX_WINDOWS_INSTALL_KEEPING_PATH = [
  "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$p = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
  "$t = if ($null -eq $p) { 'ExpandString' } else { $k.GetValueKind('Path') }",
  `& (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command '${CODEX_WINDOWS_INSTALL.replaceAll("'", "''")}'`,
  "$c = $LASTEXITCODE",
  "$b = Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin'",
  "$e = if ($t -eq 'ExpandString') { [char]37 + 'LOCALAPPDATA' + [char]37 + '\\Programs\\OpenAI\\Codex\\bin' } else { $b }",
  "if ((Test-Path (Join-Path $b 'codex.exe')) -and ([Environment]::ExpandEnvironmentVariables([string]$p).Split(';') -notcontains $b)) { $p = (@($p, $e) | Where-Object { $_ }) -join ';' }",
  "if ($null -eq $p) { $k.DeleteValue('Path', $false) } else { $k.SetValue('Path', $p, $t) }",
  "[Environment]::SetEnvironmentVariable('CLOUDROOM_PATH_REFRESH', $null, 'User')",
  "exit $c",
].join("; ");

/** OpenAI's own installer, run when npm can't install or update Codex. */
function codexOfficialInstaller(): ProviderInstallationCommand {
  return process.platform === "win32"
    ? {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          CODEX_WINDOWS_INSTALL_KEEPING_PATH,
        ],
        displayCommand: CODEX_WINDOWS_INSTALL,
      }
    : {
        command: "sh",
        args: ["-c", CODEX_OFFICIAL_INSTALL],
        displayCommand: CODEX_OFFICIAL_INSTALL,
      };
}

function fetchCodexUsage(headers: Headers): Promise<Response> {
  return fetchWithProxyFallback((init) =>
    fetchChatGpt({
      url: CODEX_USAGE_URL,
      init: (cloudflareHeaders) => {
        const requestHeaders = new Headers(headers);
        for (const [key, value] of cloudflareHeaders) {
          requestHeaders.set(key, value);
        }
        return {
          ...init,
          headers: requestHeaders,
          signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
        };
      },
    }),
  );
}

async function readCredentials(): Promise<CodexAuthCredentials | null> {
  const auth = await readCodexAuthFile();
  switch (auth.state) {
    case "ok":
      return auth.credentials;
    case "missing":
    case "unusable":
      return null;
    case "unreadable":
    case "malformed":
      throw auth.error;
  }
}

function minimumSupportedVersionForRequirement(
  requirement?: "thread_rewind",
): string {
  return requirement === "thread_rewind"
    ? CODEX_REWIND_MINIMUM_SUPPORTED_VERSION
    : CODEX_MINIMUM_SUPPORTED_VERSION;
}

function codexUpdateCommand(
  command: string,
  npmPrefix: string | null = null,
): {
  command: string;
  args: string[];
  displayCommand: string;
} {
  if (npmPrefix !== null) {
    const npm = npmCommand();
    const args = [
      "install",
      "-g",
      "--prefix",
      npmPrefix,
      `${CODEX_NPM_PACKAGE}@latest`,
    ];
    return { command: npm, args, displayCommand: formatCommand(npm, args) };
  }
  const args = ["update"];
  return {
    command,
    args,
    displayCommand: formatCommand("codex", args),
  };
}

export async function getCodexProviderInstallationStatus(
  requirement?: "thread_rewind",
): Promise<ProviderInstallationStatus> {
  const minimumSupportedVersion =
    minimumSupportedVersionForRequirement(requirement);
  // Only ever run what findCliExecutable returns. A bare `codex` or an unchecked path can reach
  // the copy inside Codex.app, and macOS may move the whole app to the Bin (#96).
  const executable = findCliExecutable("codex");
  const [versionOutput, latestVersion, npmGlobal] = await Promise.all([
    executable === null ? null : commandOutput(executable, ["--version"]),
    npmLatestVersion(CODEX_NPM_PACKAGE),
    probeNpmGlobalPackage(CODEX_NPM_PACKAGE),
  ]);
  // A launcher that can't find its native binary can't run anything, so it
  // counts as not installed and gets the install action (a reinstall).
  const broken =
    executable !== null &&
    versionOutput === null &&
    codexBrokenInstallHint(
      (await probeCliVersion(executable)).failedOutput ?? "",
    ) !== null;
  const installed = executable !== null && !broken;
  const currentVersion = versionFrom(versionOutput);
  const needsUpdate =
    installed &&
    currentVersion !== null &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  const versionUnsupported =
    installed &&
    (currentVersion === null
      ? requirement === "thread_rewind"
      : compareVersions(currentVersion, minimumSupportedVersion) < 0);
  const actionKind = !installed
    ? "install"
    : needsUpdate || versionUnsupported
      ? "update"
      : null;

  return {
    executableName: "codex",
    executablePath: executable,
    installed,
    installSource: npmGlobalInstallSource({
      installed,
      executablePath: executable,
      npmBin: npmGlobal.npmBin,
    }),
    currentVersion,
    latestVersion,
    minimumSupportedVersion,
    npmPackageName: CODEX_NPM_PACKAGE,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction:
      actionKind === null
        ? null
        : {
            kind: actionKind,
            label: actionKind === "install" ? "Install" : "Update",
            command:
              actionKind === "install"
                ? npmGlobalInstallCommand(CODEX_NPM_PACKAGE).displayCommand
                : codexUpdateCommand("codex").displayCommand,
          },
    needsUpdate,
    versionUnsupported,
  };
}

export async function getCodexProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getCodexProviderInstallationStatus();
  return buildCodexProviderInstallationRun(
    status,
    action,
    await npmPrefixOf(status.executablePath),
  );
}

// `codex update` uses the npm on PATH. With two Node installs, that updates a different copy
// than the one Cloudroom runs, so update the npm prefix that owns this executable.
async function npmPrefixOf(executable: string | null): Promise<string | null> {
  if (executable === null) return null;
  const real = await realpath(executable).catch(() => executable);
  const index = real.indexOf(
    `${sep}lib${sep}node_modules${sep}@openai${sep}codex${sep}`,
  );
  return index > 0 ? real.slice(0, index) : null;
}

function buildCodexProviderInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
  npmPrefix: string | null = null,
): ProviderInstallationRunResult {
  if (status.installAction?.kind !== action) {
    return installationRunUnavailable("Codex", action, status);
  }
  return {
    available: true,
    command:
      action === "update" && status.executablePath !== null
        ? codexUpdateCommand(status.executablePath, npmPrefix)
        : action === "install" && npmPrefix !== null
          ? // Reinstall a broken npm Codex into the prefix that owns it.
            codexUpdateCommand("codex", npmPrefix)
          : npmGlobalInstallCommand(CODEX_NPM_PACKAGE),
    verification: installationVerification(status, action),
    fallback: codexOfficialInstaller(),
  };
}

// The terminal's shell would otherwise pick its own `codex` from PATH (#96). Windows shells don't
// read these POSIX quotes, and only macOS has the app copy problem.
function codexLoginCommand(): string | null {
  const executable = findCliExecutable("codex");
  if (executable === null) return null;
  return process.platform === "win32"
    ? "codex login"
    : formatCommand(executable, ["login"]);
}

function healthResult(
  status:
    | "ready"
    | "not_installed"
    | "unauthenticated"
    | "expired"
    | "unsupported_version"
    | "unknown",
  args: {
    accountEmail?: string | null;
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: CODEX_MINIMUM_SUPPORTED_VERSION,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: codexLoginCommand(),
    },
  };
}

// The npm launcher ran, but its native binary is missing or can't run (#907).
const CODEX_BROKEN_INSTALL_PATTERN =
  /Missing optional dependency @openai\/codex|execve failed with error code ENOENT|\bspawn \S+ ENOENT\b/u;

/** Reinstall advice when Codex's output shows a broken install, else null. Prefers the launcher's own command. */
export function codexBrokenInstallHint(output: string): string | null {
  if (!CODEX_BROKEN_INSTALL_PATTERN.test(output)) return null;
  const own = /Reinstall Codex: ([^\n]+)/u.exec(output)?.[1]?.trim();
  return `Reinstall Codex: ${own || npmGlobalInstallCommand(CODEX_NPM_PACKAGE).displayCommand}`;
}

export async function getCodexProviderHealth(): Promise<ProviderHealthResult> {
  const command = findCliExecutable("codex");
  if (command === null) {
    return healthResult("not_installed");
  }
  // A timeout or unclear failure gives no hint, so a slow install still looks ready.
  const { version, failedOutput } = await probeCliVersion(command);
  const brokenHint = codexBrokenInstallHint(failedOutput ?? "");
  if (brokenHint !== null) {
    return healthResult("unknown", {
      statusMessage: `\`${command} --version\` failed: this Codex install is broken. ${brokenHint}`,
    });
  }
  if (
    version !== null &&
    compareVersions(version, CODEX_MINIMUM_SUPPORTED_VERSION) < 0
  ) {
    return healthResult("unsupported_version", { installedVersion: version });
  }
  try {
    const credentials = await readCredentials();
    if (credentials === null) {
      return healthResult("unauthenticated", { installedVersion: version });
    }
    if (credentials.type === "chatgpt" && credentials.expired) {
      return healthResult("expired", {
        accountEmail: credentials.accountEmail,
        installedVersion: version,
      });
    }
    return healthResult("ready", {
      accountEmail:
        credentials.type === "chatgpt" ? credentials.accountEmail : null,
      installedVersion: version,
    });
  } catch (error) {
    return healthResult("unknown", {
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

const codexUsageWindowSchema = z.object({
  used_percent: z.number(),
  reset_at: z.number().nullish(),
  limit_window_seconds: z.number().nullish(),
});

const codexUsageResponseSchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z
    .object({
      allowed: z.boolean().nullish(),
      limit_reached: z.boolean().nullish(),
      primary_window: codexUsageWindowSchema.nullish(),
      secondary_window: codexUsageWindowSchema.nullish(),
    })
    .nullish(),
  credits: z
    .object({
      has_credits: z.boolean().nullish(),
      unlimited: z.boolean().nullish(),
      balance: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish()
    .catch(null),
});

function usageCredits(
  usage: z.infer<typeof codexUsageResponseSchema>,
): { detail: string | null } | null {
  const limited =
    usage.rate_limit?.limit_reached === true ||
    [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].some(
      (window) => window != null && window.used_percent >= 100,
    );
  if (
    !limited ||
    usage.credits?.has_credits !== true ||
    usage.credits.unlimited === true ||
    usage.rate_limit?.allowed === false
  )
    return null;
  const balance = usage.credits.balance;
  if (balance == null || balance === "") return { detail: null };
  return {
    detail: /^[\d.,]+$/u.test(String(balance))
      ? `${balance} credits left`
      : `${balance} left`,
  };
}

function usageWindow(
  value: z.infer<typeof codexUsageWindowSchema> | null | undefined,
  fallbackLabel: string,
): ProviderUsageWindow | null {
  if (!value) return null;
  return {
    kind:
      value.limit_window_seconds === 18_000
        ? "five-hour"
        : value.limit_window_seconds === 86_400
          ? "daily"
          : value.limit_window_seconds === 604_800
            ? "weekly"
            : "custom",
    label:
      value.limit_window_seconds === 604_800 ? "Weekly limit" : fallbackLabel,
    usedPercent: clampPercent(value.used_percent),
    resetsAt:
      value.reset_at == null || !Number.isFinite(value.reset_at)
        ? null
        : new Date(value.reset_at * 1000).toISOString(),
  };
}

function planLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const labels: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    team: "Team",
    business: "Business",
    education: "Education",
    edu: "Education",
    enterprise: "Enterprise",
  };
  return labels[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

function normalizeUsage(raw: unknown, email: string | null): ProviderUsage {
  const parsed = codexUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Codex usage response was malformed.",
      planLabel: null,
      accountEmail: email,
    };
  }
  const windows = [
    usageWindow(parsed.data.rate_limit?.primary_window, "Current session"),
    usageWindow(parsed.data.rate_limit?.secondary_window, "Weekly limit"),
  ].filter((window): window is ProviderUsageWindow => window !== null);
  return {
    status: "ok",
    accountEmail: email,
    planLabel: planLabel(parsed.data.plan_type),
    credits: usageCredits(parsed.data),
    plan: parsed.data.plan_type
      ? { id: parsed.data.plan_type, multiplier: null }
      : null,
    windows,
  };
}

export async function getCodexProviderUsage(): Promise<ProviderUsageResult> {
  // Usage needs only the saved ChatGPT login, not the CLI: Cloud runs Codex on this Mac's login without one.
  const installed = findCliExecutable("codex") !== null;
  const notInstalled: ProviderUsageResult = {
    supported: true,
    usage: { status: "not_installed" },
  };
  let credentials: CodexAuthCredentials | null;
  try {
    credentials = await readCredentials();
  } catch (error) {
    if (!installed) return notInstalled;
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        planLabel: null,
        accountEmail: null,
      },
    };
  }
  if (!installed && (credentials?.type !== "chatgpt" || credentials.expired))
    return notInstalled;
  if (credentials === null) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  if (credentials.type === "apiKey") {
    return {
      supported: true,
      usage: {
        status: "error",
        message:
          "Codex is authenticated with an API key, which has no subscription usage limits.",
        planLabel: null,
        accountEmail: null,
      },
    };
  }
  if (credentials.expired) {
    return { supported: true, usage: { status: "expired" } };
  }
  try {
    const headers = new Headers({
      Authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      originator: "bb",
      "User-Agent": "bb-provider-codex",
      Accept: "application/json",
    });
    if (credentials.isFedrampAccount) headers.set("X-OpenAI-Fedramp", "true");
    const response = await fetchCodexUsage(headers);
    if (response.status === 401) {
      // Without a CLI, "Sign in" (`codex login`) can't run, so the card hides Codex instead.
      return installed
        ? { supported: true, usage: { status: "expired" } }
        : notInstalled;
    }
    if (!response.ok) {
      return {
        supported: true,
        usage: {
          status: "error",
          message: `Codex usage request failed (HTTP ${response.status}).`,
          planLabel: null,
          accountEmail: credentials.accountEmail,
        },
      };
    }
    return {
      supported: true,
      usage: {
        ...normalizeUsage(await response.json(), credentials.accountEmail),
        accountKey: credentials.accountId
          ? `openai:chatgpt:${credentials.accountId}`
          : null,
      },
    };
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        planLabel: null,
        accountEmail: credentials.accountEmail,
      },
    };
  }
}

export const __testing = {
  buildProviderInstallationRun: buildCodexProviderInstallationRun,
  minimumSupportedVersionForRequirement,
  normalizeUsage,
};
