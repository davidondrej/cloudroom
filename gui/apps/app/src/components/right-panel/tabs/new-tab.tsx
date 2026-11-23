import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAtom } from "jotai";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { directoryFromPath } from "@cloudroom/thread-view";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { EmptyStatePanel } from "@cloudroom/shared-ui/empty-state";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@cloudroom/shared-ui/motion";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import type { PluginPanelActionEntry } from "@/components/plugin/PluginPanelActions";
import { newTabActionOrderAtom } from "@/components/right-panel/store/panel-prefs";
import {
  THREAD_RECENT_ITEMS_VISIBLE_LIMIT,
  useThreadRecentItems,
  type ThreadRecentItem,
} from "@/components/right-panel/store/panel-atoms";
import type { FileSearchSelection } from "@/components/right-panel/store/use-panel-tabs";
import { useSidebarSortable } from "@/components/sidebar/sortableMotion";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { useReorderDnd } from "@/components/ui/useReorderDnd";
import {
  useFileSearchSuggestions,
  type FilePathSearchSuggestion,
} from "@/hooks/useFileSearchSuggestions";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { formatRelativeTime } from "@/lib/relative-time";
import { isDesktopBrowserAvailable } from "@/lib/room-desktop";
import { arrangeByStoredOrder, reorderStoredOrder } from "@/lib/stored-order";
import {
  getFileNameFromPath,
  resolveRightPanelFileIconName,
} from "./file-tab-visuals";
import {
  LAUNCHER_ACTION_ROW_BASE_CLASS,
  LAUNCHER_ROW_BASE_CLASS,
  LAUNCHER_ROW_ICON_CLASS,
  LauncherRowTrailing,
  LauncherSectionHeader,
} from "./tab-primitives";

export type OpenBrowserHandler = () => void;
export type StartTerminalHandler = () => void;

export interface NewTabActionsProps {
  onOpenBrowser?: OpenBrowserHandler;
  onStartTerminal?: StartTerminalHandler;
  startTerminalDisabled?: boolean;
  startTerminalTrailing?: ReactNode;
  pluginActions?: readonly PluginPanelActionEntry[];
}

export interface NewTabFileSearchProps {
  projectId: string | undefined;
  environmentId: string | null;
  hostId?: string | null;
  currentThreadId: string;
  autoFocus: boolean;
  idleActions: ReactNode;
  initialQuery?: string;
  onAutoFocusHandled: () => void;
  onSelect: (selection: FileSearchSelection) => void;
  recentItemsThreadId?: string | null;
  showFileSearch?: boolean;
}

interface ActionEntry {
  id: string;
  icon: ReactNode;
  label: string;
  disabled: boolean;
  shortcut: AppShortcutPresentation | null;
  trailing: ReactNode;
  onSelect: () => void;
}

const DRAG_HANDLE_CLASS =
  "cursor-grab touch-none opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing group-hover:opacity-100 [@media(hover:none)]:opacity-100";

function ActionRow({
  action,
  dragHandle,
}: {
  action: ActionEntry;
  dragHandle?: ReactNode;
}) {
  return (
    <div
      className={cn(
        LAUNCHER_ACTION_ROW_BASE_CLASS,
        "relative scroll-mt-7 focus-within:bg-state-hover focus-within:text-foreground",
        !action.disabled && "hover:bg-state-hover",
      )}
    >
      <button
        type="button"
        id={action.id}
        aria-keyshortcuts={action.shortcut?.ariaKeyshortcuts}
        disabled={action.disabled}
        onClick={action.onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none disabled:cursor-default"
      >
        <span className={LAUNCHER_ROW_ICON_CLASS}>{action.icon}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {action.label}
        </span>
      </button>
      <AppCommandShortcutHint shortcut={action.shortcut} />
      {dragHandle}
      {action.trailing !== null ? (
        <div className="flex min-w-0 shrink-0 items-center">
          {action.trailing}
        </div>
      ) : null}
    </div>
  );
}

function SortableActionRow({ action }: { action: ActionEntry }) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: action.id,
    disabled: false,
  });
  const { attributes, listeners, setActivatorNodeRef } = dragBindings;
  return (
    <div ref={setNodeRef} style={style}>
      <ActionRow
        action={action}
        dragHandle={
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={`Reorder ${action.label}`}
            className={cn(LAUNCHER_ROW_ICON_CLASS, DRAG_HANDLE_CLASS)}
            {...attributes}
            {...listeners}
          >
            <Icon
              name="DragDropVertical"
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              aria-hidden
            />
          </button>
        }
      />
    </div>
  );
}

