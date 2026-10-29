import { useCallback, useRef, useState } from "react";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { BbHttpError } from "@/lib/sdk";
import type { PromptDraftAttachment } from "@cloudroom/client-core";
import {
  PROMPT_FILE_ATTACHMENT_LIMIT_BYTES,
  PROMPT_IMAGE_ATTACHMENT_LIMIT_BYTES,
} from "@cloudroom/domain";
import type { AttachmentFailure } from "@/components/promptbox/PromptBoxInternal";
import type { InlineComposerDraftSession } from "./useActiveComposerDraft";

interface UseComposerAttachmentUploadsArgs {
  projectId: string;
  addDraftAttachment: (attachment: PromptDraftAttachment) => void;
  inlineEditSessionId: number | null;
  inlineSessionRef: React.RefObject<InlineComposerDraftSession | null>;
}

interface UseComposerAttachmentUploadsResult {
  bottomAttachmentFailures: readonly AttachmentFailure[];
  dismissBottomAttachmentFailures: (index?: number) => void;
  handleAttachBottomFiles: (files: File[]) => Promise<void>;
  isAttachingBottomFiles: boolean;
  inlineAttachmentFailures: readonly AttachmentFailure[];
  dismissInlineAttachmentFailures: (index?: number) => void;
  handleAttachInlineFiles: (files: File[]) => Promise<void>;
  isAttachingInlineFiles: boolean;
}

interface DraftAttachmentUploadTarget {
  key: string;
  addAttachment: (attachment: PromptDraftAttachment) => void;
}

interface UseDraftAttachmentUploadsArgs {
  projectId: string;
  target: DraftAttachmentUploadTarget | null;
}

interface UseDraftAttachmentUploadsResult {
  attachmentFailures: readonly AttachmentFailure[];
  /** Dismisses one failed file, or all of them without an index. */
  dismissAttachmentFailures: (index?: number) => void;
  handleAttachFiles: (files: File[]) => Promise<void>;
  isAttachingFiles: boolean;
}

interface DraftAttachmentOperationState {
  failures: readonly AttachmentFailure[];
  pendingCount: number;
  targetKey: string | null;
}

function uploadRejectionReason(error: unknown): string {
  return error instanceof BbHttpError
    ? getMutationErrorMessage({ error, fallbackMessage: "Upload failed" })
    : "Upload failed";
}

/** Fails oversized files before uploading them. */
function oversizedFileReason(file: File): string | null {
  const limit = file.type.startsWith("image/")
    ? PROMPT_IMAGE_ATTACHMENT_LIMIT_BYTES
    : PROMPT_FILE_ATTACHMENT_LIMIT_BYTES;
  return file.size > limit
    ? `Too big, ${limit / (1024 * 1024)}MB max`
    : null;
}

const NO_FAILURES: readonly AttachmentFailure[] = [];

export function useDraftAttachmentUploads({
  projectId,
  target,
}: UseDraftAttachmentUploadsArgs): UseDraftAttachmentUploadsResult {
  const uploadPromptAttachment = useUploadPromptAttachment();
  const targetRef = useRef(target);
  targetRef.current = target;
  const [operation, setOperation] = useState<DraftAttachmentOperationState>({
    failures: [],
    pendingCount: 0,
    targetKey: null,
  });
  const targetKey = target?.key ?? null;
  const isCurrentOperation = operation.targetKey === targetKey;

  const dismissAttachmentFailures = useCallback(
    (index?: number) => {
      setOperation((current) => ({
        failures:
          index === undefined || current.targetKey !== targetKey
            ? []
            : current.failures.filter((_, i) => i !== index),
        pendingCount:
          current.targetKey === targetKey ? current.pendingCount : 0,
        targetKey,
      }));
    },
    [targetKey],
  );
  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      const activeTarget = targetRef.current;
      if (!activeTarget || files.length === 0) return;
      const capturedTargetKey = activeTarget.key;
      setOperation((current) => ({
        failures: [],
        pendingCount:
          current.targetKey === capturedTargetKey
            ? current.pendingCount + 1
            : 1,
        targetKey: capturedTargetKey,
      }));
      const failures: AttachmentFailure[] = [];
      try {
        for (const file of files) {
          const oversized = oversizedFileReason(file);
          if (oversized !== null) {
            failures.push({ name: file.name, reason: oversized });
            continue;
          }
          try {
            const uploaded = await uploadPromptAttachment.mutateAsync({
              projectId,
              file,
            });
            const currentTarget = targetRef.current;
            if (currentTarget?.key === capturedTargetKey) {
              currentTarget.addAttachment(uploaded);
            }
          } catch (error) {
            failures.push({ name: file.name, reason: uploadRejectionReason(error) });
          }
        }
      } finally {
        setOperation((current) =>
          current.targetKey === capturedTargetKey
            ? {
                failures:
                  failures.length > 0 &&
                  targetRef.current?.key === capturedTargetKey
                    ? failures
                    : current.failures,
                pendingCount: Math.max(0, current.pendingCount - 1),
                targetKey: capturedTargetKey,
              }
            : current,
        );
      }
    },
    [projectId, uploadPromptAttachment],
  );

  return {
    attachmentFailures: isCurrentOperation ? operation.failures : NO_FAILURES,
    dismissAttachmentFailures,
    handleAttachFiles,
    isAttachingFiles: isCurrentOperation && operation.pendingCount > 0,
  };
}

export function useComposerAttachmentUploads({
  projectId,
  addDraftAttachment,
  inlineEditSessionId,
  inlineSessionRef,
}: UseComposerAttachmentUploadsArgs): UseComposerAttachmentUploadsResult {
  const {
    attachmentFailures: bottomAttachmentFailures,
    dismissAttachmentFailures: dismissBottomAttachmentFailures,
    handleAttachFiles: handleAttachBottomFiles,
    isAttachingFiles: isAttachingBottomFiles,
  } = useDraftAttachmentUploads({
    projectId,
    target: { key: "bottom", addAttachment: addDraftAttachment },
  });
  const addInlineAttachment = useCallback(
    (uploaded: PromptDraftAttachment) => {
      const current = inlineSessionRef.current;
      if (current === null || current.editSessionId !== inlineEditSessionId) {
        return;
      }
      current.setDraft((draft) =>
        draft.attachments.some((existing) => existing.path === uploaded.path)
          ? draft
          : { ...draft, attachments: [...draft.attachments, uploaded] },
      );
    },
    [inlineEditSessionId, inlineSessionRef],
  );
  const {
    attachmentFailures: inlineAttachmentFailures,
    dismissAttachmentFailures: dismissInlineAttachmentFailures,
    handleAttachFiles: handleAttachInlineFiles,
    isAttachingFiles: isAttachingInlineFiles,
  } = useDraftAttachmentUploads({
    projectId,
    target:
      inlineEditSessionId !== null
        ? {
            key: String(inlineEditSessionId),
            addAttachment: addInlineAttachment,
          }
        : null,
  });

  return {
    bottomAttachmentFailures,
    dismissBottomAttachmentFailures,
    handleAttachBottomFiles,
    isAttachingBottomFiles,
    inlineAttachmentFailures,
    dismissInlineAttachmentFailures,
    handleAttachInlineFiles,
    isAttachingInlineFiles,
  };
}
