const MAX_LOCAL_PREVIEWS = 24;

const localPreviewUrlsByPath = new Map<string, string>();
const localPreviewAspectRatiosByPath = new Map<string, number>();

function canCreateObjectUrls(): boolean {
  return (
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
  );
}

export function registerLocalAttachmentPreview(path: string, file: Blob): void {
  if (
    !canCreateObjectUrls() ||
    !file.type.startsWith("image/") ||
    /^image\/hei[cf]/i.test(file.type)
  ) {
    return;
  }
  const previous = localPreviewUrlsByPath.get(path);
  if (previous !== undefined) {
    URL.revokeObjectURL(previous);
    localPreviewUrlsByPath.delete(path);
  }
  localPreviewUrlsByPath.set(path, URL.createObjectURL(file));
  while (localPreviewUrlsByPath.size > MAX_LOCAL_PREVIEWS) {
    const oldest = localPreviewUrlsByPath.keys().next();
    if (oldest.done) {
      break;
    }
    releaseLocalAttachmentPreview(oldest.value);
  }
}

export function getLocalAttachmentPreviewSrc(path: string): string | null {
  return localPreviewUrlsByPath.get(path) ?? null;
}

export function rememberLocalAttachmentAspectRatio(
  path: string,
  width: number,
  height: number,
): void {
  if (localPreviewUrlsByPath.has(path) && width > 0 && height > 0) {
    localPreviewAspectRatiosByPath.set(path, width / height);
  }
}

export function getLocalAttachmentAspectRatio(path: string): number | null {
  return localPreviewAspectRatiosByPath.get(path) ?? null;
}

export function releaseLocalAttachmentPreview(path: string): void {
  const url = localPreviewUrlsByPath.get(path);
  if (url === undefined) {
    return;
  }
  localPreviewUrlsByPath.delete(path);
  localPreviewAspectRatiosByPath.delete(path);
  URL.revokeObjectURL(url);
}

export function clearLocalAttachmentPreviews(): void {
  for (const path of [...localPreviewUrlsByPath.keys()]) {
    releaseLocalAttachmentPreview(path);
  }
}

// Composer tiles show 56px squares. Full-size photos there (12-48MP) thrash
// the browser's decode cache and make typing lag, so tiles get small copies.
const THUMBNAIL_SIZE_PX = 168;
const MAX_THUMBNAILS = 48;
const THUMBNAIL_FETCH_TIMEOUT_MS = 15_000;

export interface AttachmentThumbnail {
  src: string;
  width: number;
  height: number;
}

const thumbnailsBySrc = new Map<string, Promise<AttachmentThumbnail | null>>();
let thumbnailQueue: Promise<unknown> = Promise.resolve();

export function canMakeAttachmentThumbnails(): boolean {
  return (
    canCreateObjectUrls() &&
    typeof createImageBitmap === "function" &&
    typeof document !== "undefined"
  );
}

/** Resolves a small square copy of an image, or null when it can't be made. */
export function getAttachmentThumbnail(
  src: string,
): Promise<AttachmentThumbnail | null> {
  const cached = thumbnailsBySrc.get(src);
  if (cached !== undefined) {
    return cached;
  }
  // Download in parallel with a timeout so one stuck request can't block the
  // rest; decode one at a time because each full-size decode briefly holds up
  // to ~200MB.
  const thumbnail = fetchImageBlob(src)
    .then((blob) => {
      if (blob === null) return null;
      const made = thumbnailQueue.then(() => makeAttachmentThumbnail(blob));
      thumbnailQueue = made.catch(() => null);
      return made;
    })
    .catch(() => null);
  thumbnailsBySrc.set(src, thumbnail);
  // Evicted copies keep their URLs: a mounted tile may still show one, and
  // each copy is only about 1KB.
  while (thumbnailsBySrc.size > MAX_THUMBNAILS) {
    const oldest = thumbnailsBySrc.keys().next();
    if (oldest.done) {
      break;
    }
    thumbnailsBySrc.delete(oldest.value);
  }
  return thumbnail;
}

async function fetchImageBlob(src: string): Promise<Blob | null> {
  const response = await fetch(src, {
    signal: AbortSignal.timeout(THUMBNAIL_FETCH_TIMEOUT_MS),
  });
  return response.ok ? await response.blob() : null;
}

async function makeAttachmentThumbnail(
  blob: Blob,
): Promise<AttachmentThumbnail | null> {
  const full = await createImageBitmap(blob);
  try {
    const { width, height } = full;
    const side = Math.min(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(THUMBNAIL_SIZE_PX, side);
    const context = canvas.getContext("2d");
    if (context === null || side === 0) {
      return null;
    }
    context.imageSmoothingQuality = "high";
    context.drawImage(
      full,
      (width - side) / 2,
      (height - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85),
    );
    return blob === null
      ? null
      : { src: URL.createObjectURL(blob), width, height };
  } finally {
    full.close();
  }
}
