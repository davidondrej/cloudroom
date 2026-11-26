import {
  promptTextMentionSchema,
  type PromptInput,
  type PromptTextMention,
} from "@cloudroom/domain";
import {
  uploadedPromptAttachmentSchema,
  type UploadedPromptAttachment,
} from "@cloudroom/server-contract";
import { z } from "zod";
import {
  isAutomationPromptCommandResource,
  SUBMITTED_AUTOMATION_PROMPT_PREFIX,
} from "./automation-prompt.js";
import {
  formatSubmittedMessageContextParts,
  parseMessageContextNumber,
  splitMessageContextSegments,
  updateCodeFenceState,
  type CodeFenceState,
} from "./message-context.js";

export type PromptDraftAttachment = UploadedPromptAttachment;

/** Full text behind a short `<context> [label] </context>` line in the draft. */
export interface PromptDraftContext {
  label: string;
  text: string;
  mentions?: PromptTextMention[];
}

export interface PromptDraftState {
  text: string;
  mentions: PromptTextMention[];
  attachments: PromptDraftAttachment[];
  contexts?: PromptDraftContext[];
}

const promptDraftContextSchema = z
  .object({
    label: z.string(),
    text: z.string(),
    mentions: z.array(z.unknown()).optional(),
  })
  .transform(({ label, text, mentions }): PromptDraftContext => {
    const parsedMentions = (mentions ?? []).flatMap((item) => {
      const result = promptTextMentionSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
    return parsedMentions.length > 0
      ? { label, text, mentions: parsedMentions }
      : { label, text };
  });

const promptDraftStorageSchema = z.object({
  text: z.string().default(""),
  mentions: z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = promptTextMentionSchema.safeParse(item);
        return result.success ? [result.data] : [];
      }),
    ),
  attachments: z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = uploadedPromptAttachmentSchema.safeParse(item);
        return result.success ? [result.data] : [];
      }),
    ),
  contexts: z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = promptDraftContextSchema.safeParse(item);
        return result.success ? [result.data] : [];
      }),
    ),
});

export function emptyPromptDraftState(): PromptDraftState {
  return {
    text: "",
    mentions: [],
    attachments: [],
  };
}

function normalizeQuotedSelectionText(text: string): string {
  const lines = text.replace(/\r\n|\r/gu, "\n").split("\n");
  const normalizedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const previousLine = normalizedLines.at(-1);
    const nextLine = lines[index + 1];
    if (
      line.trim().length === 0 &&
      previousLine?.startsWith(">") === true &&
      nextLine?.startsWith(">") === true
    ) {
      continue;
    }
    normalizedLines.push(line);
  }

  return normalizedLines.join("\n").trim();
}

export function appendQuoteToDraftText(
  state: PromptDraftState,
  quotedText: string,
): PromptDraftState {
  const trimmed = normalizeQuotedSelectionText(quotedText);
  if (trimmed === "") return state;

  const block = trimmed
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  const text = state.text === "" ? `${block}\n` : `${state.text}\n${block}\n`;

  return { ...state, text };
}

function appendAttachmentsToDraft(
  state: PromptDraftState,
  attachments: readonly PromptDraftAttachment[],
): PromptDraftState {
  if (attachments.length === 0) {
    return state;
  }

  const existingAttachmentPaths = new Set(
    state.attachments.map((attachment) => attachment.path),
  );
  const mergedAttachments = [...state.attachments];
  for (const attachment of attachments) {
    if (existingAttachmentPaths.has(attachment.path)) {
      continue;
    }
    existingAttachmentPaths.add(attachment.path);
    mergedAttachments.push(attachment);
  }

  if (mergedAttachments.length === state.attachments.length) {
    return state;
  }

  return { ...state, attachments: mergedAttachments };
}

export function appendQuoteAndAttachmentsToDraft(
  state: PromptDraftState,
  quotedText: string,
  attachments: readonly PromptDraftAttachment[],
): PromptDraftState {
  return appendAttachmentsToDraft(
    appendQuoteToDraftText(state, quotedText),
    attachments,
  );
}

function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

export function messageContextLine(label: string): string {
  return `<context> ${label} </context>`;
}

export interface MessageContextLineRange {
  start: number;
  end: number;
  label: string;
}

const CONTEXT_LINE_PATTERN = /<context> (\[[^\]\n]+\]) <\/context>/gu;

