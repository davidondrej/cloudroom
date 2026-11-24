import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { findCliExecutable } from "@cloudroom/process-utils";
import { readAntigravityStatus } from "@cloudroom/process-utils/antigravity-status";
import type { UsageWindow } from "./contract.js";

// agy keeps this computer's login in the Keychain. In an SSH session it reads only this file under HOME instead, and a
// HOME without the login Keychain makes it save there too (agy 1.5.14, docs/scopes/multiple-subscriptions.md, 35).
// Added accounts run that way, so they never touch the computer's own login.
export const AGY_TOKEN = path.join(".gemini", "antigravity-cli", "antigravity-oauth-token");
export const AGY_FILE_LOGIN = { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" } as const;
const LOGIN_MS = 10 * 60_000;

const loginSchema = z.looseObject({
  token: z.looseObject({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
  }),
  id_token_email: z.string().optional(),
});

/** An account's login file. The refresh token names the grant: agy renews the access token beside it. */
export function readAgyLogin(text: string): { email: string | null; grant: string } {
  const login = loginSchema.parse(JSON.parse(text));
  return { email: login.id_token_email ?? null, grant: login.token.refresh_token };
}
const grantOf = (text: string) => {
  try {
    return readAgyLogin(text).grant;
  } catch {
    return null;
  }
};

/** Puts the account in use's login where agy reads it in an SSH session, or takes it away (null) for this computer's
 *  own login. A login Cloudroom didn't add there, such as agy signed in over SSH, is never replaced or deleted. */
export async function placeAgyLogin(
  text: string | null,
  added: ReadonlySet<string>,
  home = os.homedir(),
): Promise<void> {
  const file = path.join(home, AGY_TOKEN);
  const before = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const ours = before === null || added.has(grantOf(before) ?? "");
  // Already this account: keep the access token agy renewed there.
  if (text !== null && before !== null && grantOf(before) === grantOf(text)) return;
  if (text === null) {
    if (before !== null && ours) await fs.rm(file, { force: true });
    return;
  }
  if (!ours)
    throw new Error(`${file} holds another Antigravity login. Move it away, then try again.`);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
}

const bucketSchema = z.looseObject({
  remaining_fraction: z.number().min(0).max(1).nullish(),
  reset_time: z.string().nullish(),
  reset_in_seconds: z.number().nonnegative().nullish(),
  disabled: z.boolean().nullish(),
});
const statusSchema = z.looseObject({
  plan_tier: z.string().nullish(),
  quota: z.record(z.string(), bucketSchema).nullish(),
});
// The labels the usage box uses for this computer's login (provider-maintenance.ts). 3P shows only once used.
const BUCKETS = [
  ["gemini-5h", "Five-hour limit"],
  ["gemini-weekly", "Weekly limit"],
  ["3p-5h", "Five-hour · 3P"],
  ["3p-weekly", "Weekly · 3P"],
] as const;

/** An added account's plan and limits, read with agy's statusLine in the account's own HOME. No tokens spent. */
export async function agyUsage(
  home: string,
): Promise<{ plan: string | null; windows: UsageWindow[] }> {
  const agy = findCliExecutable("agy");
  if (!agy) throw new Error("Install Antigravity on this computer to read this account's limits.");
  const raw = await readAntigravityStatus(agy, { ...process.env, HOME: home, ...AGY_FILE_LOGIN });
  if (raw === null) throw new Error("This account's Antigravity login stopped working. Remove it and add it again.");
  const status = statusSchema.parse(raw);
  const now = Date.now();
  const windows = BUCKETS.flatMap(([key, label]): UsageWindow[] => {
    const bucket = status.quota?.[key];
    if (!bucket || bucket.disabled || bucket.remaining_fraction == null) return [];
    const usedPercent = Math.round((1 - bucket.remaining_fraction) * 100);
    if (key.startsWith("3p") && usedPercent === 0) return [];
    const reset = bucket.reset_time ? Date.parse(bucket.reset_time) : NaN;
    return [{
      label,
      usedPercent,
      resetsAt: Number.isFinite(reset)
        ? reset
        : bucket.reset_in_seconds
          ? now + bucket.reset_in_seconds * 1_000
          : null,
      checkedAt: now,
    }];
  });
  return { plan: status.plan_tier?.trim() || null, windows };
}

type Run = {
  child: ChildProcessWithoutNullStreams;
  home: string;
  url: string | null;
  sent: boolean;
  exited: boolean;
  done: Promise<string>;
  stop: () => void;
};
// Google's sign-in link, as agy prints it. Cloud accepts the same hosts (web/antigravity-login.py).
const SIGN_IN_HOSTS = new Set(["accounts.google.com", "antigravity.google"]);
const signInLink = (output: string): string | null => {
  const clean = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const [url] of clean.matchAll(/https:\/\/[^\s<>]+(?=\s)/g)) {
    try {
      if (SIGN_IN_HOSTS.has(new URL(url).hostname)) return url;
    } catch {}
  }
  return null;
};
/** What Google shows after sign-in: one line of printable text. */
export const isAgyCode = (code: string) => /^[!-~]{1,4096}$/.test(code.trim());

