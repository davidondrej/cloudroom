import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  if (commandGuardEnabled) pi.on("tool_call", event => {
    if (event.toolName !== "bash") return;
    const reason = checkCommand(event.input.command);
    if (reason) return { block: true, reason };
  });
  const pending = new Map<string, (reply: { result?: string; error?: string; session_id?: string }) => void>();
  pi.registerCommand("cloudroom_context", {
    description: "Cloudroom context-only notice (v1)",
    handler: async (args) => {
      const { text } = JSON.parse(args);
      if (typeof text !== "string" || text.length > 32768) throw new Error("Invalid notice");
      pi.sendMessage({ customType: "cloudroom_notice", content: text, display: true }, { triggerTurn: false });
    },
  });
  pi.registerCommand("cloudroom_snapshot", {
    description: "Persist the native session before Cloudroom acknowledges a rewind",
    handler: async (_args, ctx) => {
      const path = ctx.sessionManager.getSessionFile();
      const header = ctx.sessionManager.getHeader();
      if (!path || !header) throw new Error("Native session is not persistent");
      // Pi defers empty forks until an assistant reply. Save its exact native entries now.
      const created = !existsSync(path);
      if (created) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, [header, ...ctx.sessionManager.getEntries()].map(entry => JSON.stringify(entry) + "\n").join(""), { flag: "wx", mode: 0o600 });
      }
      for (const target of [path, dirname(path)]) {
        const fd = openSync(target, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      if (created && (await ctx.switchSession(path)).cancelled) throw new Error("Could not reopen the persisted fork");
    },
  });
  pi.registerCommand("cloudroom_child_result", {
    description: "Cloudroom child result (v1)",
    handler: async (args) => {
      const reply = JSON.parse(args);
      if (typeof reply.id === "string") pending.get(reply.id)?.(reply);
    },
  });
  pi.on("session_shutdown", () => {
    for (const settle of pending.values()) settle({ error: "Parent session closed" });
    pending.clear();
  });
  pi.registerTool({
    name: "cloudroom_subagent",
    label: "Cloudroom child agent",
    description: "Run a child agent through Cloudroom on this machine, in the same workspace and with the same model. Returns its result and saved session ID.",
    parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 262144 }) }),
    async execute(toolCallId, { prompt }, signal) {
      signal?.throwIfAborted();
      const id = randomUUID();
      let abort: (() => void) | undefined;
      try {
        return await new Promise<{ content: { type: "text"; text: string }[]; details: { sessionId?: string } }>((resolve, reject) => {
          pending.set(id, (reply) => {
            if (reply.error) reject(new Error(reply.error));
            else resolve({ content: [{ type: "text" as const, text: reply.result || "Child finished without text" }], details: { sessionId: reply.session_id } });
          });
          abort = () => reject(new Error("Parent task interrupted; child history remains in Cloudroom"));
          signal?.addEventListener("abort", abort, { once: true });
          // RPC stdout is the existing private channel to the owning core, not an HTTP credential.
          // Pi's RPC mode points process.stdout.write at stderr, so use the stream's own write, the queue Pi's lines use.
          // The stream sends each line whole and waits out a full pipe; writing fd 1 directly can cut or split a line.
          const frame = JSON.stringify({ type: "cloudroom_child_request", id, tool_call_id: toolCallId, prompt }) + "\n";
          Writable.prototype.write.call(process.stdout, frame, (error) => { if (error) reject(error); });
        });
      } finally {
        pending.delete(id);
        if (abort) signal?.removeEventListener("abort", abort);
      }
    },
  });
}