/** Finds every `<context> [label] </context>` line outside fenced code blocks. */
export function findMessageContextLines(
  text: string,
): MessageContextLineRange[] {
  if (!text.includes("<context> [")) return [];

  const ranges: MessageContextLineRange[] = [];
  let fence: CodeFenceState | null = null;
  let lineStart = 0;

  while (lineStart < text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const rawEnd = lineEnd === -1 ? text.length : lineEnd;
    const lineContentEnd =
      rawEnd > lineStart && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    const nextFence = updateCodeFenceState(
      fence,
      text,
      lineStart,
      lineContentEnd,
    );
    if (nextFence !== fence || fence !== null) {
      fence = nextFence;
      lineStart = lineEnd === -1 ? text.length : lineEnd + 1;
      continue;
    }

    const line = text.slice(lineStart, lineContentEnd);
    if (line.includes("<context> [")) {
      for (const match of line.matchAll(CONTEXT_LINE_PATTERN)) {
        ranges.push({
          start: lineStart + match.index,
          end: lineStart + match.index + match[0].length,
          label: match[1]!,
        });
      }
    }
    lineStart = lineEnd === -1 ? text.length : lineEnd + 1;
  }

  return ranges;
}

function messageContextLabel(
  text: string,
  messageNumber: number | null,
): string {
  const words = countWords(text);
  return `[message${messageNumber === null ? "" : ` #${messageNumber}`} - ${words} ${words === 1 ? "word" : "words"}]`;
}

