import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SSH_CONNECTION_FAILED_EXIT_CODE, sshExecutor } from "./ssh.js";

const inputsSchema = z.object({
  target: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^\s-]\S*$/u, "Enter an SSH target like user@host"),
});

const PREFLIGHT_SCRIPT = `for tool in node npm curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool was not found. Install it, or add its folder to PATH for non-interactive SSH sessions, for example in ~/.zshenv or at the top of ~/.bashrc." >&2
    exit 1
  }
done`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function machineSshPlugin(bb: BbPluginApi): Promise<void> {
  bb.experimental_machines.register({
    id: "ssh",
    displayName: "SSH",
    description:
      "Connect a machine you can reach with ssh. Cloudroom installs itself using your SSH keys.",
    icon: "Terminal",
    inputs: inputsSchema,
    async create(context) {
      const { target } = context.inputs;
      const executor = sshExecutor(target);
      try {
        context.report.step(`Connecting to ${target}`);
        let output = "";
        const { exitCode } = await executor.exec({
          command: ["sh", "-c", PREFLIGHT_SCRIPT],
          stdin: "",
          timeoutMs: 60_000,
          signal: context.signal,
          onOutput: (chunk) => {
            output += chunk;
          },
        });
        const detail = output.trim().slice(-2_000);
        if (exitCode === SSH_CONNECTION_FAILED_EXIT_CODE) {
          return {
            status: "failed",
            message: `Couldn't connect to ${target}. Make sure "ssh ${target}" works without a password prompt.\n${detail}`,
          };
        }
        if (exitCode !== 0) {
          return { status: "failed", message: `${target}: ${detail}` };
        }
        const resource = { target };
        await context.checkpoint(resource);
        await bb.experimental_machines.bootstrap({
          key: context.key,
          executor,
          report: context.report,
          signal: context.signal,
        });
        return { status: "created", name: target, resource };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async reconcileCleanup() {
      return { status: "removed" };
    },
    async remove() {
      return { status: "removed" };
    },
  });
}
