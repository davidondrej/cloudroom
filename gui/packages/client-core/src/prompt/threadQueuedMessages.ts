import { type PromptInput } from "@cloudroom/domain";
import { fileNameFromPath } from "@cloudroom/thread-view";
import { splitMessageContextSegments } from "./message-context.js";
import { promptInputToDraft, type PromptDraftState } from "./prompt-draft.js";

const QUEUED_MESSAGE_PREVIEW_MAX_CHARS = 140;

interface FormatQueuedMessagePreviewOptions {
  parseContextBlocks?: boolean;
  truncate?: boolean;
}

function visibleQueuedMessageInput(
  input: readonly PromptInput[],
): PromptInput[] {
  return input.filter((chunk) => chunk.visibility !== "agent-only");
}

function getAttachmentNameFromPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) return "Attachment";
  return fileNameFromPath(trimmedPath);
}

export function countQueuedMessageAttachments(
  input: readonly PromptInput[],
): number {
  let count = 0;
  for (const chunk of visibleQueuedMessageInput(input)) {
    if (chunk.type === "localImage" || chunk.type === "localFile") {
      count += 1;
    }
  }
  return count;
}

function formatQueuedTextChunkForPreview(text: string): string {
  const segments = splitMessageContextSegments(text);
  if (!segments.some((segment) => segment.kind === "context")) {
    return text.trim();
  }

  const hasNonContextText = segments.some(
    (segment) => segment.kind === "text" && segment.text.trim().length > 0,
  );
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "context") {
      const ref =
        segment.messageNumber !== null ? `#${segment.messageNumber}` : "Quote";
      if (hasNonContextText) {
        parts.push(`[${ref}]`);
      } else {
        const excerpt = segment.text.replace(/\s+/gu, " ").trim();
        parts.push(excerpt ? `[${ref}] ${excerpt}` : `[${ref}]`);
      }
    } else {
      const trimmed = segment.text.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
    }
  }
  return parts.join(" ");
}

function getQueuedMessageVisibleText(
  input: readonly PromptInput[],
  parseContextBlocks: boolean,
): string {
  return visibleQueuedMessageInput(input)
    .filter(
      (chunk): chunk is Extract<PromptInput, { type: "text" }> =>
        chunk.type === "text",
    )
    .map((chunk) =>
      parseContextBlocks
        ? formatQueuedTextChunkForPreview(chunk.text)
        : chunk.text.trim(),
    )
    .filter((chunk) => chunk.length > 0)
    .join("\n\n");
}

export function formatQueuedMessagePreview(
  input: readonly PromptInput[],
  options: FormatQueuedMessagePreviewOptions = {},
): string {
  const visibleInput = visibleQueuedMessageInput(input);
  const text = getQueuedMessageVisibleText(
    visibleInput,
    options.parseContextBlocks !== false,
  );
  const trimmedText = text.replace(/\s+/g, " ").trim();
  if (trimmedText.length > 0) {
    if (
      options.truncate === false ||
      trimmedText.length <= QUEUED_MESSAGE_PREVIEW_MAX_CHARS
    ) {
      return trimmedText;
    }
    return `${trimmedText.slice(0, QUEUED_MESSAGE_PREVIEW_MAX_CHARS - 1)}...`;
  }

  const attachmentCount = countQueuedMessageAttachments(visibleInput);
  if (attachmentCount === 1) {
    const firstAttachment = visibleInput.find(
      (chunk) => chunk.type === "localImage" || chunk.type === "localFile",
    );
    if (firstAttachment) {
      if (firstAttachment.type === "localFile" && firstAttachment.name) {
        return `Attachment only (${firstAttachment.name})`;
      }
      return `Attachment only (${getAttachmentNameFromPath(
        firstAttachment.path,
      )})`;
    }
    return "Attachment only (1 file)";
  }
  if (attachmentCount > 1) {
    return `Attachment only (${attachmentCount} files)`;
  }

  return "(empty message)";
}

export function queuedInputToDraft(
  input: readonly PromptInput[],
): PromptDraftState {
  return promptInputToDraft(visibleQueuedMessageInput(input));
}
