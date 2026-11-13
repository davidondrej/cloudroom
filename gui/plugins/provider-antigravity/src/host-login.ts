import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AntigravityLoginInput,
  AntigravityLoginStatus,
} from "./login-contract.js";

const LIFETIME_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 15_000;
const CHECK_TTL_MS = 15_000;
const LINK_TIMEOUT_MS = 20_000;
const CODE_TIMEOUT_MS = 30_000;
// ACP's reserved auth-required error.
const AUTH_REQUIRED_CODE = -32000;
/**
 * The CLI opens a browser itself unless it runs in an SSH session, where it
 * only prints the link. Cloudroom opens the link where the user is (this may
 * be another machine, or a phone), so the login always runs the SSH way.
 */
const PRINT_LINK_ENV = { SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22" };
const SIGN_IN_LINK = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/u;

const status = (
  state: AntigravityLoginStatus["state"],
  message: string | null = null,
): AntigravityLoginStatus => ({
  state,
  message,
  login_id: null,
  verification_url: null,
});

/** `agy` on PATH, or where Google's installer puts it. */
export function antigravityExecutable(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  const names = process.platform === "win32" ? ["agy.exe", "agy.cmd"] : ["agy"];
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  return "agy";
}

type AcpAnswer =
  | { ok: true }
  | { ok: false; code: number | null; missing: boolean };

/**
 * One ACP request to a short-lived `agy acp`. Antigravity keeps its Google
 * login in the system keyring, so only the CLI can say whether it is signed
 * in: `session/list` succeeds when it is, and is refused at once when it is
 * not. Nothing is created and no browser opens.
 */
function askAcp(executable: string, method: string): Promise<AcpAnswer> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, ["acp"], { cwd: os.tmpdir(), stdio: "pipe" });
    } catch {
      resolve({ ok: false, code: null, missing: true });
      return;
    }
    let settled = false;
    const finish = (answer: AcpAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
      child.stdin.end();
      child.kill("SIGTERM");
    };
    const timer = setTimeout(
      () => finish({ ok: false, code: null, missing: false }),
      CHECK_TIMEOUT_MS,
    );
    timer.unref();
    const send = (message: object) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish({ ok: false, code: null, missing: error.code === "ENOENT" }),
    );
    child.once("exit", () => finish({ ok: false, code: null, missing: false }));
    child.stdin.on("error", () => undefined);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let at; (at = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message: {
          id?: unknown;
          result?: unknown;
          error?: { code?: unknown };
        };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) send({ id: 2, method, params: {} });
        if (message.id === 2) {
          const code = message.error?.code;
          finish(
            message.result !== undefined
              ? { ok: true }
              : {
                  ok: false,
                  code: typeof code === "number" ? code : null,
                  missing: false,
                },
          );
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
  });
}

function signInLink(text: string): string | null {
  const match = SIGN_IN_LINK.exec(text)?.[0];
  if (!match || match.length > 8192) return null;
  try {
    const url = new URL(match);
    return url.origin === "https://accounts.google.com" &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Google sign-in for the Antigravity CLI on this machine, run as `agy acp --login`. */
export class AntigravityLogin {
  constructor(
    private readonly onStop: () => void = () => {},
    private readonly executable: () => string = antigravityExecutable,
  ) {}
  private value = status("missing");
  private checkedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private child: ChildProcessWithoutNullStreams | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ended: Promise<void> = Promise.resolve();

  run(input: AntigravityLoginInput): Promise<AntigravityLoginStatus> {
    const result = this.queue.then(() => this.action(input));
    this.queue = result.catch(() => undefined);
    return result;
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onStop();
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 1000);
    timer.unref();
  }

  private async check(force = false): Promise<AntigravityLoginStatus> {
    if (this.child || (!force && Date.now() - this.checkedAt < CHECK_TTL_MS))
      return this.value;
    const answer = await askAcp(this.executable(), "session/list");
    this.value = answer.ok
      ? status("connected")
      : answer.code === AUTH_REQUIRED_CODE
        ? status("missing")
        : status(
            "unavailable",
            answer.missing
              ? "Antigravity is not installed on this machine."
              : "Could not check Antigravity on this machine.",
          );
    this.checkedAt = Date.now();
    return this.value;
  }

  private async action(
    input: AntigravityLoginInput,
  ): Promise<AntigravityLoginStatus> {
    if (input.action === "status") return this.check();
    if (input.action === "cancel") {
      if (input.requestId === this.value.login_id) {
        this.stop();
        this.checkedAt = 0;
      }
      return this.check();
    }
    if (input.action === "logout") {
      this.stop();
      const answer = await askAcp(this.executable(), "logout");
      if (!answer.ok && answer.code !== AUTH_REQUIRED_CODE)
        return {
          ...(await this.check(true)),
          message: "Antigravity could not sign out. Run /logout in `agy`.",
        };
      return this.check(true);
    }
    if (input.action === "complete") {
      const child = this.child;
      // One line only: the CLI reads the code up to Enter.
      const code = input.code?.trim().split(/\s/u)[0];
      if (!child || input.requestId !== this.value.login_id || !code)
        return this.value;
      child.stdin.write(`${code}\n`);
      await Promise.race([
        this.ended,
        new Promise((resolve) => setTimeout(resolve, CODE_TIMEOUT_MS).unref()),
      ]);
      return this.value;
    }
    await this.check(true);
    if (
      this.child ||
      this.value.state === "connected" ||
      this.value.state === "unavailable" ||
      !input.requestId
    )
      return this.value;
    return this.start(input.requestId);
  }

  private async start(requestId: string): Promise<AntigravityLoginStatus> {
    const child = spawn(this.executable(), ["acp", "--login"], {
      cwd: os.homedir(),
      env: { ...process.env, ...PRINT_LINK_ENV },
      stdio: "pipe",
    });
    this.child = child;
    this.value = { ...status("waiting"), login_id: requestId };
    let output = "";
    let linked: () => void = () => {};
    const link = new Promise<void>((resolve) => {
      linked = resolve;
    });
    let finished: () => void = () => {};
    this.ended = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const end = (next: AntigravityLoginStatus) => {
      if (this.child !== child) return;
      this.value = next;
      this.checkedAt = next.state === "connected" ? Date.now() : 0;
      this.stop();
      linked();
      finished();
    };
    const failed = () =>
      end(
        status(
          "error",
          /couldn't log in/iu.test(output)
            ? "Google did not accept that code. Start the sign-in again."
            : "Antigravity sign-in ended. Try again.",
        ),
      );
    child.once("error", failed);
    child.once("exit", (code) =>
      code === 0 ? end(status("connected")) : failed(),
    );
    child.stdin.on("error", () => undefined);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = (output + chunk).slice(-64 * 1024);
      if (this.child !== child || this.value.verification_url) return;
      const url = signInLink(output);
      if (!url) return;
      this.value = { ...this.value, verification_url: url };
      linked();
    });
    this.timer = setTimeout(
      () => end(status("expired", "Sign-in expired. Try again.")),
      LIFETIME_MS,
    );
    this.timer.unref();
    await Promise.race([
      link,
      new Promise((resolve) => setTimeout(resolve, LINK_TIMEOUT_MS).unref()),
    ]);
    if (this.child === child && !this.value.verification_url)
      end(
        status("error", "Antigravity did not give a sign-in link. Try again."),
      );
    return this.value;
  }
}
