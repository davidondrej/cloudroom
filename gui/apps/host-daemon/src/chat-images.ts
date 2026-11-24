import path from "node:path";
import {
  CHAT_FILE_COPY_MAX_BYTES,
  readRegularFile,
  saveChatFileCopy,
} from "@cloudroom/config/chat-file-copies";
import { chatImagePaths, isHostPathWithin } from "@cloudroom/domain";

/** Copies the images an agent's message shows to the thread's chat file copies, where the server finds them once the
 *  originals are gone. A missing, unreadable, oversized, or linked image just keeps no copy.
 *  This runs outside every sandbox, on paths the agent chose: each image is opened once, checked, and copied from
 *  that handle, into a folder no sandbox can reach. */
export async function saveChatImages(args: {
  dataDir: string;
  text: string;
  threadId: string;
  threadStorageRootPath: string;
}): Promise<void> {
  const storage = path.join(args.threadStorageRootPath, args.threadId);
  let failure: unknown;
  for (const imagePath of chatImagePaths(args.text)) {
    // An image already in the thread's storage goes only with the thread.
    if (
      !path.isAbsolute(imagePath) ||
      isHostPathWithin({ rootPath: storage, candidatePath: imagePath })
    ) {
      continue;
    }
    const data = await readRegularFile(imagePath, CHAT_FILE_COPY_MAX_BYTES);
    if (data === null) continue;
    // Keep going: the other images can still be saved. The first error is still reported.
    await saveChatFileCopy({
      data,
      dataDir: args.dataDir,
      filePath: imagePath,
      threadId: args.threadId,
    }).catch((error: unknown) => {
      failure ??= error;
    });
  }
  if (failure !== undefined) throw failure;
}
