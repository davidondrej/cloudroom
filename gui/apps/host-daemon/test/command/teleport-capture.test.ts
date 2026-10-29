import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
