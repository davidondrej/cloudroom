import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveChatImages } from "./chat-images.js";

describe("saveChatImages", () => {
  let root: string;
  let storageRoot: string;
  let storage: string;
  // The copy sits under the same folders as the original, without its root (`/`, or a Windows drive).
  const copyOf = (file: string) =>
    path.join(storage, "Cloud files", ...file.split(path.sep).slice(1));
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const save = (...files: string[]) =>
    saveChatImages({
      threadId: "thr_1",
      threadStorageRootPath: storageRoot,
      text: files.map((file) => `![Image](${encodeURI(file)})`).join("\n\n"),
    });

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "chat-images-")),
    );
    storageRoot = path.join(root, "thread-storage");
    storage = path.join(storageRoot, "thr_1");
    await fs.mkdir(storageRoot);
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("keeps a copy of each image a message shows, which outlives the original", async () => {
    const shown = path.join(root, "ui preview", "option-a.png");
    const inCode = path.join(root, "in-code.png");
    const owned = path.join(storage, "render.png");
    for (const file of [shown, inCode, owned]) {
      await write(file, path.basename(file));
    }

    await saveChatImages({
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
    const kept = await fs.readdir(path.join(storage, "Cloud files"), {
      recursive: true,
    });
    expect(kept.filter((name) => name.endsWith(".png"))).toHaveLength(1);
  });

  it("never follows a symlink an agent planted", async () => {
    const outside = path.join(root, "outside");
    await write(path.join(outside, "secret.png"), "secret");
    await write(path.join(outside, "victim.png"), "victim");
    // A linked image: its target is not copied.
    const linkedImage = path.join(root, "linked.png");
    await fs.symlink(path.join(outside, "secret.png"), linkedImage);
    // A link where the copy goes: replaced, never written through.
    const shown = path.join(root, "shown.png");
    await write(shown, "shown");
    await fs.mkdir(path.dirname(copyOf(shown)), { recursive: true });
    await fs.symlink(path.join(outside, "victim.png"), copyOf(shown));
    // A linked folder on the way: nothing is written through it.
    const inLinkedFolder = path.join(root, "folder", "pic.png");
    await write(inLinkedFolder, "pic");
    await fs.symlink(outside, path.dirname(copyOf(inLinkedFolder)));

    await save(linkedImage, shown, inLinkedFolder);

    await expect(fs.readdir(outside)).resolves.toEqual([
      "secret.png",
      "victim.png",
    ]);
    await expect(
      fs.readFile(path.join(outside, "victim.png"), "utf8"),
    ).resolves.toBe("victim");
    await expect(fs.lstat(copyOf(linkedImage))).rejects.toThrow();
    expect((await fs.lstat(copyOf(shown))).isFile()).toBe(true);
    await expect(fs.readFile(copyOf(shown), "utf8")).resolves.toBe("shown");
  });
});
