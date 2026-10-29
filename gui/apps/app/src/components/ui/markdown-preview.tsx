import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { createPortal } from "react-dom";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@cloudroom/shared-ui/context-menu";
import type {
  Components,
  ExtraProps,
  Options as ReactMarkdownOptions,
  UrlTransform,
} from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { ImageLightbox, getWrappedImageIndex } from "./image-lightbox.js";
import { InlineImageGalleryContext } from "./inline-image-gallery-context.js";
import { remarkLineBreaks } from "./markdown-line-breaks.js";
import { normalizeMathFences } from "./markdown-math-fences.js";
import {
  markdownMayContainMath,
  useRehypeKatex,
  type RehypeKatex,
} from "./markdown-katex-loader.js";
import { CopyButton } from "./copy-button.js";
import { useClipboardCopy } from "@/lib/clipboard";
import { Icon } from "@cloudroom/shared-ui/icon";
import { usePortalScopeProps } from "@cloudroom/shared-ui/lib/portal-scope";
import { usePersistentOverlayFocus } from "@cloudroom/shared-ui/responsive-overlay";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { RouteAnchor } from "./app-route-anchor.js";
import {
  getMarkdownCodeLanguage,
  isMarkdownCodeBlock,
} from "./markdown-code-block.js";
import { highlightMarkdownCode } from "./markdown-code-highlight.js";
import "./markdown-code-highlight.css";
import { normalizeLocalFileMarkdownLinks } from "./markdown-local-file-link-normalize.js";
import {
  buildLocalFileAnchorHref,
  parseLocalFileHref,
  resolveRelativeLocalFileHref,
  type MarkdownAbsoluteLocalFileLinkRouting,
  type MarkdownPreviewLocalFileLink,
  type MarkdownRelativeLocalFileLinkRouting,
} from "./markdown-local-file-link.js";
import {
  MarkdownLocalFileContextMenuContext,
  type MarkdownLinkRouting,
  type MarkdownLocalFileContextMenuItem,
  type MarkdownLocalFileLinkRouting,
  type MarkdownLocalImageRouting,
} from "./markdown-link-routing.js";
import {
  buildThreadMentionComponent,
  remarkThreadMentions,
  splitRawThreadIdsInText,
} from "./markdown-thread-mentions.js";
import {
  buildPromptMentionComponent,
  remarkPromptMentions,
  substitutePromptMentions,
  type IndexedPromptMention,
  type MarkdownPromptMentions,
} from "./markdown-prompt-mentions.js";
import {
  buildMessageDirectiveComponent,
  EMPTY_MOUNTED_MESSAGE_DIRECTIVES,
  MESSAGE_DIRECTIVE_MOUNT_LIMIT,
  MessageDirectiveMountsContext,
  remarkMessageDirectives,
  type BuildMessageDirectiveComponentArgs,
  type MarkdownMessageDirectives,
  type MountedMessageDirective,
} from "./markdown-message-directives.js";
import {
  createMarkdownPieceCache,
  resolveMarkdownPieces,
  type MarkdownPieceRenderConfig,
} from "./markdown-incremental-pieces.js";
import { normalizePromptBlockquoteBoundaries } from "./markdown-prompt-blockquote-boundaries.js";
import { MarkdownMermaidDiagram } from "./markdown-mermaid-diagram.js";
import type { PromptTextMention } from "@cloudroom/domain";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { TimelineTitleLinkResolver } from "@/components/thread/timeline/TimelineTitleView.js";
import { useThreadFileExists } from "@/hooks/queries/host-path-queries";
import { useBrowserDimmingOverlay } from "@/hooks/useBrowserDimmingModal";
import { usePreferredTheme, type Theme } from "@/hooks/useTheme";
import {
  rewriteLocalhostLinkHref,
  useRewriteLocalhostLinksPreference,
} from "@/lib/localhost-link-rewrite-preference";
import { resolveRouteHref } from "@/lib/route-paths";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import remarkDirective from "remark-directive";
import { PromptMentionPill } from "@/components/thread/timeline/ConversationMessageMentions.js";
import {
  RawThreadMentionBatchProvider,
  useRawThreadMentionResources,
} from "@/components/thread/ThreadTitleMentions.js";

interface MarkdownPreviewProps {
  allowHtml?: boolean;
  className?: string;
  content: string;
  sourcePrefix?: string;
  imagePolicy?: MarkdownImagePolicy;
  incrementalBlocks?: boolean;
  linkRouting?: MarkdownLinkRouting;
  threadMentions?: MarkdownThreadMentions;
  promptMentions?: MarkdownPromptMentions;
  messageDirectives?: MarkdownMessageDirectives;
  urlTransform?: UrlTransform;
}

type MarkdownImagePolicy = "alt-text" | "render";

export interface MarkdownThreadMentions {
  mentions: readonly PromptTextMention[];
  preserveSoftBreaks: boolean;
  resolveLinkHref?: TimelineTitleLinkResolver;
}

interface MarkdownAnchorProps
  extends ComponentPropsWithoutRef<"a">, ExtraProps {
  linkRouting?: MarkdownLinkRouting;
  rewriteLocalhostLinks?: boolean;
}

interface IsMarkdownAppRouteHrefArgs {
  href: string | undefined;
}

interface BuildMarkdownComponentsArgs {
  imagePolicy: MarkdownImagePolicy;
  imageSourceOffset: number;
  linkRouting?: MarkdownLinkRouting;
  preferredTheme: Theme;
  rewriteLocalhostLinks: boolean;
  setExpandedImage: ExpandedMarkdownImageSetter;
  threadMentions?: MarkdownThreadMentions;
  promptMentions?: ResolvedPromptMentions;
  messageDirectives?: BuildMessageDirectiveComponentArgs;
}

interface ResolvedPromptMentions {
  mentions: readonly IndexedPromptMention[];
  resolveLinkHref?: TimelineTitleLinkResolver;
  resolveMentionLink?: PromptMentionLinkResolver;
}

interface BuildLocalAwareUrlTransformArgs {
  fallbackUrlTransform: UrlTransform | undefined;
  localFileRouting: MarkdownLocalFileLinkRouting | undefined;
  localImageRouting: MarkdownLocalImageRouting | undefined;
}

interface ResolvedMarkdownLocalFileTarget {
  href: string;
  link: MarkdownPreviewLocalFileLink;
  sourceKind: "absolute" | "relative";
}

interface MarkdownImageRendererArgs {
  alt: ComponentPropsWithoutRef<"img">["alt"];
  sourceOffset: number | undefined;
  imageAttributes: MarkdownImageRenderAttributes;
  setExpandedImage: ExpandedMarkdownImageSetter;
  src: ComponentPropsWithoutRef<"img">["src"];
}

interface ResolveMarkdownSourceMediaArgs {
  media: MarkdownSourceMedia;
  preferredTheme: Theme;
}

interface AreMarkdownAbsoluteLocalFileLinkRoutingsEqualArgs {
  next: MarkdownAbsoluteLocalFileLinkRouting | undefined;
  previous: MarkdownAbsoluteLocalFileLinkRouting | undefined;
}

interface AreMarkdownRelativeLocalFileLinkRoutingsEqualArgs {
  next: MarkdownRelativeLocalFileLinkRouting | undefined;
  previous: MarkdownRelativeLocalFileLinkRouting | undefined;
}

