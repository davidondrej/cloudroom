import {
  getHostPathSegments,
  isWindowsNetworkOrDevicePath,
} from "./host-path.js";

// A chat message keeps only the path of an image it shows, and the file often goes later: agents tidy up /tmp, threads
// share its folders, macOS empties it after 3 days, a Cloud sandbox is rebuilt without it. So each thread keeps a copy
// (`@cloudroom/config/chat-file-copies`), and the chat shows the copy once the file is gone.

/** The folder in a thread's storage where copies were saved before 2026-11-23. Agents can write thread storage, so
 *  nothing is saved there now. Old copies are still read from it, and it stays hidden from file lists. */
export const LEGACY_CHAT_FILE_COPIES_FOLDER = "Cloud files";
const MAX_IMAGES_PER_MESSAGE = 10;
const CHAT_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The absolute paths of the images a chat message shows: in order, each once, 10 at most. Code is not a message's images. */
export function chatImagePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const [, wrapped, bare] of text.replace(CODE, "").matchAll(CHAT_IMAGE)) {
    const path = decodePath(wrapped ?? bare ?? "");
    // A network path (`//server/share`) would make Windows connect to that server and send the user's login.
    if (
      IMAGE_FILE.test(path) &&
      !isWindowsNetworkOrDevicePath(path) &&
      getHostPathSegments(path) !== null
    ) {
      paths.add(path);
    }
  }
  return [...paths].slice(0, MAX_IMAGES_PER_MESSAGE);
}

/** Where an old copy of a file a chat showed is, as the path parts under the thread's storage folder:
 *  `/tmp/shot/a.png` is `["Cloud files", "tmp", "shot", "a.png"]`. Null when the path is not absolute. */
export function legacyChatFileCopySegments(filePath: string): string[] | null {
  const segments = getHostPathSegments(filePath);
  return segments?.length
    ? [LEGACY_CHAT_FILE_COPIES_FOLDER, ...segments]
    : null;
}
