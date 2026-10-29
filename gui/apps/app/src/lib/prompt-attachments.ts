import type { PromptInput } from "@cloudroom/domain";

interface PromptAttachmentCounts {
  webImages: number;
  localImages: number;
  localFiles: number;
  imageUrls?: string[];
  localImagePaths?: string[];
  localFilePaths?: string[];
}

export function collectPromptAttachments(
  input: PromptInput[],
): PromptAttachmentCounts | undefined {
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];

  for (const entry of input) {
    switch (entry.type) {
      case "text":
        break;
      case "image":
        webImages += 1;
        imageUrls.push(entry.url);
        break;
      case "localImage":
        localImages += 1;
        localImagePaths.push(entry.path);
        break;
      case "localFile":
        localFiles += 1;
        localFilePaths.push(entry.path);
        break;
    }
  }

  if (webImages === 0 && localImages === 0 && localFiles === 0) {
    return undefined;
  }

  return {
    webImages,
    localImages,
    localFiles,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(localImagePaths.length > 0 ? { localImagePaths } : {}),
    ...(localFilePaths.length > 0 ? { localFilePaths } : {}),
  };
}
