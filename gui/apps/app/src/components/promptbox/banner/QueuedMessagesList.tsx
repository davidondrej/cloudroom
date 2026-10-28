import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSenderThreadMetadataById } from "@/hooks/useSenderThreadMetadataById";
import { useSecondTick } from "@/hooks/useSecondTick";
import { usePluginDisplayName } from "@/lib/plugin-logos";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  describeQueuedMessageWait,
  formatQueuedMessageCountdown,
  isQueuedMessageSendNowAllowed,
  queuedMessageCountdownInstant,
  queuedMessageFallbackTitle,
  queuedMessageHasWaitLine,
  queuedMessageWaitIcon,
} from "@/lib/queued-message-wait";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type ClientRect,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Transform } from "@dnd-kit/utilities";
import type {
  PromptInput,
  PromptTextMention,
  ThreadQueuedMessage,
} from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import { PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS } from "@/components/promptbox/banner/prompt-banner-actions";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import { OverflowFade } from "@/components/ui/overflow-fade";
import { InlineMessageEditorFrame } from "@/components/promptbox/InlineMessageEditorFrame";
import { resolveAttachmentPreviewSrc } from "@/components/promptbox/AttachmentPreview";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  countQueuedMessageAttachments,
  formatQueuedMessagePreview,
} from "@cloudroom/client-core";
import type { QueuedMessageReorderRequest } from "@/lib/queued-message-reorder";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  PromptMentionPill,
  shiftMentionsToTextRange,
} from "@/components/thread/timeline/ConversationMessageMentions";
import {
  buildPromptMentionComponent,
  remarkPromptMentions,
  substitutePromptMentions,
} from "@/components/ui/markdown-prompt-mentions";
import { normalizePromptBlockquoteBoundaries } from "@/components/ui/markdown-prompt-blockquote-boundaries";
import {
  QueuedEditorTypeaheadLayoutContext,
  type QueuedEditorTypeaheadLayout,
} from "@/components/promptbox/queued-editor-typeahead-layout";

export type QueuedMessageProcessingAction = "send" | "edit" | "delete";
export type QueuedMessageSendAction = "send-now" | "steer-when-ready";

export interface QueuedMessageEditRequest {
  queuedMessageId: string;
  queuedMessageIndex: number;
}

export interface QueuedMessageInlineEditor {
  content: ReactNode;
  queuedMessageId: string;
  queuedMessageIndex: number;
  onDismiss: () => void;
}

export interface QueuedMessagesListProps {
  attachedToComposer: boolean;
  reorderable?: boolean;
  queuedMessages: readonly ThreadQueuedMessage[];
  resolveMentionLink?: PromptMentionLinkResolver;
  attachmentProjectId?: string;
  sendAction: QueuedMessageSendAction;
  sendDisabled: boolean;
  actionDisabled: boolean;
  processingMessageId: string | null;
  processingAction: QueuedMessageProcessingAction | null;
  inlineEditor?: QueuedMessageInlineEditor;
  onSend: (id: string) => void;
  onReorder: (request: QueuedMessageReorderRequest) => void;
  onEdit: (request: QueuedMessageEditRequest) => void;
  onDelete: (id: string) => void;
}

interface QueuedMessagesPendingCardProps {
  queuedMessageCount: number;
}

interface QueuedMessagePreviewText {
  mentions: PromptTextMention[];
  text: string;
}

interface QueuedMessageRowProps {
  senderLabel: string | null;
  queuedMessage: ThreadQueuedMessage;
  resolveMentionLink?: PromptMentionLinkResolver;
  attachmentProjectId?: string;
  index: number;
  isProcessing: boolean;
  processingLabel: string;
  dragDisabled: boolean;
  showDragHandle: boolean;
  sendAction: QueuedMessageSendAction;
  sendDisabled: boolean;
  actionDisabled: boolean;
  mobileActionsExpanded: boolean;
  onExpandMobileActions: (id: string) => void;
  onSend: (id: string) => void;
  onEdit: (request: QueuedMessageEditRequest) => void;
  onDelete: (id: string) => void;
  compact: boolean;
}

const COLLAPSED_HEIGHT = 36;
const DRAWER_HEIGHT = 123;
const DRAWER_MAX_VISIBLE_MESSAGES = 3;
const DRAWER_CHROME_HEIGHT = 1 + 12 + 1;
const DRAWER_LIST_PADDING = 2;
const DRAWER_ROW_HEIGHT = 29;
const DRAWER_SECOND_LINE_HEIGHT = 16;
const DRAWER_SENDER_PILL_LINE_HEIGHT = 22;
const DRAWER_IMAGE_ROW_EXTRA_HEIGHT = 4;
const WORKSPACE_MIN_HEIGHT = 240;
const WORKSPACE_MAX_HEIGHT = 360;
const WORKSPACE_CHROME_HEIGHT = 29;
const WORKSPACE_ROW_HEIGHT = 40;
const TYPEAHEAD_MENU_GAP = 8;
const SURFACE_DRAG_THRESHOLD = 72;
type QueueSurfaceMode = "collapsed" | "drawer" | "workspace";

function getDrawerHeight({
  queuedMessages,
  processingMessageId,
}: {
  queuedMessages: readonly ThreadQueuedMessage[];
  processingMessageId: string | null;
}): number {
  const rowsHeight =
    queuedMessages.length === 0
      ? DRAWER_ROW_HEIGHT
      : queuedMessages.reduce(
          (total, queuedMessage) =>
            total +
            DRAWER_ROW_HEIGHT +
            (queuedMessage.initiator !== "user" ||
            queuedMessageHasWaitLine(queuedMessage) ||
            queuedMessage.id === processingMessageId
              ? queuedMessage.initiator === "agent" &&
                queuedMessage.senderThreadId !== null
                ? DRAWER_SENDER_PILL_LINE_HEIGHT
                : DRAWER_SECOND_LINE_HEIGHT
              : 0) +
            (findQueuedMessageImagePath(queuedMessage) === null
              ? 0
              : DRAWER_IMAGE_ROW_EXTRA_HEIGHT),
          0,
        );
  return Math.min(
    DRAWER_HEIGHT,
    DRAWER_CHROME_HEIGHT + DRAWER_LIST_PADDING + rowsHeight,
  );
}

