// Local terminals on Core's `cloudroom terminal` (core/src/runtime/terminal.rs): the same PTY code as Cloud
// terminals, in place of node-pty. One Core process per terminal, speaking frames on its stdin and stdout.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { coreWith } from "@cloudroom/host-workspace";
import type {
  SpawnTerminalPtyArgs,
  TerminalPtyAdapter,
  TerminalPtyDisposable,
  TerminalPtyExit,
  TerminalPtyProcess,
} from "./terminal-manager.js";

const OUTPUT = 0;
const EXIT = 1;
const INPUT = 0;
const RESIZE = 1;
const SIGNAL = 2;
/** After a hang-up, how long Core gets to end the program before it is killed itself. */
const DISPOSE_GRACE_MS = 2_000;

/** Core's terminal, or null where node-pty still runs: Windows, and a computer without a Core that has it. */
export function corePtyAdapter(): TerminalPtyAdapter | null {
  const binary = coreWith("local_terminal");
  return binary ? { spawn: (args) => spawnCorePty(binary, args) } : null;
}

function frame(kind: number, data: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

export function spawnCorePty(binary: string, args: Omit<SpawnTerminalPtyArgs, "logger">): TerminalPtyProcess {
  const program = typeof args.args === "string" ? [args.args] : args.args;
  // As node-pty does: the terminal's name and its folder.
  const env = { ...args.env, TERM: "xterm-256color", PWD: args.cwd };
  const child = spawn(
    binary,
    ["terminal", "--cwd", args.cwd, "--cols", String(args.cols), "--rows", String(args.rows), "--", args.file, ...program],
    { env, stdio: ["pipe", "pipe", "ignore"] },
  );
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: TerminalPtyExit) => void>();
  const decoder = new StringDecoder("utf8");
  let pending = Buffer.alloc(0);
  let exited = false;
  const exit = (exitCode: number | null) => {
    if (exited) return;
    exited = true;
    const rest = decoder.end();
    if (rest) for (const listener of dataListeners) listener(rest);
    for (const listener of exitListeners) listener({ exitCode });
  };

  child.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (pending.length < 5 + length) break;
      const kind = pending[0];
      const data = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      if (kind === OUTPUT) {
        const text = decoder.write(data);
        if (text) for (const listener of dataListeners) listener(text);
      } else if (kind === EXIT) {
        exit((JSON.parse(data.toString()) as { code: number | null }).code);
      }
    }
  });
  // Core itself failed to start or crashed: the terminal is over.
  child.on("error", () => exit(null));
  child.on("close", () => exit(null));
  child.stdin.on("error", () => undefined);

  const send = (kind: number, data: Buffer) => {
    if (child.stdin.writable) child.stdin.write(frame(kind, data));
  };
  const listen = <T>(set: Set<T>, listener: T): TerminalPtyDisposable => {
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  };
  return {
    dispose: () => {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        setTimeout(() => child.kill("SIGKILL"), DISPOSE_GRACE_MS).unref();
      }
    },
    kill: (signal = "SIGHUP") => send(SIGNAL, Buffer.from([constants.signals[signal]])),
    onData: (listener) => listen(dataListeners, listener),
    onExit: (listener) => listen(exitListeners, listener),
    resize: (cols, rows) => {
      const size = Buffer.alloc(4);
      size.writeUInt16BE(cols, 0);
      size.writeUInt16BE(rows, 2);
      send(RESIZE, size);
    },
    write: (data) => send(INPUT, typeof data === "string" ? Buffer.from(data) : data),
  };
}
