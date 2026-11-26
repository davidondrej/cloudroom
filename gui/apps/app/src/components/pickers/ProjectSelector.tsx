import { useCloudroomSignIn } from "@/hooks/queries/cloudroom-queries";
import { useQuery } from "@tanstack/react-query";
import { useGitlabConnection } from "@/hooks/useGitlabConnection";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import { useThisComputer } from "@/hooks/useHostDaemon";
import { COMPUTER_TITLE, gitlabRepository, getHostPathComparisonKey, getHostPathDirname } from "@cloudroom/domain";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { RepoSuggestion } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@cloudroom/shared-ui/command";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@cloudroom/shared-ui/option-display";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { FLOATING_DRAWER_CLASS_NAME } from "@cloudroom/shared-ui/responsive-overlay";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { formatRelativeTime } from "@/lib/relative-time";
import { folderValue, tildePath } from "./folder-path";
import {
  COMPACT_PICKER_ROW_CLASS_NAME,
  FolderPathGroup,
  HERE_VALUE,
  PICKER_DETAIL_CLASS_NAME,
  PICKER_ROW_CLASS_NAME,
  RowAction,
  type PickedFolder,
} from "./FolderGroups";
import { searchPickerOptions } from "./picker-search";
import { useFolderPicker } from "./useFolderPicker";
import { useResetPickerScroll } from "./useResetPickerScroll";

const PROJECT_SEARCH_MIN_OPTIONS = 5;
const NO_HIGHLIGHT_VALUE = "__project-picker-idle__";
const VISIBLE_REPO_SUGGESTIONS = 5;
const FOLDER_SEARCH_ROWS = 6;
const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
const MUTED_LINE_CLASS_NAME = "px-2 py-1.5 text-xs text-muted-foreground/70 max-md:py-2";
// Mobile sheet: same floating drawer and padding as the Model, Effort, and Environment pickers (Design 1A, David, 2026-11-24).
const COMPACT_SHEET_PADDING_CLASS_NAME =
  "px-3.5 pt-0 pb-[max(1.5rem,env(safe-area-inset-bottom))]";
const COMPACT_FOOTER_ROW_CLASS_NAME =
  "flex min-h-[42px] items-center gap-3 rounded-[14px] px-3.5 py-1.5 text-[15.5px] leading-snug transition-colors";
const COMPACT_COMMAND_INPUT_CLASS_NAME =
  "[&_[cmdk-input-wrapper]]:mx-0.5 [&_[cmdk-input-wrapper]]:mb-2 [&_[cmdk-input-wrapper]]:h-10 [&_[cmdk-input-wrapper]]:rounded-full [&_[cmdk-input-wrapper]]:border-0 [&_[cmdk-input-wrapper]]:bg-surface-recessed [&_[cmdk-input-wrapper]]:px-3.5 [&_[cmdk-input-wrapper]_svg]:mr-2.5 [&_[cmdk-input-wrapper]_svg]:size-4 [&_[cmdk-input-wrapper]_svg]:text-muted-foreground/70 [&_[cmdk-input-wrapper]_svg]:opacity-100";

export const repoKey = (repo: RepoSuggestion) =>
  repo.source === "mac" ? repo.path : repo.repo;

export interface ProjectSelectorOption {
  id: string;
  name: string;
  /** When the project was last used. The list shows the newest first. */
  updatedAt?: number;
}

/** Repos on this Mac and GitHub that are not projects yet, newest first. `onAdd` resolves to the new project's id.
 *  `isLoading` means no repos are known yet; `githubLoading` means GitHub's repos are still on their way. */
export interface ProjectSelectorSuggestions {
  /** This computer's host: its folders can be typed as a path or searched by name. */
  hostId: string;
  repos: readonly RepoSuggestion[];
  githubConnected: boolean;
  isLoading: boolean;
  githubLoading?: boolean;
  addingKey: string | null;
  onAdd: (repo: RepoSuggestion) => Promise<string>;
}

