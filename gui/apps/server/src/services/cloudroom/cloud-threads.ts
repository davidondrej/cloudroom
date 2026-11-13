// Cloud threads on every computer (#237, docs/scopes/cloud-threads.md "How PR 1 is built"). Every computer of an account
// follows one Cloud thread; each action happens in exactly one place. This file holds who acts: this install's tag on
// the request IDs it sends, so a turn's prompt names the computer that sent it.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readOrCreateSecretFile } from "@cloudroom/secret-storage";
import { z } from "zod";

const run = promisify(execFile);

/** The OS's own ID for this computer, so a data folder copied to another one (Migration Assistant) gets its own tag. */
async function machineId(): Promise<string> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5_000 });
      return /"IOPlatformUUID" = "([^"]+)"/.exec(stdout)?.[1] ?? "";
    }
    if (process.platform === "win32") {
      const { stdout } = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { timeout: 5_000 });
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout)?.[1] ?? "";
    }
    return (await readFile("/etc/machine-id", "utf8").catch(() => readFile("/var/lib/dbus/machine-id", "utf8"))).trim();
  } catch { return ""; }
}

/** This install's tag: 12 hex characters of the SHA-256 of its telemetry ID and the computer's own ID. It's saved with
 *  that computer ID, so a run where the OS can't say (an `ioreg` timeout) keeps it, and a data folder copied to another
 *  computer gets its own. */
export async function readInstallTag(dataDir: string, machine: () => Promise<string> = machineId): Promise<string> {
  const path = join(dataDir, "cloudroom-install-tag.json");
  const [install, computer, saved] = await Promise.all([
    readOrCreateSecretFile({ bytes: 16, dataDir, encoding: "hex", fileName: "telemetry-id" }).catch(() => dataDir), machine().catch(() => ""),
    readFile(path, "utf8").then((text) => z.object({ machine: z.string(), tag: z.string().regex(/^[a-f0-9]{12}$/) }).parse(JSON.parse(text)), () => null),
  ]);
  // Saved even when the OS couldn't say, so the next run keeps it; the first run that can say fills the ID in.
  if (saved && (!computer || !saved.machine || saved.machine === computer)) {
    if (computer && !saved.machine) await writeFile(path, JSON.stringify({ machine: computer, tag: saved.tag }), { mode: 0o600 }).catch(() => {});
    return saved.tag;
  }
  const tag = createHash("sha256").update(`${install}:${computer}`).digest("hex").slice(0, 12);
  await writeFile(path, JSON.stringify({ machine: computer, tag }), { mode: 0o600 }).catch(() => {});
  return tag;
}

const tags = new Map<string, Promise<string>>();
export function installTag(dataDir: string): Promise<string> {
  let tag = tags.get(dataDir);
  if (!tag) tags.set(dataDir, tag = readInstallTag(dataDir));
  return tag;
}

/** Home for a thread this computer adopted from another computer's start, until a tagged prompt names one: never this
 *  computer (no install's tag has this form). */
export const ELSEWHERE = "elsewhere";

const APP_ID = /^app_([a-f0-9]{12})_/;
/** A prompt, steer, edit or rewind this install sends: `app_<tag>_<id>`, within Core's 64 characters. The same raw ID
 *  always makes the same request ID, so a retry stays one request. */
export function appRequestId(tag: string, raw: string): string {
  if (raw.startsWith(`app_${tag}_`)) return raw;
  const id = `app_${tag}_${/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw.replace(/-/g, "") : raw}`;
  return id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id) ? id : `app_${tag}_${createHash("sha256").update(raw).digest("hex").slice(0, 47)}`;
}

/** The install that sent a request, or null for one no app sent (phone, loop, `tell`, Core's own, older apps). */
export function tagOf(requestId: string | null | undefined): string | null {
  return APP_ID.exec(requestId ?? "")?.[1] ?? null;
}

/** The thread ID every computer gives a session sharing another thread's sandbox, so `room-cli` names the same one. */
export function sharedChildId(coreUrl: string, session: string): string {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz", hash = createHash("sha256").update(`${coreUrl}:${session}`).digest();
  return `thr_${Array.from(hash.subarray(0, 10), (byte) => alphabet[byte % 32]).join("")}`;
}

const stateSchema = z.object({ session: z.string(), actFrom: z.number().int().nullable(), home: z.string().nullable(), from: z.string().nullable().default(null), cascade: z.array(z.string()).optional(), before: z.array(z.string()).optional(), adopted: z.boolean().optional(),
  /** History read from the website while the sandbox slept moved the shown cursor; the stream acts from `from`. */
  history: z.object({ session: z.string(), from: z.number().int().nonnegative(), until: z.number().int().nonnegative().optional() }).optional() });
export type CloudThreadState = z.infer<typeof stateSchema>;

/** Per Cloud thread, in the data folder: the Core session it follows; its action floor (`actFrom`: records up to it
 *  are shown, never acted on; null until Core's `last_sequence` is read); its home's tag (null: no app prompt seen);
 *  the thread whose home it takes until then (a website child or launch); the children an agent's archive left for
 *  home to archive once the website has the parent archived; and the sessions it left, never followed back.
 *  Written whole, one write at a time. */
export class CloudThreadStates {
  private readonly states = new Map<string, CloudThreadState>();
  private writing: Promise<void> | null = null;
  private dirty = false;
  readonly ready: Promise<void>;
  constructor(private readonly path: string) {
    this.ready = readFile(path, "utf8").then((text) => {
      for (const [id, state] of Object.entries(z.record(z.string(), z.unknown()).parse(JSON.parse(text)))) {
        const parsed = stateSchema.safeParse(state);
        if (parsed.success && !this.states.has(id)) this.states.set(id, parsed.data);
      }
    }, () => {});
  }
  get(threadId: string): CloudThreadState | undefined { return this.states.get(threadId); }
  set(threadId: string, state: CloudThreadState | null): void {
    if (state) this.states.set(threadId, state);
    else if (!this.states.delete(threadId)) return;
    this.dirty = true;
    this.flush();
  }
  private flush(): void {
    if (this.writing) return;
    this.writing = this.ready.then(async () => {
      this.dirty = false;
      const temporary = `${this.path}.${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(Object.fromEntries(this.states)), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } catch { /* The next change writes it again. */ } finally { await rm(temporary, { force: true }); }
    }).finally(() => { this.writing = null; if (this.dirty) this.flush(); });
  }
}