/** Google's sign-in for an added account: agy prints a link, the user pastes back the code Google shows, and agy
 *  saves the login in the account's own HOME. The same terminal flow Cloud uses (web/antigravity-login.py). */
export class AntigravityLogin {
  private readonly runs = new Map<string, Run>();

  async start(home: string): Promise<{ sessionId: string; authorizeUrl: string }> {
    const agy = findCliExecutable("agy");
    if (!agy) throw new Error("Install Antigravity on this computer, then try again.");
    if (process.platform === "win32")
      throw new Error("Adding Antigravity accounts works on macOS and Linux for now.");
    const command = 'stty cols 4000 2>/dev/null; exec "$AGY_BIN" acp --login --disable-telemetry';
    // `script` gives agy the terminal its sign-in needs. It takes the code from a pipe (`cat`; macOS `script` refuses
    // Node's socket), and the whole group ends with it, as in spawnInTerminal.
    const tty =
      process.platform === "darwin"
        ? `/usr/bin/script -q /dev/null /bin/sh -c '${command}'`
        : `/usr/bin/script -q -c '${command}' /dev/null`;
    const child = spawn("/bin/sh", ["-c", `cat | { ${tty}; kill 0; }`], {
      env: {
        ...process.env,
        ...AGY_FILE_LOGIN,
        HOME: home,
        AGY_BIN: agy,
        AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      },
      stdio: "pipe",
      detached: true,
    });
    child.stderr.resume();
    // Typing into an agy that already ended must not throw where nothing catches it.
    child.stdin.on("error", () => {});
    let output = "";
    let stopped = false;
    const sessionId = randomUUID();
    const run: Run = {
      child,
      home,
      url: null,
      sent: false,
      exited: false,
      done: Promise.resolve(""),
      stop: () => {
        stopped = true;
        try {
          process.kill(-child.pid!);
        } catch {}
      },
    };
    const timer = setTimeout(run.stop, LOGIN_MS);
    run.done = new Promise<string>((resolve, reject) => {
      child.on("error", () => reject(new Error("Could not start Antigravity.")));
      // The saved login decides, not how agy ended.
      child.on("close", () => {
        clearTimeout(timer);
        run.exited = true;
        // Ended before a code was sent (timed out or cancelled): nothing can finish it any more.
        if (!run.sent) this.runs.delete(sessionId);
        fs.readFile(path.join(home, AGY_TOKEN), "utf8")
          .then((text) => {
            readAgyLogin(text);
            resolve(text);
          })
          .catch(() =>
            reject(
              new Error(
                stopped && !run.sent
                  ? "Antigravity sign-in timed out. Try again."
                  : "Google didn't accept that code. Start again.",
              ),
            ),
          );
      });
    });
    run.done.catch(() => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (run.url) return;
      output = (output + chunk.toString()).slice(-32_768);
      run.url = signInLink(output);
    });
    this.runs.set(sessionId, run);
    for (let waited = 0; !run.url && !run.exited && waited < 20_000; waited += 250)
      await new Promise((resolve) => setTimeout(resolve, 250));
    if (!run.url) {
      run.stop();
      this.runs.delete(sessionId);
      throw new Error("Antigravity did not show its Google sign-in link. Try again.");
    }
    return { sessionId, authorizeUrl: run.url };
  }

  /** Types the code into agy once and waits for its login. Resolves to the account's HOME and login text. */
  async complete(sessionId: string, code: string): Promise<{ home: string; login: string }> {
    const run = this.runs.get(sessionId);
    if (!run || (run.exited && !run.sent)) throw new Error("This sign-in expired. Start again.");
    if (!isAgyCode(code)) throw new Error("Paste the code Google showed.");
    if (!run.sent) {
      run.sent = true;
      run.child.stdin.write(`${code.trim()}\n`);
    }
    // A wrong code makes agy ask again instead of exiting.
    const timer = setTimeout(run.stop, 60_000);
    try {
      return { home: run.home, login: await run.done };
    } finally {
      clearTimeout(timer);
      this.runs.delete(sessionId);
    }
  }

  /** Ends a sign-in the user closed. Returns its HOME, for the caller to delete. */
  cancel(sessionId: string): string | null {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    this.runs.delete(sessionId);
    run.stop();
    return run.home;
  }

  /** Ends every sign-in, when the plugin stops. */
  stopAll(): void {
    for (const sessionId of [...this.runs.keys()]) this.cancel(sessionId);
  }
}
