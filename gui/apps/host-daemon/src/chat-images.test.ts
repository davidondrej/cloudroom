import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chatFileCopyPath } from "@cloudroom/config/chat-file-copies";
import {
  CHAT_FILE_COPIES_DIR_NAME,
  ensureDataPrivateDir,
} from "@cloudroom/process-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveChatImages } from "./chat-images.js";

describe("saveChatImages", () => {
  let root: string;
  let dataDir: string;
  let storageRoot: string;
  let storage: string;
  const copyOf = (file: string) => chatFileCopyPath(dataDir, "thr_1", file)!;
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const save = (...files: string[]) =>
    saveChatImages({
      dataDir,
      threadId: "thr_1",
      threadStorageRootPath: storageRoot,
      text: files.map((file) => `![Image](${encodeURI(file)})`).join("\n\n"),
    });

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "chat-images-")),
    );
    dataDir = path.join(root, "data");
    storageRoot = path.join(dataDir, "thread-storage");
    storage = path.join(storageRoot, "thr_1");
    await fs.mkdir(storageRoot, { recursive: true });
    // The host daemon makes it at startup.
    ensureDataPrivateDir(dataDir, CHAT_FILE_COPIES_DIR_NAME);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps a copy of each image a message shows, which outlives the original", async () => {
    const shown = path.join(root, "ui preview", "option-a.png");
    const inCode = path.join(root, "in-code.png");
    const owned = path.join(storage, "render.png");
    for (const file of [shown, inCode, owned]) {
      await write(file, path.basename(file));
    }

    await saveChatImages({
      dataDir,
      threadId: "thr_1",
      threadStorageRootPath: storageRoot,
      text: [
        `![Option A](${encodeURI(shown)})`,
        `![Gone](${path.join(root, "gone.png")})`,
        `![Mine](${owned})`,
        `\`![Code](${inCode})\``,
      ].join("\n\n"),
    });
    await fs.rm(shown);

    await expect(fs.readFile(copyOf(shown), "utf8")).resolves.toBe(
      "option-a.png",
    );
    // Nothing else is copied: a missing file, the thread's own file, or a path in code.
    await expect(fs.readdir(path.dirname(copyOf(shown)))).resolves.toEqual([
      path.basename(copyOf(shown)),
    ]);
    // Agents can write thread storage, so no copy goes there.
    await expect(fs.readdir(storage)).resolves.toEqual(["render.png"]);
    if (process.platform !== "win32") {
      const folder = await fs.stat(path.dirname(path.dirname(copyOf(shown))));
      expect(folder.mode & 0o777).toBe(0o700);
    }
  });

  it("copies no link, FIFO, or file with a second name, and never writes through a planted link", async () => {
    const outside = path.join(root, "outside");
    await write(path.join(outside, "secret.png"), "secret");
    const linked = path.join(root, "linked.png");
    await fs.symlink(path.join(outside, "secret.png"), linked);
    const hardLinked = path.join(root, "hard-linked.png");
    await fs.link(path.join(outside, "secret.png"), hardLinked);
    const shown = path.join(root, "folder", "shown.png");
    await write(shown, "shown");
    // A folder link on the way to where this copy was saved before: never written through.
    await fs.mkdir(path.join(storage, "Cloud files"), { recursive: true });
    const [, first = ""] = root.split(path.sep);
    await fs.symlink(outside, path.join(storage, "Cloud files", first));
    const fifo = path.join(root, "pipe.png");
    if (process.platform !== "win32") execFileSync("mkfifo", [fifo]);

    // A FIFO would block an open without O_NONBLOCK, so this would time out.
    await save(linked, hardLinked, fifo, shown);

    for (const file of [linked, hardLinked, fifo]) {
      await expect(fs.lstat(copyOf(file))).rejects.toThrow();
    }
    await expect(fs.readFile(copyOf(shown), "utf8")).resolves.toBe("shown");
    await expect(fs.readdir(outside)).resolves.toEqual(["secret.png"]);
  });

  it("keeps going after a save fails, and never makes the copies folder itself", async () => {
    const first = path.join(root, "first.png");
    const second = path.join(root, "second.png");
    await write(first, "first");
    await write(second, "second");
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));

    await expect(save(first, second)).rejects.toThrow("disk full");
    await expect(fs.lstat(copyOf(first))).rejects.toThrow();
    await expect(fs.readFile(copyOf(second), "utf8")).resolves.toBe("second");

    // A folder made after a sandbox started could stay readable to it, so without the daemon's folder nothing is kept.
    const copies = path.join(dataDir, CHAT_FILE_COPIES_DIR_NAME);
    await fs.rm(copies, { recursive: true });
    await expect(save(first)).rejects.toThrow();
    await expect(fs.lstat(copies)).rejects.toThrow();
  });

  it("copies the file it checked, even when a link replaces it during the copy", async () => {
    const secret = path.join(root, "auth.json");
    await write(secret, "secret");
    const shown = path.join(root, "shot.png");
    await write(shown, "shot");
    // The agent swaps the image for a link to a secret right after Cloudroom opens it.
    const open = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (file, ...rest) => {
      const handle = await open(file, ...rest);
      if (file === shown && !swapped) {
        swapped = true;
        await fs.rename(shown, `${shown}.old`);
        await fs.symlink(secret, shown);
      }
      return handle;
    });

    await save(shown);

    expect(swapped).toBe(true);
    await expect(fs.readFile(copyOf(shown), "utf8")).resolves.toBe("shot");
    await expect(fs.readdir(storageRoot)).resolves.toEqual([]);
  });
});
