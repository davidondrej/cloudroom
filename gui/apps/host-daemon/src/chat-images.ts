import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  chatFileCopySegments,
  chatImagePaths,
  isHostPathWithin,
} from "@cloudroom/domain";
import {
  isPathWithinDirectory,
  resolveContainedPath,
} from "@cloudroom/process-utils";

// The same limit as a Cloud thread's saved images.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Copies the images an agent's message shows into the thread's storage, where the server finds them once the
 *  originals are gone. A missing, unreadable, or oversized image just keeps no copy.
 *  Agents can write to thread storage and this runs outside their sandbox, so it never follows a symlink they made:
 *  not a linked image, not a linked folder on the way, and not a link where the copy goes. */
export async function saveChatImages(args: {
  text: string;
  threadId: string;
  threadStorageRootPath: string;
}): Promise<void> {
  const storage = resolveContainedPath({
    rootPath: args.threadStorageRootPath,
    candidatePath: path.join(args.threadStorageRootPath, args.threadId),
  });
  if (storage === null) return;
  for (const imagePath of chatImagePaths(args.text)) {
    const copy = chatFileCopySegments(imagePath);
    // An image already in the thread's storage goes only with the thread.
    const inStorage = isHostPathWithin({
      rootPath: storage,
      candidatePath: imagePath,
    });
    if (copy === null || inStorage) continue;
    const target = path.join(storage, ...copy);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const info = await fs.lstat(imagePath);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      const realStorage = path.join(
        await fs.realpath(args.threadStorageRootPath),
        args.threadId,
      );
      const realFolder = await fs.realpath(path.dirname(target));
      if (!isPathWithinDirectory(realStorage, realFolder)) continue;
      // A new file, then a rename: never writes through a link at the target, and never shows half a copy.
      // A clone where the disk can make one (APFS): instant, and it takes no space until the original goes.
      await fs.copyFile(
        imagePath,
        temp,
        constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
      );
      await fs.rename(temp, target);
    } catch {
      // Keep going: the other images can still be saved.
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
}
