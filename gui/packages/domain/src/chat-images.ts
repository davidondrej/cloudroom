import {
  getHostPathSegments,
  isWindowsNetworkOrDevicePath,
} from "./host-path.js";

// A chat message keeps only the path of an image it shows, and the file often goes later: agents tidy up /tmp, threads
// share its folders, macOS empties it after 3 days, a Cloud sandbox is rebuilt without it. So each thread keeps a copy
// in its storage, and the chat shows the copy once the file is gone.

/** Cloud threads used this folder first, so it keeps their name: a thread moved between Local and Cloud looks in one place. */
export const CHAT_FILE_COPIES_FOLDER = "Cloud files";
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

/** Where a thread's storage keeps its copy of a file its chat showed, as the path parts under the storage folder:
 *  `/tmp/shot/a.png` is `["Cloud files", "tmp", "shot", "a.png"]`. Null when the path is not absolute. */
export function chatFileCopySegments(filePath: string): string[] | null {
  const segments = getHostPathSegments(filePath);
  return segments?.length ? [CHAT_FILE_COPIES_FOLDER, ...segments] : null;
}
