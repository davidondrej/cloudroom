import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import {
  providerCommandSection,
  type ProviderCommandSection,
} from "@cloudroom/server-contract";
import { directoryFromPath } from "@cloudroom/thread-view";
import { promptMentionResourceFromSuggestion } from "@/components/promptbox/editor/prompt-editor-serialization";
import { promptCommandIconName } from "@/components/promptbox/mentions/prompt-mention-display";
import {
  PromptMentionIcon,
  ThreadLocationIcon,
} from "@/components/promptbox/mentions/PromptMentionIcon";
import { ThreadStatusGlyph } from "@/components/sidebar/ThreadRow";
import { formatRelativeTime } from "@/lib/relative-time";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { Icon } from "@cloudroom/shared-ui/icon";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  EMPTY_ORDERED_MENTION_SUGGESTIONS,
  resolveThreadListIndicator,
  type OrderedMentionSuggestions,
  type PromptMentionSuggestion,
} from "@cloudroom/client-core";
import {
  getMentionKey,
  typeaheadSuggestionKey,
  type ComposerCommandMenuState,
  type ComposerCommandSuggestion,
  type ComposerTypeaheadMenuState,
  type FastModeCommandSuggestion,
  type LocationCommandSuggestion,
  type ModelShortcutCommandSuggestion,
  type ReasoningCommandSuggestion,
  type TypeaheadSuggestion,
} from "./typeahead-types";

export {
  typeaheadSuggestionKey,
  type ComposerCommandMenuState,
  type ComposerCommandSuggestion,
  type ComposerTypeaheadMenuState,
  type FastModeCommandSuggestion,
  type LocationCommandSuggestion,
  type ModelShortcutCommandSuggestion,
  type ReasoningCommandSuggestion,
  type TypeaheadSuggestion,
};

const ROW_ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";
const WINDOW_THRESHOLD = 40;
const ESTIMATED_ROW_HEIGHT_PX = 29;
const WINDOW_OVERSCAN_ROWS = 12;
const VIEWPORT_ROWS = 8;

interface MentionMenuProps {
  state: ComposerTypeaheadMenuState;
  selectedIndex: number;
  onApply: (item: TypeaheadSuggestion) => void;
  onDismiss?: () => void;
}

interface MenuSectionItem<TItem> {
  item: TItem;
  index: number;
}

interface MenuSection<TKind extends string, TItem> {
  kind: TKind;
  label: string;
  items: MenuSectionItem<TItem>[];
}

function groupSections<TKind extends string, TItem>(args: {
  suggestions: readonly TItem[];
  sectionKind: (item: TItem) => TKind;
  sectionLabel: (kind: TKind) => string;
}): MenuSection<TKind, TItem>[] {
  const sectionsByKind = new Map<TKind, MenuSection<TKind, TItem>>();
  for (let index = 0; index < args.suggestions.length; index += 1) {
    const item = args.suggestions[index]!;
    const kind = args.sectionKind(item);
    const existing = sectionsByKind.get(kind);
    if (existing) {
      existing.items.push({ item, index });
      continue;
    }

    sectionsByKind.set(kind, {
      kind,
      label: args.sectionLabel(kind),
      items: [{ item, index }],
    });
  }

  return [...sectionsByKind.values()];
}

type PathMentionSuggestion = Extract<PromptMentionSuggestion, { kind: "path" }>;
type ThreadMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "thread" }
>;
type SecondaryContextKind = "path" | "project";

function getPathSectionLabel(item: PathMentionSuggestion): string {
  return item.source === "thread-storage" ? "Thread storage" : "Workspace";
}

function getMentionTitle(item: PromptMentionSuggestion): string {
  if (item.kind === "thread") {
    const title = item.title || item.path;
    return item.projectName ? `${title} · ${item.projectName}` : title;
  }
  if (item.kind === "project") return `Project: ${item.name}`;
  if (item.kind === "section") return `Section: ${item.name}`;
  if (item.kind === "plugin") return `${item.providerLabel}: ${item.title}`;
  return `${getPathSectionLabel(item)}: ${item.path}`;
}

