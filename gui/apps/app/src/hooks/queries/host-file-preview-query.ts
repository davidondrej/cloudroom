import { useQuery } from "@tanstack/react-query";
import { decodeBase64Bytes, encodeBase64Bytes } from "@/lib/base64-bytes";
import { sdk } from "@/lib/sdk";
import {
  buildFilePreview,
  getMediaFilePreviewType,
  isHtmlFilePreviewPath,
  normalizeFilePreviewMimeType,
  type FilePreview,
} from "@cloudroom/client-core";
import type { QueryOptions } from "./query-helpers";
import { hostFilePreviewQueryKey } from "./query-keys";
import { HEAVY_PAYLOAD_QUERY_POLICY } from "./query-policies";

function splitAbsoluteHostFilePath(path: string): {
  name: string;
  rootPath: string;
} {
  const lastSeparatorIndex = Math.max(
    path.lastIndexOf("/"),
    path.lastIndexOf("\\"),
  );
  const name = path.slice(lastSeparatorIndex + 1);
  let rootPath = path.slice(0, lastSeparatorIndex);
  if (lastSeparatorIndex === 0) rootPath = "/";
  if (/^[A-Za-z]:$/u.test(rootPath)) {
    rootPath = `${rootPath}${path[lastSeparatorIndex] ?? "\\"}`;
  }
  return { name, rootPath };
}

export function useHostFilePreview(
  hostId: string | null,
  path: string | null,
  options?: QueryOptions,
) {
  const enabled =
    (options?.enabled ?? true) && hostId !== null && path !== null;
  const activeHostId = enabled ? hostId : null;
  const activePath = enabled ? path : null;
  return useQuery<FilePreview>({
    queryKey: hostFilePreviewQueryKey(activeHostId, activePath),
    queryFn: async ({ signal }) => {
      if (activeHostId === null || activePath === null) {
        throw new Error("Host file preview target is incomplete");
      }
      const { name, rootPath } = splitAbsoluteHostFilePath(activePath);
      const previewLease = await sdk.files
        .createPreview({ hostId: activeHostId, rootPath, signal })
        .catch(() => null);
      signal.throwIfAborted();
      const previewUrl =
        previewLease === null
          ? null
          : `${previewLease.baseUrl}/${encodeURIComponent(name)}`;
      const mediaPreviewType = getMediaFilePreviewType(name);
      if (previewUrl !== null && mediaPreviewType !== null) {
        return { ...mediaPreviewType, name, path: activePath, url: previewUrl };
      }

      const response = await sdk.files.read({
        hostId: activeHostId,
        path: activePath,
        signal,
      });
      const contentBytes =
        response.contentEncoding === "base64"
          ? decodeBase64Bytes(response.content)
          : new TextEncoder().encode(response.content);
      const mimeType = normalizeFilePreviewMimeType(response.mimeType ?? null);
      const preview = buildFilePreview({
        contentBytes,
        mimeType,
        name,
        path: activePath,
        url: previewUrl ?? activePath,
      });
      if (
        previewUrl !== null ||
        (preview.kind !== "image" &&
          preview.kind !== "video" &&
          preview.kind !== "audio" &&
          !isHtmlFilePreviewPath(activePath))
      ) {
        return preview;
      }

      const base64Content =
        response.contentEncoding === "base64"
          ? response.content
          : encodeBase64Bytes(contentBytes);
      return {
        ...preview,
        url: `data:${mimeType};base64,${base64Content}`,
      };
    },
    enabled,
    staleTime: 30_000,
    ...HEAVY_PAYLOAD_QUERY_POLICY,
  });
}