export interface ProjectSelectorCreateProjectConfig {
  onCreate: () => void;
  disabled?: boolean;
  isCreating?: boolean;
  suggestions?: ProjectSelectorSuggestions;
}

interface ProjectSelectorProps {
  projects: readonly ProjectSelectorOption[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  allowNoProject?: boolean;
  createProject?: ProjectSelectorCreateProjectConfig;
  disabled?: boolean;
  isLoading?: boolean;
  showChevronWhenDisabled?: boolean;
  className?: string;
  defaultOpen?: boolean;
  modal?: boolean;
}

export function ProjectSelector({
  projects,
  value,
  onChange,
  allowNoProject = false,
  createProject,
  disabled: disabledProp = false,
  isLoading = false,
  showChevronWhenDisabled = false,
  className,
  defaultOpen,
  modal = true,
}: ProjectSelectorProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [searchQuery, setSearchQuery] = useState("");
  // The row the user moved to, for the query they moved on. A new query falls back to the most likely row.
  const [chosen, setChosen] = useState({ query: "", value: NO_HIGHLIGHT_VALUE });
  const commandRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const isCompactViewport = useIsCompactViewport();
  const disabled = disabledProp || isLoading;
  const suggestions = createProject?.suggestions;
  // With repo suggestions the search box shows from the start, so the menu doesn't jump when repos arrive.
  const showSearch =
    Boolean(suggestions) || projects.length > PROJECT_SEARCH_MIN_OPTIONS;
  const queried = showSearch && searchQuery.trim() !== "";
  const filteredProjects = useMemo(
    () =>
      showSearch
        ? searchPickerOptions({
            options: projects,
            query: searchQuery,
            getLabel: (project) => project.name,
          })
        : projects,
    [projects, searchQuery, showSearch],
  );
  const folders = useFolderPicker({
    hostId: suggestions?.hostId ?? null,
    query: searchQuery,
    open,
  });
  const { pathMode } = folders;
  // Found folders, minus projects the list already shows. Exactly these rows render.
  const folderResults = useMemo(() => {
    const listed = new Set(filteredProjects.map((project) => project.id));
    return folders.results
      .filter((entry) => !entry.projectId || !listed.has(entry.projectId))
      .slice(0, FOLDER_SEARCH_ROWS);
  }, [filteredProjects, folders.results]);
  const pasted = suggestions && open ? gitlabRepository(searchQuery) : null;
  const visibleRepos = useMemo<readonly RepoSuggestion[]>(() => {
    if (pasted) return [{source:"gitlab",repo:pasted,name:pasted.split("/").at(-1)!,updatedAt:null}];
    // A Mac repo found by the folder search shows once, with the folders.
    const found = new Set(folderResults.map((entry) => getHostPathComparisonKey(entry.path)));
    const repos = (suggestions?.repos ?? []).filter(
      (repo) => !(repo.source === "mac" && found.has(getHostPathComparisonKey(repo.path))),
    );
    return searchPickerOptions({
      options: repos,
      query: searchQuery,
      getLabel: (repo) => repo.name,
    }).slice(0, VISIBLE_REPO_SUGGESTIONS);
  }, [folderResults, searchQuery, suggestions?.repos, pasted]);
  const folderRows = pathMode ? folders.matches : folderResults;
  const topFolder = pathMode
    ? folders.leaf
      ? folders.drive ? folders.exact : folders.matches[0]
      : undefined
    : folderResults[0];
  // While typing, the most likely row is highlighted, so Enter picks it.
  // The order matches the rows, so it agrees with cmdk, which highlights the first row after each keystroke.
  const firstValue = pathMode
    ? topFolder
      ? folderValue(topFolder.path)
      : folders.leaf
        ? NO_HIGHLIGHT_VALUE
        : folders.canAddHere
          ? HERE_VALUE
          : folders.matches[0] && !folders.drive
            ? folderValue(folders.matches[0].path)
            : NO_HIGHLIGHT_VALUE
    : searchQuery.trim()
      ? (filteredProjects[0]?.id ??
        (topFolder ? folderValue(topFolder.path) : undefined) ??
        (visibleRepos[0] ? `repo:${repoKey(visibleRepos[0])}` : undefined) ??
        NO_HIGHLIGHT_VALUE)
      : null;
  const rendered = (row: string) =>
    row === HERE_VALUE
      ? folders.canAddHere && !folders.leaf
      : row === "new-project" || row === "no-project" ||
        filteredProjects.some((project) => project.id === row) ||
        folderRows.some((entry) => folderValue(entry.path) === row) ||
        visibleRepos.some((repo) => `repo:${repoKey(repo)}` === row);
  const highlightedValue =
    firstValue !== null && (chosen.query !== searchQuery || !rendered(chosen.value))
      ? firstValue
      : chosen.value;
  const userMoved = useRef(false);
  const markUserMove = () => {
    userMoved.current = true;
    // cmdk reports the move synchronously; anything later is its own re-selection.
    queueMicrotask(() => {
      userMoved.current = false;
    });
  };
  const setHighlightedValue = (next: string) => {
    if (userMoved.current) setChosen({ query: searchQuery, value: next });
  };
  const highlightedFolder = folderRows.find(
    (entry) => folderValue(entry.path) === highlightedValue,
  );
  // Plain text completes against home, unless the user moved to a found folder.
  const pickedFolder = highlightedFolder && chosen.query === searchQuery ? highlightedFolder : undefined;
  const homeMatch = pathMode ? undefined : folders.homeMatch;
  // Tab completes the highlighted folder; in path mode, else the most likely one (the newest with no name typed).
  const completion =
    pickedFolder ?? homeMatch ?? highlightedFolder ?? (pathMode ? (topFolder ?? folders.matches[0]) : undefined);
  const ghost =
    pathMode && completion && (folders.leaf || highlightedFolder)
      ? `${completion.name}${folders.separator}`.slice(folders.leaf.length)
      : !pathMode && completion && completion === homeMatch
        ? `${completion.name}/`.slice(searchQuery.trim().length)
        : "";
  // Tab does something: the hint sits at the end of the search box.
  const showTab = Boolean(completion) && (pathMode || Boolean(folders.home?.startsWith("/")));
  const selected = value !== null ? projects.find((p) => p.id === value) : null;
  const fallback = !allowNoProject && !selected ? projects[0] : null;
  const triggerLabel = isLoading
    ? "Loading projects…"
    : (selected?.name ?? fallback?.name ?? "Work in a project");
  const compactTriggerLabel = isLoading
    ? "Loading…"
    : (selected?.name ?? fallback?.name ?? "No project");
  const triggerIcon =
    isLoading || selected || fallback ? "Folder" : "FolderPlus";
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setChosen({ query: "", value: NO_HIGHLIGHT_VALUE });
    if (!nextOpen) {
      setSearchQuery("");
    }
  };
  const selectProject = (projectId: string | null) => {
    onChange(projectId);
    handleOpenChange(false);
  };
  const addRepo = (repo: RepoSuggestion) => {
    if (!suggestions || suggestions.addingKey !== null) return;
    return suggestions.onAdd(repo).then(
      () => handleOpenChange(false),
      () => {},
    );
  };
  const pickFolder = (folder: PickedFolder) => {
    if (folder.projectId && projects.some((project) => project.id === folder.projectId)) {
      return selectProject(folder.projectId);
    }
    addRepo({
      source: "mac",
      name: folder.name,
      path: folder.path,
      updatedAt: folder.activityAt ?? 0,
    });
  };
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && searchQuery) {
      event.preventDefault();
      event.stopPropagation();
      setSearchQuery("");
      return;
    }
    if (event.key !== "Tab" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    // Path mode: the name becomes the folder, ready for the next one. Search: a found folder becomes its path.
    const fill = !completion
      ? null
      : pathMode
        ? `${folders.folder}${completion.name}${folders.separator}`
        : folders.home?.startsWith("/")
          ? `${tildePath(completion.path, folders.home)}/`
          : null;
    if (fill === null && !pathMode) return;
    event.preventDefault();
    if (fill !== null) setSearchQuery(fill);
  };

  // Rows that are not projects yet are dimmer, unless there is no project to tell them apart from.
  const dim = projects.length > 0;
  const addingKey = suggestions?.addingKey ?? null;
  const projectRows = filteredProjects.map((project) => {
    const isCurrent = project.id === value;
    return {
      at: project.updatedAt ?? 0,
      current: isCurrent,
      node: (
        <CommandItem
          key={project.id}
          value={project.id}
          keywords={[project.name]}
          aria-current={isCurrent ? "true" : undefined}
          onSelect={() => selectProject(project.id)}
          className={
            isCompactViewport
              ? cn(
                  COMPACT_PICKER_ROW_CLASS_NAME,
                  // Touch has no keyboard cursor: only the chosen row is highlighted.
                  isCurrent
                    ? "bg-composer font-medium text-foreground shadow-message data-[selected=true]:bg-composer"
                    : "text-foreground/90 data-[selected=true]:bg-transparent active:bg-state-hover",
                )
              : cn(PICKER_ROW_CLASS_NAME, isCurrent && "font-medium")
          }
        >
          {isCompactViewport ? (
            <Icon
              name="Folder"
              className={cn(
                "size-[19px]! shrink-0",
                isCurrent
                  ? "text-foreground dark:text-primary"
                  : "text-muted-foreground",
              )}
              aria-hidden
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {isCurrent ? <CurrentCheck compact={isCompactViewport} /> : null}
        </CommandItem>
      ),
    };
  });
  const foundRows = folderResults.map((entry) => (
    <AddRow
      key={entry.path}
      value={folderValue(entry.path)}
      name={entry.name}
      detail={tildePath(getHostPathDirname(entry.path) ?? entry.path, folders.home)}
      action={entry.projectId ? "Select" : "Add"}
      compact={isCompactViewport}
      icon="Folder"
      dim={dim}
      adding={addingKey === entry.path}
      disabled={addingKey !== null && addingKey !== entry.path}
      onSelect={() => pickFolder(entry)}
    />
  ));
  const repoRows = visibleRepos.map((repo) => repo.source === "gitlab" ? (
    <GitlabRepoRow
      key={repo.repo}
      repo={repo}
      compact={isCompactViewport}
      addingKey={addingKey}
      onAdd={addRepo}
    />
  ) : (
    <RepoRow
      key={`repo:${repoKey(repo)}`}
      repo={repo}
      compact={isCompactViewport}
      dim={dim}
      addingKey={addingKey}
      onAdd={addRepo}
    />
  ));
  // Projects first: the current one, then the most recently used. A search keeps its own ranking.
  // Below them, what is not a project yet: found folders, then repos.
  const rows = [
    ...(queried
      ? projectRows
      : [...projectRows].sort((a, b) => Number(b.current) - Number(a.current) || b.at - a.at)
    ).map((row) => row.node),
    ...foundRows,
    ...repoRows,
  ];
  const loadingMessage = !suggestions
    ? null
    : suggestions.isLoading
      ? "Looking for repos…"
      : suggestions.githubLoading
        ? "Checking GitHub…"
        : null;
  const emptyMessage =
    rows.length > 0
      ? null
      : queried
        ? suggestions
          ? folders.windows
            ? "Nothing matches. Paste a folder path like C:\\code\\app."
            : "Nothing matches. Type ~/ to browse folders."
          : "No projects found"
        : suggestions
          ? "No projects yet."
          : null;

  const hasListContent =
    (pathMode && Boolean(suggestions)) ||
    rows.length > 0 ||
    Boolean(loadingMessage) ||
    Boolean(emptyMessage);
  const mutedLineClassName = isCompactViewport
    ? "px-3.5 py-2.5 text-sm text-muted-foreground/70"
    : MUTED_LINE_CLASS_NAME;

  const listItems =
    pathMode && suggestions ? (
      <FolderPathGroup
        folders={folders}
        addingKey={suggestions.addingKey}
        onPick={pickFolder}
        compact={isCompactViewport}
      />
    ) : rows.length > 0 || loadingMessage || emptyMessage ? (
      <CommandGroup
        className={
          isCompactViewport
            ? "p-0 [&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col [&_[cmdk-group-items]]:gap-0.5"
            : undefined
        }
      >
        {rows}
        {loadingMessage ? (
          <div className={cn(mutedLineClassName, "flex items-center gap-2")}>
            <Icon name="Loading" className="size-3.5 animate-spin" aria-hidden />
            {loadingMessage}
          </div>
        ) : emptyMessage ? (
          <div className={mutedLineClassName}>{emptyMessage}</div>
        ) : null}
      </CommandGroup>
    ) : null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal={modal}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Project: ${triggerLabel}`}
          aria-busy={isLoading || undefined}
          disabled={disabled}
          data-promptbox-project-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            !disabled && OPTION_INTERACTIVE_CLASS_NAME,
            disabled && "cursor-default disabled:opacity-100",
            OPTION_MUTED_CLASS_NAME,
            className,
          )}
        >
          <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME}>
            <Icon
              name={triggerIcon}
              className="size-3.5 shrink-0"
              aria-hidden
            />
            <span className="min-w-0 truncate" data-promptbox-full-label="">
              {triggerLabel}
            </span>
            <span className="min-w-0 truncate" data-promptbox-compact-label="">
              {compactTriggerLabel}
            </span>
          </span>
          {disabled && !showChevronWhenDisabled ? null : (
            <Icon
              name="ChevronDown"
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Project"
        mobileTitle="Project"
        mobileClassName={FLOATING_DRAWER_CLASS_NAME}
        onEscapeKeyDown={(event) => {
          // The first Esc clears the search; the next one closes.
          if (!searchQuery) return;
          event.preventDefault();
          setSearchQuery("");
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (showSearch) {
            searchInputRef.current?.focus();
          } else {
            commandRef.current?.focus();
          }
        }}
        // Gray lines, not the theme's accent-tinted border, and a slightly lifted surface in dark mode.
        className={cn(
          isCompactViewport
            ? cn(
                "flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none",
                COMPACT_SHEET_PADDING_CLASS_NAME,
              )
            : cn(
                "flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] flex-col overflow-hidden rounded-xl border-muted bg-[var(--picker-surface)] p-0 shadow-xl [--picker-surface:var(--popover)] dark:[--picker-surface:color-mix(in_oklch,var(--ink)_4%,var(--canvas))]",
                suggestions ? "w-[18.75rem]" : "w-52",
              ),
        )}
      >
        {isCompactViewport ? (
          <div className="shrink-0 px-4 pt-1 pb-2 text-sm text-subtle-foreground">
            Project
          </div>
        ) : null}
        <Command
          ref={commandRef}
          label="Search projects"
          shouldFilter={false}
          value={highlightedValue}
          onValueChange={setHighlightedValue}
          onKeyDown={(event) => {
            if (NAVIGATION_KEYS.has(event.key) || (event.ctrlKey && "npjk".includes(event.key))) markUserMove();
          }}
          className={cn(
            "relative min-h-0 flex-1 bg-transparent",
            isCompactViewport
              ? COMPACT_COMMAND_INPUT_CLASS_NAME
              : "[&_[cmdk-input-wrapper]]:border-accent",
          )}
        >
          {showSearch ? (
            <CommandInput
              ref={searchInputRef}
              aria-label="Search projects"
              placeholder={suggestions ? "Find or add a project" : "Search projects"}
              value={searchQuery}
              onValueChange={setSearchQuery}
              onKeyDown={handleSearchKeyDown}
              ghost={!isCompactViewport && suggestions ? ghost : undefined}
              className={
                isCompactViewport
                  ? "h-10 py-0 text-base text-foreground caret-primary placeholder:text-subtle-foreground"
                  : "h-9 text-xs caret-primary placeholder:text-muted-foreground/50"
              }
            />
          ) : null}
          {!isCompactViewport && suggestions && showTab ? (
            <kbd className="pointer-events-none absolute right-3 top-2.5 rounded-sm border border-muted px-1 font-sans text-[0.625rem] leading-4 text-muted-foreground">
              tab
            </kbd>
          ) : null}
          {isCompactViewport ? (
            <>
              {hasListContent ? (
                <div className="relative -mx-1 flex min-h-0 flex-1 flex-col">
                  <CommandList
                    ref={listRef}
                    onPointerMoveCapture={markUserMove}
                    className="min-h-0 max-h-[310px] flex-1 overscroll-contain px-1 pt-0.5 pb-2"
                  >
                    {listItems}
                  </CommandList>
                  <div
                    ref={watchListEnd}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent to-background"
                  />
                </div>
              ) : null}
              {createProject || allowNoProject ? (
                <>
                  {hasListContent ? (
                    <div className="mx-4 my-2 h-px shrink-0 bg-border" />
                  ) : null}
                  <div className="flex shrink-0 items-center justify-between gap-2">
                    {createProject ? (
                      <button
                        type="button"
                        disabled={createProject.disabled}
                        onClick={() => {
                          createProject.onCreate();
                          handleOpenChange(false);
                        }}
                        className={cn(
                          COMPACT_FOOTER_ROW_CLASS_NAME,
                          "flex-1 text-subtle-foreground active:bg-state-hover disabled:opacity-50",
                        )}
                      >
                        <Icon
                          name="FolderPlus"
                          className="size-[19px]! shrink-0"
                          aria-hidden
                        />
                        <span>
                          {createProject.isCreating ? "Creating..." : "New project"}
                        </span>
                      </button>
                    ) : (
                      <span />
                    )}
                    {allowNoProject ? (
                      <button
                        type="button"
                        aria-current={value === null ? "true" : undefined}
                        onClick={() => selectProject(null)}
                        className={cn(
                          COMPACT_FOOTER_ROW_CLASS_NAME,
                          "shrink-0",
                          value === null
                            ? "bg-composer font-medium text-foreground shadow-message"
                            : "text-subtle-foreground active:bg-state-hover",
                        )}
                      >
                        <span>No project</span>
                        {value === null ? <CurrentCheck compact /> : null}
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <CommandList
              ref={listRef}
              onPointerMoveCapture={markUserMove}
              className="min-h-0 max-h-[20.25rem] flex-1 scroll-pb-10 overscroll-contain"
            >
              {listItems}
              {createProject || allowNoProject ? (
                <div className="sticky bottom-0 flex items-center justify-between gap-1 border-t border-accent bg-[var(--picker-surface)] p-1">
                  <div
                    ref={watchListEnd}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-[calc(100%+1px)] h-8 bg-gradient-to-b from-transparent to-[var(--picker-surface)]"
                  />
                  {createProject ? (
                    <CommandItem
                      disabled={createProject.disabled}
                      value="new-project"
                      onSelect={() => {
                        createProject.onCreate();
                        handleOpenChange(false);
                      }}
                      className={cn(PICKER_ROW_CLASS_NAME, "text-muted-foreground/70")}
                    >
                      <Icon name="FolderPlus" className="size-3.5! opacity-70" aria-hidden />
                      {createProject.isCreating ? "Creating..." : "New project"}
                    </CommandItem>
                  ) : (
                    <span />
                  )}
                  {allowNoProject ? (
                    <CommandItem
                      value="no-project"
                      aria-current={value === null ? "true" : undefined}
                      onSelect={() => selectProject(null)}
                      className={cn(
                        PICKER_ROW_CLASS_NAME,
                        value === null ? "font-medium" : "text-muted-foreground/70",
                      )}
                    >
                      No project
                      {value === null ? <CurrentCheck /> : null}
                    </CommandItem>
                  ) : null}
                </div>
              ) : null}
            </CommandList>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The fade above the footer says "more below". It hides when the list fits, or is scrolled to its end. */
function watchListEnd(fade: HTMLDivElement | null) {
  const list =
    fade?.closest<HTMLElement>("[cmdk-list]") ??
    fade?.parentElement?.querySelector<HTMLElement>("[cmdk-list]");
  if (!fade || !list || typeof ResizeObserver === "undefined") return;
  const update = () => {
    fade.hidden = list.scrollHeight - list.scrollTop - list.clientHeight < 4;
  };
  const observer = new ResizeObserver(update);
  observer.observe(list);
  if (list.firstElementChild) observer.observe(list.firstElementChild);
  list.addEventListener("scroll", update, { passive: true });
  return () => {
    observer.disconnect();
    list.removeEventListener("scroll", update);
  };
}

function CurrentCheck({ compact = false }: { compact?: boolean }) {
  return (
    <Icon
      name="Check"
      className={
        compact
          ? "size-[18px]! shrink-0 text-foreground"
          : "size-3.5! text-primary-text [&_*]:stroke-2"
      }
      aria-hidden
    />
  );
}

interface AddRowProps {
  value: string;
  name: string;
  /** Where it lives, on the right. */
  detail: ReactNode;
  repositoryUrl?: string;
  action?: string;
  compact?: boolean;
  icon?: "Folder" | "Laptop" | "Github";
  dim: boolean;
  adding: boolean;
  disabled: boolean;
  onSelect: () => void;
}

/** A repo or folder that is not a project yet. */
function AddRow({
  value,
  name,
  detail,
  repositoryUrl,
  action = "Add",
  compact = false,
  icon = "Folder",
  dim,
  adding,
  disabled,
  onSelect,
}: AddRowProps) {
  return (
    <CommandItem
      value={value}
      keywords={[name]}
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        compact
          ? cn(
              COMPACT_PICKER_ROW_CLASS_NAME,
              "text-foreground/90 data-[selected=true]:bg-transparent active:bg-state-hover",
            )
          : PICKER_ROW_CLASS_NAME,
        "animate-in fade-in duration-300 motion-reduce:animate-none",
      )}
    >
      {repositoryUrl ? (
        <img className={cn(compact ? "size-[19px]" : "size-4", "shrink-0")} src="/gitlab.svg" alt="" />
      ) : compact ? (
        <Icon name={icon} className="size-[19px]! shrink-0 text-muted-foreground/60" aria-hidden />
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          dim &&
            (compact
              ? "text-muted-foreground/75"
              : "text-muted-foreground/70 group-data-[selected=true]:text-foreground"),
        )}
      >
        {name}
        {repositoryUrl && <small className="block truncate text-2xs font-normal text-muted-foreground">{repositoryUrl}</small>}
      </span>
      {adding || repositoryUrl ? null : (
        <span
          className={cn(
            compact
              ? "flex shrink-0 items-center gap-2 text-xs text-muted-foreground/55"
              : cn(PICKER_DETAIL_CLASS_NAME, "flex shrink-0 items-center gap-2 group-data-[selected=true]:hidden"),
          )}
        >
          {detail}
          <Icon name="Plus" className={compact ? "size-4! shrink-0" : "size-3.5!"} aria-hidden />
        </span>
      )}
      {compact && !adding && !repositoryUrl ? null : (
        <RowAction label={action} busy={adding} visible={Boolean(repositoryUrl)} />
      )}
    </CommandItem>
  );
}

interface RepoRowProps {
  repo: RepoSuggestion;
  compact?: boolean;
  dim: boolean;
  addingKey: string | null;
  onAdd: (repo: RepoSuggestion) => void;
}

function GitlabRepoRow({
  repo,
  compact = false,
  addingKey,
  onAdd,
}: Pick<RepoRowProps, "compact" | "addingKey" | "onAdd"> & {
  repo: RepoSuggestion & { repo: string };
}) {
  const connection = useGitlabConnection();
  const signIn = useCloudroomSignIn();
  const submitting = useRef(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (connection.error) appToast.error(connection.error);
  }, [connection.error]);
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(repo.repo), 400);
    return () => clearTimeout(timer);
  }, [repo.repo]);
  const check = useQuery({
    queryKey: [
      "gitlab-project-access",
      connection.accountId,
      repo.repo,
      connection.state?.login,
      connection.state?.waiting,
      connection.state?.expired,
    ],
    enabled: connection.ready && settled === repo.repo,
    queryFn: ({ signal }) => sdk.cloudroom.gitlabCheck(repo.repo, signal),
    retry: false,
    staleTime: 30_000,
  });
  const connect =
    check.data?.accessible === false && connection.state?.available;
  const waiting = Boolean(connection.state?.waiting);
  return (
    <AddRow
      value={"repo:" + repoKey(repo)}
      name={repo.name}
      detail={null}
      compact={compact}
      repositoryUrl={repo.repo
        .replace("https://", "")
        .split("/")
        .slice(0, -1)
        .join("/")}
      action={
        !connection.accountId ? "Sign in to Cloudroom" : connect
          ? waiting
            ? "Open GitLab"
            : connection.state?.login && !connection.state.expired
              ? "Switch account"
              : "Connect GitLab"
          : "Add"
      }
      dim={false}
      adding={addingKey === repoKey(repo) || connection.busy || checking || signIn.isPending}
      disabled={addingKey !== null || connection.busy || checking || signIn.isPending || Boolean(connection.accountId && !connection.ready)}
      onSelect={async () => {
        if (submitting.current) return;
        submitting.current = true;
        setChecking(true);
        try {
          if (!connection.accountId) {
            await signIn.mutateAsync("signIn");
            return;
          }
          const access = check.data ?? (await check.refetch({ throwOnError: true })).data;
          if (access?.accessible === false && connection.state?.available) {
            if (waiting) connection.open();
            else connection.change("start");
          } else if (access?.accessible === false) {
            appToast.error("Check the GitLab URL and your access to this project.");
          } else await onAdd(repo);
        } catch (error) {
          if (connection.accountId) appToast.error(error instanceof Error ? error.message : "Could not check this project.");
        } finally {
          submitting.current = false;
          setChecking(false);
        }
      }}
    />
  );
}

function RepoRow({ repo, compact = false, dim, addingKey, onAdd }: RepoRowProps) {
  const computer = useThisComputer() === "this PC" ? "PC" : COMPUTER_TITLE;
  const key = repoKey(repo);
  const age =
    repo.updatedAt === null
      ? ""
      : ` · ${formatRelativeTime({ timestamp: repo.updatedAt, now: Date.now() }).replace(" ago", "")}`;
  return (
    <AddRow
      value={`repo:${key}`}
      name={repo.name}
      detail={`${repo.source === "github" ? "GitHub" : computer}${age}`}
      compact={compact}
      icon={repo.source === "github" ? "Github" : "Laptop"}
      dim={dim}
      adding={addingKey === key}
      disabled={addingKey !== null && addingKey !== key}
      onSelect={() => onAdd(repo)}
    />
  );
}
