import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { pluginCommandId, pluginCommandIdSchema } from "@cloudroom/domain";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogTitle } from "@cloudroom/shared-ui/dialog";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { COARSE_POINTER_TEXT_SM_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { LAUNCHER_ACTION_ROW_BASE_CLASS } from "@/components/secondary-panel/launcherRow";
import {
  useAppCommandHandler,
  useIndexedAppCommandHandlers,
  useAppCommandRunner,
  useAppCommandShortcuts,
} from "./AppCommandProvider";
import { AppCommandShortcutPill } from "./AppCommandShortcutHint";
import type { PaletteAction } from "@/lib/command-palette/palette-action";
import {
  buildAppCommandActions,
  PALETTE_COMMAND_IDS,
} from "@/lib/command-palette/palette-app-commands";
import {
  rankPaletteActions,
  type RankedPaletteAction,
} from "@/lib/command-palette/palette-ranking";
import {
  readPaletteRecents,
  recordPaletteRecent,
} from "@/lib/command-palette/palette-recents";
import { buildPluginPaletteActions } from "@/lib/command-palette/palette-plugin-actions";
import { buildSettingsPaletteActions } from "@/lib/command-palette/palette-settings-actions";
import { buildPluginPagePaletteActions } from "@/lib/command-palette/palette-plugin-page-actions";
import { usePluginSlots } from "@/lib/plugin-slots";
import { getActiveThreadPanelOpener } from "@/components/plugin/plugin-thread-panel-navigation";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";
import { pluginListQueryOptions } from "@/hooks/queries/plugin-settings-queries";
import {
  buildPluginSettingsEntries,
  type PluginSettingsCandidate,
} from "@/components/settings/plugin-settings-entries";
import { useSettingsNavSections } from "@/components/settings/settings-nav";
import { appQueryClient } from "@/lib/app-query-client";
import {
  ThreadPaletteResults,
  type SearchFilters,
  type ThreadPaletteNavigationItem,
  type ThreadPaletteSummary,
} from "./ThreadPaletteResults";

type PaletteMode = "commands" | "threads";

const FILTERS_KEY = "cloudroom.search.filters";
const FILTER_CHIPS = [
  { key: "threads", label: "Threads", icon: "MessageSquare" },
  { key: "projects", label: "Projects", icon: "Folder" },
  { key: "archived", label: "Archived", icon: "Archive" },
] as const;

function readFilters(): SearchFilters {
  const all = { threads: true, projects: true, archived: true };
  try {
    const saved = JSON.parse(window.localStorage.getItem(FILTERS_KEY) ?? "null") as Partial<SearchFilters> | null;
    return saved ? { ...all, ...saved } : all;
  } catch {
    return all;
  }
}

function ShortcutHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <AppCommandShortcutPill shortcut={{ ariaKeyshortcuts: "", label: keys }} />
      {label}
    </span>
  );
}

function invocationTarget(invocation: {
  target: EventTarget | null;
}): EventTarget | null {
  return (
    invocation.target ??
    (typeof document === "undefined" ? null : document.activeElement)
  );
}

export interface CommandPaletteProps {
  threadId: string | null;
  projectId: string | null;
}