function findQueuedMessageImagePath(
  queuedMessage: ThreadQueuedMessage,
): string | null {
  for (const chunk of queuedMessage.content) {
    if (chunk.type === "localImage" && chunk.visibility !== "agent-only") {
      return chunk.path;
    }
  }
  return null;
}

function getPendingDrawerHeight(queuedMessageCount: number): number {
  return Math.min(
    DRAWER_HEIGHT,
    DRAWER_CHROME_HEIGHT +
      DRAWER_LIST_PADDING +
      Math.max(1, queuedMessageCount) * DRAWER_ROW_HEIGHT,
  );
}

function getWorkspaceHeight({
  messageCount,
}: {
  messageCount: number;
}): number {
  const estimatedHeight =
    WORKSPACE_CHROME_HEIGHT + Math.max(1, messageCount) * WORKSPACE_ROW_HEIGHT;
  return clamp(estimatedHeight, WORKSPACE_MIN_HEIGHT, WORKSPACE_MAX_HEIGHT);
}

export function getInlineEditorSurfaceMaxHeight({
  containerHeight,
  surfaceHeight,
  viewportHeight,
}: {
  containerHeight: number;
  surfaceHeight: number;
  viewportHeight: number;
}): number {
  const occupiedHeightOutsideQueue = Math.max(
    0,
    containerHeight - surfaceHeight,
  );
  return Math.max(
    COLLAPSED_HEIGHT,
    Math.floor(viewportHeight - occupiedHeightOutsideQueue),
  );
}

function queuedMarkdownPreviewClass(compact: boolean): string {
  return cn(
    "block min-w-0 truncate",
    compact ? "!text-xs !leading-4" : "!text-sm !leading-5",
  );
}

const QUEUED_MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkPromptMentions];

function compactInline(children: ReactNode): ReactElement {
  return <span>{children} </span>;
}

const QUEUED_MARKDOWN_COMPONENTS: Components = {
  a: ({ children }) => <span>{children}</span>,
  blockquote: ({ children }) => (
    <span className="inline border-l-2 border-surface-selected-border pl-2 text-muted-foreground">
      {children}
    </span>
  ),
  br: () => " ",
  code: ({ children }) => (
    <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs">
      {children}
    </code>
  ),
  h1: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h2: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h3: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h4: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h5: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h6: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  hr: () => " ",
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  li: ({ children }) => <span>{children} </span>,
  ol: ({ children }) => <span>{children}</span>,
  p: ({ children }) => compactInline(children),
  pre: ({ children }) => <span>{children}</span>,
  section: ({ children }) => <span>{children}</span>,
  table: ({ children }) => <span>{children}</span>,
  tbody: ({ children }) => <span>{children}</span>,
  td: ({ children }) => <span>{children} </span>,
  th: ({ children }) => <span>{children} </span>,
  thead: ({ children }) => <span>{children}</span>,
  tr: ({ children }) => <span>{children} </span>,
  ul: ({ children }) => <span>{children}</span>,
};

function CompactQueuedMarkdownPreview({
  compact,
  preview,
  resolveMentionLink,
}: {
  compact: boolean;
  preview: QueuedMessagePreviewText;
  resolveMentionLink?: PromptMentionLinkResolver;
}) {
  const promptMentionSubstitution = useMemo(
    () => substitutePromptMentions(preview.text, preview.mentions),
    [preview.mentions, preview.text],
  );
  const markdownContent = useMemo(
    () =>
      normalizePromptBlockquoteBoundaries(promptMentionSubstitution.content),
    [promptMentionSubstitution.content],
  );
  const components = useMemo<Components>(
    () => ({
      ...QUEUED_MARKDOWN_COMPONENTS,
      "bb-prompt-mention": buildPromptMentionComponent({
        mentions: promptMentionSubstitution.mentions,
        resolveMentionLink,
      }),
    }),
    [promptMentionSubstitution.mentions, resolveMentionLink],
  );

  return (
    <span className={queuedMarkdownPreviewClass(compact)}>
      <ReactMarkdown
        components={components}
        remarkPlugins={QUEUED_MARKDOWN_REMARK_PLUGINS}
      >
        {markdownContent}
      </ReactMarkdown>
    </span>
  );
}

export function resolveQueuedMessageDrag({
  activeId,
  orderedMessages,
  overId,
}: {
  activeId: string;
  orderedMessages: readonly ThreadQueuedMessage[];
  overId: string;
}): {
  request: QueuedMessageReorderRequest;
  orderedMessages: ThreadQueuedMessage[];
} | null {
  if (activeId === overId) {
    return null;
  }
  const oldIndex = orderedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === activeId,
  );
  const newIndex = orderedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === overId,
  );
  if (oldIndex === -1 || newIndex === -1) {
    return null;
  }

  const nextMessages = arrayMove([...orderedMessages], oldIndex, newIndex);
  return {
    orderedMessages: nextMessages,
    request: {
      queuedMessageId: activeId,
      previousQueuedMessageId: nextMessages[newIndex - 1]?.id ?? null,
      nextQueuedMessageId: nextMessages[newIndex + 1]?.id ?? null,
    },
  };
}

export function clampQueuedMessageDragTransform({
  draggingNodeRect,
  listRect,
  scrollRect,
  transform,
}: {
  draggingNodeRect: ClientRect | null;
  listRect: ClientRect | null;
  scrollRect: ClientRect | null;
  transform: Transform;
}): Transform {
  if (!draggingNodeRect || (!listRect && !scrollRect)) {
    return { ...transform, x: 0 };
  }

  const boundsTop = Math.max(
    listRect?.top ?? Number.NEGATIVE_INFINITY,
    scrollRect?.top ?? Number.NEGATIVE_INFINITY,
  );
  const boundsBottom = Math.min(
    listRect?.bottom ?? Number.POSITIVE_INFINITY,
    scrollRect?.bottom ?? Number.POSITIVE_INFINITY,
  );
  const minY = boundsTop - draggingNodeRect.top;
  const maxY = boundsBottom - draggingNodeRect.bottom;

  return {
    ...transform,
    x: 0,
    y: Math.min(Math.max(transform.y, minY), maxY),
  };
}

function visibleQueuedMessageTextChunks(
  input: readonly PromptInput[],
): Extract<PromptInput, { type: "text" }>[] {
  return input.filter(
    (chunk): chunk is Extract<PromptInput, { type: "text" }> =>
      chunk.type === "text" && chunk.visibility !== "agent-only",
  );
}