function ReorderableActionList({
  actions,
  normalizedOrder,
  onOrderChange,
}: {
  actions: readonly ActionEntry[];
  normalizedOrder: readonly string[];
  onOrderChange: (order: string[]) => void;
}) {
  const ids = useMemo(() => actions.map((a) => a.id), [actions]);
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (
        !event.over ||
        typeof event.active.id !== "string" ||
        typeof event.over.id !== "string"
      ) {
        return;
      }
      const next = reorderStoredOrder({
        activeId: event.active.id,
        overId: event.over.id,
        order: normalizedOrder,
        visibleIds: ids,
      });
      if (next) onOrderChange(next);
    },
    [ids, normalizedOrder, onOrderChange],
  );
  const { dndContextProps, onClickCapture } = useReorderDnd({ onDragEnd });

  return (
    <DndContext {...dndContextProps}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-px" onClickCapture={onClickCapture}>
          {actions.map((action) => (
            <SortableActionRow key={action.id} action={action} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

export function NewTabActions({
  onOpenBrowser,
  onStartTerminal,
  pluginActions,
  startTerminalDisabled = false,
  startTerminalTrailing,
}: NewTabActionsProps) {
  const terminalShortcut = useAppCommandShortcut("terminal.open");
  const [storedOrder, setStoredOrder] = useAtom(newTabActionOrderAtom);

  const actions = useMemo<ActionEntry[]>(() => {
    const list: ActionEntry[] = [];
    const makeIcon = (name: IconName) => (
      <Icon
        name={name}
        className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
        aria-hidden
      />
    );
    if (onOpenBrowser && isDesktopBrowserAvailable()) {
      list.push({
        id: "file-search-result-open-browser",
        icon: makeIcon("Globe"),
        label: "Open browser",
        disabled: false,
        shortcut: null,
        trailing: null,
        onSelect: onOpenBrowser,
      });
    }
    if (onStartTerminal) {
      list.push({
        id: "file-search-result-start-terminal",
        icon: makeIcon("Terminal"),
        label: "Start terminal",
        disabled: startTerminalDisabled,
        shortcut: terminalShortcut,
        trailing: startTerminalTrailing ?? null,
        onSelect: onStartTerminal,
      });
    }
    for (const action of pluginActions ?? []) {
      list.push({
        id: action.id,
        icon: (
          <PluginIcon
            pluginId={action.pluginId}
            icon={action.icon}
            className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
          />
        ),
        label: action.title,
        disabled: false,
        shortcut: null,
        trailing: null,
        onSelect: action.onSelect,
      });
    }
    return list;
  }, [
    onOpenBrowser,
    onStartTerminal,
    pluginActions,
    startTerminalDisabled,
    startTerminalTrailing,
    terminalShortcut,
  ]);

  const { ordered, normalizedOrder } = useMemo(
    () =>
      arrangeByStoredOrder({
        items: actions.map((a) => a.id),
        getId: (id) => id,
        storedOrder,
      }),
    [actions, storedOrder],
  );

  const orderedActions = useMemo(() => {
    const map = new Map(actions.map((a) => [a.id, a]));
    return ordered
      .map((id) => map.get(id))
      .filter((a): a is ActionEntry => a !== undefined);
  }, [actions, ordered]);

  if (orderedActions.length === 0) return null;

  return (
    <div data-testid="new-tab-actions" className="flex min-w-0 flex-col">
      <section>
        <LauncherSectionHeader label="Actions" className="pb-1" />
        {orderedActions.length < 2 ? (
          <div className="flex flex-col gap-px">
            {orderedActions.map((action) => (
              <ActionRow key={action.id} action={action} />
            ))}
          </div>
        ) : (
          <ReorderableActionList
            actions={orderedActions}
            normalizedOrder={normalizedOrder}
            onOrderChange={setStoredOrder}
          />
        )}
      </section>
    </div>
  );
}

type SearchEntry =
  | { kind: "suggestion"; suggestion: FilePathSearchSuggestion }
  | { kind: "recent"; item: ThreadRecentItem };

const SOURCE_LABELS = {
  workspace: "Workspace",
  "thread-storage": "Thread storage",
} as const;

function entryDomId(entry: SearchEntry): string {
  return entry.kind === "recent"
    ? `file-search-result-recent-${entry.item.source}-${encodeURIComponent(entry.item.path)}`
    : `file-search-result-${entry.suggestion.source}-${encodeURIComponent(entry.suggestion.path)}`;
}

function SearchNotice({
  iconName,
  iconClassName,
  message,
}: {
  iconName: "AlertCircle" | "File" | "FileQuestion" | "Spinner";
  iconClassName?: string;
  message: string;
}) {
  return (
    <EmptyStatePanel className="flex min-h-24 items-center justify-center">
      <div className="flex max-w-64 items-center justify-center gap-1.5">
        <Icon
          name={iconName}
          className={cn(
            COARSE_POINTER_ICON_SIZE_CLASS,
            "shrink-0",
            iconClassName,
          )}
        />
        <p className={COARSE_POINTER_TEXT_SM_CLASS}>{message}</p>
      </div>
    </EmptyStatePanel>
  );
}

export function NewTabFileSearch({
  projectId,
  environmentId,
  hostId,
  currentThreadId,
  autoFocus,
  idleActions,
  initialQuery = "",
  onAutoFocusHandled,
  onSelect,
  recentItemsThreadId,
  showFileSearch = true,
}: NewTabFileSearchProps) {
  const quickOpenShortcut = useAppCommandShortcut("file.quickOpen");
  const inputRef = useRef<HTMLInputElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const listboxId = useId();
  const isCoarse = usePointerCoarse();

  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [nowMs] = useState(() => Date.now());

  const recentThreadId =
    recentItemsThreadId === undefined
      ? currentThreadId || null
      : recentItemsThreadId;
  const recentItems = useThreadRecentItems(recentThreadId);
  const hasQuery = query.trim().length > 0;

  const {
    suggestions,
    isLoading,
    fileSearchError,
    isDebouncing,
    isUnavailable,
  } = useFileSearchSuggestions({
    projectId,
    query,
    limit: 20,
    environmentId,
    hostId,
    currentThreadId,
  });

  const fileEntries = useMemo<SearchEntry[]>(
    () =>
      hasQuery
        ? suggestions.map((suggestion) => ({ kind: "suggestion", suggestion }))
        : [],
    [hasQuery, suggestions],
  );

  const visibleRecent = useMemo(
    () =>
      recentExpanded
        ? recentItems
        : recentItems.slice(0, THREAD_RECENT_ITEMS_VISIBLE_LIMIT),
    [recentExpanded, recentItems],
  );

  const recentEntries = useMemo<SearchEntry[]>(
    () =>
      hasQuery ? [] : visibleRecent.map((item) => ({ kind: "recent", item })),
    [hasQuery, visibleRecent],
  );

  const navigable = useMemo(
    () => [...fileEntries, ...recentEntries],
    [fileEntries, recentEntries],
  );

  useEffect(() => {
    setActiveIndex(navigable.length > 0 ? 0 : -1);
  }, [navigable]);

  useEffect(
    () => () => {
      if (focusFrameRef.current !== null)
        cancelAnimationFrame(focusFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!autoFocus) return;
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    }
    if (isCoarse) {
      onAutoFocusHandled();
      return;
    }
    inputRef.current?.focus({ preventScroll: true });
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      inputRef.current?.focus({ preventScroll: true });
    });
    onAutoFocusHandled();
  }, [autoFocus, isCoarse, onAutoFocusHandled]);

  const activeEntry =
    activeIndex >= 0 && activeIndex < navigable.length
      ? (navigable[activeIndex] ?? null)
      : null;

  const selectEntry = useCallback(
    (entry: SearchEntry) => {
      if (entry.kind === "recent") {
        onSelect({ source: entry.item.source, path: entry.item.path });
      } else {
        onSelect({
          source: entry.suggestion.source,
          path: entry.suggestion.path,
        });
      }
    },
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (navigable.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((cur) => (cur + 1) % navigable.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((cur) => (cur <= 0 ? navigable.length - 1 : cur - 1));
      } else if (event.key === "Enter" && activeEntry) {
        event.preventDefault();
        selectEntry(activeEntry);
      }
    },
    [activeEntry, navigable.length, selectEntry],
  );

  if (!showFileSearch) {
    return <div className="flex min-w-0 flex-col gap-3">{idleActions}</div>;
  }

  const hasListbox = !isUnavailable && navigable.length > 0;
  const showFiles = fileEntries.length > 0;
  const showRecentRows = recentEntries.length > 0;
  const showRecentEmpty = !hasQuery && recentItems.length === 0;
  const showLoading = isLoading && !showFiles;
  const showError = fileSearchError && !showFiles && !showLoading;
  const showNoMatches = hasQuery && !showFiles && !showLoading && !showError;
  const showSearchMsg = showLoading || showError || showNoMatches;
  const recentHasHeaderAbove = showFiles || showSearchMsg;
  const showMoreCount = Math.max(
    0,
    recentItems.length - THREAD_RECENT_ITEMS_VISIBLE_LIMIT,
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="relative min-w-0">
        <Icon
          name="Search"
          className={cn(
            "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground",
            COARSE_POINTER_ICON_SIZE_CLASS,
          )}
        />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isUnavailable}
          role="combobox"
          aria-label={
            quickOpenShortcut
              ? `Search files (${quickOpenShortcut.label})`
              : "Search files"
          }
          aria-keyshortcuts={quickOpenShortcut?.ariaKeyshortcuts}
          aria-autocomplete="list"
          aria-expanded={hasListbox}
          aria-controls={hasListbox ? listboxId : undefined}
          aria-activedescendant={
            hasListbox && activeEntry ? entryDomId(activeEntry) : undefined
          }
          placeholder={isUnavailable ? "No searchable source" : "Search files"}
          className={cn(
            "h-8 pl-8 pr-8 focus-visible:ring-0 max-md:pointer-coarse:h-10",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        />
        {isDebouncing ? (
          <Icon
            name="Spinner"
            className={cn(
              "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
            )}
          />
        ) : null}
      </div>

      {hasQuery ? null : idleActions}

      {isUnavailable ? (
        <SearchNotice
          iconName="FileQuestion"
          message="No searchable source is available."
        />
      ) : !showFiles &&
        !showRecentRows &&
        !showRecentEmpty &&
        !showLoading &&
        !showError ? (
        <SearchNotice
          iconName={hasQuery ? "FileQuestion" : "File"}
          message={
            hasQuery ? "No results match your search." : "Type to search files."
          }
        />
      ) : (
        <div className="pb-1">
          {showSearchMsg ? (
            <SearchNotice
              iconName={
                showError
                  ? "AlertCircle"
                  : showLoading
                    ? "Spinner"
                    : "FileQuestion"
              }
              iconClassName={showLoading ? "animate-spin" : undefined}
              message={
                showError
                  ? "Search failed."
                  : showLoading
                    ? "Searching files..."
                    : "No results match your search."
              }
            />
          ) : null}

          {showFiles || showRecentRows ? (
            <div id={listboxId} role="listbox" aria-label="File search results">
              {showFiles ? (
                <section role="group" aria-label="Files">
                  <LauncherSectionHeader label="Files" sticky />
                  <div className="flex flex-col gap-px">
                    {fileEntries.map((entry, idx) => {
                      if (entry.kind !== "suggestion") return null;
                      const { suggestion } = entry;
                      const dir = directoryFromPath(suggestion.path) || null;
                      const active = idx === activeIndex;
                      return (
                        <button
                          key={`${suggestion.source}:${suggestion.path}`}
                          type="button"
                          id={entryDomId(entry)}
                          role="option"
                          aria-selected={active}
                          onClick={() => selectEntry(entry)}
                          onMouseEnter={() => setActiveIndex(idx)}
                          title={`${SOURCE_LABELS[suggestion.source]}: ${suggestion.path}`}
                          className={cn(
                            "w-full scroll-mt-7 rounded px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                            LIST_HOVER_TRANSITION,
                            COARSE_POINTER_TEXT_SM_CLASS,
                            active ? "bg-state-active" : "hover:bg-state-hover",
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Icon
                              name={resolveRightPanelFileIconName(
                                suggestion.path,
                              )}
                              className={cn(
                                COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                                "text-muted-foreground",
                              )}
                              aria-hidden
                            />
                            <span className="truncate">{suggestion.name}</span>
                            {dir ? (
                              <TruncateStart className="text-muted-foreground [flex-shrink:9999]">
                                {dir}
                              </TruncateStart>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {showRecentRows ? (
                <section
                  role="group"
                  aria-label="Recent"
                  className={cn(recentHasHeaderAbove && "mt-3")}
                >
                  <LauncherSectionHeader
                    label="Recent"
                    count={
                      recentItems.length > 0 ? recentItems.length : undefined
                    }
                    sticky
                    className={recentHasHeaderAbove ? "pt-2" : undefined}
                  />
                  <div className="flex flex-col gap-px">
                    {recentEntries.map((entry, offset) => {
                      if (entry.kind !== "recent") return null;
                      const idx = fileEntries.length + offset;
                      const { item } = entry;
                      const active = idx === activeIndex;
                      const dir = directoryFromPath(item.path);
                      return (
                        <button
                          key={`recent:${item.source}:${item.path}`}
                          type="button"
                          id={entryDomId(entry)}
                          role="option"
                          aria-selected={active}
                          onClick={() => selectEntry(entry)}
                          onMouseEnter={() => setActiveIndex(idx)}
                          title={item.path}
                          className={cn(
                            LAUNCHER_ROW_BASE_CLASS,
                            "relative scroll-mt-7",
                            active ? "bg-state-active" : "hover:bg-state-hover",
                          )}
                        >
                          <span className={LAUNCHER_ROW_ICON_CLASS}>
                            <Icon
                              name={resolveRightPanelFileIconName(item.path)}
                              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
                              aria-hidden
                            />
                          </span>
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="truncate text-foreground">
                              {getFileNameFromPath({ path: item.path })}
                            </span>
                            {dir ? (
                              <TruncateStart className="text-muted-foreground [flex-shrink:9999]">
                                {dir}
                              </TruncateStart>
                            ) : null}
                          </span>
                          <LauncherRowTrailing
                            idle={formatRelativeTime({
                              timestamp: item.openedAt,
                              now: nowMs,
                            })}
                            isActive={active}
                          />
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          {showRecentEmpty && !showRecentRows ? (
            <section className={cn(recentHasHeaderAbove && "mt-3")}>
              <LauncherSectionHeader
                label="Recent"
                sticky
                className={recentHasHeaderAbove ? "pt-2" : undefined}
              />
              <EmptyStatePanel
                className={cn("py-4", COARSE_POINTER_TEXT_SM_CLASS)}
              >
                Plans, mockups, and files you open will show up here.
              </EmptyStatePanel>
            </section>
          ) : null}

          {!hasQuery && showMoreCount > 0 ? (
            <button
              type="button"
              aria-expanded={recentExpanded}
              onClick={() => setRecentExpanded((v) => !v)}
              className={cn(
                "ml-1.5 mt-0.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
                COARSE_POINTER_TEXT_SM_CLASS,
              )}
            >
              <Icon
                name="ChevronDown"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
                  "transition-transform",
                  recentExpanded && "rotate-180",
                )}
                aria-hidden
              />
              <span>
                {recentExpanded ? "Show less" : `Show ${showMoreCount} more`}
              </span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function NewTabPage({
  onOpenBrowser,
  onStartTerminal,
  pluginActions,
  startTerminalDisabled,
  startTerminalTrailing,
  ...searchProps
}: Omit<NewTabFileSearchProps, "idleActions"> & NewTabActionsProps) {
  return (
    <div className="flex min-h-full flex-col gap-3 bg-sidebar px-4 pb-3 pt-1">
      <NewTabFileSearch
        {...searchProps}
        idleActions={
          <NewTabActions
            onOpenBrowser={onOpenBrowser}
            onStartTerminal={onStartTerminal}
            pluginActions={pluginActions}
            startTerminalDisabled={startTerminalDisabled}
            startTerminalTrailing={startTerminalTrailing}
          />
        }
      />
    </div>
  );
}