export function CommandPalette({ threadId, projectId }: CommandPaletteProps) {
  const navigate = useNavigate();
  const runner = useAppCommandRunner();
  const shortcuts = useAppCommandShortcuts(PALETTE_COMMAND_IDS);
  const listId = useId();
  const optionIdPrefix = useId();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [actions, setActions] = useState<readonly PaletteAction[]>([]);
  const [threadItems, setThreadItems] = useState<
    readonly ThreadPaletteNavigationItem[]
  >([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const pickedThreadIdRef = useRef<string | null>(null);
  const handleThreadItems = useCallback(
    (items: readonly ThreadPaletteNavigationItem[]) => {
      setThreadItems(items);
      const picked = pickedThreadIdRef.current;
      const index = picked === null ? -1 : items.findIndex((item) => item.id === picked);
      if (index >= 0) setHighlightedIndex(index);
    },
    [],
  );
  const [recents, setRecents] = useState<readonly string[]>(() =>
    readPaletteRecents(),
  );
  const [filters, setFilters] = useState<SearchFilters>(readFilters);
  const [summary, setSummary] = useState<ThreadPaletteSummary>({ counts: null, jev: "off" });
  const toggleFilter = useCallback((key: keyof SearchFilters) => {
    setFilters((current) => {
      const next = { ...current, [key]: !current[key] };
      window.localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
      return next;
    });
    setHighlightedIndex(0);
    pickedThreadIdRef.current = null;
  }, []);
  const includeArchived = useCallback(() => {
    if (!filters.archived) toggleFilter("archived");
  }, [filters.archived, toggleFilter]);
  const [installedPlugins, setInstalledPlugins] = useState<
    readonly PluginSettingsCandidate[]
  >([]);
  const pluginSlots = usePluginSlots();
  const pluginCommandIds = useMemo(
    () =>
      pluginSlots.commandPaletteActions.map((command) =>
        pluginCommandId(command.pluginId, command.id),
      ),
    [pluginSlots.commandPaletteActions],
  );
  const pluginShortcuts = useAppCommandShortcuts(pluginCommandIds);
  useIndexedAppCommandHandlers(pluginCommandIds, (index) => {
    const slot = pluginSlots.commandPaletteActions[index];
    if (!slot) return false;
    const action = buildPluginPaletteActions({
      slots: [slot],
      threadId,
      projectId,
      openThreadPanel: getActiveThreadPanelOpener(),
    })[0];
    if (!action) return false;
    action.run();
    return true;
  });
  const sections = useSettingsNavSections(pluginSlots.fileOpeners);
  const pluginSettingsEntries = useMemo(
    () =>
      buildPluginSettingsEntries({
        installedPlugins,
        settingsSections: pluginSlots.settingsSections,
      }),
    [installedPlugins, pluginSlots.settingsSections],
  );
  const settingsActions = useMemo(
    () =>
      buildSettingsPaletteActions({
        navigate: (path) => {
          void navigate(path);
        },
        pluginEntries: pluginSettingsEntries,
        sections,
      }),
    [navigate, pluginSettingsEntries, sections],
  );
  const pluginPageActions = useMemo(
    () =>
      buildPluginPagePaletteActions({
        navigate: (path) => {
          void navigate(path);
        },
        panels: pluginSlots.navPanels,
      }),
    [navigate, pluginSlots.navPanels],
  );
  const openTargetRef = useRef<EventTarget | null>(null);
  const pendingRunRef = useRef<(() => void) | null>(null);

  const loadInstalledPlugins = useCallback(() => {
    void appQueryClient
      .fetchQuery(pluginListQueryOptions({ enabled: true }))
      .then(setInstalledPlugins, () => {});
  }, []);

  const buildActions = useCallback(
    (target: EventTarget | null) => [
      ...buildAppCommandActions({
        target,
        isCommandAvailable: runner.isCommandAvailable,
        dispatch: runner.dispatch,
        shortcuts,
      }),
      ...buildPluginPaletteActions({
        slots: pluginSlots.commandPaletteActions,
        threadId,
        projectId,
        openThreadPanel: getActiveThreadPanelOpener(),
      }).map((action) => ({
        ...action,
        shortcut:
          pluginShortcuts.get(pluginCommandIdSchema.parse(action.id)) ?? null,
      })),
    ],
    [
      projectId,
      pluginSlots.commandPaletteActions,
      pluginShortcuts,
      runner.dispatch,
      runner.isCommandAvailable,
      shortcuts,
      threadId,
    ],
  );

  const openPalette = useCallback(
    (mode: PaletteMode, target: EventTarget | null) => {
      openTargetRef.current = target;
      setActions(buildActions(target));
      setThreadItems([]);
      setQuery(mode === "commands" ? ">" : "");
      setHighlightedIndex(0);
      pickedThreadIdRef.current = null;
      setOpen(true);
      loadInstalledPlugins();
    },
    [buildActions, loadInstalledPlugins],
  );

  useAppCommandHandler("palette.open", (invocation) => {
    openPalette("commands", invocationTarget(invocation));
    return true;
  });

  useAppCommandHandler("thread.search", (invocation) => {
    openPalette("threads", invocationTarget(invocation));
    return true;
  });

  const mode: PaletteMode = query.startsWith(">") ? "commands" : "threads";
  const modeQuery = mode === "commands" ? query.slice(1) : query;
  const commandActions = useMemo<readonly PaletteAction[]>(
    () => [...actions, ...settingsActions, ...pluginPageActions],
    [actions, pluginPageActions, settingsActions],
  );
  const rankedCommands = useMemo(
    () =>
      rankPaletteActions({
        actions: commandActions,
        query: modeQuery,
        recentIds: recents,
      }),
    [commandActions, modeQuery, recents],
  );
  const resultCount =
    mode === "commands" ? rankedCommands.length : threadItems.length;
  const activeIndex =
    resultCount === 0 ? -1 : Math.min(highlightedIndex, resultCount - 1);

  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollOnNextHighlightRef = useRef(false);
  useEffect(() => {
    if (!scrollOnNextHighlightRef.current) return;
    scrollOnNextHighlightRef.current = false;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const chooseAction = useCallback((action: PaletteAction) => {
    if (action.id === "app:thread.search") {
      setQuery("");
      setHighlightedIndex(0);
      if (listRef.current !== null) listRef.current.scrollTop = 0;
      return;
    }
    pendingRunRef.current = action.run;
    setRecents((current) => recordPaletteRecent(current, action.id));
    setOpen(false);
  }, []);

  const chooseThread = useCallback(
    (item: ThreadPaletteNavigationItem) => {
      pendingRunRef.current = () => {
        void navigate(
          item.threadId === null
            ? getProjectComposeRoutePath(item.projectId)
            : getThreadRoutePath({
                projectId: item.projectId,
                threadId: item.threadId,
              }),
          item.messageSeq === null
            ? undefined
            : {
                state: {
                  searchMessageSeq: item.messageSeq,
                  searchThreadId: item.threadId,
                },
              },
        );
      };
      setOpen(false);
    },
    [navigate],
  );

  const handleAfterCloseAutoFocus = useCallback(() => {
    const pending = pendingRunRef.current;
    pendingRunRef.current = null;
    const target = openTargetRef.current;
    if (target instanceof HTMLElement && target.isConnected) {
      target.focus({ preventScroll: true });
    }
    pending?.();
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (resultCount === 0) return;
      const moveTo = (index: number) => {
        event.preventDefault();
        scrollOnNextHighlightRef.current = true;
        setHighlightedIndex(index);
        pickedThreadIdRef.current = mode === "threads" ? threadItems[index]?.id ?? null : null;
      };
      if (event.key === "ArrowDown") {
        moveTo(activeIndex + 1 >= resultCount ? 0 : activeIndex + 1);
        return;
      }
      if (event.key === "ArrowUp") {
        moveTo(activeIndex <= 0 ? resultCount - 1 : activeIndex - 1);
        return;
      }
      if (event.key === "Home") {
        moveTo(0);
        return;
      }
      if (event.key === "End") {
        moveTo(resultCount - 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (mode === "commands") {
          const choice = rankedCommands[activeIndex];
          if (choice !== undefined) chooseAction(choice.action);
          return;
        }
        const choice = threadItems[activeIndex];
        if (choice !== undefined) chooseThread(choice);
      }
    },
    [
      activeIndex,
      chooseAction,
      chooseThread,
      mode,
      rankedCommands,
      resultCount,
      threadItems,
    ],
  );

  const activeDescendant =
    activeIndex === -1
      ? undefined
      : mode === "commands"
        ? `${optionIdPrefix}-${activeIndex}`
        : threadItems[activeIndex]?.optionId;
  const inputLabel =
    mode === "commands" ? "Search commands" : "Search projects and threads";
  const placeholder = mode === "commands" ? "Search commands" : "Search...";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
        onAfterCloseAutoFocus={handleAfterCloseAutoFocus}
        data-testid="command-palette"
      >
        <DialogTitle className="sr-only">
          {mode === "commands"
            ? "Quick palette"
            : "Search projects and threads"}
        </DialogTitle>
        <div className="border-b bg-foreground/[0.05]">
          <div className="flex h-12 items-center gap-2.5 px-3">
            <Icon
              name="Search"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <input
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeDescendant}
              aria-label={inputLabel}
              autoComplete="off"
              spellCheck={false}
              className="h-12 w-full bg-transparent text-[15px] outline-none placeholder:text-subtle-foreground/50"
              placeholder={placeholder}
              value={query}
              onChange={(event) => {
                const nextQuery = event.target.value;
                setQuery(nextQuery);
                if (!nextQuery.startsWith(">")) setThreadItems([]);
                pickedThreadIdRef.current = null;
                setHighlightedIndex(0);
                if (listRef.current !== null) listRef.current.scrollTop = 0;
              }}
              onKeyDown={handleKeyDown}
            />
            {mode === "threads" && summary.jev !== "off" ? (
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                {summary.jev === "thinking" ? (
                  <Icon name="Spinner" className="size-3 animate-spin" />
                ) : (
                  <span className="size-1.5 rounded-full bg-primary" />
                )}
                Jev
              </span>
            ) : null}
          </div>
          {mode === "threads" ? (
            <div className="flex items-center gap-1.5 px-3 pb-2.5">
              {FILTER_CHIPS.map(({ key, label, icon }) => {
                const on = filters[key];
                const count = summary.counts?.[key];
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    className={cn(
                      "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                      on
                        ? "bg-state-hover text-muted-foreground hover:text-foreground"
                        : "border border-border/60 text-muted-foreground/60 hover:text-muted-foreground",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => toggleFilter(key)}
                  >
                    <Icon name={on ? "Check" : icon} className="size-3" aria-hidden />
                    {label}
                    {count === undefined ? null : (
                      <span className="tabular-nums opacity-60">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={mode === "commands" ? "Commands" : "Search results"}
          className="max-h-[min(24rem,50dvh)] overflow-y-auto p-1"
        >
          {mode === "commands" && rankedCommands.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No matching commands
            </p>
          ) : mode === "commands" ? (
            rankedCommands.map((entry, index) => (
              <PaletteRow
                key={entry.action.id}
                entry={entry}
                id={`${optionIdPrefix}-${index}`}
                isActive={index === activeIndex}
                onActivate={() => setHighlightedIndex(index)}
                onSelect={() => chooseAction(entry.action)}
              />
            ))
          ) : (
            <ThreadPaletteResults
              activeIndex={activeIndex}
              filters={filters}
              onActiveIndexChange={setHighlightedIndex}
              onIncludeArchived={includeArchived}
              onNavigationItemsChange={handleThreadItems}
              onSelect={chooseThread}
              onSummaryChange={setSummary}
              optionIdPrefix={optionIdPrefix}
              query={modeQuery}
            />
          )}
        </div>
        {resultCount > 0 ? (
          <div className="flex items-center justify-end gap-3 px-3 pb-2.5 pt-1 text-xs text-muted-foreground">
            <ShortcutHint keys="↑↓" label="move" />
            <ShortcutHint keys="↵" label="open" />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PaletteRow({
  entry,
  id,
  isActive,
  onActivate,
  onSelect,
}: {
  entry: RankedPaletteAction;
  id: string;
  isActive: boolean;
  onActivate: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={isActive}
      className={cn(
        LAUNCHER_ACTION_ROW_BASE_CLASS,
        "cursor-pointer",
        isActive && "bg-state-hover text-foreground",
      )}
      onPointerMove={onActivate}
      onClick={onSelect}
    >
      <span className="min-w-0 truncate">
        <HighlightedTitle
          title={entry.action.title}
          positions={entry.positions}
        />
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <span
          className={cn("text-muted-foreground", COARSE_POINTER_TEXT_SM_CLASS)}
        >
          {entry.action.group}
        </span>
        {entry.action.shortcut === null ? null : (
          <AppCommandShortcutPill shortcut={entry.action.shortcut} />
        )}
      </span>
    </div>
  );
}

function HighlightedTitle({
  title,
  positions,
}: {
  title: string;
  positions: readonly number[];
}) {
  if (positions.length === 0) return <>{title}</>;
  const emphasized = new Set(positions);
  return (
    <>
      {[...title].map((character, index) =>
        emphasized.has(index) ? (
          <span key={index} className="font-semibold text-foreground">
            {character}
          </span>
        ) : (
          <span key={index}>{character}</span>
        ),
      )}
    </>
  );
}
