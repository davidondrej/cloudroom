import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { ClaudeLoginInput, ClaudeLoginStatus } from "./login-contract.js";
import { claudeExecutable } from "./bridge/provider-maintenance.js";

const lifetime = 10 * 60_000;
const status = (
  state: ClaudeLoginStatus["state"],
  message: string | null = null,
): ClaudeLoginStatus => ({
  state,
  message,
  login_id: null,
  verification_url: null,
});

export class ClaudeLogin {
  constructor(private readonly onStop: () => void = () => {}) {}
  private value = status("missing");
  private checkedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private child: ChildProcessWithoutNullStreams | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<
    string,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
    }
  >();
  private next = 0;

  run(input: ClaudeLoginInput): Promise<ClaudeLoginStatus> {
    const result = this.queue.then(() => this.action(input));
    this.queue = result.catch(() => undefined);
    return result;
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const request of this.pending.values())
      request.reject(new Error("Claude sign-in ended."));
    this.pending.clear();
    this.onStop();
    child?.stdin.end();
    if (child) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 1000);
      timer.unref();
    }
  }

  private connectedSince: number | null = null;

  private noteLoginChange(
    previous: ClaudeLoginStatus["state"],
    next: ClaudeLoginStatus["state"],
  ) {
    const now = Date.now();
    if (next === "connected" && previous !== "connected") {
      this.connectedSince = now;
      if (this.checkedAt > 0)
        console.error(`claude login: signed in at ${new Date(now).toISOString()}`);
    } else if (previous === "connected" && next === "missing") {
      const healthyMin =
        this.connectedSince === null
          ? "unknown"
          : Math.round((now - this.connectedSince) / 60_000);
      this.connectedSince = null;
      console.error(
        `claude login: signed out at ${new Date(now).toISOString()} after ${healthyMin} min healthy`,
      );
    }
  }

  private async check(force = false) {
    if (this.child || (!force && Date.now() - this.checkedAt < 15_000))
      return this.value;
    const previous = this.value.state;
    let stdout = "";
    let code = 0;
    try {
      ({ stdout } = await promisify(execFile)(
        claudeExecutable(),
        ["auth", "status", "--json"],
        {
          cwd: os.homedir(),
          timeout: 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 65536,
        },
      ));
    } catch (error) {
      const result = error as { code?: unknown; stdout?: string };
      code = typeof result.code === "number" ? result.code : -1;
      stdout = result.stdout ?? "";
    }
    try {
      const value = JSON.parse(stdout);
      this.value =
        code === 0 && value.loggedIn === true
          ? status("connected")
          : code === 1 && value.loggedIn === false
            ? status("missing")
            : status(
                "unavailable",
                "Could not check Claude Code on this machine.",
              );
    } catch {
      this.value = status(
        "unavailable",
        "Could not check Claude Code on this machine.",
      );
    }
    this.noteLoginChange(previous, this.value.state);
    this.checkedAt = Date.now();
    return this.value;
  }

  private call(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 10_000,
  ): Promise<Record<string, unknown>> {
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Claude sign-in timed out."));
      }, timeout);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child?.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: id,
          request: { ...params, subtype: method },
        }) + "\n",
        (error) => {
          if (error) {
            this.pending.get(id)?.reject(new Error("Claude sign-in ended."));
            this.pending.delete(id);
          }
        },
      );
    });
  }

  private async action(input: ClaudeLoginInput): Promise<ClaudeLoginStatus> {
    if (input.action === "status") return this.check();
    if (input.action === "cancel") {
      if (input.requestId === this.value.login_id) {
        this.stop();
        this.checkedAt = 0;
      }
      return this.check();
    }
    if (input.action === "complete") {
      if (
        !this.child ||
        input.requestId !== this.value.login_id ||
        !input.code ||
        !input.state
      )
        return this.value;
      try {
        await this.call("claude_oauth_callback", {
          authorizationCode: input.code,
          state: input.state,
        });
      } catch {
        if (this.value.state === "waiting")
          this.value = {
            ...this.value,
            message: "Could not finish sign-in. Check the code or try again.",
          };
      }
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
    const child = spawn(
      claudeExecutable(),
      [
        "-p",
        "--no-session-persistence",
        "--tools",
        "",
        "--no-chrome",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources",
        "user",
        "--settings",
        '{"disableAllHooks":true}',
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
      ],
      { cwd: os.homedir(), stdio: "pipe" },
    );
    this.child = child;
    let buffer = "";
    const fail = () => {
      if (this.child !== child) return;
      this.value = status("error", "Claude sign-in ended. Try again.");
      this.checkedAt = Date.now();
      this.stop();
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        fail();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.type !== "control_response") continue;
          const response = value.response;
          const pending = this.pending.get(response.request_id);
          this.pending.delete(response.request_id);
          if (response.subtype === "success")
            pending?.resolve(response.response ?? {});
          else pending?.reject(new Error("Claude could not complete sign-in."));
        } catch {
          fail();
          return;
        }
      }
    });
    this.timer = setTimeout(() => {
      if (this.child === child) {
        this.value = status("expired", "Sign-in expired. Try again.");
        this.checkedAt = Date.now();
        this.stop();
      }
    }, lifetime);
    this.timer.unref();
    try {
      await this.call("initialize");
      const urls = await this.call("claude_authenticate", {
        loginWithClaudeAi: true,
      });
      const [url, manual] = [urls.automaticUrl, urls.manualUrl].map((value) => {
        const url = new URL(String(value));
        if (
          url.href.length > 8192 ||
          url.username ||
          url.password ||
          ![
            "https://claude.ai",
            "https://claude.com",
            "https://platform.claude.com",
          ].includes(url.origin) ||
          !["/oauth/authorize", "/cai/oauth/authorize"].includes(url.pathname)
        )
          throw new Error("Unexpected Claude sign-in URL.");
        return url.href;
      });
      this.value = {
        ...status("waiting"),
        login_id: input.requestId,
        verification_url: url!,
        manual_url: manual!,
      };
      void this.call("claude_oauth_wait_for_completion", {}, lifetime).then(
        () => {
          if (this.child !== child) return;
          this.value = status("connected");
          this.checkedAt = Date.now();
          this.stop();
        },
        fail,
      );
    } catch {
      fail();
    }
    return this.value;
  }
}