interface AreMarkdownLocalFileLinkRoutingsEqualArgs {
  next: MarkdownLocalFileLinkRouting | undefined;
  previous: MarkdownLocalFileLinkRouting | undefined;
}

interface AreMarkdownLocalImageRoutingsEqualArgs {
  next: MarkdownLocalImageRouting | undefined;
  previous: MarkdownLocalImageRouting | undefined;
}

interface AreMarkdownLinkRoutingsEqualArgs {
  next: MarkdownLinkRouting | undefined;
  previous: MarkdownLinkRouting | undefined;
}

interface AreMarkdownThreadMentionsEqualArgs {
  next: MarkdownThreadMentions | undefined;
  previous: MarkdownThreadMentions | undefined;
}

interface AreMarkdownPromptMentionsEqualArgs {
  next: MarkdownPromptMentions | undefined;
  previous: MarkdownPromptMentions | undefined;
}

interface AreMarkdownMessageDirectivesEqualArgs {
  next: MarkdownMessageDirectives | undefined;
  previous: MarkdownMessageDirectives | undefined;
}

interface ExpandedMarkdownImage {
  imageSources: readonly string[];
  index: number;
  url: string;
}

type ExpandedMarkdownImageSetter = Dispatch<
  SetStateAction<ExpandedMarkdownImage | null>
>;

type MarkdownPreviewPropsEqual = (
  previous: MarkdownPreviewProps,
  next: MarkdownPreviewProps,
) => boolean;
type MarkdownAnchorEvent = ReactMouseEvent<HTMLAnchorElement>;
type MarkdownBlockquoteProps = ComponentPropsWithoutRef<"blockquote"> &
  ExtraProps;
type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;
interface MarkdownCodeRendererProps extends MarkdownCodeProps {
  imagePolicy: MarkdownImagePolicy;
  linkRouting?: MarkdownLinkRouting;
  preferredTheme: Theme;
  rewriteLocalhostLinks: boolean;
}
type MarkdownHeadingProps = ComponentPropsWithoutRef<"h1"> & ExtraProps;
type MarkdownHrProps = ComponentPropsWithoutRef<"hr"> & ExtraProps;
type MarkdownImageProps = ComponentPropsWithoutRef<"img"> &
  ExtraProps & {
    "data-markdown-image-offset"?: number;
  };
type MarkdownImageRenderAttributes = Omit<
  MarkdownImageProps,
  "alt" | "children" | "className" | "node" | "src"
>;
type MarkdownListItemProps = ComponentPropsWithoutRef<"li"> & ExtraProps;
type MarkdownOrderedListProps = ComponentPropsWithoutRef<"ol"> & ExtraProps;
type MarkdownParagraphProps = ComponentPropsWithoutRef<"p"> & ExtraProps;
type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & ExtraProps;
type MarkdownSourceMedia = ComponentPropsWithoutRef<"source">["media"];
type MarkdownSourceProps = ComponentPropsWithoutRef<"source"> & ExtraProps;
type MarkdownTableProps = ComponentPropsWithoutRef<"table"> & ExtraProps;
type MarkdownTableCellProps = ComponentPropsWithoutRef<"td"> & ExtraProps;
type MarkdownTableHeadProps = ComponentPropsWithoutRef<"thead"> & ExtraProps;
type MarkdownTableHeaderProps = ComponentPropsWithoutRef<"th"> & ExtraProps;
type MarkdownUnorderedListProps = ComponentPropsWithoutRef<"ul"> & ExtraProps;
type MarkdownRehypePlugins = NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
type MarkdownRemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
interface MarkdownHastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: MarkdownHastNode[];
}

const MARKDOWN_TABLE_CLASS =
  "w-full border-separate border-spacing-0 text-[13px] leading-normal";
const MARKDOWN_TABLE_HEADER_CLASS =
  "whitespace-nowrap border-b border-foreground/10 bg-surface-recessed-solid text-left align-bottom text-xs font-medium text-muted-foreground/70";
const MARKDOWN_TABLE_CELL_CLASS =
  "border-b border-foreground/[0.07] align-top first:font-medium first:text-foreground";
const MARKDOWN_TABLE_STICKY_COLUMN_CLASS =
  "first:sticky first:left-0 first:shadow-[inset_-1px_0_0_color-mix(in_oklab,var(--foreground)_12%,transparent)]";
const MARKDOWN_TABLE_SHORT_CELL_LENGTH = 24;
const MarkdownTableExpandedContext = createContext(false);
const MARKDOWN_SOURCE_COLOR_SCHEME_MEDIA_PATTERN =
  /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/iu;
const MARKDOWN_HTML_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  rehypeRaw,
  rehypeSanitize,
];

const MARKDOWN_PLAIN_REHYPE_PLUGINS: MarkdownRehypePlugins = [];

function resolveRehypePlugins({
  allowHtml,
  rehypeKatex,
}: {
  allowHtml: boolean;
  rehypeKatex: RehypeKatex | null;
}): MarkdownRehypePlugins {
  const base = allowHtml
    ? MARKDOWN_HTML_REHYPE_PLUGINS
    : MARKDOWN_PLAIN_REHYPE_PLUGINS;
  return rehypeKatex === null ? base : [...base, rehypeKatex];
}

function areMarkdownAbsoluteLocalFileLinkRoutingsEqual({
  next,
  previous,
}: AreMarkdownAbsoluteLocalFileLinkRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "trusted-host" || next.kind === "trusted-host") {
    return true;
  }
  return previous.rootPath === next.rootPath;
}

function areMarkdownRelativeLocalFileLinkRoutingsEqual({
  next,
  previous,
}: AreMarkdownRelativeLocalFileLinkRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.baseDir === next.baseDir && previous.rootPath === next.rootPath
  );
}

function areMarkdownLocalFileLinkRoutingsEqual({
  next,
  previous,
}: AreMarkdownLocalFileLinkRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.onOpenLink === next.onOpenLink &&
    previous.threadId === next.threadId &&
    areMarkdownAbsoluteLocalFileLinkRoutingsEqual({
      next: next.absoluteLinks,
      previous: previous.absoluteLinks,
    }) &&
    areMarkdownRelativeLocalFileLinkRoutingsEqual({
      next: next.relativeLinks,
      previous: previous.relativeLinks,
    })
  );
}

function areMarkdownLocalImageRoutingsEqual({
  next,
  previous,
}: AreMarkdownLocalImageRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.resolveSrc === next.resolveSrc &&
    areMarkdownAbsoluteLocalFileLinkRoutingsEqual({
      next: next.absolutePaths,
      previous: previous.absolutePaths,
    }) &&
    areMarkdownRelativeLocalFileLinkRoutingsEqual({
      next: next.relativePaths,
      previous: previous.relativePaths,
    })
  );
}

function areMarkdownLinkRoutingsEqual({
  next,
  previous,
}: AreMarkdownLinkRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.onOpenLink === next.onOpenLink &&
    areMarkdownLocalFileLinkRoutingsEqual({
      next: next.localFile,
      previous: previous.localFile,
    }) &&
    areMarkdownLocalImageRoutingsEqual({
      next: next.localImage,
      previous: previous.localImage,
    })
  );
}

