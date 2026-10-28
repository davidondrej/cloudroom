import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { HOST_ARTIFACT_MAX_BYTES } from "@cloudroom/host-daemon-contract";
import { runGit } from "@cloudroom/host-workspace";
import { userExecutableProcessOptions } from "../user-executable-env.js";
import { requireResolvedWorkspaceForCommand } from "../workspace-resolution.js";
import type {
  CommandDispatchOptions,
  CommandOf,
} from "../command-dispatch-support.js";

const excluded = new Set([
  ".git",
  "node_modules",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".turbo",
  ".pnpm-store",
  "target",
  ".DS_Store",
  ".cloudroom",
  ".cloudroom-imported",
]);
type Source = {
  path: string;
  source: string;
  size: number;
  sha256: string;
  kind: "native" | "lineage" | "context" | "project" | "attachment";
  executable: boolean;
  frozen?: string;
  symlink?: boolean;
};
type Capture = { nativeId: string; files: Source[]; omitted: string[] };
const execFileAsync = promisify(execFile);
const signature = (s: Awaited<ReturnType<typeof stat>>) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function nativePath(
  harness: string,
  threadId: string,
  nativeId: string,
): Promise<string> {
  if (harness === "pi") {
    const root = resolve(
      process.env.BB_PI_BRIDGE_SESSION_DIR ||
        join(homedir(), ".bb", "pi-bridge-sessions"),
    );
    for (const id of [nativeId, threadId]) {
      const path = join(root, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
      if (
        await stat(path).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        return path;
    }
  } else if (harness === "claude-code") {
    const root = join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      "projects",
    );
    const found: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(
      () => [],
    )) {
      const path = join(root, entry.name, `${nativeId}.jsonl`);
      if (
        entry.isDirectory() &&
        (await stat(path).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
        found.push(path);
    }
    if (found.length === 1) return found[0]!;
  } else if (harness === "cursor") {
    const path = join(
      homedir(),
      ".cursor",
      "acp-sessions",
      nativeId,
      "meta.json",
    );
    if (
      /^[a-f0-9-]{36}$/.test(nativeId) &&
      (await stat(path).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      return path;
  } else {
    const found = await codexRollouts((name) =>
      name.endsWith(`-${nativeId}.jsonl`),
    );
    if (found.length === 1) return found[0]!;
  }
  throw new Error(
    `Saved ${harness} conversation is unavailable for ${threadId}; local history was not changed`,
  );
}

/** Codex rollout files whose names match, searched in Codex's order: active sessions, then archived ones. */
async function codexRollouts(match: (name: string) => boolean) {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const found: string[] = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && match(entry.name)) found.push(path);
    }
  }
  for (const directory of ["sessions", "archived_sessions"]) {
    await visit(join(home, directory)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return found;
}

const captures = new Map<string, Promise<unknown>>();
export function captureTeleport(
  command: CommandOf<"thread.teleport">,
  options: CommandDispatchOptions,
) {
  const key = `${command.threadId}:${command.transferId}`;
  const work = (captures.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => runCapture(command, options));
  captures.set(key, work);
  const release = () => {
    if (captures.get(key) === work) captures.delete(key);
  };
  void work.then(release, release);
  return work;
}

async function runCapture(
  command: CommandOf<"thread.teleport">,
  options: CommandDispatchOptions,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(command.threadId))
    throw new Error("Invalid thread identity");
  const root = join(
    options.threadStorageRootPath,
    command.threadId,
    "teleport",
    command.transferId,
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const capturePath = join(root, "capture.json");
  if (command.action === "import") {
    const session = command.sessions?.[0];
    if (session?.harness !== "opencode" || !command.file)
      throw new Error("Unsupported Teleport import");
    await runOpenCode(
      ["import", command.file],
      await realpath(command.workspaceContext.workspacePath),
      options,
    );
    return { nativeId: session.nativeId };
  }
  if (command.action === "read") {
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as Capture;
    const index = command.index;
    const file = index === undefined ? undefined : capture.files[index];
    if (!file) throw new Error("Transfer file does not exist");
    if (!file.frozen) {
      const frozen = join(root, `file-${index}`);
      const existing = await lstat(frozen).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        },
      );
      if (!existing) {
        const before = await lstat(file.source);
        if (!before.isFile() || before.size > 4 * 1024 ** 3)
          throw new Error(`Unsupported transfer file: ${file.path}`);
        const temporary = `${frozen}.${randomUUID()}`;
        try {
          await copyFile(file.source, temporary, constants.COPYFILE_EXCL);
          if (process.platform === "win32") await chmod(temporary, 0o600);
          if (signature(await lstat(file.source)) !== signature(before))
            return { pending: true };
          await syncPath(temporary);
          await rename(temporary, frozen);
          await syncPath(root);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      const info = await lstat(frozen);
      if (!info.isFile() || info.size > 4 * 1024 ** 3)
        throw new Error("Invalid staged transfer file");
      file.size = info.size;
      file.sha256 = await digest(frozen);
      file.frozen = frozen;
      const metadataTemporary = `${capturePath}.${randomUUID()}`;
      await writeSnapshot(metadataTemporary, JSON.stringify(capture));
      await rename(metadataTemporary, capturePath);
      await syncPath(root);
    }
    const handle = await open(
      file.frozen,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const offset = command.offset ?? 0;
      if (offset > file.size) throw new Error("Invalid transfer offset");
      const buffer = Buffer.alloc(Math.min(1024 * 1024, file.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return {
        data: buffer.subarray(0, bytesRead).toString("base64"),
        sha256: file.sha256,
        size: file.size,
      };
    } finally {
      await handle.close();
    }
  }
  const existing = await readFile(capturePath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    },
  );
  if (existing) return publicCapture(JSON.parse(existing) as Capture);
  const entry = await requireResolvedWorkspaceForCommand({
    environmentId: command.environmentId,
    targetThreadId: command.threadId,
    workspaceContext: command.workspaceContext,
    runtimeManager: options.runtimeManager,
  });
  const workspace = await realpath(entry.workspace.path);
  const git = await lstat(join(workspace, ".git")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    },
  );
  const capture: Capture = { nativeId: "", files: [], omitted: [] };
  const add = async (
    source: string,
    path: string,
    kind: Source["kind"],
    frozen?: string,
  ) => {
    const info = await lstat(frozen ?? source);
    if (!info.isFile() || info.size > 4 * 1024 ** 3)
      throw new Error(`Unsupported transfer file: ${path}`);
    capture.files.push({
      path,
      source,
      size: info.size,
      sha256: frozen ? await digest(frozen) : "",
      kind,
      executable: Boolean(info.mode & 0o111),
      ...(frozen ? { frozen } : {}),
    });
  };
  const sessions = [...(command.sessions ?? [])];
  const texts: string[] = [];
  const knownCodexSessions = new Set(
    sessions
      .filter((session) => session.harness === "codex")
      .map((session) => session.nativeId),
  );
  for (const session of sessions) {
    const opencode = session.harness === "opencode";
    const source = opencode
      ? await exportOpenCode(session.nativeId, root, workspace, options)
      : await nativePath(session.harness, session.threadId, session.nativeId);
    const info = await lstat(source);
    if (!info.isFile() || info.size > HOST_ARTIFACT_MAX_BYTES)
      throw new Error("Native history exceeds the bounded capture size");
    const cursor = session.harness === "cursor";
    const exported = opencode
      ? (JSON.parse(await readFile(source, "utf8")) as OpenCodeExport)
      : null;
    const lines =
      cursor || exported
        ? []
        : (await readFile(source, "utf8")).trimEnd().split("\n");
    if (lines.length > 1)
      try {
        JSON.parse(lines.at(-1)!);
      } catch {
        lines.pop();
      }
    const header = cursor || exported ? {} : JSON.parse(lines[0]!);
    const id = exported
      ? exported.info?.id
      : cursor ||
          (session.harness === "claude-code" &&
            lines.some(
              (line) => JSON.parse(line).sessionId === session.nativeId,
            ))
        ? session.nativeId
        : session.harness === "pi"
          ? header.id
          : header.payload?.id;
    if (
      typeof id !== "string" ||
      (session.harness !== "pi" && id !== session.nativeId)
    )
      throw new Error("Native history has no matching session identity");
    if (session.threadId === command.threadId) capture.nativeId = id;
    // A Codex fork stores only its new turns and reads the rest from its parents' files at saved byte
    // offsets, so every parent travels too, byte-for-byte.
    if (session.harness === "codex" && session.threadId === command.threadId)
      for (let base = header.payload?.history_base, depth = 0; base; depth++) {
        const parentId = String(base.thread_id);
        const [parent] = await codexRollouts(
          (name) =>
            name.endsWith(`-${parentId}.jsonl`) ||
            name.endsWith(`_${parentId}.jsonl`),
        );
        if (!parent || depth === 64)
          throw new Error(
            `The parent conversation ${parentId} of this forked Codex chat is missing or loops; local history was not changed`,
          );
        if ((await lstat(parent)).size > HOST_ARTIFACT_MAX_BYTES)
          throw new Error("Native history exceeds the bounded capture size");
        const data = await readFile(parent);
        // A parent still running locally may be mid-write; its forks never read past a full line.
        const frozen = join(root, `lineage-${depth}.jsonl`);
        await rm(frozen, { force: true }); // A failed earlier capture may have frozen an older copy.
        await writeSnapshot(frozen, data.subarray(0, data.lastIndexOf(10) + 1));
        await add(parent, basename(parent), "lineage", frozen);
        base = JSON.parse(data.subarray(0, data.indexOf(10)).toString("utf8"))
          .payload?.history_base;
      }
    let imageIndex = 0;
    function separateImages(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(separateImages);
      if (!value || typeof value !== "object") return value;
      const item = value as Record<string, unknown>;
      const url = typeof item.image_url === "string" ? item.image_url : null;
      const base64 = item.source as Record<string, unknown> | undefined;
      const embedded =
        item.type === "image" && typeof item.data === "string"
          ? { data: item.data, mime: String(item.mimeType ?? "image/png") }
          : item.type === "image" &&
              base64?.type === "base64" &&
              typeof base64.data === "string"
            ? {
                data: base64.data,
                mime: String(base64.media_type ?? "image/png"),
              }
            : item.type === "input_image" && url?.startsWith("data:")
              ? {
                  data: url.slice(url.indexOf(",") + 1),
                  mime: url.slice(5, url.indexOf(";")),
                }
              : null;
      if (embedded) {
        const extension =
          (
            {
              "image/jpeg": "jpg",
              "image/jpg": "jpg",
              "image/png": "png",
              "image/webp": "webp",
              "image/gif": "gif",
            } as Record<string, string>
          )[embedded.mime] ?? "bin";
        const name = `${session.threadId}-image-${imageIndex++}.${extension}`;
        const file = join(root, name);
        images.push({ file, name, data: Buffer.from(embedded.data, "base64") });
        return {
          type: item.type === "input_image" ? "input_text" : "text",
          text: `[Teleport attachment pending: ${name}. It is uploading separately; do not assume it has arrived.]`,
        };
      }
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          separateImages(child),
        ]),
      );
    }
    const images: { file: string; name: string; data: Buffer }[] = [];
    const frozen = join(root, `${session.threadId}.jsonl`);
    for (const message of exported?.messages ?? [])
      for (const part of message.parts ?? [])
        if (part.type === "text") collectText(part.text, texts);
    const text = cursor
      ? await cursorSnapshot(dirname(source), session.nativeId, root)
      : exported
        ? await readFile(source, "utf8")
        : lines
            .map((line) => {
              const record = JSON.parse(line);
              if (session.harness === "codex" && record.type === "event_msg") {
                const payload = record.payload;
                const item = payload?.item;
                const children =
                  item?.type === "SubAgentActivity" && item.kind === "started"
                    ? [item.agent_thread_id]
                    : item?.type === "CollabAgentToolCall" &&
                        item.tool === "spawn"
                      ? (item.receiver_thread_ids ?? [])
                      : payload?.type === "collab_agent_spawn_end"
                        ? [payload.new_agent_id]
                        : [];
                for (const child of children) {
                  if (
                    typeof child !== "string" ||
                    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
                      child,
                    ) ||
                    knownCodexSessions.has(child)
                  )
                    continue;
                  knownCodexSessions.add(child);
                  sessions.push({
                    threadId: child,
                    nativeId: child,
                    harness: "codex",
                  });
                }
              }
              const separated = command.keepImages ? record : separateImages(record);
              collectText(
                spoken(session.harness, separated as Record<string, any>),
                texts,
              );
              return JSON.stringify(separated);
            })
            .join("\n") + "\n";
    await writeSnapshot(frozen, text);
    await add(
      source,
      session.threadId === command.threadId
        ? cursor
          ? `${session.nativeId}.jsonl`
          : basename(source)
        : `${session.threadId}.jsonl`,
      session.threadId === command.threadId ? "native" : "context",
      frozen,
    );
    if (
      session.threadId === command.threadId &&
      command.extraText !== undefined
    ) {
      const history = join(root, "gui-history.json");
      const separated = separateImages(JSON.parse(command.extraText)) as {
        queued?: unknown;
        threads?: {
          events?: { type?: string; data?: { input?: unknown } }[];
        }[];
      };
      collectText(separated.queued, texts);
      for (const thread of separated.threads ?? [])
        for (const event of thread.events ?? [])
          if (event.type === "client/turn/requested")
            collectText(event.data?.input, texts);
      await writeSnapshot(history, JSON.stringify(separated) + "\n");
      await add(history, "gui-history.json", "context", history);
    }
    for (const image of images) {
      await writeSnapshot(image.file, image.data);
      await add(image.file, image.name, "attachment", image.file);
    }
  }
  if (!capture.nativeId)
    throw new Error("Parent conversation was not captured");
  // Pi discovers these instructions at startup; they are not in its transcript.
  if (sessions.some((session) => session.harness === "pi")) {
    const ancestors: string[] = [];
    for (let dir = workspace; ; dir = dirname(dir)) {
      ancestors.unshift(dir);
      if (dirname(dir) === dir) break;
    }
    const configured =
      process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const agentDir = resolve(
      workspace,
      configured.startsWith("~/")
        ? join(homedir(), configured.slice(2))
        : configured,
    );
    const seen = new Set<string>();
    for (const dir of [agentDir, ...ancestors]) {
      for (const name of [
        "AGENTS.override.md",
        "AGENTS.md",
        "AGENTS.MD",
        "CLAUDE.md",
        "CLAUDE.MD",
      ]) {
        const path = join(dir, name);
        const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (!info?.isFile()) continue;
        const source = await realpath(path);
        if (!seen.has(source)) {
          if (info.size > HOST_ARTIFACT_MAX_BYTES)
            throw new Error(
              "Instruction file exceeds the bounded capture size",
            );
          seen.add(source);
          const label = `instructions-${seen.size}-${name}`;
          const frozen = join(root, label);
          await writeSnapshot(frozen, await readFile(source));
          await add(source, label, "context", frozen);
        }
        break;
      }
    }
  }
  // Tracked files reach the cloud through Git, and ignored files are build
  // output or secrets. Copy only new, unignored files the conversation
  // mentions, plus the local Git state so the agent can match it.
  const gitOptions = {
    cwd: workspace,
    ...userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
  };
  const untracked = git
    ? new Set(
        (
          await runGit(
            ["ls-files", "-z", "--others", "--exclude-standard"],
            gitOptions,
          )
        ).stdout.split("\0"),
      )
    : null;
  if (git) {
    const gitState = join(root, "git-state.txt");
    const status = await runGit(
      ["status", "--short", "--branch", "--untracked-files=no"],
      gitOptions,
    );
    const head = await runGit(["log", "-1", "--format=HEAD %H %s"], {
      ...gitOptions,
      allowFailure: true,
    });
    await writeSnapshot(gitState, status.stdout + head.stdout);
    await add(gitState, "git-state.txt", "context", gitState);
  }
  for (const path of mentionedPaths(workspace, texts)) {
    if (
      (untracked && !untracked.has(path)) ||
      path
        .split("/")
        .some(
          (part) => excluded.has(part) || part.startsWith(".cloudroom-sync-"),
        )
    )
      continue;
    const source = join(workspace, path);
    const info = await lstat(source).catch(() => null);
    if (info?.isFile() && info.size <= 4 * 1024 ** 3)
      await add(source, path, "project");
  }
  for (const source of command.attachments ?? []) {
    const path = await realpath(source).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      },
    );
    if (!path) {
      capture.omitted.push(source);
      continue;
    }
    if (!capture.files.some((file) => file.source === path))
      await add(
        path,
        `${capture.files.length}-${basename(path)}`,
        "attachment",
      );
  }
  await writeSnapshot(capturePath, JSON.stringify(capture));
  return publicCapture(capture);
}

