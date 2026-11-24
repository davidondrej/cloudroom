import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { getHostPathComparisonKey } from "@cloudroom/domain";
import {
  CHAT_FILE_COPIES_DIR_NAME,
  existingDataPrivateDir,
} from "@cloudroom/process-utils";

// A chat message keeps only the path of a file it shows, and the file often goes later. So Cloudroom keeps a copy, and
// the chat shows it once the file is gone. Copies live in `<data folder>/chat-file-copies/<thread>/`, an owner-only
// folder no agent sandbox can write or read. Never in thread storage: every sandboxed Local agent can write it, and
// Node can't open a file relative to a checked folder, so a link the agent swaps in there could send a copy anywhere.

/** The same limit as a Cloud thread's saved images. */
export const CHAT_FILE_COPY_MAX_BYTES = 20 * 1024 * 1024;

const THREAD_ID = /^[A-Za-z0-9_-]+$/u;
const EXTENSION = /\.[a-z0-9]{1,10}$/iu;
// Never through a link at the file's own name, and never waits on a FIFO.
const OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

/** A copy's file name: a hash of the shown path, so no folder of that path is ever made, and the path's extension, so
 *  the copy is served as the same type. Null for a relative path. */
export function chatFileCopyName(filePath: string): string | null {
  const key = getHostPathComparisonKey(filePath);
  if (key === null) return null;
  const extension = EXTENSION.exec(key)?.[0].toLowerCase() ?? "";
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hash}${extension}`;
}

/** Where a thread keeps its copy of `filePath` in this computer's data folder. Null for a relative path. */
export function chatFileCopyPath(
  dataDir: string,
  threadId: string,
  filePath: string,
): string | null {
  const name = chatFileCopyName(filePath);
  if (name === null || !THREAD_ID.test(threadId)) return null;
  return path.join(dataDir, CHAT_FILE_COPIES_DIR_NAME, threadId, name);
}

/** Reads a file an agent named, from the one handle that was checked: only a regular file with a single name and at
 *  most `maxBytes`. A link swapped in after the open changes nothing. Null for anything else. */
export async function readRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    // A second name can be a hard link to a file the agent may not read.
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) return null;
    // At most the size checked: a file that grows while it is read can't use more memory.
    const data = Buffer.alloc(info.size);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(
        data,
        length,
        data.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return data.subarray(0, length);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Saves `data` as a thread's copy of `filePath`: a new file, then a rename, so a reader never sees half a copy.
 *  Only in the copies folder the host daemon made at startup, before any sandbox started, never one made later. */
export async function saveChatFileCopy(args: {
  data: Uint8Array;
  dataDir: string;
  filePath: string;
  threadId: string;
}): Promise<void> {
  const name = chatFileCopyName(args.filePath);
  if (name === null || !THREAD_ID.test(args.threadId)) return;
  const folder = path.join(
    existingDataPrivateDir(args.dataDir, CHAT_FILE_COPIES_DIR_NAME),
    args.threadId,
  );
  await fs.mkdir(folder, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const target = path.join(folder, name);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, args.data, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Removes a thread's copies, when the thread is deleted. */
export async function deleteChatFileCopies(
  dataDir: string,
  threadId: string,
): Promise<void> {
  if (!THREAD_ID.test(threadId)) return;
  await fs.rm(path.join(dataDir, CHAT_FILE_COPIES_DIR_NAME, threadId), {
    recursive: true,
    force: true,
  });
}
