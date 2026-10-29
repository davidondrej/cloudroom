import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  getWrappedImageIndex,
  ImageLightbox,
} from "@/components/ui/image-lightbox.js";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import type { PromptDraftAttachment } from "@cloudroom/client-core";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";
import {
  getLocalAttachmentPreviewSrc,
  releaseLocalAttachmentPreview,
  rememberLocalAttachmentAspectRatio,
} from "@/lib/attachment-local-previews";

export function resolveAttachmentPreviewSrc(
  path: string,
  attachmentProjectId: string | undefined,
): string {
  return (
    getLocalAttachmentPreviewSrc(path) ??
    toUserAttachmentImageSrc(path, attachmentProjectId)
  );
}

const FILE_TYPES: Array<[RegExp, IconName, string]> = [
  [/^pdf$/, "FileText", "text-red-400"],
  [/^(xlsx?|csv|tsv|numbers|ods)$/, "FileSpreadsheet", "text-emerald-400"],
  [/^(zip|tar|gz|tgz|rar|7z|bz2|xz)$/, "FileZip", "text-amber-400"],
  [/^(docx?|rtf|pages|odt|pptx?|key)$/, "FileText", "text-sky-400"],
  [/^(mp3|wav|m4a|aac|flac|ogg)$/, "FileAudio", "text-pink-400"],
  [/^(mp4|mov|webm|mkv|avi)$/, "FileVideo", "text-pink-400"],
  [
    /^(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|sql|json|ya?ml|toml|xml|html?|css|scss|vue|svelte)$/,
    "FileCode",
    "text-violet-400",
  ],
];

