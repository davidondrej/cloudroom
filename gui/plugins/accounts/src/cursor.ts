import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { cursorAuthFile } from "@cloudroom/process-utils";
import { z } from "zod";
import type { UsageWindow } from "./contract.js";
import { SignInAgainError } from "./tokens.js";

// Added Cursor accounts run on user API keys, Cursor's own way to use a second account side by side. A key is swapped for
// a short-lived token, which reads the account, plan, and usage the way the Mac's own login does (provider-acp).
const API = "https://api2.cursor.sh";
const TIMEOUT_MS = 15_000;

export const cursorSecretSchema = z.object({ apiKey: z.string().min(1) });
export const isCursorKey = (key: string) => /^[\x21-\x7e]{1,4096}$/.test(key);

/** What a Local Cursor run on an added account gets. The memory store keeps the key's tokens out of the Mac's Keychain,
 *  where Cursor would otherwise save them over the Mac's own login. */
export const cursorEnv = (apiKey: string) => ({
  CURSOR_API_KEY: apiKey,
  AGENT_CLI_CREDENTIAL_STORE: "memory",
});

async function exchange(apiKey: string): Promise<string> {
  const response = await fetch(`${API}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status >= 500)
    throw new Error(`Cursor is unavailable (HTTP ${response.status}).`);
  if (!response.ok)
    throw new SignInAgainError("Cursor rejected this API key. Add a new one.");
  return z
    .object({ accessToken: z.string().min(1) })
    .parse(await response.json()).accessToken;
}

async function dashboard(token: string, method: string): Promise<unknown> {
  const response = await fetch(
    `${API}/aiserver.v1.DashboardService/${method}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (response.status === 401)
    throw new SignInAgainError("Cursor signed this account out.");
  if (!response.ok)
    throw new Error(`Cursor didn't answer (HTTP ${response.status}).`);
  return response.json();
}

const meSchema = z.object({
  email: z.string().nullish(),
  authId: z.string().nullish(),
});
const planSchema = z.object({
  planInfo: z.object({ planName: z.string().nullish() }).nullish(),
});

async function account(token: string) {
  const [me, plan] = await Promise.all([
    dashboard(token, "GetMe").then((raw) => meSchema.catch({}).parse(raw)),
    dashboard(token, "GetPlanInfo").then(
      (raw) => planSchema.catch({}).parse(raw),
      () => ({ planInfo: null }),
    ),
  ]);
  return {
    email: me.email || null,
    plan: plan.planInfo?.planName || null,
    accountKey: me.authId ? `cursor:${me.authId}` : null,
  };
}

/** The account a key belongs to. Throws when Cursor rejects the key. */
export const cursorAccount = async (apiKey: string) =>
  account(await exchange(apiKey));

const amount = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .nullish();
const usageSchema = z.object({
  billingCycleEnd: amount,
  planUsage: z.object({ totalPercentUsed: z.number().nullish() }).nullish(),
  spendLimitUsage: z
    .object({
      overallLimit: amount,
      overallUsed: amount,
      individualLimit: amount,
      individualUsed: amount,
    })
    .nullish(),
});

/** The same bars as the Mac's own Cursor login (provider-acp's provider-maintenance.ts). */
export async function cursorUsage(apiKey: string): Promise<UsageWindow[]> {
  const usage = usageSchema.parse(
    await dashboard(await exchange(apiKey), "GetCurrentPeriodUsage"),
  );
  const resetsAt = usage.billingCycleEnd ?? null;
  const windows: UsageWindow[] = [];
  const percent = (value: number) => Math.max(0, Math.min(100, value));
  if (usage.planUsage?.totalPercentUsed != null)
    windows.push({
      label: "Plan usage",
      usedPercent: percent(usage.planUsage.totalPercentUsed),
      resetsAt,
    });
  const spend = usage.spendLimitUsage;
  const limit = spend?.overallLimit ?? spend?.individualLimit;
  const used =
    spend?.overallLimit != null ? spend.overallUsed : spend?.individualUsed;
  if (limit)
    windows.push({
      label: "On-demand spend",
      usedPercent: percent(((used ?? 0) / limit) * 100),
      resetsAt,
    });
  return windows;
}

/** The email of the Mac's own Cursor CLI login, or null when it is signed out. Read like Cloud's copy of it
 *  (sandboxes.ts macCursorLogin), so macOS shows no prompt. */
export async function localCursorEmail(): Promise<string | null> {
  const file = cursorAuthFile();
  const token = file
    ? await fs
        .readFile(file, "utf8")
        .then(
          (text) =>
            z.object({ accessToken: z.string() }).parse(JSON.parse(text))
              .accessToken,
        )
        .catch(() => null)
    : process.platform === "darwin"
      ? await promisify(execFile)(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-a",
            "cursor-user",
            "-s",
            "cursor-access-token",
            "-w",
          ],
          { timeout: 10_000 },
        ).then(
          (result) => result.stdout.trim() || null,
          () => null,
        )
      : null;
  return token
    ? ((await account(token).catch(() => null))?.email ?? null)
    : null;
}
