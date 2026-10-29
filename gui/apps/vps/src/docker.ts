// Each Cloud thread's sandbox is one Docker container on this VPS, run from Cloudroom's sandbox image (ADR 0319).
// This talks to the Docker Engine API on its socket; the website drives it through api.ts.
import { request } from "node:http";
import { readFile, statfs } from "node:fs/promises";

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const LABEL = "cloudroom.sandbox";
/** Core's port inside every sandbox, published on the host's loopback only. */
const CORE_PORT = "9840/tcp";
const PORTS = { first: 20_000, last: 29_999 };
const NAME = /^room-[a-z0-9-]{1,57}$/;
const SHM_BYTES = 1024 ** 3;
// When the VPS runs out of memory, Linux kills agents' processes before this service (-500, set by the installer).
// The process cap stops a runaway agent from exhausting the VPS's process table.
const OOM_SCORE_ADJ = 500;
const PIDS_LIMIT = 8192;
// All sandboxes share this systemd slice; the installer caps it at 90% of the VPS's memory, so together they can't
// starve the VPS itself. Only with Docker's systemd cgroup driver (the default on current Debian and Ubuntu).
const SLICE = "cloudroom.slice";

export type Status = "running" | "stopped" | "missing";
export type ExecResult = { exitCode: number | null; stdout: string | null; timedOut: boolean };
type Response = { status: number; body: Buffer };
type Container = { Id: string; Names: string[]; State: string; Labels: Record<string, string> };

/** One Docker Engine API call. `raw` sends a Buffer as-is (tar archives). */
function api(method: string, path: string, body?: unknown, options: { raw?: boolean; timeoutMs?: number } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : options.raw ? (body as Buffer) : Buffer.from(JSON.stringify(body));
    const req = request({ socketPath: SOCKET, method, path, headers: payload ? { "content-type": options.raw ? "application/x-tar" : "application/json", "content-length": payload.length } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    if (options.timeoutMs) req.setTimeout(options.timeoutMs, () => req.destroy(new TimeoutError()));
    req.on("error", reject);
    req.end(payload);
  });
}
class TimeoutError extends Error {}

async function ok(response: Promise<Response>, what: string): Promise<Response> {
  const result = await response;
  if (result.status >= 300) throw new Error(`${what} failed (${result.status}): ${result.body.toString().slice(0, 500)}`);
  return result;
}

const json = <T>(response: Response) => JSON.parse(response.body.toString()) as T;
const named = (name: string) => {
  if (!NAME.test(name)) throw new Error("Invalid sandbox name");
  return name;
};

async function containers(): Promise<Container[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
  return json<Container[]>(await ok(api("GET", `/containers/json?all=1&filters=${filters}`), "List"));
}

/** The loopback ports sandboxes publish Core on. Only these reach the relay (tunnel.ts). */
export async function sandboxPorts(): Promise<Set<number>> {
  return new Set((await containers()).map((each) => Number(each.Labels["cloudroom.port"])).filter(Number.isInteger));
}

export async function status(name: string): Promise<Status> {
  const found = await api("GET", `/containers/${named(name)}/json`);
  if (found.status === 404) return "missing";
  return json<{ State: { Running: boolean } }>(await ok(Promise.resolve(found), "Inspect")).State.Running ? "running" : "stopped";
}

