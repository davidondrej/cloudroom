import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PhoneRelay } from "./phone.js";

const LINKS_KV_KEY = "mac-links";
const FALLBACK_PATH = "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin";
const JOB_OUTPUT_LIMIT = 1_000_000;
const JOB_TIMEOUT_MS = 15 * 60_000;
const JOB_KEEP_MS = 10 * 60_000;
const POLL_MS = 1_000;

const PREFLIGHT_SCRIPT = `for tool in node npm curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool was not found on this Mac. Install it (for example with Homebrew), then try again." >&2
    exit 1
  }
done`;

const computersSchema = z.object({
  selfHandle: z.string(),
  computers: z.array(
    z.object({ handle: z.string(), name: z.string(), live: z.boolean(), url: z.string() }),
  ),
});
const openSchema = z.object({
  url: z.string().url(),
  cookie: z.object({ name: z.string(), value: z.string() }),
});
const rpcSchema = z.object({ ok: z.literal(true), result: z.unknown() });
const jobSchema = z.object({ jobId: z.string() });
const jobStatusSchema = z.object({ output: z.string(), exitCode: z.number().int().nullable() });
const linkSchema = z.object({ key: z.string(), hostId: z.string().nullable() });
const linksSchema = z.record(z.string(), linkSchema);

type Links = z.infer<typeof linksSchema>;

export interface Mac {
  handle: string;
  name: string;
  online: boolean;
  self: boolean;
  hostId: string | null;
  settingUp: boolean;
}

export const setupJobInputSchema = z.object({
  command: z.array(z.string()).min(1),
  stdin: z.string(),
});
export const setupJobStatusInputSchema = z.object({ jobId: z.string(), offset: z.number().int().min(0) });

interface Job {
  output: string;
  exitCode: number | null;
  finishedAt: number | null;
}

export class SetupJobs {
  private readonly jobs = new Map<string, Job>();