function shiftMentionsBy(
  mentions: readonly PromptTextMention[],
  offset: number,
): PromptTextMention[] {
  if (offset === 0) return [...mentions];
  return mentions.map((mention) => ({
    ...mention,
    start: mention.start + offset,
    end: mention.end + offset,
  }));
}

function trimQueuedMessagePreviewTextRange({
  mentions,
  rangeEnd,
  rangeStart,
  text,
}: {
  mentions: readonly PromptTextMention[];
  rangeEnd: number;
  rangeStart: number;
  text: string;
}): QueuedMessagePreviewText | null {
  const rawText = text.slice(rangeStart, rangeEnd);
  const leadingWhitespaceLength = rawText.length - rawText.trimStart().length;
  const trimmedRelativeEnd = rawText.trimEnd().length;
  if (trimmedRelativeEnd <= leadingWhitespaceLength) {
    return null;
  }

  const trimmedStart = rangeStart + leadingWhitespaceLength;
  const trimmedEnd = rangeStart + trimmedRelativeEnd;
  return {
    text: text.slice(trimmedStart, trimmedEnd),
    mentions: shiftMentionsToTextRange({
      mentions,
      rangeStart: trimmedStart,
      rangeEnd: trimmedEnd,
    }),
  };
}

function buildQueuedMessagePreviewText(
  input: readonly PromptInput[],
): QueuedMessagePreviewText {
  let text = "";
  const mentions: PromptTextMention[] = [];

  for (const chunk of visibleQueuedMessageTextChunks(input)) {
    const trimmedChunk = trimQueuedMessagePreviewTextRange({
      text: chunk.text,
      mentions: chunk.mentions,
      rangeStart: 0,
      rangeEnd: chunk.text.length,
    });
    if (!trimmedChunk) continue;

    const separator = text.length > 0 ? "\n\n" : "";
    const offset = text.length + separator.length;
    text += separator + trimmedChunk.text;
    mentions.push(...shiftMentionsBy(trimmedChunk.mentions, offset));
  }

  return { text, mentions };
}

function QueuedMessageFallbackTitle({
  compact,
  queuedMessage,
}: {
  compact: boolean;
  queuedMessage: ThreadQueuedMessage;
}) {
  const now = useSecondTick();
  const title = queuedMessageFallbackTitle({
    createdAt: queuedMessage.createdAt,
    now,
    payload: queuedMessage.payload,
  });
  return (
    <span className={queuedMarkdownPreviewClass(compact)} title={title}>
      {title}
    </span>
  );
}

function QueuedMessagePreview({
  compact,
  queuedMessage,
  resolveMentionLink,
}: {
  compact: boolean;
  queuedMessage: ThreadQueuedMessage;
  resolveMentionLink?: PromptMentionLinkResolver;
}) {
  const preview = useMemo(
    () =>
      formatQueuedMessagePreview(queuedMessage.content, {
        truncate: false,
      }),
    [queuedMessage.content],
  );
  const markdownPreview = useMemo(
    () => buildQueuedMessagePreviewText(queuedMessage.content),
    [queuedMessage.content],
  );

  if (queuedMessage.payload.kind === "retry") {
    return (
      <div className="min-w-0 flex-1 overflow-hidden text-foreground">
        <QueuedMessageFallbackTitle
          compact={compact}
          queuedMessage={queuedMessage}
        />
      </div>
    );
  }

  return (
    <div
      className="min-w-0 flex-1 overflow-hidden text-foreground"
      title={preview}
    >
      {markdownPreview.text.length > 0 ? (
        <CompactQueuedMarkdownPreview
          compact={compact}
          preview={markdownPreview}
          resolveMentionLink={resolveMentionLink}
        />
      ) : (
        <span className={queuedMarkdownPreviewClass(compact)}>{preview}</span>
      )}
    </div>
  );
}

function QueuedMessageWaitLine({
  pluginDisplayName,
  queuedMessage,
}: {
  pluginDisplayName: string;
  queuedMessage: ThreadQueuedMessage;
}) {
  const now = useSecondTick();
  const label = describeQueuedMessageWait({
    failureReason: queuedMessage.failureReason,
    now,
    payload: queuedMessage.payload,
    pluginDisplayName,
    sendAt: queuedMessage.sendAt,
    waitingOn: queuedMessage.waitingOn,
  });
  if (label === null) return null;
  const failed = queuedMessage.failureReason !== null;
  const icon = queuedMessageWaitIcon(queuedMessage);
  const countdownInstant = queuedMessageCountdownInstant(queuedMessage);
  const countdown =
    countdownInstant === null
      ? null
      : formatQueuedMessageCountdown(countdownInstant - now);
  return (
    <div
      data-queued-message-wait=""
      data-queued-message-failed={failed ? "" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-1 text-2xs",
        failed ? "text-destructive-text" : "text-subtle-foreground",
      )}
    >
      {icon !== null ? (
        <Icon name={icon} className="size-3 shrink-0" aria-hidden />
      ) : queuedMessage.waitingOn?.kind === "plugin" ? (
        <PluginIcon
          pluginId={queuedMessage.waitingOn.pluginId}
          icon={null}
          fallbackIcon={null}
          className="size-3"
        />
      ) : null}
      <span className="min-w-0 truncate">{label}</span>
      {countdown === null ? null : (
        <span className="shrink-0 tabular-nums">· {countdown}</span>
      )}
    </div>
  );
}

