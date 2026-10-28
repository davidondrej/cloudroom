import { useEffect, useState } from "react";
import type { TimelineConversationAttachments } from "@cloudroom/server-contract";
import { fileNameFromPath } from "@cloudroom/thread-view";
import {
  ImageLightbox,
  getWrappedImageIndex,
} from "../../ui/image-lightbox.js";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { buildProjectAttachmentContentUrl } from "@/lib/file-content-urls";
import { getLocalAttachmentAspectRatio } from "@/lib/attachment-local-previews";
import { AttachmentFileIcon } from "@/components/promptbox/AttachmentPreview";
import type {
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "./types.js";

interface ConversationImageItem {
  alt: string;
  aspectRatio?: number | null;
  src: string;
}

const FALLBACK_IMAGE_ASPECT_RATIO = 4 / 3;

export interface ConversationAttachmentItems {
  filePaths: string[];
  imageItems: ConversationImageItem[];
}

interface ConversationAttachmentsProps extends ConversationAttachmentItems {
  align?: "start" | "end";
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
}

interface BuildAttachmentItemsArgs {
  attachments: TimelineConversationAttachments | null;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
}

interface ProjectAttachmentHrefArgs {
  path: string;
  projectId: string | undefined;
}

interface PathClassificationArgs {
  path: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/u;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;

function isAbsoluteLocalPath({ path }: PathClassificationArgs): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(path);
}

function isProjectAttachmentPath({ path }: PathClassificationArgs): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("\\") &&
    !isAbsoluteLocalPath({ path }) &&
    !URL_SCHEME_PATTERN.test(path)
  );
}

function projectAttachmentHref({
  path,
  projectId,
}: ProjectAttachmentHrefArgs): string | null {
  if (!projectId || !isProjectAttachmentPath({ path })) {
    return null;
  }

  return buildProjectAttachmentContentUrl(projectId, path);
}

export function buildAttachmentItems({
  attachments,
  projectId,
  resolveUserAttachmentImageSrc,
}: BuildAttachmentItemsArgs): ConversationAttachmentItems {
  if (!attachments) {
    return {
      filePaths: [],
      imageItems: [],
    };
  }

  const imageItems: ConversationImageItem[] = [
    ...attachments.imageUrls.map((url) => ({
      alt: fileNameFromPath(url),
      src: url,
    })),
    ...attachments.localImagePaths.map((path) => ({
      alt: fileNameFromPath(path),
      aspectRatio: getLocalAttachmentAspectRatio(path),
      src: resolveUserAttachmentImageSrc
        ? resolveUserAttachmentImageSrc(path, projectId)
        : path,
    })),
  ];

  return {
    filePaths: attachments.localFilePaths,
    imageItems,
  };
}

export function ConversationAttachments({
  align = "start",
  filePaths,
  imageItems,
  onOpenLocalFileLink,
  projectId,
}: ConversationAttachmentsProps) {
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const currentImageItem =
    expandedImageIndex === null
      ? null
      : (imageItems[expandedImageIndex] ?? null);
  const hasMultipleImages = imageItems.length > 1;
  const justifyClassName = align === "end" ? "justify-end" : "justify-start";

  useEffect(() => {
    if (expandedImageIndex === null || expandedImageIndex < imageItems.length) {
      return;
    }
    setExpandedImageIndex(null);
  }, [expandedImageIndex, imageItems.length]);

  if (filePaths.length === 0 && imageItems.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2">
      {imageItems.length > 0 ? (
        <div className={cn("flex flex-wrap gap-2", justifyClassName)}>
          {imageItems.map((imageItem, index) => (
            <button
              type="button"
              key={`${imageItem.src}-${index}`}
              className={cn(
                "cursor-zoom-in overflow-hidden rounded-md border",
                align === "end"
                  ? "border-surface-selected-border bg-surface-raised"
                  : "border-border bg-surface-recessed",
              )}
              onClick={() => setExpandedImageIndex(index)}
              title={imageItem.alt}
            >
              <img
                src={imageItem.src}
                alt={imageItem.alt}
                className={cn(
                  "object-cover",
                  align === "end" ? "h-20 max-w-36" : "h-16 w-24",
                )}
                style={{
                  aspectRatio: `auto ${imageItem.aspectRatio ?? FALLBACK_IMAGE_ASPECT_RATIO}`,
                }}
                loading="lazy"
                decoding="async"
              />
            </button>
          ))}
        </div>
      ) : null}
      {filePaths.length > 0 ? (
        <div className={cn("flex flex-wrap gap-1.5", justifyClassName)}>
          {filePaths.map((path) => {
            const className = cn(
              "inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-foreground/10 px-2 text-xs text-foreground",
              align === "end" ? "bg-surface-raised" : "bg-surface-recessed",
            );
            const name = fileNameFromPath(path);
            const label = (
              <>
                <AttachmentFileIcon name={name} />
                <span className="truncate">{name}</span>
              </>
            );
            const attachmentHref = projectAttachmentHref({ path, projectId });

            if (attachmentHref) {
              return (
                <a
                  key={path}
                  href={attachmentHref}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    className,
                    "cursor-pointer hover:bg-state-hover",
                  )}
                >
                  {label}
                </a>
              );
            }

            if (!onOpenLocalFileLink || !isAbsoluteLocalPath({ path })) {
              return (
                <span key={path} className={cn(className, "cursor-default")}>
                  {label}
                </span>
              );
            }

            return (
              <button
                key={path}
                type="button"
                className={cn(className, "cursor-pointer hover:bg-state-hover")}
                onClick={() => {
                  onOpenLocalFileLink({ lineRange: null, path });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
      <ImageLightbox
        title="Attached image preview"
        imageSrc={currentImageItem?.src ?? null}
        imageAlt={currentImageItem?.alt ?? "Attached image"}
        hasMultipleImages={hasMultipleImages}
        onPrevious={() => {
          setExpandedImageIndex(
            expandedImageIndex === null || imageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "previous",
                  itemCount: imageItems.length,
                }),
          );
        }}
        onNext={() => {
          setExpandedImageIndex(
            expandedImageIndex === null || imageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "next",
                  itemCount: imageItems.length,
                }),
          );
        }}
        onClose={() => setExpandedImageIndex(null)}
      />
    </div>
  );
}