function arePromptTextMentionsEqual(
  left: readonly PromptTextMention[] | undefined,
  right: readonly PromptTextMention[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Picks a unique draft context label when two distinct quotes share a base label. */
function uniqueMessageContextLabel(
  baseLabel: string,
  text: string,
  mentions: readonly PromptTextMention[] | undefined,
  existingByLabel: ReadonlyMap<string, PromptDraftContext>,
  reservedLabels?: ReadonlySet<string>,
): string {
  const matchesExisting = (existing: PromptDraftContext) =>
    existing.text === text &&
    arePromptTextMentionsEqual(existing.mentions, mentions);

  if (!reservedLabels?.has(baseLabel)) {
    const direct = existingByLabel.get(baseLabel);
    if (!direct || matchesExisting(direct)) {
      return baseLabel;
    }
  }

  const prefix = baseLabel.endsWith("]") ? baseLabel.slice(0, -1) : baseLabel;
  const suffix = baseLabel.endsWith("]") ? "]" : "";
  for (let occurrence = 2; ; occurrence += 1) {
    const candidate = `${prefix} (${occurrence})${suffix}`;
    if (reservedLabels?.has(candidate)) continue;
    const existing = existingByLabel.get(candidate);
    if (!existing || matchesExisting(existing)) {
      return candidate;
    }
  }
}

/**
 * Adds a chat message as a short `<context> [message #7 - 494 words] </context>`
 * reply chip, followed by a newline so the user types on the next line. The full
 * text is kept in `contexts` and swapped in on send.
 */
export function appendMessageContextToDraft(
  state: PromptDraftState,
  messageText: string,
  messageNumber: number | null,
  attachments: readonly PromptDraftAttachment[] = [],
): PromptDraftState {
  const text = messageText.trim();
  if (text === "") return appendAttachmentsToDraft(state, attachments);

  const existingContexts = state.contexts ?? [];
  const existingByLabel = new Map(
    existingContexts.map((context) => [context.label, context]),
  );
  const label = uniqueMessageContextLabel(
    messageContextLabel(text, messageNumber),
    text,
    undefined,
    existingByLabel,
  );
  const separator = state.text === "" || state.text.endsWith("\n") ? "" : "\n";
  const contexts = existingContexts.filter(
    (context) => context.label !== label,
  );
  return appendAttachmentsToDraft(
    {
      ...state,
      text: `${state.text}${separator}${messageContextLine(label)}\n`,
      contexts: [...contexts, { label, text }],
    },
    attachments,
  );
}

/** Adds the number to a context that was added before its message number was known. */
export function numberMessageContextInDraft(
  state: PromptDraftState,
  messageText: string,
  messageNumber: number,
): PromptDraftState {
  const text = messageText.trim();
  const contexts = state.contexts ?? [];
  const matching = contexts.find(
    (context) =>
      context.text === text &&
      parseMessageContextNumber(context.label) === null,
  );
  if (!matching) return state;

  const oldLabel = matching.label;
  const otherByLabel = new Map(
    contexts
      .filter((context) => context.label !== oldLabel)
      .map((context) => [context.label, context]),
  );
  const label = uniqueMessageContextLabel(
    messageContextLabel(text, messageNumber),
    matching.text,
    matching.mentions,
    otherByLabel,
  );
  return {
    ...state,
    text: state.text.replaceAll(
      messageContextLine(oldLabel),
      messageContextLine(label),
    ),
    contexts: contexts.flatMap((context) =>
      context.label === label
        ? []
        : context.label === oldLabel
          ? [{ ...context, label }]
          : [context],
    ),
  };
}

function endsInsideCodeFence(text: string): boolean {
  let fence: CodeFenceState | null = null;
  let start = 0;
  for (const line of text.split("\n")) {
    const end = start + line.length - (line.endsWith("\r") ? 1 : 0);
    fence = updateCodeFenceState(fence, text, start, end);
    start += line.length + 1;
  }
  return fence !== null;
}

/**
 * Puts a failed send back above what the user wrote since. Quotes keep their own
 * bodies: a colliding label in `current` is renamed and later mentions shift.
 * Null when `failed` ends inside an open code fence, which would swallow `current`.
 */
export function prependPromptDraft(
  failed: PromptDraftState,
  current: PromptDraftState,
): PromptDraftState | null {
  if (endsInsideCodeFence(failed.text)) return null;
  const byLabel = new Map((failed.contexts ?? []).map((c) => [c.label, c]));
  const reserved = new Set((current.contexts ?? []).map((c) => c.label));
  const renames = new Map<string, string>();
  for (const context of current.contexts ?? []) {
    const label = uniqueMessageContextLabel(
      context.label,
      context.text,
      context.mentions,
      byLabel,
      new Set([...reserved].filter((other) => other !== context.label)),
    );
    if (label !== context.label) renames.set(context.label, label);
    byLabel.set(label, { ...context, label });
  }
  let text = "";
  let last = 0;
  const shifts: { at: number; delta: number }[] = [];
  for (const line of findMessageContextLines(current.text)) {
    const label = renames.get(line.label);
    if (label === undefined) continue;
    const next = messageContextLine(label);
    text += current.text.slice(last, line.start) + next;
    last = line.end;
    shifts.push({
      at: line.end,
      delta: (shifts.at(-1)?.delta ?? 0) + next.length - (line.end - line.start),
    });
  }
  text += current.text.slice(last);
  const offset = failed.text.length + 2;
  const shiftAt = (index: number) =>
    offset + (shifts.filter((shift) => shift.at <= index).at(-1)?.delta ?? 0);
  const paths = new Set(failed.attachments.map((attachment) => attachment.path));
  const contexts = [...byLabel.values()];
  return {
    text: `${failed.text}\n\n${text}`,
    mentions: [
      ...failed.mentions,
      ...current.mentions.map((mention) => ({
        ...mention,
        start: mention.start + shiftAt(mention.start),
        end: mention.end + shiftAt(mention.start),
      })),
    ],
    attachments: [
      ...failed.attachments,
      ...current.attachments.filter((attachment) => !paths.has(attachment.path)),
    ],
    ...(contexts.length > 0 ? { contexts } : {}),
  };
}

export function isPromptDraftEmpty(draft: PromptDraftState): boolean {
  return (
    draft.text.length === 0 &&
    draft.mentions.length === 0 &&
    draft.attachments.length === 0
  );
}

export function parsePromptDraftStorage(
  rawValue: string | null,
): PromptDraftState {
  if (!rawValue) return emptyPromptDraftState();

  try {
    const parsed: unknown = JSON.parse(rawValue);
    const result = promptDraftStorageSchema.safeParse(parsed);
    if (!result.success) return emptyPromptDraftState();
    const { contexts, ...draft } = result.data;
    return contexts.length > 0 ? { ...draft, contexts } : draft;
  } catch {
    return emptyPromptDraftState();
  }
}

export function serializePromptDraftStorage(
  draft: PromptDraftState,
): string | null {
  const text = draft.text;
  const mentions = draft.mentions;
  const attachments = draft.attachments;
  const contexts = draft.contexts ?? [];
  if (isPromptDraftEmpty(draft)) {
    return null;
  }
  return JSON.stringify({
    text,
    ...(mentions.length > 0 ? { mentions } : {}),
    attachments,
    ...(contexts.length > 0 ? { contexts } : {}),
  });
}

export function arePromptDraftStatesEqual(
  left: PromptDraftState,
  right: PromptDraftState,
): boolean {
  return (
    serializePromptDraftStorage(left) === serializePromptDraftStorage(right)
  );
}

function getFileNameFromPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) {
    return "Attachment";
  }

  const segments = trimmedPath.split("/");
  const lastSegment = segments[segments.length - 1];
  return lastSegment && lastSegment.length > 0 ? lastSegment : trimmedPath;
}

