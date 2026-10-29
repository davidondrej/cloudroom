import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { replySchema } from "./contract.js";

// `room-cli gpu` in Local threads (ADR 0333, docs/scopes/gpus.md). The website runs the whole tool (web/lib/gpu.ts);
// this only passes the words on, prints the answers, and copies files. The app's server shows the approval card and
// sends the user's answer itself (apps/server/src/services/cloudroom/gpu.ts). Core's `room-cli gpu` does the same for
// Cloud threads.

/** Plugin commands end after 65 minutes, so a long command's output stops here with a way to keep following it. */
const MAX_RUN_MS = 55 * 60_000, MAX_OUTPUT = 1_000_000;

// Files go straight between this computer and the GPU box through signed links, never through Cloudroom.
const UPLOAD = 'COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TGZ" -C "$(dirname "$SRC")" "$(basename "$SRC")" && curl -sSf -X POST -F "file=@$TGZ" "$URL" >/dev/null; code=$?; rm -f "$TGZ"; exit $code';
const DOWNLOAD = 'mkdir -p "$DIR" && curl -sSf "$URL" | tar -xzf - -C "$DIR"';

function shell(script: string, cwd: string, env: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("sh", ["-c", script], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`))));
  });
}
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

export default async function gpuPlugin(bb: BbPluginApi) {
  const website = async (input: { argv: string[]; thread?: string }) => bb.sdk.cloudroom.gpu(input);
  async function runCli(argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> {
    const cwd = ctx.cwd ?? process.cwd(), started = Date.now();
    let stdout = "";
    let reply = replySchema.parse(await website({ argv, thread: ctx.threadId }));
    for (;;) {
      // Plugin output arrives all at once at the end, so keep only its last MAX_OUTPUT characters.
      stdout = (stdout + reply.output).slice(-MAX_OUTPUT);
      try {
        const TGZ = join(tmpdir(), `cloudroom-gpu-${randomBytes(6).toString("hex")}.tgz`);
        if (reply.upload) await shell(UPLOAD, cwd, { SRC: reply.upload.path, URL: reply.upload.url, TGZ });
        if (reply.download) await shell(DOWNLOAD, cwd, { DIR: reply.download.dir, URL: reply.download.url });
      } catch (error) {
        return { exitCode: 1, stdout, stderr: `Copying failed: ${error instanceof Error ? error.message : String(error)}\n` };
      }
      if (!reply.next) return { exitCode: reply.exit_code, stdout };
      if (ctx.signal?.aborted) return { exitCode: 130, stdout };
      if (Date.now() - started > MAX_RUN_MS && reply.next.argv[0] === "logs") {
        const [, id, command] = reply.next.argv;
        return { exitCode: 0, stdout: `${stdout}\n(Still running. Keep following with: room-cli gpu logs ${id} ${command} --follow)\n` };
      }
      await sleep(reply.next.after_ms, ctx.signal);
      reply = replySchema.parse(await website({ argv: reply.next.argv, thread: ctx.threadId }));
    }
  }

  bb.agents.configure(() => ({ tools: [], skills: ["gpu"] }));
  bb.cli.register({
    name: "gpu",
    summary: "Rent a GPU box for heavy GPU work, after the user approves its Cloud Credits (beta)",
    commands: [
      { name: "list", summary: "GPU types, Cloud Credits per hour, and how many are free", usage: "room-cli gpu list" },
      { name: "start", summary: "Ask the user to approve a GPU session, then start it", usage: "room-cli gpu start --gpu TYPE --purpose TEXT [--count N] [--hours H]" },
      { name: "run", summary: "Run a shell command on the GPU box", usage: "room-cli gpu run ID [--cwd DIR] [--detach] -- COMMAND" },
      { name: "push", summary: "Copy a file or folder to the GPU box", usage: "room-cli gpu push ID LOCAL_PATH [REMOTE_DIR]" },
      { name: "pull", summary: "Copy a file or folder from the GPU box", usage: "room-cli gpu pull ID REMOTE_PATH [LOCAL_DIR]" },
      { name: "stop", summary: "Delete the GPU box", usage: "room-cli gpu stop ID" },
    ],
    async run(argv, ctx) {
      try {
        return await runCli(argv, ctx);
      } catch (error) {
        return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    },
  });
}