function QueuedMessageProcessingLine({ label }: { label: string }) {
  return (
    <div
      data-queued-message-processing=""
      className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
    >
      <Icon
        name="Spinner"
        className="size-3 shrink-0 animate-spin"
        aria-hidden
      />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function QueuedMessageImageThumbnail({
  src,
  attachmentCount,
}: {
  src: string;
  attachmentCount: number;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      data-queued-message-image=""
      className="relative mr-1.5 shrink-0"
      role="img"
      aria-label={
        attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`
      }
    >
      {failed ? (
        <span className="flex size-6 items-center justify-center rounded-[5px] border border-border bg-muted text-subtle-foreground">
          <Icon name="FileAttachment" className="size-3.5" aria-hidden />
        </span>
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="block size-6 rounded-[5px] border border-white/15 object-cover"
        />
      )}
      {attachmentCount > 1 ? (
        <span
          aria-hidden
          className="absolute bottom-px right-px rounded-[3px] bg-black/75 px-[3px] text-[9px] font-semibold leading-[11px] text-white tabular-nums"
        >
          +{attachmentCount - 1}
        </span>
      ) : null}
    </span>
  );
}

const QueuedMessageRow = memo(function QueuedMessageRow({
  senderLabel,
  queuedMessage,
  resolveMentionLink,
  attachmentProjectId,
  index,
  isProcessing,
  processingLabel,
  dragDisabled,
  showDragHandle,
  sendAction,
  sendDisabled,
  actionDisabled,
  mobileActionsExpanded,
  onExpandMobileActions,
  onSend,
  onEdit,
  onDelete,
  compact,
}: QueuedMessageRowProps) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const focusActionsOnExpandRef = useRef(false);
  useLayoutEffect(() => {
    if (!mobileActionsExpanded || !focusActionsOnExpandRef.current) return;
    focusActionsOnExpandRef.current = false;
    actionsRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [mobileActionsExpanded]);
  const attachmentCount = useMemo(
    () => countQueuedMessageAttachments(queuedMessage.content),
    [queuedMessage.content],
  );
  const imagePath = useMemo(
    () => findQueuedMessageImagePath(queuedMessage),
    [queuedMessage],
  );
  const pluginDisplayName = usePluginDisplayName(
    queuedMessage.waitingOn?.kind === "plugin"
      ? queuedMessage.waitingOn.pluginId
      : "",
  );
  const hasWaitLine = queuedMessageHasWaitLine(queuedMessage);
  const sendAllowed =
    sendAction === "steer-when-ready" ||
    isQueuedMessageSendNowAllowed(queuedMessage.waitingOn);
  const sendAriaLabel =
    sendAction === "steer-when-ready"
      ? `Steer queued message ${index + 1} when ready`
      : `Send queued message ${index + 1} now`;
  const sendLabel =
    sendAction === "steer-when-ready" ? "Steer when ready" : "Send now";
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: queuedMessage.id,
    disabled: dragDisabled,
  });
  const rowStyle = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={rowStyle}
      data-queued-message-row=""
      data-queued-message-id={queuedMessage.id}
      className={cn(
        "group/dispatch-row relative border-b border-transparent px-2.5",
        isDragging &&
          "z-20 rounded-lg border border-border bg-background opacity-90 shadow-lift",
      )}
    >
      <div className="flex items-center gap-1.5">
        {showDragHandle ? <Button
          ref={setActivatorNodeRef}
          type="button"
          variant="ghost"
          className={cn(
            "-ml-2 flex h-7 w-5 shrink-0 touch-none items-center justify-center rounded-md px-0.5 text-muted-foreground",
            !dragDisabled && "cursor-grab active:cursor-grabbing",
          )}
          disabled={dragDisabled}
          aria-label={`Reorder queued message ${index + 1}`}
          {...attributes}
          {...listeners}
        >
          <Icon
            name="DragDropVertical"
            className={cn(
              "size-3.5 shrink-0 opacity-35 transition-opacity",
              !dragDisabled &&
                "group-hover/dispatch-row:opacity-100 group-focus-within/dispatch-row:opacity-100 [@media(hover:none)]:opacity-100",
              isDragging && "opacity-100",
            )}
            aria-hidden="true"
          />
        </Button> : null}
        <div
          className={cn(
            "min-w-0 flex-1 py-1",
            (senderLabel !== null || hasWaitLine || isProcessing) && "py-1.5",
          )}
        >
          <div className="flex min-w-0 items-center gap-1">
            {queuedMessage.hardQueue === true ? (
              <span
                data-queued-message-hard-queue=""
                className="inline-flex shrink-0 text-subtle-foreground"
                role="img"
                aria-label="Hard Queue"
                title="Hard Queue: sends after all child threads finish"
              >
                <Icon name="Lock" className="size-3" aria-hidden />
              </span>
            ) : null}
            {imagePath === null ? null : (
              <QueuedMessageImageThumbnail
                src={resolveAttachmentPreviewSrc(imagePath, attachmentProjectId)}
                attachmentCount={attachmentCount}
              />
            )}
            <QueuedMessagePreview
              compact={compact}
              queuedMessage={queuedMessage}
              resolveMentionLink={resolveMentionLink}
            />
            {attachmentCount > 0 && imagePath === null ? (
              <span
                data-queued-message-attachment=""
                className={cn(
                  "ml-auto inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle-foreground opacity-70 transition-opacity duration-[120ms] ease-out",
                  !isProcessing &&
                    "group-hover/dispatch-row:opacity-0 group-focus-within/dispatch-row:opacity-0 [@media(hover:none)]:opacity-0",
                )}
                role="img"
                aria-label={
                  attachmentCount === 1
                    ? "1 attachment"
                    : `${attachmentCount} attachments`
                }
              >
                <Icon name="FileAttachment" className="size-3.5" aria-hidden />
                <span aria-hidden>{attachmentCount}</span>
              </span>
            ) : null}
          </div>
          {senderLabel !== null || isProcessing || hasWaitLine ? (
            <div
              data-queued-message-metadata=""
              className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-subtle-foreground"
            >
              {senderLabel === null ? null : (
                <span
                  data-queued-message-sender=""
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1",
                    (isProcessing || hasWaitLine) && "max-w-[40%] shrink-0",
                  )}
                  title={`From ${senderLabel}`}
                >
                  <span className="shrink-0">From</span>
                  {queuedMessage.initiator === "agent" &&
                  queuedMessage.senderThreadId !== null ? (
                    <span className="flex min-w-0 [&>.prompt-mention-pill]:text-2xs">
                      <PromptMentionPill
                        interactive={false}
                        resource={{
                          kind: "thread",
                          threadId: queuedMessage.senderThreadId,
                          label: senderLabel,
                        }}
                        serializedText={`@thread:${queuedMessage.senderThreadId}`}
                      />
                    </span>
                  ) : (
                    <span className="min-w-0 truncate">{senderLabel}</span>
                  )}
                </span>
              )}
              {senderLabel !== null && (isProcessing || hasWaitLine) ? (
                <span aria-hidden className="shrink-0">
                  ·
                </span>
              ) : null}
              {isProcessing ? (
                <QueuedMessageProcessingLine label={processingLabel} />
              ) : hasWaitLine ? (
                <QueuedMessageWaitLine
                  pluginDisplayName={pluginDisplayName}
                  queuedMessage={queuedMessage}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {isProcessing ? null : (
          <>
            <TooltipProvider delayDuration={300}>
              <div
                ref={actionsRef}
                data-queued-message-actions=""
                className={cn(
                  PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS,
                  "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 items-center gap-0.5 rounded-md opacity-0 transition-opacity duration-[120ms] ease-out md:flex",
                  mobileActionsExpanded
                    ? "flex max-md:pointer-events-auto max-md:opacity-100"
                    : "max-md:hidden",
                  "group-hover/dispatch-row:pointer-events-auto group-hover/dispatch-row:opacity-100",
                  "group-focus-within/dispatch-row:pointer-events-auto group-focus-within/dispatch-row:opacity-100",
                )}
              >
                {sendAllowed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={cn(
                          "shrink-0 text-muted-foreground",
                          compact ? "size-7" : "size-8",
                        )}
                        disabled={actionDisabled || sendDisabled}
                        onClick={() => onSend(queuedMessage.id)}
                        aria-label={sendAriaLabel}
                      >
                        <Icon name="Sent" className="size-4" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-md:hidden">
                      {sendLabel}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {queuedMessage.editable ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={cn(
                          "shrink-0 text-muted-foreground",
                          compact ? "size-7" : "size-8",
                        )}
                        disabled={actionDisabled}
                        onClick={() =>
                          onEdit({
                            queuedMessageId: queuedMessage.id,
                            queuedMessageIndex: index,
                          })
                        }
                        aria-label={`Edit queued message ${index + 1}`}
                      >
                        <Icon name="Edit" className="size-4" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-md:hidden">
                      Edit
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "shrink-0 text-muted-foreground hover:text-destructive max-md:text-destructive",
                        compact ? "size-7" : "size-8",
                      )}
                      disabled={actionDisabled}
                      onClick={() => onDelete(queuedMessage.id)}
                      aria-label={`Delete queued message ${index + 1}`}
                    >
                      <Icon name="Trash2" className="size-4" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-md:hidden">
                    Delete
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={cn(
                PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS,
                "pointer-events-none absolute right-2.5 top-1/2 shrink-0 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity duration-[120ms] ease-out md:hidden",
                "group-hover/dispatch-row:pointer-events-auto group-hover/dispatch-row:opacity-100",
                "group-focus-within/dispatch-row:pointer-events-auto group-focus-within/dispatch-row:opacity-100",
                "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
                compact ? "size-7" : "size-8",
                mobileActionsExpanded && "hidden",
              )}
              disabled={actionDisabled}
              aria-label={`Queued message ${index + 1} actions`}
              aria-expanded={mobileActionsExpanded}
              onClick={(event) => {
                focusActionsOnExpandRef.current = event.detail === 0;
                onExpandMobileActions(queuedMessage.id);
              }}
            >
              <Icon name="MoreHorizontal" className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </div>
    </li>
  );
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function findInlineEditorNeighborhood(list: HTMLUListElement): {
  editorElement: HTMLElement;
  firstElement: HTMLElement;
  lastElement: HTMLElement;
} | null {
  const editorElement = list.querySelector<HTMLElement>(
    "[data-queued-message-inline-editor]",
  );
  if (!editorElement) return null;

  const items = Array.from(list.children);
  const editorIndex = items.indexOf(editorElement);
  const previousRow = items
    .slice(0, editorIndex)
    .reverse()
    .find((item) => item.hasAttribute("data-queued-message-row"));
  const followingRow = items
    .slice(editorIndex + 1)
    .find((item) => item.hasAttribute("data-queued-message-row"));
  return {
    editorElement,
    firstElement: (previousRow ?? editorElement) as HTMLElement,
    lastElement: (followingRow ?? editorElement) as HTMLElement,
  };
}

function QueuedMessageInlineEditorSlot({
  editor,
}: {
  editor: QueuedMessageInlineEditor;
}) {
  const [typeaheadLayout, setTypeaheadLayout] =
    useState<QueuedEditorTypeaheadLayout>({ height: 0, isOpen: false });
  const typeaheadReservation = typeaheadLayout.isOpen
    ? Math.ceil(typeaheadLayout.height) + TYPEAHEAD_MENU_GAP
    : 0;
  return (
    <li
      data-queued-message-inline-editor=""
      className="relative z-10 border-b border-border/35 px-2.5 py-1 last:border-b-0"
    >
      <OverflowFade placement="above" tone="surface-raised" className="z-10" />
      <InlineMessageEditorFrame
        cancelLabel="Stop editing queued message"
        label={`Editing queued message ${editor.queuedMessageIndex + 1}`}
        onCancel={editor.onDismiss}
      >
        <QueuedEditorTypeaheadLayoutContext.Provider value={setTypeaheadLayout}>
          <div
            data-queued-editor-typeahead-reservation=""
            style={{ paddingTop: typeaheadReservation }}
          >
            {editor.content}
          </div>
        </QueuedEditorTypeaheadLayoutContext.Provider>
      </InlineMessageEditorFrame>
      <OverflowFade placement="below" tone="surface-raised" className="z-10" />
    </li>
  );
}

export function QueuedMessagesPendingCard({
  queuedMessageCount,
}: QueuedMessagesPendingCardProps) {
  return (
    <PromptStackCard
      ariaLabel="Queued messages"
      style={{ height: getPendingDrawerHeight(queuedMessageCount) }}
      className="relative z-10 mx-3 -mb-5 flex min-h-0 flex-col overflow-hidden rounded-xl rounded-b-none border-muted-foreground/15 border-b-0 bg-surface-raised-solid pb-3 sm:mx-4"
    >
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center gap-2 px-3 text-xs text-subtle-foreground"
      >
        <Icon name="Loading" className="size-3.5 animate-spin" aria-hidden />
        <span>Loading queued message details…</span>
      </div>
    </PromptStackCard>
  );
}

export function QueuedMessagesList({
  attachedToComposer,
  reorderable = true,
  queuedMessages,
  resolveMentionLink,
  attachmentProjectId,
  sendAction,
  sendDisabled,
  actionDisabled,
  processingMessageId,
  processingAction,
  inlineEditor,
  onSend,
  onReorder,
  onEdit,
  onDelete,
}: QueuedMessagesListProps) {
  const senderThreadMetadataById = useSenderThreadMetadataById();
  const processingLabel =
    processingAction === "edit"
      ? "Editing…"
      : processingAction === "delete"
        ? "Deleting…"
        : "Sending…";
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [mode, setMode] = useState<QueueSurfaceMode>(
    queuedMessages.length > 0 ? "drawer" : "collapsed",
  );
  const [expandedMobileActionsId, setExpandedMobileActionsId] = useState<
    string | null
  >(null);
  const [surfaceDragging, setSurfaceDragging] = useState(false);
  const [surfaceDragOffset, setSurfaceDragOffset] = useState(0);
  const [inlineEditorMaxHeight, setInlineEditorMaxHeight] = useState<
    number | null
  >(null);
  const [inlineEditorDesiredHeight, setInlineEditorDesiredHeight] = useState<
    number | null
  >(null);
  const inlineEditorActive = inlineEditor !== undefined;
  const getScrollElement = useBottomAnchoredScroll()?.getScrollElement;
  const surfaceRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const surfaceDragStartYRef = useRef(0);
  const surfaceDragOffsetRef = useRef(0);
  const surfaceDraggingRef = useRef(false);
  const wasInlineEditingRef = useRef(false);
  const inlineEditorDismissModeRef = useRef<QueueSurfaceMode | null>(null);
  const previousMessageCountRef = useRef(queuedMessages.length);
  useEffect(() => {
    if (expandedMobileActionsId === null) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !surfaceRef.current?.contains(event.target)
      ) {
        setExpandedMobileActionsId(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [expandedMobileActionsId]);
  const {
    aboveOverflow,
    belowOverflow,
    bottomSentinelRef,
    scrollRef,
    topSentinelRef,
  } = useScrollOverflowState<HTMLDivElement>({
    measureOverflow: true,
  });

  const scrollInlineEditorNeighborhoodIntoView = useCallback(() => {
    const list = listRef.current;
    const scroll = scrollRef.current;
    const neighborhood = list ? findInlineEditorNeighborhood(list) : null;
    if (!scroll || !neighborhood) return;

    const { editorElement, firstElement, lastElement } = neighborhood;
    const viewportRect = scroll.getBoundingClientRect();
    const firstRect = firstElement.getBoundingClientRect();
    const lastRect = lastElement.getBoundingClientRect();
    const neighborhoodHeight = lastRect.bottom - firstRect.top;
    let delta = 0;

    if (neighborhoodHeight <= viewportRect.height) {
      if (firstRect.top < viewportRect.top) {
        delta = firstRect.top - viewportRect.top;
      } else if (lastRect.bottom > viewportRect.bottom) {
        delta = lastRect.bottom - viewportRect.bottom;
      }
    } else {
      const editorRect = editorElement.getBoundingClientRect();
      if (editorRect.height > viewportRect.height) {
        delta = editorRect.top - viewportRect.top;
      } else if (editorRect.top < viewportRect.top) {
        delta = editorRect.top - viewportRect.top;
      } else if (editorRect.bottom > viewportRect.bottom) {
        delta = editorRect.bottom - viewportRect.bottom;
      }
    }
    if (delta !== 0) {
      scroll.scrollTop += delta;
    }
  }, [scrollRef]);

  const measureInlineEditorMaxHeight = useCallback(() => {
    if (!inlineEditorActive) {
      setInlineEditorMaxHeight(null);
      setInlineEditorDesiredHeight(null);
      return;
    }
    const viewport = getScrollElement?.();
    const surface = surfaceRef.current;
    const composerShell = surface?.closest<HTMLElement>("[data-app-composer]");
    const container = composerShell?.parentElement;
    if (!viewport || !surface || !container) {
      setInlineEditorMaxHeight(null);
      return;
    }

    const nextHeight = getInlineEditorSurfaceMaxHeight({
      containerHeight: container.getBoundingClientRect().height,
      surfaceHeight: surface.getBoundingClientRect().height,
      viewportHeight: viewport.clientHeight,
    });
    setInlineEditorMaxHeight((currentHeight) =>
      currentHeight === nextHeight ? currentHeight : nextHeight,
    );

    const list = listRef.current;
    const scroll = scrollRef.current;
    const neighborhood = list ? findInlineEditorNeighborhood(list) : null;
    if (!scroll || !neighborhood) {
      setInlineEditorDesiredHeight(null);
      return;
    }
    const { firstElement, lastElement } = neighborhood;
    const surfaceRect = surface.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const contentHeight =
      lastElement.getBoundingClientRect().bottom -
      firstElement.getBoundingClientRect().top;
    const chromeHeight = Math.max(0, surfaceRect.height - scrollRect.height);
    const desiredHeight = Math.max(
      WORKSPACE_MIN_HEIGHT,
      Math.ceil(contentHeight + chromeHeight),
    );
    setInlineEditorDesiredHeight((currentHeight) =>
      currentHeight === desiredHeight ? currentHeight : desiredHeight,
    );
    scrollInlineEditorNeighborhoodIntoView();
  }, [
    getScrollElement,
    inlineEditorActive,
    scrollInlineEditorNeighborhoodIntoView,
    scrollRef,
  ]);

  useLayoutEffect(() => {
    measureInlineEditorMaxHeight();
    if (!inlineEditorActive) return;

    const viewport = getScrollElement?.();
    const surface = surfaceRef.current;
    const composerShell = surface?.closest<HTMLElement>("[data-app-composer]");
    const container = composerShell?.parentElement;
    const animationFrame = window.requestAnimationFrame(
      measureInlineEditorMaxHeight,
    );
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measureInlineEditorMaxHeight);
    if (viewport) resizeObserver?.observe(viewport);
    if (surface) resizeObserver?.observe(surface);
    if (listRef.current) resizeObserver?.observe(listRef.current);
    const editorElement = listRef.current?.querySelector<HTMLElement>(
      "[data-queued-message-inline-editor]",
    );
    if (editorElement) resizeObserver?.observe(editorElement);
    if (composerShell) resizeObserver?.observe(composerShell);
    if (container) resizeObserver?.observe(container);
    window.addEventListener("resize", measureInlineEditorMaxHeight);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureInlineEditorMaxHeight);
    };
  }, [getScrollElement, inlineEditorActive, measureInlineEditorMaxHeight]);

  const [orderedMessages, setOrderedMessages] = useState(queuedMessages);
  const orderKey = queuedMessages
    .map(
      (queuedMessage) =>
        `${queuedMessage.id}:${queuedMessage.updatedAt}`,
    )
    .join("|");
  const [syncedOrderKey, setSyncedOrderKey] = useState(orderKey);
  if (orderKey !== syncedOrderKey) {
    setSyncedOrderKey(orderKey);
    setOrderedMessages(queuedMessages);
  }

  const sortingDisabled =
    !reorderable || actionDisabled || processingMessageId !== null || queuedMessages.length < 2;
  const sortableIds = useMemo(
    () =>
      orderedMessages
        .map((queuedMessage) => queuedMessage.id)
        .filter((id) => id !== inlineEditor?.queuedMessageId),
    [inlineEditor, orderedMessages],
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over) {
        return;
      }

      const dragResult = resolveQueuedMessageDrag({
        activeId: String(event.active.id),
        orderedMessages,
        overId: String(event.over.id),
      });
      if (!dragResult) return;

      setOrderedMessages(dragResult.orderedMessages);
      onReorder(dragResult.request);
    },
    [onReorder, orderedMessages],
  );
  const restrictToListBounds = useCallback<Modifier>(
    ({ draggingNodeRect, transform }) => {
      return clampQueuedMessageDragTransform({
        draggingNodeRect,
        listRect: listRef.current?.getBoundingClientRect() ?? null,
        scrollRect: scrollRef.current?.getBoundingClientRect() ?? null,
        transform,
      });
    },
    [scrollRef],
  );

  useEffect(() => {
    if (inlineEditor) {
      if (!wasInlineEditingRef.current) {
        inlineEditorDismissModeRef.current = null;
      }
      setMode("workspace");
    } else if (wasInlineEditingRef.current) {
      setMode(inlineEditorDismissModeRef.current ?? "drawer");
      inlineEditorDismissModeRef.current = null;
    }
    wasInlineEditingRef.current = inlineEditor !== undefined;
  }, [inlineEditor]);

  useEffect(() => {
    const previousMessageCount = previousMessageCountRef.current;
    previousMessageCountRef.current = queuedMessages.length;
    if (inlineEditorActive) {
      return;
    }
    if (
      queuedMessages.length !== 0 &&
      queuedMessages.length <= previousMessageCount
    ) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (queuedMessages.length === 0) {
        setMode("collapsed");
        return;
      }
      setMode((currentMode) =>
        currentMode === "collapsed" ? "drawer" : currentMode,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [inlineEditorActive, queuedMessages.length]);

  const openWorkspace = useCallback(() => {
    setMode("workspace");
    setSurfaceDragOffset(0);
    surfaceDragOffsetRef.current = 0;
  }, []);
  const dockWorkspace = useCallback(() => {
    setMode("drawer");
    inlineEditorDismissModeRef.current = "drawer";
    inlineEditor?.onDismiss();
    setSurfaceDragOffset(0);
    surfaceDragOffsetRef.current = 0;
  }, [inlineEditor]);
  const collapseDrawer = useCallback(() => {
    setExpandedMobileActionsId(null);
    setMode("collapsed");
    inlineEditorDismissModeRef.current = "collapsed";
    inlineEditor?.onDismiss();
    setSurfaceDragOffset(0);
    surfaceDragOffsetRef.current = 0;
  }, [inlineEditor]);
  const showDrawer = useCallback(() => {
    setMode("drawer");
    setSurfaceDragOffset(0);
    surfaceDragOffsetRef.current = 0;
  }, []);
  const handleEdit = useCallback(
    (request: QueuedMessageEditRequest) => {
      setExpandedMobileActionsId(null);
      openWorkspace();
      onEdit(request);
    },
    [onEdit, openWorkspace],
  );
  const handleSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      surfaceDragStartYRef.current = event.clientY;
      surfaceDragOffsetRef.current = 0;
      setSurfaceDragOffset(0);
      surfaceDraggingRef.current = true;
      setSurfaceDragging(true);
    },
    [],
  );
  const handleSurfacePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!surfaceDraggingRef.current) return;
      const offset = surfaceDragStartYRef.current - event.clientY;
      surfaceDragOffsetRef.current = offset;
      setSurfaceDragOffset(offset);
    },
    [],
  );
  const finishSurfaceDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!surfaceDraggingRef.current) return;
      const offset =
        event.type === "pointerup"
          ? surfaceDragStartYRef.current - event.clientY
          : surfaceDragOffsetRef.current;
      surfaceDraggingRef.current = false;
      setSurfaceDragging(false);
      setSurfaceDragOffset(0);
      surfaceDragOffsetRef.current = 0;

      if (mode !== "workspace" && offset >= SURFACE_DRAG_THRESHOLD) {
        openWorkspace();
      } else if (mode === "workspace" && offset <= -SURFACE_DRAG_THRESHOLD) {
        dockWorkspace();
      } else if (mode === "drawer" && offset <= -SURFACE_DRAG_THRESHOLD) {
        collapseDrawer();
      }
    },
    [collapseDrawer, dockWorkspace, mode, openWorkspace],
  );
  const handleSurfaceKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        if (mode === "collapsed") showDrawer();
        else openWorkspace();
      } else if (event.key === "ArrowDown" || event.key === "Escape") {
        event.preventDefault();
        if (mode === "workspace") dockWorkspace();
        else collapseDrawer();
      }
    },
    [collapseDrawer, dockWorkspace, mode, openWorkspace, showDrawer],
  );

  const baseSurfaceHeight =
    inlineEditor || mode === "workspace"
      ? getWorkspaceHeight({
          messageCount: queuedMessages.length,
        })
      : mode === "drawer"
        ? getDrawerHeight({ queuedMessages, processingMessageId })
        : COLLAPSED_HEIGHT;
  const unconstrainedSurfaceHeight = surfaceDragging
    ? clamp(
        baseSurfaceHeight + surfaceDragOffset,
        COLLAPSED_HEIGHT,
        WORKSPACE_MAX_HEIGHT + 22,
      )
    : baseSurfaceHeight;
  const surfaceHeight =
    inlineEditor && inlineEditorMaxHeight !== null
      ? Math.min(
          inlineEditorDesiredHeight ?? unconstrainedSurfaceHeight,
          inlineEditorMaxHeight,
        )
      : unconstrainedSurfaceHeight;

  useLayoutEffect(() => {
    if (!inlineEditor) return;
    const animationFrame = window.requestAnimationFrame(() => {
      scrollInlineEditorNeighborhoodIntoView();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [inlineEditor, scrollInlineEditorNeighborhoodIntoView, surfaceHeight]);

  const queueItems: ReactNode[] = [];
  let messageIndex = 0;
  let inlineEditorInserted = false;
  for (const queuedMessage of orderedMessages) {
    if (
      inlineEditor &&
      !inlineEditorInserted &&
      queuedMessage.id === inlineEditor.queuedMessageId
    ) {
      queueItems.push(
        <QueuedMessageInlineEditorSlot
          key={`inline-editor:${inlineEditor.queuedMessageId}`}
          editor={inlineEditor}
        />,
      );
      inlineEditorInserted = true;
    }
    if (queuedMessage.id !== inlineEditor?.queuedMessageId) {
      queueItems.push(
        <QueuedMessageRow
          key={queuedMessage.id}
          queuedMessage={queuedMessage}
          senderLabel={
            queuedMessage.initiator === "system"
              ? "System"
              : queuedMessage.initiator === "agent"
                ? (senderThreadMetadataById.get(
                    queuedMessage.senderThreadId ?? "",
                  )?.title ??
                  queuedMessage.senderThreadId ??
                  "Agent")
                : null
          }
          resolveMentionLink={resolveMentionLink}
          attachmentProjectId={attachmentProjectId}
          index={messageIndex}
          isProcessing={processingMessageId === queuedMessage.id}
          processingLabel={processingLabel}
          dragDisabled={sortingDisabled || inlineEditor !== undefined}
          showDragHandle={reorderable}
          sendAction={sendAction}
          sendDisabled={sendDisabled}
          actionDisabled={actionDisabled}
          mobileActionsExpanded={expandedMobileActionsId === queuedMessage.id}
          onExpandMobileActions={setExpandedMobileActionsId}
          compact={mode !== "workspace"}
          onSend={onSend}
          onEdit={handleEdit}
          onDelete={onDelete}
        />,
      );
    }
    messageIndex += 1;
  }
  if (inlineEditor && !inlineEditorInserted) {
    queueItems.push(
      <QueuedMessageInlineEditorSlot
        key={`inline-editor:${inlineEditor.queuedMessageId}`}
        editor={inlineEditor}
      />,
    );
  }

  if (queuedMessages.length === 0 && !inlineEditor) return null;

  const queueFitsDrawer = queuedMessages.length <= DRAWER_MAX_VISIBLE_MESSAGES;
  const caretWillCollapse =
    mode === "workspace" || (mode === "drawer" && queueFitsDrawer);
  const caretLabel = caretWillCollapse
    ? "Collapse queued messages"
    : mode === "collapsed" && queueFitsDrawer
      ? "Show queued messages"
      : "Expand queued messages";
  const handleCaretClick = () => {
    if (caretWillCollapse) {
      collapseDrawer();
    } else if (mode === "drawer" || !queueFitsDrawer) {
      openWorkspace();
    } else {
      showDrawer();
    }
  };

  return (
    <PromptStackCard
      rootRef={surfaceRef}
      ariaLabel="Queued messages"
      style={{ height: surfaceHeight }}
      className={cn(
        "relative z-10 mx-3 flex min-h-0 flex-col border-muted-foreground/15 bg-surface-raised-solid sm:mx-4",
        inlineEditor || !attachedToComposer
          ? "mb-0 rounded-xl pb-4"
          : "-mb-5 rounded-xl rounded-b-none border-b-0 pb-3",
        !surfaceDragging &&
          "transition-[height,margin,border-radius,padding] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-x-2 top-0 z-30 flex h-5 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-60",
          (mode === "collapsed" || surfaceDragging) && "opacity-100",
        )}
        data-queued-messages-mode={mode}
      >
        <button
          type="button"
          className={cn(
            "group/handle pointer-events-auto flex h-full w-16 touch-none select-none items-center justify-center rounded-full bg-surface-raised-solid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            surfaceDragging ? "cursor-grabbing" : "cursor-grab",
          )}
          aria-label={
            mode === "workspace"
              ? "Drag down to dock the queue"
              : "Drag up to open the queue workspace"
          }
          onPointerDown={handleSurfacePointerDown}
          onPointerMove={handleSurfacePointerMove}
          onPointerUp={finishSurfaceDrag}
          onPointerCancel={finishSurfaceDrag}
          onKeyDown={handleSurfaceKeyDown}
        >
          <span className="h-px w-7 rounded-full bg-muted-foreground opacity-30 transition-opacity group-hover/handle:opacity-50 group-focus-visible/handle:opacity-50" />
        </button>
        <div className="pointer-events-auto absolute right-0 flex items-center gap-1 rounded-full bg-surface-raised-solid">
          {mode === "collapsed" ? (
            <span className="pl-2 text-2xs tabular-nums text-subtle-foreground">
              {queuedMessages.length}
            </span>
          ) : null}
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className={cn(
                    "h-5 rounded-full text-muted-foreground hover:bg-surface-recessed",
                    PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS,
                  )}
                  onClick={handleCaretClick}
                  aria-label={caretLabel}
                  aria-expanded={mode !== "collapsed"}
                >
                  <Icon
                    name={caretWillCollapse ? "ChevronDown" : "ChevronUp"}
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-md:hidden">
                {caretLabel}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-t-[inherit]"
        data-queued-messages-scroll-frame=""
        hidden={mode === "collapsed"}
        aria-hidden={mode === "collapsed"}
        inert={mode === "collapsed" ? true : undefined}
      >
        <div
          ref={scrollRef}
          data-queued-messages-scroll=""
          className="h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain"
          tabIndex={mode === "collapsed" ? -1 : 0}
        >
          <div ref={topSentinelRef} aria-hidden className="h-px w-full" />
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToListBounds]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortableIds}
              strategy={verticalListSortingStrategy}
            >
              <ul ref={listRef} className="pt-0.5">
                {queueItems}
              </ul>
            </SortableContext>
          </DndContext>
          <div
            ref={bottomSentinelRef}
            aria-hidden
            className="-mt-px h-px w-full"
          />
        </div>
        {aboveOverflow && mode !== "collapsed" ? (
          <OverflowFade
            placement="above"
            tone="surface-raised"
            inset
            className="z-10"
          />
        ) : null}
        {belowOverflow && mode !== "collapsed" ? (
          <OverflowFade
            placement="below"
            tone="surface-raised"
            inset
            className="z-10"
          />
        ) : null}
      </div>
    </PromptStackCard>
  );
}
