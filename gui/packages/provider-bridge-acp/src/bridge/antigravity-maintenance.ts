import os from "node:os";
import type {
  ProviderUsage,
  ProviderUsageResult,
  ProviderUsageWindow,
} from "@cloudroom/provider-bridge-protocol";
import {
  clampPercent,
  downloadedInstallerCommand,
  execPortableFile,
  withoutBridgeRuntimeEnv,
} from "@cloudroom/provider-bridge-protocol/bridge-kit";
import { z } from "zod";
import {
  AcpAgentResponseError,
  createAcpAgentConnection,
  requestAcpInitialize,
} from "./agent-connection.js";
import type { AcpMaintenanceDialect } from "./provider-maintenance.js";

const INSTALL_SCRIPT_URL = "https://antigravity.google/cli/install.sh";
const INSTALL_POWERSHELL_URL = "https://antigravity.google/cli/install.ps1";
const SIGN_IN_CHECK_TIMEOUT_MS = 15_000;
const USAGE_TIMEOUT_MS = 20_000;
// ACP's reserved auth-required error.
const AUTH_REQUIRED_CODE = -32000;
const AUTH_REQUIRED_MESSAGE = "Authentication required";

function isAuthRequired(error: unknown): boolean {
  return (
    error instanceof AcpAgentResponseError &&
    error.code === AUTH_REQUIRED_CODE &&
    error.message.startsWith(AUTH_REQUIRED_MESSAGE)
  );
}

/**
 * Antigravity keeps its Google login in the system keyring, so the CLI is the
 * only one who can say whether it is signed in. `session/list` answers without
 * creating a session, and a signed-out CLI rejects it at once. Print mode
 * (`agy -p`) must not be used for this: signed out, it opens the browser and
 * waits a minute for a login.
 */
async function antigravitySignedIn(command: string): Promise<boolean> {
  const connection = createAcpAgentConnection({
    command,
    args: ["acp"],
    cwd: os.tmpdir(),
    env: withoutBridgeRuntimeEnv(process.env),
    recordThreadId: null,
    onNotification: () => {},
    onRequest: (_method, _params, responder) => {
      responder.error(-32601, "The sign-in check does not support requests");
    },
    onExit: () => {},
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await requestAcpInitialize(connection, {
          parameterizedModelPicker: false,
          fsAccess: false,
        });
        await connection.request({
          method: "session/list",
          params: {},
          resultSchema: z.unknown(),
        });
        return true;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Antigravity did not answer its sign-in check."));
        }, SIGN_IN_CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (isAuthRequired(error)) return false;
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    void connection.kill();
  }
}

const usageBucketSchema = z
  .object({
    name: z.string().nullish(),
    window: z.string().nullish(),
    remaining_fraction: z.number(),
    reset_time: z.string().nullish(),
  })
  .passthrough();

const usageGroupSchema = z
  .object({
    name: z.string().min(1),
    buckets: z.array(usageBucketSchema).default([]),
  })
  .passthrough();

/** What `agy -p "/usage" --output-format json` prints. */
const usageResultSchema = z
  .object({
    status: z.string().nullish(),
    error: z.string().nullish(),
    command: z
      .object({
        data: z
          .object({ groups: z.array(usageGroupSchema).default([]) })
          .passthrough(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

type WindowKind = "five-hour" | "daily" | "weekly";
const WINDOW_KINDS: Readonly<Record<string, WindowKind>> = {
  "5h": "five-hour",
  daily: "daily",
  weekly: "weekly",
};
const WINDOW_LABELS: Readonly<Record<WindowKind, string>> = {
  "five-hour": "Five-hour limit",
  daily: "Daily limit",
  weekly: "Weekly limit",
};
const WINDOW_ORDER = ["five-hour", "daily", "weekly", "custom"];

/** "Gemini Models" is "Gemini"; "Claude and GPT models" is "Claude and GPT". */
function groupTitle(name: string): string {
  return name.replace(/\s+models$/iu, "");
}

function resetIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const usageError = (message: string): ProviderUsage => ({
  status: "error",
  message,
  planLabel: null,
  accountEmail: null,
});

function normalizeUsage(stdout: string): ProviderUsage {
  // The result is the last line; earlier lines are the CLI's own notices.
  const line = stdout
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text.startsWith("{"))
    .at(-1);
  let raw: unknown;
  try {
    raw = JSON.parse(line ?? "");
  } catch {
    return usageError("Antigravity usage response was malformed.");
  }
  const parsed = usageResultSchema.safeParse(raw);
  if (!parsed.success) {
    return usageError("Antigravity usage response was malformed.");
  }
  const data = parsed.data.command?.data;
  if (!data) {
    return /authentication/iu.test(parsed.data.error ?? "")
      ? { status: "unauthenticated" }
      : usageError(
          parsed.data.error || "Antigravity did not report its usage.",
        );
  }
  const windows: ProviderUsageWindow[] = [];
  for (const group of data.groups) {
    const title = groupTitle(group.name);
    // The usage card names a row by its model: "gemini", "claude/gpt".
    const model = title.replace(/\s+and\s+/giu, "/").toLowerCase();
    const rows = group.buckets.map((bucket): ProviderUsageWindow => {
      const kind = WINDOW_KINDS[bucket.window ?? ""];
      // The CLI names a bucket by what is left ("Weekly Limit Remaining"); the bar shows what is used.
      const name = (bucket.name ?? bucket.window ?? "Limit").replace(
        /\s+remaining$/iu,
        "",
      );
      return {
        kind: kind ?? "custom",
        model,
        label: `${title} · ${kind === undefined ? name : WINDOW_LABELS[kind]}`,
        usedPercent: clampPercent((1 - bucket.remaining_fraction) * 100),
        resetsAt: resetIso(bucket.reset_time),
      };
    });
    const order = (row: ProviderUsageWindow) =>
      WINDOW_ORDER.indexOf(String(row["kind"]));
    windows.push(...rows.sort((a, b) => order(a) - order(b)));
  }
  return { status: "ok", accountEmail: null, planLabel: null, windows };
}

async function readAntigravityUsage(
  command: string,
): Promise<ProviderUsageResult> {
  try {
    if (!(await antigravitySignedIn(command))) {
      return { supported: true, usage: { status: "unauthenticated" } };
    }
    // A read-only slash command: print mode answers it without a model turn.
    const { stdout } = await execPortableFile(
      command,
      ["-p", "/usage", "--output-format", "json"],
      {
        cwd: os.tmpdir(),
        env: withoutBridgeRuntimeEnv(process.env),
        timeoutMs: USAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
    return { supported: true, usage: normalizeUsage(stdout) };
  } catch (error) {
    return {
      supported: true,
      usage: usageError(error instanceof Error ? error.message : String(error)),
    };
  }
}

export const ANTIGRAVITY_ACP_MAINTENANCE: AcpMaintenanceDialect = {
  loginCommand: "agy acp --login",
  // The CLI updates itself in the background, so there is no update to offer.
  installer: () =>
    downloadedInstallerCommand(INSTALL_SCRIPT_URL, {
      powershellUrl: INSTALL_POWERSHELL_URL,
    }),
  readAccount: async (command) =>
    (await antigravitySignedIn(command)) ? { email: null } : null,
  readUsage: readAntigravityUsage,
};

export const __testing = { normalizeUsage };