type CommandSectionKind =
  | ProviderCommandSection
  | "reasoning"
  | "fast-mode"
  | "location";

function getCommandSectionLabel(kind: CommandSectionKind): string {
  switch (kind) {
    case "location":
      return "Location";
    case "fast-mode":
      return "Fast mode";
    case "reasoning":
      return "Reasoning";
    case "agent-command":
      return "Commands";
    case "skill":
      return "Skills";
    case "project-command":
      return "Project commands";
    case "user-command":
      return "User commands";
  }
}

function getCommandIcon(item: ComposerCommandSuggestion): ReactNode {
  if (item.kind === "location") {
    return (
      <Icon
        name={item.name === "cloud" ? "Cloud" : "Laptop"}
        className={ROW_ICON_CLASS}
        aria-hidden
      />
    );
  }
  if (item.kind === "fast-mode") {
    return <Icon name="Zap" className={ROW_ICON_CLASS} aria-hidden />;
  }
  if (item.kind === "model-shortcut") {
    const HarnessLogo = item.icon;
    return HarnessLogo ? (
      <HarnessLogo className={ROW_ICON_CLASS} />
    ) : (
      <Icon name="Bot" className={ROW_ICON_CLASS} aria-hidden />
    );
  }
  if (item.kind === "reasoning") {
    return <Icon name="Brain" className={ROW_ICON_CLASS} aria-hidden />;
  }
  if (item.pluginId !== undefined) {
    return (
      <PluginIcon
        pluginId={item.pluginId}
        icon={null}
        className={ROW_ICON_CLASS}
      />
    );
  }
  return (
    <Icon
      name={promptCommandIconName(item)}
      className={ROW_ICON_CLASS}
      aria-hidden
    />
  );
}

function MutedTrailing({ children }: { children: string }) {
  return (
    <span className="truncate text-subtle-foreground [flex-shrink:9999]">
      {children}
    </span>
  );
}

function ThreadSuggestionTrailing({
  item,
  now,
}: {
  item: ThreadMentionSuggestion;
  now: number;
}) {
  const indicator = item.indicator;
  const hasStatus =
    indicator !== undefined && resolveThreadListIndicator(indicator) !== "none";
  return (
    <>
      {hasStatus ? (
        <span className="flex shrink-0 items-center [&_[data-icon-root]]:size-3">
          <ThreadStatusGlyph {...indicator} />
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-3 text-subtle-foreground">
        {item.projectName ? (
          <span className="max-w-32 truncate">{item.projectName}</span>
        ) : null}
        {item.lastActivityAt === undefined ? null : (
          <span className="tabular-nums">
            {formatRelativeTime({
              timestamp: item.lastActivityAt,
              now,
            })}
          </span>
        )}
      </span>
    </>
  );
}

function MutedTrailingPath({ children }: { children: string }) {
  return (
    <TruncateStart className="text-subtle-foreground [flex-shrink:9999]">
      {children}
    </TruncateStart>
  );
}

interface SuggestionRowProps {
  index: number;
  isSelected: boolean;
  icon: ReactNode;
  primary: string;
  trailing: ReactNode;
  title: string;
  onSelectIndex: (index: number) => void;
}

function SuggestionRow({
  index,
  isSelected,
  icon,
  primary,
  trailing,
  title,
  onSelectIndex,
}: SuggestionRowProps) {
  return (
    <button
      data-suggestion-index={index}
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        onSelectIndex(index);
      }}
      className={cn(
        "w-full scroll-mt-7 rounded-lg px-2 py-1.5 text-left text-xs",
        isSelected ? "bg-state-active text-foreground" : "hover:bg-state-hover",
      )}
      title={title}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-foreground">{primary}</span>
        {trailing}
      </div>
    </button>
  );
}

function CloseSuggestionsButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close suggestions"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onDismiss}
      className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
    >
      <Icon name="X" className="size-4" aria-hidden />
    </button>
  );
}

function MenuStatusRow({
  children,
  onDismiss,
  className,
}: {
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-xs",
        onDismiss
          ? "flex h-11 items-center justify-between pl-3 pr-1"
          : "px-3 py-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      {onDismiss ? <CloseSuggestionsButton onDismiss={onDismiss} /> : null}
    </div>
  );
}

function MenuSectionHeader({
  label,
  onDismiss,
}: {
  label: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 bg-background text-xs text-muted-foreground",
        onDismiss
          ? "flex h-11 items-center justify-between pl-3 pr-1"
          : "px-3 pb-1 pt-1.5",
      )}
    >
      <span>{label}</span>
      {onDismiss ? <CloseSuggestionsButton onDismiss={onDismiss} /> : null}
    </div>
  );
}

function MentionResults({
  results,
  selectedIndex,
  onSelectIndex,
  onDismiss,
}: {
  results: OrderedMentionSuggestions;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onDismiss?: () => void;
}) {
  const [now] = useState(Date.now);

  if (results.groups.length === 0) {
    return (
      <MenuStatusRow onDismiss={onDismiss} className="text-muted-foreground">
        No matching mentions
      </MenuStatusRow>
    );
  }

  return (
    <div className="pb-1">
      {results.groups.map((group, groupIndex) => (
        <div key={group.key}>
          <MenuSectionHeader
            label={group.label}
            onDismiss={groupIndex === 0 ? onDismiss : undefined}
          />
          <div className="flex flex-col gap-px px-1">
            {group.suggestions.map((item, itemIndex) => {
              const index = group.startIndex + itemIndex;
              let primary: string;
              let secondaryContext: string | null = null;
              let secondaryContextKind: SecondaryContextKind | null = null;

              if (item.kind === "thread") {
                primary = item.title || "Untitled thread";
              } else if (item.kind === "project" || item.kind === "section") {
                primary = item.name;
              } else if (item.kind === "plugin") {
                primary = item.title;
                secondaryContext = item.subtitle;
                secondaryContextKind =
                  item.subtitle === null ? null : "project";
              } else {
                const directory = directoryFromPath(item.path);
                primary = item.name;
                secondaryContext = directory || null;
                secondaryContextKind = directory ? "path" : null;
              }

              return (
                <SuggestionRow
                  key={getMentionKey(item)}
                  index={index}
                  isSelected={index === selectedIndex}
                  icon={
                    item.kind === "thread" ? (
                      <ThreadLocationIcon
                        isCloud={item.executionTarget === "cloud"}
                        className={cn(
                          ROW_ICON_CLASS,
                          item.executionTarget !== "cloud" && "opacity-50",
                        )}
                      />
                    ) : (
                      <PromptMentionIcon
                        resource={promptMentionResourceFromSuggestion(item)}
                        className={ROW_ICON_CLASS}
                      />
                    )
                  }
                  primary={primary}
                  trailing={
                    item.kind === "thread" ? (
                      <ThreadSuggestionTrailing item={item} now={now} />
                    ) : secondaryContext ===
                      null ? null : secondaryContextKind === "path" ? (
                      <MutedTrailingPath>{secondaryContext}</MutedTrailingPath>
                    ) : (
                      <MutedTrailing>{secondaryContext}</MutedTrailing>
                    )
                  }
                  title={getMentionTitle(item)}
                  onSelectIndex={onSelectIndex}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Computes a windowed slice for a long command section while always keeping `selectedIndex` mounted. */
function sectionWindow(
  items: readonly MenuSectionItem<ComposerCommandSuggestion>[],
  scrollTop: number,
  sectionTopOffsetPx: number,
  selectedIndex: number,
): { start: number; end: number; topSpacerPx: number; bottomSpacerPx: number } {
  const count = items.length;
  if (count <= WINDOW_THRESHOLD) {
    return { start: 0, end: count, topSpacerPx: 0, bottomSpacerPx: 0 };
  }
  const relativeScrollPx = Math.max(0, scrollTop - sectionTopOffsetPx);
  const firstVisible = Math.floor(relativeScrollPx / ESTIMATED_ROW_HEIGHT_PX);
  let start = Math.min(count, Math.max(0, firstVisible - WINDOW_OVERSCAN_ROWS));
  let end = Math.min(
    count,
    firstVisible + VIEWPORT_ROWS + WINDOW_OVERSCAN_ROWS,
  );
  const firstIndex = items[0]!.index;
  const lastIndex = items[count - 1]!.index;
  if (selectedIndex >= firstIndex && selectedIndex <= lastIndex) {
    const localSelected = selectedIndex - firstIndex;
    if (localSelected < start) {
      start = Math.max(0, localSelected - WINDOW_OVERSCAN_ROWS);
      end = Math.min(count, localSelected + VIEWPORT_ROWS + WINDOW_OVERSCAN_ROWS);
    } else if (localSelected >= end) {
      end = Math.min(count, localSelected + WINDOW_OVERSCAN_ROWS + 1);
      start = Math.max(0, end - (VIEWPORT_ROWS + WINDOW_OVERSCAN_ROWS * 2));
    }
  }
  return {
    start,
    end,
    topSpacerPx: start * ESTIMATED_ROW_HEIGHT_PX,
    bottomSpacerPx: (count - end) * ESTIMATED_ROW_HEIGHT_PX,
  };
}

function CommandResults({
  suggestions,
  selectedIndex,
  scrollTop,
  onSelectIndex,
  onDismiss,
}: {
  suggestions: readonly ComposerCommandSuggestion[];
  selectedIndex: number;
  scrollTop: number;
  onSelectIndex: (index: number) => void;
  onDismiss?: () => void;
}) {
  const sections = useMemo(
    () =>
      groupSections({
        suggestions,
        sectionKind: (item): CommandSectionKind =>
          item.kind === "command"
            ? providerCommandSection(item)
            : item.kind === "model-shortcut"
              ? "skill"
              : item.kind,
        sectionLabel: getCommandSectionLabel,
      }),
    [suggestions],
  );

  if (sections.length === 0) {
    return null;
  }

  let runningOffsetPx = 0;
  return (
    <div className="pb-1">
      {sections.map((section, sectionIndex) => {
        const sectionTopOffsetPx = runningOffsetPx;
        runningOffsetPx += 24 + section.items.length * ESTIMATED_ROW_HEIGHT_PX;
        const { start, end, topSpacerPx, bottomSpacerPx } = sectionWindow(
          section.items,
          scrollTop,
          sectionTopOffsetPx,
          selectedIndex,
        );
        const visibleItems =
          start === 0 && end === section.items.length
            ? section.items
            : section.items.slice(start, end);

        return (
          <div key={section.kind}>
            <MenuSectionHeader
              label={section.label}
              onDismiss={sectionIndex === 0 ? onDismiss : undefined}
            />
            <div className="flex flex-col gap-px px-1">
              {topSpacerPx > 0 ? (
                <div style={{ height: topSpacerPx }} aria-hidden />
              ) : null}
              {visibleItems.map(({ item, index }) => (
                <SuggestionRow
                  key={typeaheadSuggestionKey(item)}
                  index={index}
                  isSelected={index === selectedIndex}
                  icon={getCommandIcon(item)}
                  primary={item.name}
                  trailing={
                    <>
                      {item.description !== null ? (
                        <MutedTrailing>{item.description}</MutedTrailing>
                      ) : null}
                      {item.kind === "command" && item.argumentHint !== null ? (
                        <span className="shrink-0 text-subtle-foreground">
                          {item.argumentHint}
                        </span>
                      ) : null}
                    </>
                  }
                  title={item.description ?? item.name}
                  onSelectIndex={onSelectIndex}
                />
              ))}
              {bottomSpacerPx > 0 ? (
                <div style={{ height: bottomSpacerPx }} aria-hidden />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function flatSuggestions(
  state: ComposerTypeaheadMenuState,
): readonly TypeaheadSuggestion[] {
  if (state.state.kind !== "results") return [];
  return state.trigger === "mention"
    ? state.state.results.suggestions
    : state.state.suggestions;
}

function mentionResults(
  state: ComposerTypeaheadMenuState,
): OrderedMentionSuggestions {
  return state.trigger === "mention" && state.state.kind === "results"
    ? state.state.results
    : EMPTY_ORDERED_MENTION_SUGGESTIONS;
}

function commandSuggestions(
  state: ComposerTypeaheadMenuState,
): readonly ComposerCommandSuggestion[] {
  return state.trigger === "command" && state.state.kind === "results"
    ? state.state.suggestions
    : [];
}

export const MentionMenu = memo(function MentionMenu({
  state,
  selectedIndex,
  onApply,
  onDismiss,
}: MentionMenuProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const items = flatSuggestions(state);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  const isWindowed =
    state.trigger === "command" && items.length > WINDOW_THRESHOLD;
  const resultsLength = items.length;
  const [scrollTop, setScrollTop] = useState(0);
  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!isWindowed) return;
      const nextTop = event.currentTarget.scrollTop;
      setScrollTop((current) =>
        nextTop === 0 || Math.abs(current - nextTop) >= ESTIMATED_ROW_HEIGHT_PX
          ? nextTop
          : current,
      );
    },
    [isWindowed],
  );

  useLayoutEffect(() => {
    const nextTop = isWindowed
      ? (scrollContainerRef.current?.scrollTop ?? 0)
      : 0;
    setScrollTop((current) => (current === nextTop ? current : nextTop));
  }, [isWindowed, resultsLength]);

  const handleSelectIndex = useCallback((index: number) => {
    const item = itemsRef.current[index];
    if (item) onApplyRef.current(item);
  }, []);

  useEffect(() => {
    if (resultsLength === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const selectedItem = container.querySelector<HTMLElement>(
      `[data-suggestion-index="${selectedIndex}"]`,
    );
    selectedItem?.scrollIntoView({ block: "nearest" });
  }, [resultsLength, selectedIndex]);

  const innerState = state.state;
  return (
    <div className="overflow-hidden rounded-xl border border-foreground/[0.11] bg-popover text-popover-foreground">
      <div
        ref={scrollContainerRef}
        className="max-h-48 overflow-y-auto"
        onScroll={isWindowed ? handleScroll : undefined}
      >
        {innerState.kind === "hint" ? (
          <MenuStatusRow
            onDismiss={onDismiss}
            className="text-muted-foreground"
          >
            Type to search mentions
          </MenuStatusRow>
        ) : innerState.kind === "loading" ? (
          <MenuStatusRow
            onDismiss={onDismiss}
            className="text-muted-foreground"
          >
            <Icon name="Spinner" className="size-3.5 animate-spin" />
            <span>
              {state.trigger === "command"
                ? "Searching commands…"
                : "Searching mentions…"}
            </span>
          </MenuStatusRow>
        ) : innerState.kind === "error" ? (
          <MenuStatusRow onDismiss={onDismiss} className="text-destructive">
            {state.trigger === "command"
              ? "Failed to load commands"
              : "Failed to load suggestions"}
          </MenuStatusRow>
        ) : state.trigger === "command" ? (
          <CommandResults
            suggestions={commandSuggestions(state)}
            selectedIndex={selectedIndex}
            scrollTop={scrollTop}
            onSelectIndex={handleSelectIndex}
            onDismiss={onDismiss}
          />
        ) : (
          <MentionResults
            results={mentionResults(state)}
            selectedIndex={selectedIndex}
            onSelectIndex={handleSelectIndex}
            onDismiss={onDismiss}
          />
        )}
      </div>
    </div>
  );
});