export function normalizePromptTextMentions(
  mentions: readonly PromptTextMention[],
  textLength: number,
): PromptTextMention[] {
  return mentions
    .filter(
      (mention) =>
        mention.start >= 0 &&
        mention.end > mention.start &&
        mention.end <= textLength,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

interface ExpandedPromptText {
  text: string;
  mentions: PromptTextMention[];
}

interface PromptTextReplacement {
  start: number;
  end: number;
  text: string;
  mentions?: readonly PromptTextMention[];
}

function automationPromptCommandReplacements(
  mentions: readonly PromptTextMention[],
): PromptTextReplacement[] {
  return mentions
    .filter((mention) => isAutomationPromptCommandResource(mention.resource))
    .map((mention) => ({
      start: mention.start,
      end: mention.end,
      text: SUBMITTED_AUTOMATION_PROMPT_PREFIX,
    }));
}

function messageContextReplacements(
  text: string,
  contexts: readonly PromptDraftContext[],
): PromptTextReplacement[] {
  if (contexts.length === 0) return [];
  const contextsByLabel = new Map(
    contexts.map((context) => [context.label, context]),
  );
  const replacements: PromptTextReplacement[] = [];
  for (const line of findMessageContextLines(text)) {
    const context = contextsByLabel.get(line.label);
    if (!context) continue;
    const formatted = formatSubmittedMessageContextParts(
      context.text,
      context.label,
    );
    const mentions = context.mentions?.map((mention) => ({
      ...mention,
      start: formatted.bodyOffset + mention.start,
      end: formatted.bodyOffset + mention.end,
    }));
    replacements.push({
      start: line.start,
      end: line.end,
      text: formatted.text,
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
    });
  }
  return replacements;
}

/** Applies non-overlapping replacements, dropping mentions inside them, restoring replacement mentions, and shifting the rest. */
function applyPromptTextReplacements(
  text: string,
  mentions: readonly PromptTextMention[],
  replacements: readonly PromptTextReplacement[],
): ExpandedPromptText {
  if (replacements.length === 0) {
    return { text, mentions: [...mentions] };
  }

  const applied: PromptTextReplacement[] = [];
  const insertedMentions: PromptTextMention[] = [];
  let cursor = 0;
  let nextText = "";
  for (const replacement of [...replacements].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (replacement.start < cursor) {
      continue;
    }
    applied.push(replacement);
    nextText += text.slice(cursor, replacement.start);
    const insertedStart = nextText.length;
    nextText += replacement.text;
    if (replacement.mentions) {
      for (const mention of replacement.mentions) {
        insertedMentions.push({
          ...mention,
          start: insertedStart + mention.start,
          end: insertedStart + mention.end,
        });
      }
    }
    cursor = replacement.end;
  }
  nextText += text.slice(cursor);

  const nextMentions = mentions.flatMap((mention) => {
    let offset = 0;
    for (const replacement of applied) {
      if (mention.start < replacement.end && mention.end > replacement.start) {
        return [];
      }
      if (replacement.end <= mention.start) {
        offset +=
          replacement.text.length - (replacement.end - replacement.start);
      }
    }

    return [
      {
        ...mention,
        start: mention.start + offset,
        end: mention.end + offset,
      },
    ];
  });

  return {
    text: nextText,
    mentions: normalizePromptTextMentions(
      [...nextMentions, ...insertedMentions],
      nextText.length,
    ),
  };
}

export function promptDraftToInput(draft: PromptDraftState): PromptInput[] {
  const input: PromptInput[] = [];

  const trimStartLength = draft.text.length - draft.text.trimStart().length;
  const trimEndIndex = draft.text.trimEnd().length;
  const text = draft.text.slice(trimStartLength, trimEndIndex);
  if (text.length > 0) {
    const mentions = normalizePromptTextMentions(
      draft.mentions.flatMap((mention) => {
        const visibleStart = Math.max(mention.start, trimStartLength);
        const visibleEnd = Math.min(mention.end, trimEndIndex);
        return visibleStart < visibleEnd
          ? [
              {
                ...mention,
                start: visibleStart - trimStartLength,
                end: visibleEnd - trimStartLength,
              },
            ]
          : [];
      }),
      text.length,
    );
    const expandedText = applyPromptTextReplacements(text, mentions, [
      ...automationPromptCommandReplacements(mentions),
      ...messageContextReplacements(text, draft.contexts ?? []),
    ]);
    input.push({
      type: "text",
      text: expandedText.text,
      mentions: expandedText.mentions,
    });
  }

  for (const attachment of draft.attachments) {
    if (attachment.type === "localImage") {
      input.push({
        type: "localImage",
        path: attachment.path,
      });
      continue;
    }

    input.push({
      type: "localFile",
      path: attachment.path,
      name: attachment.name,
      ...(attachment.sizeBytes > 0 ? { sizeBytes: attachment.sizeBytes } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    });
  }

  return input;
}

export function promptInputToDraft(
  input: readonly PromptInput[],
): PromptDraftState {
  const textSegments: string[] = [];
  const mentions: PromptTextMention[] = [];
  const attachments: PromptDraftState["attachments"] = [];
  const contextsByLabel = new Map<string, PromptDraftContext>();
  const reservedLabels = new Set<string>();
  const chunkSegments = input.map((chunk) =>
    chunk.type === "text" && chunk.text.trim().length > 0
      ? splitMessageContextSegments(chunk.text)
      : null,
  );
  for (const segments of chunkSegments) {
    if (!segments) continue;
    for (const segment of segments) {
      if (segment.kind !== "text") continue;
      for (const line of findMessageContextLines(segment.text)) {
        reservedLabels.add(line.label);
      }
    }
  }
  let textOffset = 0;

  for (const [chunkIndex, chunk] of input.entries()) {
    if (chunk.type === "text") {
      const segments = chunkSegments[chunkIndex];
      if (segments) {
        if (textSegments.length > 0) {
          textOffset += 2;
        }
        const replacements: PromptTextReplacement[] = [];
        for (const segment of segments) {
          if (segment.kind !== "context") continue;
          const contextMentions = normalizePromptTextMentions(
            chunk.mentions.flatMap((mention) =>
              mention.start >= segment.bodyStart &&
              mention.end <= segment.bodyEnd
                ? [
                    {
                      ...mention,
                      start: mention.start - segment.bodyStart,
                      end: mention.end - segment.bodyStart,
                    },
                  ]
                : [],
            ),
            segment.text.length,
          );
          const label = uniqueMessageContextLabel(
            messageContextLabel(segment.text, segment.messageNumber),
            segment.text,
            contextMentions,
            contextsByLabel,
            reservedLabels,
          );
          if (!contextsByLabel.has(label)) {
            contextsByLabel.set(label, {
              label,
              text: segment.text,
              ...(contextMentions.length > 0
                ? { mentions: contextMentions }
                : {}),
            });
          }
          replacements.push({
            start: segment.start,
            end: segment.end,
            text: messageContextLine(label),
          });
        }
        const collapsed = applyPromptTextReplacements(
          chunk.text,
          chunk.mentions,
          replacements,
        );
        for (const mention of collapsed.mentions) {
          if (
            mention.start >= 0 &&
            mention.end > mention.start &&
            mention.end <= collapsed.text.length
          ) {
            mentions.push({
              ...mention,
              start: textOffset + mention.start,
              end: textOffset + mention.end,
            });
          }
        }
        textSegments.push(collapsed.text);
        textOffset += collapsed.text.length;
      }
      continue;
    }

    if (chunk.type === "localImage") {
      attachments.push({
        type: "localImage",
        path: chunk.path,
        name: getFileNameFromPath(chunk.path),
        sizeBytes: 0,
      });
      continue;
    }

    if (chunk.type === "localFile") {
      attachments.push({
        type: "localFile",
        path: chunk.path,
        name: chunk.name ?? getFileNameFromPath(chunk.path),
        sizeBytes: chunk.sizeBytes ?? 0,
        ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
      });
    }
  }

  const contexts: PromptDraftContext[] = [...contextsByLabel.values()];
  return {
    text: textSegments.join("\n\n"),
    mentions,
    attachments,
    ...(contexts.length > 0 ? { contexts } : {}),
  };
}

export function getProjectStoredPromptAttachmentPaths(
  attachments: readonly PromptDraftAttachment[],
): string[] {
  return [
    ...new Set(
      attachments.flatMap((attachment) => {
        const path = attachment.path;
        const isRuntimeReadable =
          /^[\\/]/u.test(path) ||
          /^[a-zA-Z]:[\\/]/u.test(path) ||
          /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path);
        return isRuntimeReadable ? [] : [path];
      }),
    ),
  ];
}