// Only what the user and agent said or did counts as a mention, not tool output.
function spoken(harness: string, record: Record<string, any>): unknown {
  if (harness === "claude-code") {
    const content = ["user", "assistant"].includes(record.type)
      ? record.message?.content
      : undefined;
    return Array.isArray(content)
      ? content.filter((block) => block?.type !== "tool_result")
      : content;
  }
  if (harness === "pi")
    return record.type === "message" &&
      ["user", "assistant"].includes(record.message?.role)
      ? record.message.content
      : undefined;
  const payload = record.type === "response_item" ? record.payload : undefined;
  if (payload?.type === "message")
    return ["user", "assistant"].includes(payload.role)
      ? payload.content
      : undefined;
  return ["function_call", "custom_tool_call"].includes(payload?.type)
    ? payload
    : undefined;
}

type OpenCodeExport = {
  info?: { id?: unknown };
  messages?: { parts?: { type?: string; text?: unknown }[] }[];
};

async function runOpenCode(
  args: string[],
  cwd: string,
  options: CommandDispatchOptions,
): Promise<string> {
  const { stdout } = await execFileAsync("opencode", args, {
    cwd,
    env: {
      ...process.env,
      ...options.runtimeManager.getShellEnv(),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
    maxBuffer: HOST_ARTIFACT_MAX_BYTES,
    timeout: 60_000,
  });
  return stdout;
}

async function exportOpenCode(
  nativeId: string,
  root: string,
  workspace: string,
  options: CommandDispatchOptions,
): Promise<string> {
  const exported = await runOpenCode(["export", nativeId], workspace, options);
  JSON.parse(exported);
  const path = join(root, `${nativeId}.json`);
  await rm(path, { force: true });
  await writeSnapshot(path, exported);
  return path;
}

// Same JSONL snapshot format the core's cursor-history.py restores.
async function cursorSnapshot(
  directory: string,
  sessionId: string,
  scratch: string,
): Promise<string> {
  const meta = await readFile(join(directory, "meta.json"));
  const parsed = JSON.parse(meta.toString("utf8"));
  if (parsed.schemaVersion !== 1 || typeof parsed.cwd !== "string")
    throw new Error("Unsupported Cursor session metadata");
  const files: [string, Buffer][] = [["meta.json", meta]];
  const store = join(directory, "store.db");
  if (
    await stat(store).then(
      () => true,
      () => false,
    )
  ) {
    // VACUUM INTO takes a consistent copy that includes unmerged WAL pages.
    const copy = join(scratch, `cursor-${randomUUID()}.db`);
    const database = new DatabaseSync(store, { readOnly: true });
    try {
      database.prepare("VACUUM INTO ?").run(copy);
    } finally {
      database.close();
    }
    files.push(["store.db", await readFile(copy)]);
    await rm(copy, { force: true });
  }
  const lines = [
    JSON.stringify({
      type: "cursor_snapshot",
      version: 1,
      session_id: sessionId,
    }),
  ];
  for (const [name, data] of files)
    for (let offset = 0; offset < data.length; offset += 64 * 1024)
      lines.push(
        JSON.stringify({
          file: name,
          offset,
          data: data.subarray(offset, offset + 64 * 1024).toString("base64"),
        }),
      );
  const digest = createHash("sha256");
  for (const line of lines) digest.update(`${line}\n`);
  lines.push(JSON.stringify({ end: true, sha256: digest.digest("hex") }));
  return `${lines.join("\n")}\n`;
}

function collectText(value: unknown, out: string[]) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object")
    for (const child of Object.values(value)) collectText(child, out);
}