export function AttachmentFileIcon({ name }: { name: string }) {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const match = FILE_TYPES.find(([pattern]) => pattern.test(extension));
  return (
    <Icon
      name={match?.[1] ?? "FileText"}
      className={`size-4 shrink-0 ${match?.[2] ?? "text-muted-foreground"}`}
    />
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageAttachment(attachment: PromptDraftAttachment): boolean {
  return (
    attachment.type === "localImage" ||
    attachment.mimeType?.toLowerCase().startsWith("image/") === true
  );
}

/**
 * Counts images that are still uploading, so the composer can show a
 * placeholder tile for each until the real thumbnail lands.
 */
export function useUploadingImageCount(attachments: PromptDraftAttachment[]) {
  const [uploadingImageCount, setUploadingImageCount] = useState(0);
  const pendingUploadsRef = useRef(0);
  const imageCount = attachments.filter(isImageAttachment).length;
  const previousImageCountRef = useRef(imageCount);

  // Each landed image replaces one placeholder before paint, so no flash.
  useLayoutEffect(() => {
    const added = imageCount - previousImageCountRef.current;
    previousImageCountRef.current = imageCount;
    if (added > 0) {
      setUploadingImageCount((count) => Math.max(0, count - added));
    }
  }, [imageCount]);

  const trackUpload = useCallback(
    (files: File[], upload: void | Promise<void>) => {
      const images = files.filter((file) =>
        file.type.startsWith("image/"),
      ).length;
      if (images === 0) return;
      pendingUploadsRef.current += 1;
      setUploadingImageCount((count) => count + images);
      void Promise.resolve(upload).finally(() => {
        pendingUploadsRef.current -= 1;
        // Failed images never land, so clear leftovers once all uploads settle.
        if (pendingUploadsRef.current === 0) setUploadingImageCount(0);
      });
    },
    [],
  );

  return { uploadingImageCount, trackUpload };
}

interface AttachmentPreviewProps {
  attachments: PromptDraftAttachment[];
  uploadingImageCount?: number;
  compact?: boolean;
  attachmentProjectId?: string;
  expandedImageIndex: number | null;
  onExpandedImageIndexChange: (index: number | null) => void;
  onRemoveAttachment?: (path: string) => void;
}

export function AttachmentPreview({
  attachments,
  uploadingImageCount = 0,
  compact = false,
  attachmentProjectId,
  expandedImageIndex,
  onExpandedImageIndexChange,
  onRemoveAttachment,
}: AttachmentPreviewProps) {
  const imageAttachments = attachments.filter(isImageAttachment);
  const nonImageAttachments = attachments.filter(
    (attachment) => !isImageAttachment(attachment),
  );
  const attachmentImageItems = imageAttachments.map((attachment) => ({
    alt: attachment.name,
    src: resolveAttachmentPreviewSrc(attachment.path, attachmentProjectId),
  }));
  const hasMultipleAttachmentImages = imageAttachments.length > 1;
  const currentAttachmentImage =
    expandedImageIndex !== null
      ? (attachmentImageItems[expandedImageIndex] ?? null)
      : null;

  useEffect(() => {
    if (expandedImageIndex === null) return;
    if (expandedImageIndex < imageAttachments.length) return;
    onExpandedImageIndexChange(null);
  }, [expandedImageIndex, imageAttachments.length, onExpandedImageIndexChange]);

  if (attachments.length === 0 && uploadingImageCount === 0) {
    return null;
  }

  return (
    <>
      {compact ? (
        <span
          data-promptbox-attachments=""
          role="img"
          aria-label={`${attachments.length} ${attachments.length === 1 ? "attachment" : "attachments"}`}
          className="ml-3 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-surface-recessed px-2 text-xs text-muted-foreground"
        >
          <Icon name="Paperclip" className="size-3.5" />
          <span aria-hidden="true">{attachments.length}</span>
        </span>
      ) : (
        <div className="mx-3 mb-1 mt-1">
          {imageAttachments.length > 0 || uploadingImageCount > 0 ? (
            <div className="mb-1.5 flex flex-wrap gap-2">
              {imageAttachments.map((attachment, index) => (
                <div key={`${attachment.path}-${index}`} className="relative">
                  <button
                    type="button"
                    className="cursor-zoom-in overflow-hidden rounded-md border border-border bg-surface-recessed"
                    onClick={() => onExpandedImageIndexChange(index)}
                    title={attachment.name}
                  >
                    <img
                      src={attachmentImageItems[index]?.src}
                      alt={attachment.name}
                      className="h-16 w-24 object-cover"
                      loading="lazy"
                      decoding="async"
                      onLoad={(event) =>
                        rememberLocalAttachmentAspectRatio(
                          attachment.path,
                          event.currentTarget,
                        )
                      }
                    />
                  </button>
                  {onRemoveAttachment ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.currentTarget.blur();
                        releaseLocalAttachmentPreview(attachment.path);
                        onRemoveAttachment(attachment.path);
                      }}
                      className="group/attachment-remove-image absolute right-1 top-1 z-10 inline-flex size-4 items-center justify-center rounded-full text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:-right-1 max-md:pointer-coarse:-top-1 max-md:pointer-coarse:size-7"
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <span className="inline-flex size-4 items-center justify-center rounded-full bg-black/55 transition-colors group-hover/attachment-remove-image:bg-black/70">
                        <Icon name="X" className="size-3" />
                      </span>
                    </button>
                  ) : null}
                </div>
              ))}
              {Array.from({ length: uploadingImageCount }, (_, index) => (
                <div
                  key={`uploading-${index}`}
                  role="status"
                  aria-label="Uploading image"
                  className="flex h-16 w-24 items-center justify-center rounded-md border border-border bg-surface-recessed text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
                >
                  <Icon name="Spinner" className="size-4 animate-spin" />
                </div>
              ))}
            </div>
          ) : null}

          {nonImageAttachments.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {nonImageAttachments.map((attachment) => (
                <span
                  key={attachment.path}
                  className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-foreground/10 bg-surface-recessed pl-2 pr-1.5 text-xs text-foreground"
                >
                  <AttachmentFileIcon name={attachment.name} />
                  <span className="truncate">{attachment.name}</span>
                  <span className="shrink-0 text-subtle-foreground">
                    {formatFileSize(attachment.sizeBytes)}
                  </span>
                  {onRemoveAttachment ? (
                    <span className="relative size-4 shrink-0">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.currentTarget.blur();
                          onRemoveAttachment(attachment.path);
                        }}
                        className="group/attachment-remove-file absolute left-1/2 top-1/2 inline-flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-7"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <span className="inline-flex size-4 items-center justify-center rounded transition-colors group-hover/attachment-remove-file:bg-state-hover">
                          <Icon name="X" className="size-3" />
                        </span>
                      </button>
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}

      <ImageLightbox
        imageSrc={currentAttachmentImage?.src ?? null}
        imageAlt={currentAttachmentImage?.alt ?? "Attached image"}
        title="Attached image preview"
        hasMultipleImages={hasMultipleAttachmentImages}
        onPrevious={() => {
          onExpandedImageIndexChange(
            expandedImageIndex === null || attachmentImageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "previous",
                  itemCount: attachmentImageItems.length,
                }),
          );
        }}
        onNext={() => {
          onExpandedImageIndexChange(
            expandedImageIndex === null || attachmentImageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "next",
                  itemCount: attachmentImageItems.length,
                }),
          );
        }}
        onClose={() => onExpandedImageIndexChange(null)}
      />
    </>
  );
}