  start(command: string[], stdin: string): { jobId: string } {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > JOB_KEEP_MS) this.jobs.delete(id);
    }
    if ([...this.jobs.values()].some((job) => job.exitCode === null)) {
      throw new Error("This Mac is already being set up. Try again in a minute.");
    }
    const jobId = randomUUID();
    const job: Job = { output: "", exitCode: null, finishedAt: null };
    this.jobs.set(jobId, job);
    const finish = (exitCode: number) => {
      if (job.exitCode !== null) return;
      job.exitCode = exitCode;
      job.finishedAt = Date.now();
      clearTimeout(timer);
    };
    const append = (chunk: string) => {
      if (job.output.length < JOB_OUTPUT_LIMIT) job.output += chunk;
    };
    const child = spawn(command[0]!, command.slice(1), {
      env: {
        HOME: process.env.HOME ?? homedir(),
        USER: process.env.USER ?? "",
        LOGNAME: process.env.LOGNAME ?? "",
        SHELL: process.env.SHELL ?? "/bin/sh",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        PATH: [process.env.PATH, FALLBACK_PATH].filter(Boolean).join(":"),
      },
    });
    const timer = setTimeout(() => {
      append("\nSetup timed out.\n");
      child.kill();
      finish(124);
    }, JOB_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    child.on("error", (error) => {
      append(`${error.message}\n`);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    return { jobId };
  }

  status(jobId: string, offset: number): { output: string; exitCode: number | null } {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Unknown setup job.");
    return { output: job.output.slice(offset), exitCode: job.exitCode };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function macExecutor(phone: PhoneRelay, handle: string): MachineExecutor {
  let opened: Promise<z.infer<typeof openSchema>> | null = null;
  async function rpc(method: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    opened ??= phone.call("/api/computers/open", { handle }).then((value) => openSchema.parse(value));
    const mac = await opened;
    const response = await fetch(`${mac.url}/api/v1/plugins/connect/rpc/${method}`, {
      method: "POST",
      headers: {
        cookie: `${mac.cookie.name}=${mac.cookie.value}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const body: unknown = await response.json().catch(() => null);
    const parsed = rpcSchema.safeParse(body);
    if (!response.ok || !parsed.success) {
      const error = (body as { error?: { message?: unknown } | string } | null)?.error;
      const detail = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new Error(response.status === 404 ? "Update Cloudroom on that Mac, then try again." : detail);
    }
    return parsed.data.result;
  }
  return {
    async exec({ command, stdin, timeoutMs, signal, onOutput }) {
      const { jobId } = jobSchema.parse(await rpc("runSetupJob", { command, stdin }, signal));
      const deadline = Date.now() + timeoutMs;
      let offset = 0;
      for (;;) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
        signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error("Setting up that Mac took too long.");
        const status = jobStatusSchema.parse(await rpc("setupJobStatus", { jobId, offset }, signal));
        if (status.output) {
          onOutput(status.output);
          offset += status.output.length;
        }
        if (status.exitCode !== null) return { exitCode: status.exitCode };
      }
    },
  };
}

export function registerMacs(bb: BbPluginApi, phone: PhoneRelay) {
  let queue = Promise.resolve();
  function updateLinks(change: (links: Links) => void): Promise<void> {
    const next = queue.then(async () => {
      const parsed = linksSchema.safeParse(await bb.storage.kv.get<unknown>(LINKS_KV_KEY));
      const links = parsed.success ? parsed.data : {};
      change(links);
      await bb.storage.kv.set(LINKS_KV_KEY, links);
    });
    queue = next.catch(() => undefined);
    return next;
  }

  async function list(): Promise<Mac[]> {
    const { selfHandle, computers } = computersSchema.parse(await phone.call("/api/computers", {}));
    const parsed = linksSchema.safeParse(await bb.storage.kv.get<unknown>(LINKS_KV_KEY));
    const links = parsed.success ? parsed.data : {};
    return computers.map((computer) => {
      const link = links[computer.handle];
      return {
        handle: computer.handle,
        name: computer.name,
        online: computer.live,
        self: computer.handle === selfHandle,
        hostId: link?.hostId ?? null,
        settingUp: link !== undefined && link.hostId === null,
      };
    });
  }

  bb.experimental_machines.register({
    id: "mac",
    displayName: "Your Mac",
    description: "Run threads on another Mac signed in to your Cloudroom account.",
    icon: "Laptop",
    inputs: z.object({ handle: z.string().regex(/^[a-z0-9]{1,63}$/u) }),
    availability: () =>
      phone.signedIn
        ? { status: "available" }
        : { status: "setup-required", message: "Sign in to Cloudroom to use your other Macs" },
    async create(context) {
      const { handle } = context.inputs;
      const mac = (await list()).find((candidate) => candidate.handle === handle);
      if (!mac || mac.self) return { status: "failed", message: "That Mac is not on your Cloudroom account." };
      if (!mac.online) {
        return { status: "failed", message: `${mac.name} is offline. Open Cloudroom on it, then try again.` };
      }
      await updateLinks((links) => {
        links[handle] = { key: context.key, hostId: null };
      });
      try {
        const executor = macExecutor(phone, handle);
        context.report.step(`Connecting to ${mac.name}`);
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
        if (exitCode !== 0) throw new Error(`${mac.name}: ${output.trim().slice(-2_000)}`);
        await context.checkpoint({ handle });
        const { hostId } = await bb.experimental_machines.bootstrap({
          key: context.key,
          executor,
          report: context.report,
          signal: context.signal,
        });
        await updateLinks((links) => {
          links[handle] = { key: context.key, hostId };
        });
        return { status: "created", name: mac.name, resource: { handle } };
      } catch (error) {
        await updateLinks((links) => {
          if (links[handle]?.key === context.key) delete links[handle];
        });
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async reconcileCleanup({ key }) {
      await updateLinks((links) => {
        for (const [handle, link] of Object.entries(links)) if (link.key === key) delete links[handle];
      });
      return { status: "removed" };
    },
    async remove({ hostId }) {
      await updateLinks((links) => {
        for (const [handle, link] of Object.entries(links)) if (link.hostId === hostId) delete links[handle];
      });
      return { status: "removed" };
    },
  });

  return { list };
}
