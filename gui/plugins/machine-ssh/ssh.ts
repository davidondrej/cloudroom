import { spawn } from "node:child_process";
import type { MachineExecutor } from "@get-bb/plugin-sdk";

export const SSH_CONNECTION_FAILED_EXIT_CODE = 255;

const SSH_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "RemoteCommand=none",
];

const FALLBACK_PATH = "/opt/homebrew/bin:/usr/local/bin";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function remoteCommand(command: readonly string[]): string {
  return `export PATH="$PATH:${FALLBACK_PATH}"; exec ${command.map(shellQuote).join(" ")}`;
}

export function sshExecutor(target: string): MachineExecutor {
  return {
    exec({ command, timeoutMs, signal, stdin, onOutput }) {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const child = spawn("ssh", [
          ...SSH_OPTIONS,
          "--",
          target,
          remoteCommand(command),
        ]);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
        const abort = () => child.kill();
        signal.addEventListener("abort", abort, { once: true });
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        };
        child.stdout.setEncoding("utf8").on("data", onOutput);
        child.stderr.setEncoding("utf8").on("data", onOutput);
        child.stdin.on("error", () => {});
        child.stdin.end(stdin);
        child.on("error", (error) => {
          finish();
          reject(error);
        });
        child.on("close", (exitCode) => {
          finish();
          if (signal.aborted) reject(signal.reason);
          else if (timedOut)
            reject(new Error(`SSH command timed out after ${timeoutMs} ms`));
          else resolve({ exitCode: exitCode ?? 1 });
        });
      });
    },
  };
}