function areMarkdownThreadMentionsEqual({
  next,
  previous,
}: AreMarkdownThreadMentionsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.mentions === next.mentions &&
    previous.preserveSoftBreaks === next.preserveSoftBreaks &&
    previous.resolveLinkHref === next.resolveLinkHref
  );
}

function areMarkdownPromptMentionsEqual({
  next,
  previous,
}: AreMarkdownPromptMentionsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.mentions === next.mentions &&
    previous.resolveLinkHref === next.resolveLinkHref &&
    previous.resolveMentionLink === next.resolveMentionLink
  );
}

function areMarkdownMessageDirectivesEqual({
  next,
  previous,
}: AreMarkdownMessageDirectivesEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.registry === next.registry &&
    previous.openWorkspaceFile === next.openWorkspaceFile &&
    previous.openThreadPanel === next.openThreadPanel &&
    previous.message.id === next.message.id &&
    previous.message.threadId === next.message.threadId &&
    previous.message.turnId === next.message.turnId &&
    previous.message.projectId === next.message.projectId
  );
}

const areMarkdownPreviewPropsEqual: MarkdownPreviewPropsEqual = (
  previous,
  next,
) =>
  (previous.allowHtml ?? false) === (next.allowHtml ?? false) &&
  previous.className === next.className &&
  previous.content === next.content &&
  (previous.sourcePrefix ?? "") === (next.sourcePrefix ?? "") &&
  (previous.imagePolicy ?? "render") === (next.imagePolicy ?? "render") &&
  (previous.incrementalBlocks ?? false) === (next.incrementalBlocks ?? false) &&
  previous.urlTransform === next.urlTransform &&
  areMarkdownThreadMentionsEqual({
    next: next.threadMentions,
    previous: previous.threadMentions,
  }) &&
  areMarkdownPromptMentionsEqual({
    next: next.promptMentions,
    previous: previous.promptMentions,
  }) &&
  areMarkdownMessageDirectivesEqual({
    next: next.messageDirectives,
    previous: previous.messageDirectives,
  }) &&
  areMarkdownLinkRoutingsEqual({
    next: next.linkRouting,
    previous: previous.linkRouting,
  });

function isMarkdownAppRouteHref({ href }: IsMarkdownAppRouteHrefArgs): boolean {
  if (!href || typeof window === "undefined") {
    return false;
  }

  return (
    resolveRouteHref({
      currentOrigin: window.location.origin,
      href,
    }) !== null
  );
}

function resolveMarkdownLocalFileTarget(
  value: string,
  absolute: MarkdownAbsoluteLocalFileLinkRouting,
  relative: MarkdownRelativeLocalFileLinkRouting | undefined,
): ResolvedMarkdownLocalFileTarget | null {
  const absoluteLink = parseLocalFileHref({
    absoluteLinks: absolute,
    href: value,
  });
  if (absoluteLink !== null) {
    return {
      href: value,
      link: absoluteLink,
      sourceKind: "absolute",
    };
  }
  if (relative === undefined) {
    return null;
  }

  const resolvedHref = resolveRelativeLocalFileHref({
    href: value,
    ...relative,
  });
  if (resolvedHref === null) {
    return null;
  }
  const relativeLink = parseLocalFileHref({
    absoluteLinks: absolute,
    href: resolvedHref,
  });
  return relativeLink === null
    ? null
    : {
        href: resolvedHref,
        link: relativeLink,
        sourceKind: "relative",
      };
}

function buildLocalAwareUrlTransform({
  fallbackUrlTransform,
  localFileRouting,
  localImageRouting,
}: BuildLocalAwareUrlTransformArgs): UrlTransform {
  return (value, key, node) => {
    if (key === "href" && localFileRouting !== undefined) {
      const localFile = resolveMarkdownLocalFileTarget(
        value,
        localFileRouting.absoluteLinks,
        localFileRouting.relativeLinks,
      );
      if (localFile !== null) {
        return localFile.href;
      }
    }

    if (key === "src" && localImageRouting !== undefined) {
      const localImage = resolveMarkdownLocalFileTarget(
        value,
        localImageRouting.absolutePaths,
        localImageRouting.relativePaths,
      );
      if (localImage !== null) {
        return localImageRouting.resolveSrc(
          localImage.link,
          localImage.sourceKind,
        );
      }
    }

    return (fallbackUrlTransform ?? defaultUrlTransform)(value, key, node);
  };
}

function hasMarkdownFileExtension(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path);
}

function resolveInlineCodeMarkdownFileTarget({
  codeText,
  localFileRouting,
}: {
  codeText: string;
  localFileRouting: MarkdownLocalFileLinkRouting | undefined;
}): ResolvedMarkdownLocalFileTarget | null {
  if (
    localFileRouting === undefined ||
    codeText.length === 0 ||
    codeText.trim() !== codeText ||
    codeText.includes("\n") ||
    codeText.includes("\r") ||
    !/[\\/]/u.test(codeText)
  ) {
    return null;
  }

  const target = resolveMarkdownLocalFileTarget(
    codeText,
    localFileRouting.absoluteLinks,
    localFileRouting.relativeLinks,
  );
  return target !== null && hasMarkdownFileExtension(target.link.path)
    ? target
    : null;
}

function MarkdownAnchor({
  children,
  href,
  linkRouting,
  rewriteLocalhostLinks,
  ...anchorProps
}: MarkdownAnchorProps) {
  const localFileRouting = linkRouting?.localFile;
  const onOpenLocalFileLink = localFileRouting?.onOpenLink;
  const rewrittenHref = rewriteLocalhostLinkHref({
    currentHostname:
      typeof window === "undefined" ? undefined : window.location.hostname,
    enabled: rewriteLocalhostLinks ?? false,
    href,
  });
  const isAppRouteHref = isMarkdownAppRouteHref({ href: rewrittenHref });
  const localFileLink =
    !isAppRouteHref && localFileRouting
      ? parseLocalFileHref({
          absoluteLinks: localFileRouting.absoluteLinks,
          href: rewrittenHref,
        })
      : null;
  const anchorHref = buildLocalFileAnchorHref(localFileLink, rewrittenHref);
  const getContextMenuItems = useContext(MarkdownLocalFileContextMenuContext);
  const contextMenuItems =
    localFileLink !== null && getContextMenuItems !== null
      ? getContextMenuItems(localFileLink)
      : null;
  const handleAnchorClick = (event: MarkdownAnchorEvent) => {
    if (localFileLink && onOpenLocalFileLink) {
      if (onOpenLocalFileLink(localFileLink)) {
        event.preventDefault();
      }
      return;
    }

    if (isAppRouteHref) {
      return;
    }

    if (
      linkRouting?.onOpenLink &&
      rewrittenHref &&
      linkRouting.onOpenLink({ href: rewrittenHref })
    ) {
      event.preventDefault();
      return;
    }
  };

  const anchor = (
    <RouteAnchor
      {...anchorProps}
      href={anchorHref}
      className={cn(
        "break-words [overflow-wrap:anywhere] underline underline-offset-2",
      )}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleAnchorClick}
    >
      {children}
      {localFileLink ? (
        <Icon
          name="ExternalLink"
          aria-hidden
          className="ml-1 inline size-3 align-[-0.125em] text-subtle-foreground"
        />
      ) : null}
    </RouteAnchor>
  );
  const link =
    contextMenuItems === null || contextMenuItems.length === 0 ? (
      anchor
    ) : (
      <ContextMenu>
        <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          {contextMenuItems.map(renderMarkdownLocalFileContextMenuItem)}
        </ContextMenuContent>
      </ContextMenu>
    );
  if (localFileLink === null || localFileRouting?.threadId === undefined) {
    return link;
  }
  return (
    <ThreadFileExistenceGate
      missing={<span>{children}</span>}
      path={localFileLink.path}
      threadId={localFileRouting.threadId}
      unknown={link}
    >
      {link}
    </ThreadFileExistenceGate>
  );
}

