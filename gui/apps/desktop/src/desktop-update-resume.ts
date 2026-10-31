import { localServerFetch } from "./local-caller-auth.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DesktopAutoUpdateLogger } from "./desktop-auto-update.js";

const RESUME_FILE_NAME = "update-resume-threads.json";
const RESUME_MESSAGE = "keep working";
const RUNNING_STATUSES = new Set(["starting", "active"]);
const RESUMABLE_STATUSES = new Set(["idle", "error"]);
const STOP_TIMEOUT_MS = 30_000;
const STOP_POLL_MS = 500;

const runningThreadsSchema = z.array(z.object({ id: z.string() }));
const threadSchema = z.object({
  archivedAt: z.string().nullish(),
  deletedAt: z.string().nullish(),
  executionTarget: z.string().nullish(),
  status: z.string(),
});
const threadIdsSchema = z.array(z.string());

type Thread = z.infer<typeof threadSchema>;

export interface UpdateResumeArgs {
  logger: DesktopAutoUpdateLogger;
  serverUrl: string;
  userDataPath: string;
}

async function requestJson(
  serverUrl: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await localServerFetch(
    `${serverUrl.replace(/\/$/u, "")}/api/v1${path}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status})`);
  }
  return response.json();
}

async function getThread(serverUrl: string, id: string): Promise<Thread> {
  return threadSchema.parse(await requestJson(serverUrl, `/threads/${id}`));
}

function isLocalThread(thread: Thread): boolean {
  return (
    !thread.archivedAt &&
    !thread.deletedAt &&
    thread.executionTarget !== "cloud"
  );
}

function resumeFilePath(userDataPath: string): string {
  return join(userDataPath, RESUME_FILE_NAME);
}

async function waitUntilStopped(serverUrl: string, ids: string[]) {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  let pending = ids;
  while (pending.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    const threads = await Promise.all(
      pending.map((id) => getThread(serverUrl, id)),
    );
    pending = pending.filter(
      (_id, index) =>
        RUNNING_STATUSES.has(threads[index]!.status) ||
        threads[index]!.status === "stopping",
    );
  }
}

// The server reads this on its next start to report whether the install worked (setup-telemetry.ts).
const ATTEMPT_FILE_NAME = "update-attempt.json";

type AttemptNote = Record<string, string | boolean>;

export async function saveUpdateAttempt(dataDir: string, from: string, to: string, note: AttemptNote = {}): Promise<void> {
  await writeFile(join(dataDir, ATTEMPT_FILE_NAME), JSON.stringify({ from, to, at: Date.now(), ...note }));
}

/** Adds what happened after "Restart to update" (a quit timeout, an updater error), so a failed install says why. */
export async function noteUpdateAttempt(dataDir: string, note: AttemptNote): Promise<void> {
  const file = join(dataDir, ATTEMPT_FILE_NAME);
  const attempt = JSON.parse(await readFile(file, "utf8")) as object;
  await writeFile(file, JSON.stringify({ ...attempt, ...note }));
}

// Windows: electron-updater quits before the installer has started, so a failed start can't be caught in
// this process. Restart to update leaves this marker; still on the old version at the next launch means it failed.
const WINDOWS_UPDATE_FILE_NAME = "update-pending.json";
const windowsUpdateSchema = z.object({ from: z.string(), to: z.string() });

export async function saveWindowsUpdateMarker(userDataPath: string, from: string, to: string): Promise<void> {
  await writeFile(join(userDataPath, WINDOWS_UPDATE_FILE_NAME), JSON.stringify({ from, to }));
}

/** The version a failed Restart to update meant to install, or null. Reads the marker once. */
export async function takeFailedWindowsUpdate(userDataPath: string, currentVersion: string): Promise<string | null> {
  const file = join(userDataPath, WINDOWS_UPDATE_FILE_NAME);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  await rm(file, { force: true });
  try {
    const marker = windowsUpdateSchema.parse(JSON.parse(text));
    return marker.from === currentVersion ? marker.to : null;
  } catch {
    return null;
  }
}

export async function reportDesktopUpdate(
  serverUrl: string,
  version: string,
  installAt: number | null,
): Promise<boolean> {
  const response = await requestJson(serverUrl, "/cloudroom/desktop-update", "POST", { version, installAt });
  return z.object({ install: z.boolean() }).parse(response).install;
}

export async function runningLocalThreadIds(
  serverUrl: string,
): Promise<string[]> {
  const running = runningThreadsSchema.parse(
    await requestJson(serverUrl, "/threads/running"),
  );
  const threads = await Promise.all(
    running.map(({ id }) => getThread(serverUrl, id)),
  );
  return running
    .filter(
      (_entry, index) =>
        isLocalThread(threads[index]!) &&
        RUNNING_STATUSES.has(threads[index]!.status),
    )
    .map(({ id }) => id);
}

export async function stopThreadsForUpdate(
  args: UpdateResumeArgs,
): Promise<void> {
  const ids = await runningLocalThreadIds(args.serverUrl);
  if (ids.length === 0) {
    return;
  }
  await writeFile(resumeFilePath(args.userDataPath), JSON.stringify(ids));
  await Promise.all(
    ids.map((id) => requestJson(args.serverUrl, `/threads/${id}/stop`, "POST")),
  );
  await waitUntilStopped(args.serverUrl, ids);
  args.logger.info(`Stopped ${ids.length} Local thread(s) for the update.`);
}

export async function resumeThreadsAfterUpdate(
  args: UpdateResumeArgs,
): Promise<void> {
  const filePath = resumeFilePath(args.userDataPath);
  const saved = await readFile(filePath, "utf8").catch(() => null);
  if (saved === null) {
    return;
  }
  await rm(filePath, { force: true });
  const ids = threadIdsSchema.safeParse(JSON.parse(saved));
  if (!ids.success) {
    return;
  }
  for (const id of ids.data) {
    try {
      const thread = await getThread(args.serverUrl, id);
      if (!isLocalThread(thread) || !RESUMABLE_STATUSES.has(thread.status)) {
        continue;
      }
      await requestJson(args.serverUrl, `/threads/${id}/send`, "POST", {
        input: [{ mentions: [], text: RESUME_MESSAGE, type: "text" }],
        mode: "steer-if-active",
      });
      args.logger.info(`Resumed thread ${id} after the update.`);
    } catch (error: unknown) {
      args.logger.error(`Could not resume thread ${id} after the update: ${String(error)}`);
    }
  }
}
