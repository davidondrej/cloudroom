import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Provider, SwitchWhere } from "./contract.js";

/**
 * Account telemetry (docs/scopes/multiple-subscriptions.md#tracking). Counts, timings, and fixed codes only: never
 * emails, names, or error text.
 */
type Value = string | number | boolean | null;
export type AddKind = "new" | "sign_in_again" | "approve_mac";
// Claude: `login` is the full login, `token` the one-year token for Cloud. Codex signs in with a device code, Cursor a key.
export type AddStep = "login" | "token" | "device" | "key";

const SNAPSHOT_DAY = "telemetry-snapshot-day:v1";
const CODES: [RegExp, string][] = [
  // First: its text says "terminal", which would read as login_not_started.
  [/Couldn't read this computer's Claude login/i, "mac_login_unreadable"],
  [/same Claude account|different Claude account/i, "different_account"],
  [/expired/i, "expired"],
  [/up to \d+ accounts/i, "max_accounts"],
  [/API key/i, "bad_key"],
  [/Approve this Mac/i, "mac_needs_cloud"],
  [/Sign in to |Sign in again|signed this account out|rejected this login/i, "signed_out"],
  [/Install Claude Code|Update Cloudroom/i, "cli_missing"],
  [/sign-in page|terminal/i, "login_not_started"],
  [/Cloud didn't switch|isn't connected in Cloud/i, "cloud_failed"],
  [/Couldn't confirm/i, "unconfirmed"],
  [/HTTP \d|time(d)? ?out|unavailable|didn't answer|fetch failed/i, "network"],
];

/** A fixed code for an error: the message itself may hold an email. */
export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return CODES.find(([pattern]) => pattern.test(message))?.[1] ?? "other";
}

export function accountTelemetry(room: BbPluginApi) {
  const capture = (name: string, properties: Record<string, Value>) => {
    try {
      room.experimental_telemetry.capture(name, properties);
    } catch {}
  };
  return {
    /** One step of adding an account; `ms` counts from its start. A `started` with no `done` or `failed` was given up. */
    add(
      provider: Provider,
      add: { kind: AddKind; startedAt: number },
      action: "started" | "step_done" | "done" | "failed",
      step: AddStep,
      error?: unknown,
    ) {
      capture("account_add", {
        provider,
        kind: add.kind,
        action,
        step,
        code: action === "failed" ? errorCode(error) : null,
        ms: Date.now() - add.startedAt,
      });
    },
    /** A pick of the account every thread uses, sent once it is saved. */
    switched(properties: {
      provider: Provider;
      where: SwitchWhere | null;
      to: "this_mac" | "added";
      accounts: number;
      target_at_limit: boolean;
      waiting_threads: number;
      outcome: "ok" | "failed";
      code: string | null;
      ms: number;
    }) {
      capture("account_switch", properties);
    },
    /** Cloud moved to the picked account, or failed to. `ms` counts from the pick. */
    cloudSwitched(provider: Provider, startedAt: number, failed: unknown) {
      capture("account_switch_cloud", {
        provider,
        outcome: failed ? "failed" : "ok",
        code: failed ? errorCode(failed) : null,
        ms: Date.now() - startedAt,
      });
    },
    /** Once a UTC day per install: how many accounts each agent has, and which kind is in use. */
    async daily(read: () => Record<string, Value>) {
      const day = new Date().toISOString().slice(0, 10);
      if ((await room.storage.kv.get(SNAPSHOT_DAY)) === day) return;
      await room.storage.kv.set(SNAPSHOT_DAY, day);
      capture("accounts_snapshot", read());
    },
  };
}