function ThreadFileExistenceGate({
  children,
  missing,
  path,
  threadId,
  unknown,
}: {
  children: ReactNode;
  missing: ReactNode;
  path: string;
  threadId: string;
  unknown: ReactNode;
}) {
  const exists = useThreadFileExists(threadId, path);
  return exists === null ? unknown : exists ? children : missing;
}

function renderMarkdownLocalFileContextMenuItem(
  item: MarkdownLocalFileContextMenuItem,
) {
  if (item.type === "separator") {
    return <ContextMenuSeparator key={item.id} />;
  }
  if (item.type === "submenu") {
    return (
      <ContextMenuSub key={item.id}>
        <ContextMenuSubTrigger>{item.label}</ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-44">
          {item.items.map(renderMarkdownLocalFileContextMenuItem)}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  }
  return (
    <ContextMenuItem key={item.id} onSelect={item.onSelect}>
      {item.label}
    </ContextMenuItem>
  );
}

function MarkdownCode({
  className: codeClassName,
  children,
  imagePolicy,
  linkRouting,
  node: _node,
  preferredTheme,
  rewriteLocalhostLinks,
  ...props
}: MarkdownCodeRendererProps) {
  const codeText = String(children ?? "").replace(/\n$/, "");
  const language = getMarkdownCodeLanguage({ className: codeClassName });
  const isBlock = isMarkdownCodeBlock({ codeText, language });
  const highlightedHtml = useMemo(
    () =>
      isBlock && language !== "mermaid"
        ? highlightMarkdownCode({ code: codeText, language })
        : null,
    [isBlock, language, codeText],
  );
  const highlightedMarkup = useMemo(
    () => (highlightedHtml === null ? null : { __html: highlightedHtml }),
    [highlightedHtml],
  );
  if (isBlock) {
    if (language === "mermaid" && imagePolicy === "render") {
      return (
        <MarkdownMermaidDiagram
          preferredTheme={preferredTheme}
          source={codeText}
        />
      );
    }

    return (
      <div className="my-2 overflow-clip rounded-md border border-border bg-surface-recessed">
        <div className="sticky top-2 z-[2] mt-2 h-0">
          <MarkdownCodeCopyButton codeText={codeText} />
        </div>
        <pre className="bb-code-highlight overflow-x-auto px-3 pb-3 pr-12 pt-3">
          {highlightedMarkup === null ? (
            <code className="font-mono text-xs" {...props}>
              {codeText}
            </code>
          ) : (
            <code
              className={cn(
                "font-mono text-xs",
                language ? `language-${language}` : "",
              )}
              dangerouslySetInnerHTML={highlightedMarkup}
              {...props}
            />
          )}
        </pre>
      </div>
    );
  }

  const localFileRouting = linkRouting?.localFile;
  const markdownFileTarget = resolveInlineCodeMarkdownFileTarget({
    codeText,
    localFileRouting,
  });
  const inlineCode = (
    <MarkdownInlineCode codeText={codeText} {...props}>
      {children}
    </MarkdownInlineCode>
  );
  if (markdownFileTarget === null) {
    return inlineCode;
  }
  const link = (
    <MarkdownAnchor
      href={markdownFileTarget.href}
      linkRouting={linkRouting}
      rewriteLocalhostLinks={rewriteLocalhostLinks}
    >
      {codeText}
    </MarkdownAnchor>
  );
  if (localFileRouting?.threadId === undefined) {
    return link;
  }
  return (
    <ThreadFileExistenceGate
      missing={inlineCode}
      path={markdownFileTarget.link.path}
      threadId={localFileRouting.threadId}
      unknown={inlineCode}
    >
      {link}
    </ThreadFileExistenceGate>
  );
}

function MarkdownCodeCopyButton({ codeText }: { codeText: string }) {
  const { copied, copy } = useClipboardCopy({ text: codeText });
  const [hovered, setHovered] = useState(false);
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={hovered || copied} onOpenChange={setHovered}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Copy code"
            onClick={() => {
              void copy();
            }}
            className="absolute right-2 top-0 inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-border bg-surface-recessed-solid text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon
              name={copied ? "Check" : "Copy"}
              className={cn("size-4", copied && "text-success")}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {copied ? "Copied" : "Copy code"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function MarkdownInlineCode({
  children,
  codeText,
  ...props
}: ComponentPropsWithoutRef<"code"> & { codeText: string }) {
  const { copied, copy } = useClipboardCopy({ text: codeText });
  const [iconMovesCode, setIconMovesCode] = useState(false);
  return (
    <code
      {...props}
      className="group/code cursor-pointer rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs hover:bg-muted"
      onMouseEnter={(event) =>
        setIconMovesCode(showingIconMovesCode(event.currentTarget))
      }
      onClick={(event) => {
        // Links keep their own click, and drag-selecting part of the code still works.
        if (
          event.currentTarget.closest("a") ||
          !window.getSelection()?.isCollapsed
        ) {
          return;
        }
        void copy();
      }}
    >
      {children}
      <Icon
        name={copied ? "Check" : "Copy"}
        aria-hidden
        className={cn(
          "ml-1 size-3 align-[-0.125em] in-[a]:hidden",
          iconMovesCode
            ? "hidden"
            : copied
              ? "inline text-success"
              : "hidden text-muted-foreground group-hover/code:inline",
        )}
      />
    </code>
  );
}

function showingIconMovesCode(code: HTMLElement): boolean {
  const icon = code.querySelector<SVGElement>(":scope > [data-icon]");
  if (icon === null) {
    return false;
  }
  const top = () => code.getClientRects()[0]?.top ?? 0;
  icon.style.display = "none";
  const hiddenTop = top();
  icon.style.display = "inline";
  const shownTop = top();
  icon.style.display = "";
  return Math.abs(shownTop - hiddenTop) > 1;
}

function MarkdownPre({ children }: MarkdownPreProps) {
  return <>{children}</>;
}

function MarkdownH1({ children }: MarkdownHeadingProps) {
  return (
    <h1 className="mb-2 mt-4 text-lg font-semibold text-foreground first:mt-0">
      {children}
    </h1>
  );
}

function MarkdownH2({ children }: MarkdownHeadingProps) {
  return (
    <h2 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">
      {children}
    </h2>
  );
}

function MarkdownH3({ children }: MarkdownHeadingProps) {
  return (
    <h3 className="mb-2 mt-3 text-sm font-semibold text-foreground first:mt-0">
      {children}
    </h3>
  );
}

function MarkdownH4({ children }: MarkdownHeadingProps) {
  return (
    <h4 className="mb-1 mt-3 text-sm font-medium text-foreground first:mt-0">
      {children}
    </h4>
  );
}

function MarkdownH5({ children }: MarkdownHeadingProps) {
  return (
    <h5 className="mb-1 mt-2 text-sm font-semibold uppercase text-muted-foreground first:mt-0">
      {children}
    </h5>
  );
}

function MarkdownH6({ children }: MarkdownHeadingProps) {
  return (
    <h6 className="mb-1 mt-2 text-xs font-semibold uppercase text-muted-foreground first:mt-0">
      {children}
    </h6>
  );
}

function MarkdownParagraph({
  children,
  className: _className,
  node: _node,
  ...paragraphProps
}: MarkdownParagraphProps) {
  return (
    <p {...paragraphProps} className="mb-2 text-foreground last:mb-0">
      {children}
    </p>
  );
}

function MarkdownUnorderedList({ children }: MarkdownUnorderedListProps) {
  return <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>;
}

function MarkdownOrderedList({
  children,
  className: _className,
  node,
  ...orderedListProps
}: MarkdownOrderedListProps) {
  // Outside markers grow left, so widen the gutter for "10." and up.
  const itemCount =
    node?.children.filter((child) => child.type === "element").length ?? 0;
  const lastNumber = (orderedListProps.start ?? 1) + Math.max(itemCount, 1) - 1;
  const extraDigits = Math.max(String(lastNumber).length - 1, 0);
  return (
    <ol
      {...orderedListProps}
      className="mb-2 list-decimal pl-5 text-foreground"
      style={
        extraDigits > 0
          ? { paddingLeft: `calc(1.25rem + ${extraDigits}ch)` }
          : undefined
      }
    >
      {children}
    </ol>
  );
}

function MarkdownListItem({ children }: MarkdownListItemProps) {
  return <li className="mb-1 text-foreground">{children}</li>;
}

function MarkdownBlockquote({ children }: MarkdownBlockquoteProps) {
  return (
    <blockquote className="my-2 border-l-2 border-surface-selected-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  );
}

function markdownHastText(node: MarkdownHastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(markdownHastText).join("");
}

function markdownHastTableRows(node: MarkdownHastNode | undefined): string[][] {
  if (node === undefined) return [];
  if (node.tagName === "tr") {
    return [
      (node.children ?? [])
        .filter((cell) => cell.tagName === "th" || cell.tagName === "td")
        .map((cell) => markdownHastText(cell).trim()),
    ];
  }
  return (node.children ?? []).flatMap(markdownHastTableRows);
}

function previousMarkdownHeadingText(
  element: HTMLElement | null,
): string | null {
  let sibling = element?.previousElementSibling ?? null;
  for (let step = 0; sibling !== null && step < 4; step += 1) {
    if (/^H[1-6]$/u.test(sibling.tagName)) {
      return sibling.textContent?.trim() || null;
    }
    sibling = sibling.previousElementSibling;
  }
  return null;
}

function MarkdownTable({ children, node }: MarkdownTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedTitle, setExpandedTitle] = useState<string | null>(null);
  const closeExpanded = useCallback(() => setExpandedTitle(null), []);

  return (
    <div
      ref={containerRef}
      className="group/table relative my-3 w-full overflow-hidden rounded-lg border border-border"
    >
      <MarkdownTableScroller>
        <table
          className={cn(
            MARKDOWN_TABLE_CLASS,
            "[&_tbody_tr:last-child_td]:border-b-0 [&_thead_th:last-child]:pr-11",
          )}
        >
          {children}
        </table>
      </MarkdownTableScroller>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Expand table"
              onClick={() =>
                setExpandedTitle(
                  previousMarkdownHeadingText(containerRef.current) ?? "Table",
                )
              }
              className="absolute right-1.5 top-1.5 z-[2] inline-flex size-6 cursor-pointer items-center justify-center rounded-md bg-surface-recessed-solid text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground group-hover/table:text-muted-foreground"
            >
              <Icon name="Maximize2" className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Expand table</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <MarkdownTableDialog
        node={node}
        onClose={closeExpanded}
        title={expandedTitle}
      >
        {children}
      </MarkdownTableDialog>
    </div>
  );
}

function MarkdownTableScroller({ children }: { children: ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [hasMoreRight, setHasMoreRight] = useState(false);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const update = () =>
      setHasMoreRight(
        scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1,
      );
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    if (scroller.firstElementChild)
      observer?.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  return (
    <div className="relative">
      <div ref={scrollerRef} className="overflow-x-auto">
        {children}
      </div>
      {hasMoreRight ? (
        <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-background to-transparent" />
      ) : null}
    </div>
  );
}

function MarkdownTableDialog({
  children,
  node,
  onClose,
  title,
}: {
  children: ReactNode;
  node: MarkdownTableProps["node"];
  onClose: () => void;
  title: string | null;
}) {
  const open = title !== null;
  const panelRef = useRef<HTMLDivElement>(null);
  const scopeProps = usePortalScopeProps();
  useBrowserDimmingOverlay(open);
  usePersistentOverlayFocus({ open, panelRef, requestClose: onClose });
  if (!open) return null;

  const rows = markdownHastTableRows(node);
  return createPortal(
    <div
      {...scopeProps}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 backdrop-blur-[3px] animate-in fade-in-0 duration-150 motion-reduce:animate-none sm:p-12"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-[0_24px_80px_rgba(0,0,0,0.55)] outline-none animate-in fade-in-0 zoom-in-[0.98] duration-150 motion-reduce:animate-none"
      >
        <div className="flex items-center gap-3 border-b border-foreground/10 py-2 pl-5 pr-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground/60">
            {Math.max(rows.length - 1, 0)} rows · {rows[0]?.length ?? 0} columns
          </span>
          <span className="flex-1" />
          <CopyButton
            text={rows.map((row) => row.join("\t")).join("\n")}
            label="Copy table"
          />
          <kbd className="ml-1 rounded border border-foreground/15 px-1.5 font-mono text-[10px] leading-4 text-muted-foreground/60 max-sm:hidden">
            Esc
          </kbd>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <Icon name="X" className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <MarkdownTableExpandedContext.Provider value={true}>
            <table
              className={cn(
                MARKDOWN_TABLE_CLASS,
                "text-sm [&_tbody_tr:hover_td]:bg-surface-recessed-solid",
              )}
            >
              {children}
            </table>
          </MarkdownTableExpandedContext.Provider>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MarkdownTableHead({ children }: MarkdownTableHeadProps) {
  return <thead>{children}</thead>;
}

function MarkdownTableHeader({ children }: MarkdownTableHeaderProps) {
  const expanded = useContext(MarkdownTableExpandedContext);
  return (
    <th
      className={cn(
        MARKDOWN_TABLE_HEADER_CLASS,
        MARKDOWN_TABLE_STICKY_COLUMN_CLASS,
        expanded
          ? "sticky top-0 z-[2] px-4 py-2.5 first:z-[3]"
          : "px-3.5 py-2 first:z-[1]",
      )}
    >
      {children}
    </th>
  );
}

function MarkdownTableCell({ children, node }: MarkdownTableCellProps) {
  const expanded = useContext(MarkdownTableExpandedContext);
  const text = node ? markdownHastText(node).trim() : "";
  return (
    <td
      className={cn(
        MARKDOWN_TABLE_CELL_CLASS,
        MARKDOWN_TABLE_STICKY_COLUMN_CLASS,
        "first:z-[1] first:bg-background",
        text.length <= MARKDOWN_TABLE_SHORT_CELL_LENGTH
          ? "whitespace-nowrap"
          : "min-w-48",
        /^[-\u2013\u2014]$/u.test(text) && "text-muted-foreground/45",
        expanded
          ? "px-4 py-2.5"
          : "px-3.5 py-2 first:min-w-40 first:max-w-48 first:whitespace-normal",
      )}
    >
      {children}
    </td>
  );
}

function MarkdownRenderedImage({
  alt,
  sourceOffset,
  imageAttributes,
  setExpandedImage,
  src,
}: MarkdownImageRendererArgs) {
  const openGallery = useContext(InlineImageGalleryContext);
  const imageUrl = typeof src === "string" ? src : "";
  // Cloud images can take many seconds to arrive; show a skeleton until then.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  if (!imageUrl) return null;
  const loading = loadedUrl !== imageUrl;
  const image = (
    <img
      {...imageAttributes}
      ref={(element) => {
        if (element?.complete && element.naturalWidth > 0)
          setLoadedUrl(imageUrl);
      }}
      onLoad={() => setLoadedUrl(imageUrl)}
      onError={() => setLoadedUrl(imageUrl)}
      src={imageUrl}
      alt={typeof alt === "string" ? alt : "Image"}
      className={
        loading
          ? "absolute inset-0 size-full opacity-0"
          : "my-2 max-h-[max(384px,50vh)] max-w-full cursor-zoom-in object-contain"
      }
      loading="lazy"
      data-markdown-image=""
      data-markdown-image-offset={sourceOffset}
      onClick={(event) => {
        if (openGallery) {
          openGallery(event.currentTarget);
          return;
        }
        const markdownElement = event.currentTarget.closest(
          "[data-markdown-preview]",
        );
        const images = Array.from(
          markdownElement?.querySelectorAll("img") ?? [],
        );
        const imageIndex = images.indexOf(event.currentTarget);
        const imageSources = images.map(
          (image) => image.getAttribute("src") ?? image.src,
        );
        setExpandedImage({
          imageSources,
          index: imageIndex,
          url: event.currentTarget.getAttribute("src") ?? imageUrl,
        });
      }}
    />
  );
  if (!loading) return image;
  return (
    <span
      className="relative my-2 block h-44 w-80 max-w-full animate-pulse rounded-md bg-muted"
      data-markdown-image-loading=""
    >
      {image}
    </span>
  );
}

function MarkdownHr(_props: MarkdownHrProps) {
  return <hr className="my-4 border-t border-border" />;
}

function parseMarkdownSourceColorScheme(media: string): Theme | null {
  const match = MARKDOWN_SOURCE_COLOR_SCHEME_MEDIA_PATTERN.exec(media);
  const colorScheme = match?.[1];
  if (colorScheme === "dark" || colorScheme === "light") {
    return colorScheme;
  }
  return null;
}

function resolveMarkdownSourceMedia({
  media,
  preferredTheme,
}: ResolveMarkdownSourceMediaArgs): MarkdownSourceMedia {
  if (!media) return media;

  const colorScheme = parseMarkdownSourceColorScheme(media);
  if (!colorScheme) return media;

  return colorScheme === preferredTheme ? "all" : "not all";
}

const EMPTY_THREAD_IDS: readonly string[] = [];

function buildMarkdownComponents({
  imagePolicy,
  imageSourceOffset,
  linkRouting,
  preferredTheme,
  rewriteLocalhostLinks,
  setExpandedImage,
  threadMentions,
  promptMentions,
  messageDirectives,
}: BuildMarkdownComponentsArgs): Components {
  interface RawThreadIdLabelCandidate {
    end: number;
    start: number;
    threadId: string;
  }

  function flattenMarkdownLinkLabel(node: ReactNode): {
    codeRanges: ReadonlyArray<{ end: number; start: number }>;
    text: string;
  } {
    const codeRanges: Array<{ end: number; start: number }> = [];
    let text = "";
    const append = (child: ReactNode): void => {
      if (typeof child === "string" || typeof child === "number") {
        text += String(child);
        return;
      }
      if (!isValidElement(child)) {
        Children.forEach(child, append);
        return;
      }
      const element = child as ReactElement<{ children?: ReactNode }>;
      const isCode =
        element.type === "code" || element.type === MarkdownCodeRenderer;
      const start = text.length;
      append(element.props.children);
      if (isCode && text.length > start) {
        codeRanges.push({ start, end: text.length });
      }
    };
    append(node);
    return { codeRanges, text };
  }

  function rawThreadIdLabelCandidates(
    node: ReactNode,
  ): RawThreadIdLabelCandidate[] {
    const flattened = flattenMarkdownLinkLabel(node);
    const candidates: RawThreadIdLabelCandidate[] = [];
    let offset = 0;
    for (const segment of splitRawThreadIdsInText(flattened.text)) {
      const start = offset;
      const end = start + segment.text.length;
      offset = end;
      if (
        segment.rawThreadId === null ||
        flattened.codeRanges.some(
          (range) => start < range.end && end > range.start,
        )
      ) {
        continue;
      }
      candidates.push({ start, end, threadId: segment.rawThreadId });
    }
    return candidates;
  }

  function renderLiftedMarkdownLinkLabel(
    node: ReactNode,
    anchorProps: Omit<MarkdownAnchorProps, "children">,
    candidates: readonly RawThreadIdLabelCandidate[],
    resourceById: ReadonlyMap<string, PromptTextMention["resource"]>,
    cursor: { value: number },
  ): ReactNode {
    if (typeof node === "string" || typeof node === "number") {
      const text = String(node);
      const start = cursor.value;
      const end = start + text.length;
      cursor.value = end;
      const containedCandidates = candidates.filter(
        (candidate) => candidate.start >= start && candidate.end <= end,
      );
      if (containedCandidates.length === 0) {
        return (
          <MarkdownAnchor
            {...anchorProps}
            linkRouting={linkRouting}
            rewriteLocalhostLinks={rewriteLocalhostLinks}
          >
            {text}
          </MarkdownAnchor>
        );
      }
      const rendered: ReactNode[] = [];
      let localCursor = 0;
      for (const candidate of containedCandidates) {
        const candidateStart = candidate.start - start;
        const candidateEnd = candidate.end - start;
        if (candidateStart > localCursor) {
          rendered.push(
            <MarkdownAnchor
              key={`text:${localCursor}`}
              {...anchorProps}
              linkRouting={linkRouting}
              rewriteLocalhostLinks={rewriteLocalhostLinks}
            >
              {text.slice(localCursor, candidateStart)}
            </MarkdownAnchor>,
          );
        }
        const resource = resourceById.get(candidate.threadId);
        if (resource !== undefined) {
          rendered.push(
            <PromptMentionPill
              key={`${candidate.threadId}:${candidateStart}`}
              resource={resource}
              serializedText={candidate.threadId}
            />,
          );
        }
        localCursor = candidateEnd;
      }
      if (localCursor < text.length) {
        rendered.push(
          <MarkdownAnchor
            key={`text:${localCursor}`}
            {...anchorProps}
            linkRouting={linkRouting}
            rewriteLocalhostLinks={rewriteLocalhostLinks}
          >
            {text.slice(localCursor)}
          </MarkdownAnchor>,
        );
      }
      return rendered;
    }
    if (!isValidElement(node)) {
      return Children.map(node, (child) =>
        renderLiftedMarkdownLinkLabel(
          child,
          anchorProps,
          candidates,
          resourceById,
          cursor,
        ),
      );
    }
    if (node.type === "code" || node.type === MarkdownCodeRenderer) {
      cursor.value += flattenMarkdownLinkLabel(node).text.length;
      return (
        <MarkdownAnchor
          {...anchorProps}
          linkRouting={linkRouting}
          rewriteLocalhostLinks={rewriteLocalhostLinks}
        >
          {node}
        </MarkdownAnchor>
      );
    }
    const element = node as ReactElement<{ children?: ReactNode }>;
    return cloneElement(
      element,
      undefined,
      renderLiftedMarkdownLinkLabel(
        element.props.children,
        anchorProps,
        candidates,
        resourceById,
        cursor,
      ),
    );
  }

  function MarkdownLink(props: MarkdownAnchorProps) {
    const { children, ...anchorProps } = props;
    const candidates = useMemo(
      () =>
        threadMentions === undefined
          ? []
          : rawThreadIdLabelCandidates(children),
      [children],
    );
    const candidateThreadIds = useMemo(
      () =>
        candidates.length === 0
          ? EMPTY_THREAD_IDS
          : [...new Set(candidates.map((candidate) => candidate.threadId))],
      [candidates],
    );
    const resourceById = useRawThreadMentionResources(candidateThreadIds);
    const resolvedCandidates = candidates.filter((candidate) =>
      resourceById.has(candidate.threadId),
    );
    if (resolvedCandidates.length > 0) {
      return (
        <>
          {renderLiftedMarkdownLinkLabel(
            children,
            anchorProps,
            resolvedCandidates,
            resourceById,
            { value: 0 },
          )}
        </>
      );
    }
    return (
      <MarkdownAnchor
        {...anchorProps}
        linkRouting={linkRouting}
        rewriteLocalhostLinks={rewriteLocalhostLinks}
      >
        {children}
      </MarkdownAnchor>
    );
  }

  function MarkdownCodeRenderer(props: MarkdownCodeProps) {
    return (
      <MarkdownCode
        {...props}
        imagePolicy={imagePolicy}
        linkRouting={linkRouting}
        preferredTheme={preferredTheme}
        rewriteLocalhostLinks={rewriteLocalhostLinks}
      />
    );
  }

  function MarkdownImage({
    src,
    alt,
    className: _className,
    node,
    "data-markdown-image-offset": pieceOffset,
    ...imageAttributes
  }: MarkdownImageProps) {
    if (imagePolicy === "alt-text") {
      return (
        <span data-markdown-image-fallback="">
          [Image: {typeof alt === "string" && alt.length > 0 ? alt : "image"}]
        </span>
      );
    }
    const sourceOffset = pieceOffset ?? node?.position?.start.offset;
    return (
      <MarkdownRenderedImage
        alt={alt}
        sourceOffset={
          sourceOffset === undefined
            ? undefined
            : imageSourceOffset + sourceOffset
        }
        imageAttributes={imageAttributes}
        setExpandedImage={setExpandedImage}
        src={src}
      />
    );
  }

  function MarkdownSource({
    media,
    node: _node,
    ...sourceProps
  }: MarkdownSourceProps) {
    if (imagePolicy === "alt-text") {
      return null;
    }
    return (
      <source
        {...sourceProps}
        media={resolveMarkdownSourceMedia({ media, preferredTheme })}
      />
    );
  }

  const components: Components = {
    a: MarkdownLink,
    blockquote: MarkdownBlockquote,
    code: MarkdownCodeRenderer,
    h1: MarkdownH1,
    h2: MarkdownH2,
    h3: MarkdownH3,
    h4: MarkdownH4,
    h5: MarkdownH5,
    h6: MarkdownH6,
    hr: MarkdownHr,
    img: MarkdownImage,
    li: MarkdownListItem,
    ol: MarkdownOrderedList,
    p: MarkdownParagraph,
    pre: MarkdownPre,
    source: MarkdownSource,
    table: MarkdownTable,
    td: MarkdownTableCell,
    th: MarkdownTableHeader,
    thead: MarkdownTableHead,
    ul: MarkdownUnorderedList,
  };

  if (threadMentions !== undefined) {
    components["bb-thread-mention"] = buildThreadMentionComponent({
      mentions: threadMentions.mentions,
      resolveSegmentLinkHref: threadMentions.resolveLinkHref,
    });
  }

  if (promptMentions !== undefined) {
    components["bb-prompt-mention"] = buildPromptMentionComponent({
      mentions: promptMentions.mentions,
      resolveLinkHref: promptMentions.resolveLinkHref,
      resolveMentionLink: promptMentions.resolveMentionLink,
    });
  }

  if (messageDirectives !== undefined) {
    components["bb-message-directive"] =
      buildMessageDirectiveComponent(messageDirectives);
  }

  return components;
}

const FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function splitMarkdownFrontmatter(markdown: string): {
  frontmatter: string | null;
  body: string;
} {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (match === null) {
    return { frontmatter: null, body: markdown };
  }
  return { frontmatter: match[1], body: markdown.slice(match[0].length) };
}

function MarkdownFrontmatter({ source }: { source: string }) {
  const lines = source.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
      {lines.map((line, index) => {
        const separator = line.indexOf(":");
        if (separator > 0 && !/^[\s-]/.test(line)) {
          const key = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim();
          return (
            <div key={index} className="contents">
              <span className="font-medium text-muted-foreground/70">
                {key}
              </span>
              <span className="min-w-0 break-words">{value}</span>
            </div>
          );
        }
        return (
          <div
            key={index}
            className="col-span-2 whitespace-pre-wrap break-words text-muted-foreground/80"
          >
            {line}
          </div>
        );
      })}
    </div>
  );
}

function MarkdownPreviewComponent({
  allowHtml = false,
  className,
  content,
  sourcePrefix = "",
  imagePolicy = "render",
  incrementalBlocks = false,
  linkRouting,
  threadMentions,
  promptMentions,
  messageDirectives,
  urlTransform,
}: MarkdownPreviewProps) {
  const preferredTheme = usePreferredTheme();
  const [rewriteLocalhostLinks] = useRewriteLocalhostLinksPreference();
  const [expandedImage, setExpandedImage] =
    useState<ExpandedMarkdownImage | null>(null);
  const [markdownPieceCache] = useState(createMarkdownPieceCache);
  const usesIncrementalBlocks =
    incrementalBlocks && !allowHtml && promptMentions === undefined;
  const localFileRouting = linkRouting?.localFile;
  const localImageRouting = linkRouting?.localImage;
  const normalizeLocalFileLinks =
    localFileRouting !== undefined || localImageRouting !== undefined;
  const imageSourceOffset = useMemo(() => {
    const prefix = normalizeLocalFileLinks
      ? normalizeLocalFileMarkdownLinks(sourcePrefix)
      : sourcePrefix;
    return normalizeMathFences(splitMarkdownFrontmatter(prefix).body).length;
  }, [sourcePrefix, normalizeLocalFileLinks]);
  const promptMentionSubstitution = useMemo(
    () =>
      promptMentions
        ? substitutePromptMentions(content, promptMentions.mentions)
        : null,
    [content, promptMentions],
  );
  const resolvedPromptMentions = useMemo<ResolvedPromptMentions | undefined>(
    () =>
      promptMentions && promptMentionSubstitution
        ? {
            mentions: promptMentionSubstitution.mentions,
            resolveLinkHref: promptMentions.resolveLinkHref,
            resolveMentionLink: promptMentions.resolveMentionLink,
          }
        : undefined,
    [promptMentions, promptMentionSubstitution],
  );
  const substitutedContent = promptMentionSubstitution?.content ?? content;
  const markdownContent = useMemo(
    () =>
      normalizeLocalFileLinks
        ? normalizeLocalFileMarkdownLinks(substitutedContent)
        : substitutedContent,
    [substitutedContent, normalizeLocalFileLinks],
  );
  const promptMarkdownContent = useMemo(
    () =>
      promptMentions !== undefined
        ? normalizePromptBlockquoteBoundaries(markdownContent)
        : markdownContent,
    [markdownContent, promptMentions],
  );
  const { frontmatter, body } = useMemo(() => {
    const split = splitMarkdownFrontmatter(promptMarkdownContent);
    return {
      frontmatter: split.frontmatter,
      body: normalizeMathFences(split.body),
    };
  }, [promptMarkdownContent]);
  const messageDirectiveMounts = useMemo(() => {
    if (messageDirectives === undefined) {
      return null;
    }
    const mounts: MountedMessageDirective[] = [];
    return {
      mounts,
      message: messageDirectives.message,
      openWorkspaceFile: messageDirectives.openWorkspaceFile,
      openThreadPanel: messageDirectives.openThreadPanel,
      registry: messageDirectives.registry,
    };
  }, [messageDirectives]);
  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents({
        imagePolicy,
        imageSourceOffset,
        linkRouting,
        preferredTheme,
        rewriteLocalhostLinks,
        setExpandedImage,
        threadMentions,
        promptMentions: resolvedPromptMentions,
        messageDirectives: messageDirectiveMounts ?? undefined,
      }),
    [
      linkRouting,
      imagePolicy,
      imageSourceOffset,
      preferredTheme,
      rewriteLocalhostLinks,
      threadMentions,
      resolvedPromptMentions,
      messageDirectiveMounts,
    ],
  );
  const hasMessageDirectives = messageDirectiveMounts !== null;
  const baseRemarkPlugins = useMemo((): MarkdownRemarkPlugins => {
    const plugins: MarkdownRemarkPlugins = [
      remarkGfm,
      [remarkMath, { singleDollarTextMath: false }],
    ];
    if (
      threadMentions?.preserveSoftBreaks === true ||
      promptMentions !== undefined
    ) {
      plugins.push(remarkLineBreaks);
    }
    if (threadMentions !== undefined) {
      plugins.push(remarkThreadMentions);
    }
    if (promptMentions !== undefined) {
      plugins.push(remarkPromptMentions);
    }
    if (hasMessageDirectives) {
      plugins.push(remarkDirective);
    }
    return plugins;
  }, [threadMentions, promptMentions, hasMessageDirectives]);
  const remarkPlugins = useMemo(
    (): MarkdownRemarkPlugins =>
      messageDirectiveMounts === null
        ? baseRemarkPlugins
        : [
            ...baseRemarkPlugins,
            [
              remarkMessageDirectives,
              {
                indexBase: 0,
                limit: MESSAGE_DIRECTIVE_MOUNT_LIMIT,
                mounts: messageDirectiveMounts.mounts,
                registry: messageDirectiveMounts.registry,
              },
            ],
          ],
    [baseRemarkPlugins, messageDirectiveMounts],
  );
  const resolvedUrlTransform = useMemo(
    () =>
      localFileRouting || localImageRouting
        ? buildLocalAwareUrlTransform({
            fallbackUrlTransform: urlTransform,
            localFileRouting,
            localImageRouting,
          })
        : urlTransform,
    [localFileRouting, localImageRouting, urlTransform],
  );

  const rehypeKatex = useRehypeKatex(markdownMayContainMath(body));
  const rehypePlugins = useMemo(
    () => resolveRehypePlugins({ allowHtml, rehypeKatex }),
    [allowHtml, rehypeKatex],
  );

  const markdownPieceRenderConfig = useMemo(
    (): MarkdownPieceRenderConfig => ({
      components: markdownComponents,
      messageDirectiveRegistry: messageDirectiveMounts?.registry ?? null,
      rehypePlugins,
      remarkPlugins: baseRemarkPlugins,
      urlTransform: resolvedUrlTransform,
    }),
    [
      markdownComponents,
      messageDirectiveMounts,
      rehypePlugins,
      baseRemarkPlugins,
      resolvedUrlTransform,
    ],
  );
  const markdownPieces = usesIncrementalBlocks
    ? resolveMarkdownPieces(markdownPieceCache, markdownPieceRenderConfig, body)
    : null;

  const renderedMarkdown =
    markdownPieces === null ? (
      <ReactMarkdown
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
        urlTransform={resolvedUrlTransform}
      >
        {body}
      </ReactMarkdown>
    ) : (
      markdownPieces.children
    );

  const imageSources = expandedImage?.imageSources ?? [];
  const expandedImageIndex = expandedImage?.index ?? -1;
  const hasImageNavigation =
    expandedImageIndex !== -1 && imageSources.length > 1;
  const stepExpandedImage = (direction: "previous" | "next") => {
    if (expandedImageIndex === -1) return;
    const nextIndex = getWrappedImageIndex({
      currentIndex: expandedImageIndex,
      direction,
      itemCount: imageSources.length,
    });
    const nextImageSource = imageSources[nextIndex];
    setExpandedImage(
      nextImageSource === undefined
        ? null
        : { imageSources, index: nextIndex, url: nextImageSource },
    );
  };

  return (
    <>
      <div
        data-markdown-preview=""
        className={cn(
          "max-w-none break-words text-sm leading-relaxed text-foreground",
          className,
        )}
      >
        {frontmatter !== null ? (
          <MarkdownFrontmatter source={frontmatter} />
        ) : null}
        <MessageDirectiveMountsContext.Provider
          value={
            markdownPieces?.mounts ??
            messageDirectiveMounts?.mounts ??
            EMPTY_MOUNTED_MESSAGE_DIRECTIVES
          }
        >
          {threadMentions === undefined ? (
            renderedMarkdown
          ) : (
            <RawThreadMentionBatchProvider>
              {renderedMarkdown}
            </RawThreadMentionBatchProvider>
          )}
        </MessageDirectiveMountsContext.Provider>
      </div>

      <ImageLightbox
        imageSrc={expandedImage?.url ?? null}
        imageAlt="Expanded image"
        title="Expanded image preview"
        hasMultipleImages={hasImageNavigation}
        onPrevious={() => stepExpandedImage("previous")}
        onNext={() => stepExpandedImage("next")}
        onClose={() => setExpandedImage(null)}
      />
    </>
  );
}

export const MarkdownPreview = memo(
  MarkdownPreviewComponent,
  areMarkdownPreviewPropsEqual,
);
MarkdownPreview.displayName = "MarkdownPreview";
