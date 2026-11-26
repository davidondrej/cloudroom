import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureTeleport } from "../../src/command-handlers/teleport.js";

const state = vi.hoisted(() => ({ workspace: "" }));
vi.mock("../../src/workspace-resolution.js", () => ({
  requireResolvedWorkspaceForCommand: async () => ({ workspace: { path: state.workspace } }),
}));

let root = "";
const previousConfig = process.env.CLAUDE_CONFIG_DIR;
const nativeId = "11111111-2222-3333-4444-555555555555";
const image = Buffer.from("png-bytes").toString("base64");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "teleport-capture-"));
  state.workspace = join(root, "workspace");
  await mkdir(state.workspace);
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  await mkdir(join(root, "claude", "projects", "workspace"), { recursive: true });
  const message = { type: "user", uuid: "u1", sessionId: nativeId, message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: image } }] } };
  await writeFile(join(root, "claude", "projects", "workspace", `${nativeId}.jsonl`), `${JSON.stringify(message)}\n`);
});

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  await rm(root, { recursive: true, force: true });
});

const capture = (transferId: string, keepImages?: boolean) => captureTeleport({
  type: "thread.teleport", threadId: "thr_source", transferId, action: "capture",
  workspaceContext: { workspacePath: state.workspace },
  sessions: [{ threadId: "thr_source", nativeId, harness: "claude-code" }],
  ...(keepImages === undefined ? {} : { keepImages }),
} as never, { threadStorageRootPath: join(root, "storage"), runtimeManager: { getShellEnv: () => process.env } } as never) as Promise<{ files: { kind: string }[] }>;

it("keeps a fork's embedded images in its transcript instead of splitting them out", async () => {
  const fork = await capture("fork_one", true);
  expect(fork.files.map((file) => file.kind)).toEqual(["native"]);
  const transcript = await readFile(join(root, "storage", "thr_source", "teleport", "fork_one", "thr_source.jsonl"), "utf8");
  expect(transcript).toContain(image);
  expect(transcript).not.toContain("Teleport attachment pending");

  const teleport = await capture("teleport_one");
  expect(teleport.files.map((file) => file.kind)).toEqual(["native", "attachment"]);
});

it("captures a read-only file (Windows copies the read-only flag)", async () => {
  const transcript = join(root, "claude", "projects", "workspace", `${nativeId}.jsonl`);
  await chmod(transcript, 0o444);
  const teleport = await capture("teleport_read_only");
  expect(teleport.files.map((file) => file.kind)).toContain("native");
  await chmod(transcript, 0o644);
});

// A shell script stands in for OpenCode, so this runs on macOS and Linux only.
it.skipIf(process.platform === "win32")("moves an OpenCode 2 chat with its session commands, and resumes only a matching existing copy (#2686)", async () => {
  const bin = join(root, "bin");
  await mkdir(bin);
  const chat = JSON.stringify({ info: { id: "ses_2686" }, messages: [{ type: "user", text: "hi" }] });
  await writeFile(join(bin, "opencode"), `#!/bin/sh
case "$*" in
  --version) echo "opencode v2.3.0" ;;
  "session export --standalone ses_2686") echo '${chat}' ;;
  "session import --standalone "*) echo "Session already exists" >&2 ;;
  *) echo "unexpected $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const options = { threadStorageRootPath: join(root, "storage"), runtimeManager: { getShellEnv: () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}` }) } } as never;
  const command = (action: string) => ({ type: "thread.teleport", threadId: "thr_source", transferId: `oc_${action}`, action, file: join(root, "chat.json"), workspaceContext: { workspacePath: state.workspace }, sessions: [{ threadId: "thr_source", nativeId: "ses_2686", harness: "opencode" }] }) as never;
  const captured = await captureTeleport(command("capture"), options) as { files: { kind: string }[] };
  expect(captured.files.map((file) => file.kind)).toContain("native");
  await writeFile(join(root, "chat.json"), chat);
  await expect(captureTeleport(command("import"), options)).resolves.toEqual({ nativeId: "ses_2686" });
  await writeFile(join(root, "chat.json"), JSON.stringify({ info: { id: "ses_2686" }, messages: [{ type: "user", text: "hi" }, { type: "user", text: "more" }] }));
  await expect(captureTeleport(command("import"), options)).rejects.toThrow("older copy");
});

it("sends the GUI history with an Antigravity chat, since the server needs it to finish the move", async () => {
  const home = join(root, "home");
  const conversations = join(home, ".gemini", "antigravity-cli", "conversations");
  await mkdir(conversations, { recursive: true });
  const db = new DatabaseSync(join(conversations, `${nativeId}.db`));
  db.exec("CREATE TABLE trajectory_meta (cascade_id TEXT)");
  db.prepare("INSERT INTO trajectory_meta VALUES (?)").run(nativeId);
  db.close();
  // os.homedir() reads HOME on Unix and USERPROFILE on Windows.
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    // A capture an older host saved without the GUI history is redone on retry.
    const stale = join(root, "storage", "thr_source", "teleport", "agy_one");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "capture.json"), JSON.stringify({ nativeId, files: [{ path: `${nativeId}.db`, kind: "native" }], omitted: [] }));
    await writeFile(join(stale, "git-state.txt"), "stale");
    const captured = await captureTeleport({
      type: "thread.teleport", threadId: "thr_source", transferId: "agy_one", action: "capture",
      workspaceContext: { workspacePath: state.workspace },
      sessions: [{ threadId: "thr_source", nativeId, harness: "antigravity" }],
      extraText: JSON.stringify({ threads: [{ events: [{ type: "client/turn/requested", data: { input: [{ type: "image", data: image, mimeType: "image/png" }] } }] }] }),
    } as never, { threadStorageRootPath: join(root, "storage"), runtimeManager: { getShellEnv: () => process.env } } as never) as { nativeId: string; files: { kind: string; path: string }[] };
    expect(captured.nativeId).toBe(nativeId);
    expect(captured.files.map((file) => [file.kind, file.path])).toEqual([["native", `${nativeId}.db`], ["context", "gui-history.json"], ["attachment", "gui-history-image-0.png"]]);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