function mentionedPaths(workspace: string, texts: string[]): Set<string> {
  const paths = new Set<string>();
  for (const text of texts)
    for (const token of text.split(/[\s"'`()[\]{}<>,;:|=*]+/)) {
      if (token.length > 1024 || !/[/.]/.test(token)) continue;
      const cleaned = token.replace(/^@/, "").replace(/[.!?]+$/, "");
      const absolute = cleaned.startsWith("~/")
        ? join(homedir(), cleaned.slice(2))
        : resolve(workspace, cleaned);
      const path = relative(workspace, absolute).split(sep).join("/");
      if (path && !path.startsWith("..") && !isAbsolute(path)) paths.add(path);
    }
  return paths;
}

async function syncPath(path: string) {
  // Windows flushes only through a writable handle and can't open a folder to flush it; NTFS journals the rename itself.
  if (process.platform === "win32" && (await lstat(path)).isDirectory()) return;
  const file = await open(
    path,
    process.platform === "win32" ? "r+" : constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeSnapshot(path: string, value: string | Buffer) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await readFile(path)).equals(bytes)
    )
      throw error;
  }
  await syncPath(path);
  await syncPath(dirname(path));
}

function publicCapture(capture: Capture) {
  return {
    nativeId: capture.nativeId,
    omitted: capture.omitted,
    files: capture.files.map(({ source, frozen: _frozen, ...entry }) => ({
      ...entry,
      origin: source,
    })),
  };
}