export async function list(prefix: string): Promise<{ name: string; status: Status }[]> {
  return (await containers())
    .map((each) => ({ name: each.Names[0]?.replace(/^\//, "") ?? "", status: each.State === "running" ? ("running" as const) : ("stopped" as const) }))
    .filter((each) => each.name.startsWith(prefix));
}

// Creates are one at a time, so two never take the same port.
let creating: Promise<unknown> = Promise.resolve();

/** Creates a stopped sandbox from `image`. An existing one is kept. A missing image starts downloading, and the newest
 *  image of the same name already here is used meanwhile; the very first one has to wait for its download. */
export function create(name: string, image: string): Promise<{ created: boolean }> {
  const next = creating.then(async () => {
    if ((await status(named(name))) !== "missing") return { created: false };
    const used = await sandboxPorts();
    let port = PORTS.first;
    while (used.has(port)) port += 1;
    if (port > PORTS.last) throw new Error("This VPS has no free sandbox ports left.");
    const memory = Math.floor((await memoryInfo()).total * 0.9);
    const body = {
      Image: await usableImage(image),
      Cmd: ["sleep", "infinity"],
      Labels: { [LABEL]: "true", "cloudroom.port": String(port) },
      ExposedPorts: { [CORE_PORT]: {} },
      HostConfig: {
        Init: true,
        PortBindings: { [CORE_PORT]: [{ HostIp: "127.0.0.1", HostPort: String(port) }] },
        ShmSize: SHM_BYTES,
        Memory: memory,
        OomScoreAdj: OOM_SCORE_ADJ,
        PidsLimit: PIDS_LIMIT,
        ...((await hostInfo()).CgroupDriver === "systemd" ? { CgroupParent: SLICE } : {}),
        RestartPolicy: { Name: "no" },
      },
    };
    await ok(api("POST", `/containers/create?name=${name}`, body), "Create");
    return { created: true };
  });
  creating = next.catch(() => {});
  return next;
}

async function usableImage(image: string): Promise<string> {
  if ((await api("GET", `/images/${encodeURIComponent(image)}/json`)).status === 200) return image;
  const pulling = pull(image);
  const repository = image.replace(/:[^/:]+$/, "");
  const filters = encodeURIComponent(JSON.stringify({ reference: [repository] }));
  const local = json<{ Id: string; Created: number; RepoTags: string[] | null }[]>(await ok(api("GET", `/images/json?filters=${filters}`), "Images"));
  const newest = local.sort((a, b) => b.Created - a.Created)[0];
  if (newest) {
    pulling.catch((error: unknown) => console.error(JSON.stringify({ pull_failed: String(error) })));
    return newest.RepoTags?.[0] ?? newest.Id;
  }
  await pulling;
  return image;
}

const pulls = new Map<string, Promise<void>>();
/** Downloads an image once at a time. */
export function pull(image: string): Promise<void> {
  const existing = pulls.get(image);
  if (existing) return existing;
  const [, repository, tag] = /^(.+?)(?::([^/:]+))?$/.exec(image) ?? [];
  const pending = ok(api("POST", `/images/create?fromImage=${encodeURIComponent(repository ?? image)}&tag=${encodeURIComponent(tag ?? "latest")}`), "Pull")
    .then((result) => {
      // The pull streams progress as JSON lines; an error arrives as a line, not a status code.
      const failed = result.body.toString().split("\n").find((line) => line.includes('"error"'));
      if (failed) throw new Error(`Pull failed: ${failed.slice(0, 500)}`);
    })
    .finally(() => pulls.delete(image));
  pulls.set(image, pending);
  return pending;
}

/** Starts the sandbox if needed and returns the host port its Core listens on. */
export async function start(name: string): Promise<number> {
  const found = await ok(api("GET", `/containers/${named(name)}/json`), "Inspect");
  const info = json<{ State: { Running: boolean }; Config: { Labels: Record<string, string> } }>(found);
  if (!info.State.Running) await ok(api("POST", `/containers/${name}/start`), "Start");
  return Number(info.Config.Labels["cloudroom.port"]);
}

export async function stop(name: string): Promise<void> {
  const result = await api("POST", `/containers/${named(name)}/stop?t=10`);
  if (result.status !== 304) await ok(Promise.resolve(result), "Stop");
}

export async function remove(name: string): Promise<void> {
  const result = await api("DELETE", `/containers/${named(name)}?force=1&v=1`);
  if (result.status !== 404) await ok(Promise.resolve(result), "Remove");
}

/** Runs a command as root with `sudo`, else as the agent. Output is stdout and stderr together. */
export async function exec(name: string, command: string, options: { sudo?: boolean; detached?: boolean; timeoutMs?: number } = {}): Promise<ExecResult> {
  const created = json<{ Id: string }>(await ok(api("POST", `/containers/${named(name)}/exec`, {
    Cmd: ["bash", "-c", command],
    User: options.sudo ? "root" : "cloudroom-agent",
    AttachStdout: !options.detached,
    AttachStderr: !options.detached,
  }), "Exec"));
  if (options.detached) {
    await ok(api("POST", `/exec/${created.Id}/start`, { Detach: true, Tty: false }), "Exec start");
    return { exitCode: null, stdout: null, timedOut: false };
  }
  try {
    const output = await ok(api("POST", `/exec/${created.Id}/start`, { Detach: false, Tty: false }, { timeoutMs: options.timeoutMs ?? 30_000 }), "Exec start");
    const result = json<{ ExitCode: number | null }>(await ok(api("GET", `/exec/${created.Id}/json`), "Exec result"));
    return { exitCode: result.ExitCode, stdout: demux(output.body), timedOut: false };
  } catch (error) {
    if (error instanceof TimeoutError) return { exitCode: null, stdout: null, timedOut: true };
    throw error;
  }
}

/** Docker frames non-TTY output: 1 byte stream, 3 zero bytes, 4 bytes length, then the bytes. */
function demux(raw: Buffer): string {
  const parts: Buffer[] = [];
  for (let at = 0; at + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(at + 4);
    parts.push(raw.subarray(at + 8, at + 8 + size));
    at += 8 + size;
  }
  return Buffer.concat(parts).toString();
}

/** Writes files as root, mode 0600; the website moves them into place with `install` (web/lib/sandboxes.ts putAll). */
export async function writeFiles(name: string, files: { path: string; content: Buffer }[]): Promise<void> {
  await ok(api("PUT", `/containers/${named(name)}/archive?path=/`, tar(files), { raw: true }), "Write files");
}

/** Reads one regular file, or null when it does not exist. Docker sends it as a tar archive. */
export async function readSandboxFile(name: string, path: string): Promise<Buffer | null> {
  const result = await api("GET", `/containers/${named(name)}/archive?path=${encodeURIComponent(path)}`);
  if (result.status === 404) return null;
  const body = (await ok(Promise.resolve(result), "Read file")).body;
  for (let at = 0; at + 512 <= body.length; ) {
    const type = body.toString("latin1", at + 156, at + 157);
    const size = parseInt(body.toString("latin1", at + 124, at + 136).replace(/\0/g, "").trim() || "0", 8);
    // Extended headers (x, g) describe the next entry; skip them.
    if (type === "x" || type === "g") { at += 512 + Math.ceil(size / 512) * 512; continue; }
    return type === "0" || type === "\0" ? body.subarray(at + 512, at + 512 + size) : null;
  }
  return null;
}

/** A minimal ustar archive of regular files, owned by root with mode 0600. Docker makes the parent folders. */
function tar(files: { path: string; content: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { path, content } of files) {
    const full = path.replace(/^\/+/, "");
    const cut = Buffer.byteLength(full) <= 100 ? -1 : full.lastIndexOf("/", 155);
    const [prefix, file] = cut < 0 ? ["", full] : [full.slice(0, cut), full.slice(cut + 1)];
    if (Buffer.byteLength(file) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Path too long: ${path}`);
    const header = Buffer.alloc(512);
    const field = (value: string, offset: number, length: number) => header.write(value, offset, length, "latin1");
    field(file, 0, 100);
    field("0000600\0", 100, 8);
    field("0000000\0", 108, 8);
    field("0000000\0", 116, 8);
    field(content.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    field(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
    field("        ", 148, 8);
    field("0", 156, 1);
    field("ustar\u000000", 257, 8);
    field(prefix, 345, 155);
    let sum = 0;
    for (const byte of header) sum += byte;
    field(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

async function memoryInfo(): Promise<{ used: number; total: number }> {
  const text = await readFile("/proc/meminfo", "utf8");
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0) * 1024;
  const total = kb("MemTotal");
  return { used: total - kb("MemAvailable"), total };
}

// CPU over the last minute and memory over the last 2, from /proc samples every 5 s. /proc shows the whole VPS, even
// from a container.
const samples: { busy: number; total: number }[] = [];
const memorySamples: number[] = [];
async function sample(): Promise<void> {
  const [, ...fields] = (await readFile("/proc/stat", "utf8")).split("\n")[0]!.trim().split(/\s+/);
  const values = fields.map(Number);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  samples.push({ busy: total - idle, total });
  if (samples.length > 13) samples.shift();
  memorySamples.push((await memoryInfo()).used);
  if (memorySamples.length > 24) memorySamples.shift();
}
void sample();
setInterval(() => void sample().catch(() => {}), 5_000).unref();

/** What the website checks before it starts a thread here (ADR 0319). Disk is the folder Docker and this service share. */
// Docker's view of the host: its OS ("Ubuntu 24.04.5 LTS", for its logo in Settings; this service's own container
// would report the image's) and cgroup driver. It never changes while the service runs.
type HostInfo = { OperatingSystem?: string; CgroupDriver?: string };
let host: Promise<HostInfo> | undefined;
const hostInfo = (): Promise<HostInfo> => (host ??= ok(api("GET", "/info"), "Info").then((info) => json<HostInfo>(info)).catch(() => {
  host = undefined;
  return {} as HostInfo;
}));

export async function health() {
  const first = samples[0], last = samples[samples.length - 1];
  const cpu = first && last && last.total > first.total ? (last.busy - first.busy) / (last.total - first.total) : 0;
  const disk = await statfs(process.env.DATA_DIR ?? "/data");
  const running = (await containers()).filter((each) => each.State === "running").length;
  const memory = await memoryInfo();
  return {
    cpu: Math.round(cpu * 1000) / 1000,
    // `sustained`: the least used in the last 2 minutes, so a short spike never reads as a full VPS.
    memory: { ...memory, sustained: memorySamples.length >= 24 ? Math.min(...memorySamples) : 0 },
    disk: { used: (disk.blocks - disk.bavail) * disk.bsize, total: disk.blocks * disk.bsize },
    running,
    os: (await hostInfo()).OperatingSystem ?? null,
  };
}
