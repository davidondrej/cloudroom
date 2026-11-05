import { useThisComputer } from "@/hooks/useHostDaemon";
import { COMPUTER_TITLE, getHostPathComparisonKey } from "@cloudroom/domain";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { RepoSuggestion } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
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
import { formatRelativeTime } from "@/lib/relative-time";
import { folderValue, tildePath } from "./folder-path";
import {
  FolderKeyHints,
  FolderPathGroup,
  FolderSearchGroup,
  HERE_VALUE,
  baseName,
  type PickedFolder,
} from "./FolderGroups";
import { searchPickerOptions } from "./picker-search";
import { useFolderPicker } from "./useFolderPicker";
import { useResetPickerScroll } from "./useResetPickerScroll";

const PROJECT_SEARCH_MIN_OPTIONS = 5;
const NO_HIGHLIGHT_VALUE = "__project-picker-idle__";
const PROJECT_PICKER_ITEM_CLASS_NAME = "py-[0.3125rem] text-xs max-md:py-2";
const VISIBLE_REPO_SUGGESTIONS = 5;
const FOLDER_SEARCH_ROWS = 6;
const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
const REPO_FILTERS = [
  { id: "all", label: "All" },
  { id: "github", label: "GitHub" },
  { id: "mac", label: COMPUTER_TITLE },
] as const;
type RepoFilter = (typeof REPO_FILTERS)[number]["id"];

export const repoKey = (repo: RepoSuggestion) =>
  repo.source === "mac" ? repo.path : repo.repo;

export interface ProjectSelectorOption {
  id: string;
  name: string;
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
  const [repoFilter, setRepoFilter] = useState<RepoFilter>("all");
  const commandRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const disabled = disabledProp || isLoading;
  const suggestions = createProject?.suggestions;
  // With repo suggestions the search box shows from the start, so the menu doesn't jump when repos arrive.
  const showSearch =
    Boolean(suggestions) || projects.length > PROJECT_SEARCH_MIN_OPTIONS;
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
  // Found folders, minus projects the list above already shows. Exactly these rows render.
  const folderResults = useMemo(() => {
    const listed = new Set(filteredProjects.map((project) => project.id));
    return folders.results
      .filter((entry) => !entry.projectId || !listed.has(entry.projectId))
      .slice(0, FOLDER_SEARCH_ROWS);
  }, [filteredProjects, folders.results]);
  const visibleRepos = useMemo(() => {
    // A Mac repo found by the folder search shows once, with the folders.
    const found = new Set(folderResults.map((entry) => getHostPathComparisonKey(entry.path)));
    const repos = (suggestions?.repos ?? []).filter(
      (repo) =>
        (repoFilter === "all" || repo.source === repoFilter) &&
        !(repo.source === "mac" && found.has(getHostPathComparisonKey(repo.path))),
    );
    return searchPickerOptions({
      options: repos,
      query: searchQuery,
      getLabel: (repo) => repo.name,
    }).slice(0, VISIBLE_REPO_SUGGESTIONS);
  }, [folderResults, repoFilter, searchQuery, suggestions?.repos]);
  const folderRows = pathMode ? folders.matches : folderResults;
  // While searching, empty project and repo groups only add noise next to found folders.
  const searching = Boolean(suggestions && searchQuery.trim());
  const showProjects =
    !pathMode && projects.length > 0 && !(searching && filteredProjects.length === 0);
  const showRepos =
    Boolean(suggestions) &&
    !pathMode &&
    !(searching && visibleRepos.length === 0 && folderResults.length > 0);
  const topFolder = pathMode
    ? folders.leaf
      ? folders.matches[0]
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
          : folders.matches[0]
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
      ? `${completion.name}/`.slice(folders.leaf.length)
      : !pathMode && completion && completion === homeMatch
        ? `${completion.name}/`.slice(searchQuery.trim().length)
        : "";
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
  const createProjectAction = createProject;
  const createProjectLabel = createProjectAction?.isCreating
    ? "Creating..."
    : "New project";
  const showActionSeparator =
    projects.length > 0 && (Boolean(createProjectAction) || allowNoProject);
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
    void suggestions.onAdd(repo).then(
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
        ? `${folders.folder}${completion.name}/`
        : folders.home?.startsWith("/")
          ? `${tildePath(completion.path, folders.home)}/`
          : null;
    if (fill === null && !pathMode) return;
    event.preventDefault();
    if (fill !== null) setSearchQuery(fill);
  };
  const here = folders.listing;
  const enterFolder =
    highlightedValue === HERE_VALUE && here
      ? { name: baseName(here.directory), projectId: here.projectId }
      : highlightedFolder;
  const enterHint: [string, string][] = enterFolder
    ? [["enter", `${enterFolder.projectId ? "Select" : "Add"} ${enterFolder.name}`]]
    : [];
  const keyHints: [string, string][] = pathMode
    ? [...(completion ? [["tab", "Complete"] as [string, string]] : []), ...enterHint]
    : completion && folders.home?.startsWith("/")
      ? [["tab", `Open ${tildePath(completion.path, folders.home)}/`], ...(highlightedFolder ? enterHint : [])]
      : [];

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
        className={cn(
          "flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] flex-col overflow-hidden p-0 max-md:min-h-0 max-md:flex-1",
          suggestions ? "w-80" : "w-52",
        )}
      >
        <Command
          ref={commandRef}
          label="Search projects"
          shouldFilter={false}
          value={highlightedValue}
          onValueChange={setHighlightedValue}
          onKeyDown={(event) => {
            if (NAVIGATION_KEYS.has(event.key) || (event.ctrlKey && "npjk".includes(event.key))) markUserMove();
          }}
          className="min-h-0"
        >
          {showSearch ? (
            <CommandInput
              ref={searchInputRef}
              aria-label="Search projects"
              placeholder={
                suggestions
                  ? "Search, or type ~/ for a path"
                  : "Search projects"
              }
              value={searchQuery}
              onValueChange={setSearchQuery}
              onKeyDown={handleSearchKeyDown}
              ghost={suggestions ? ghost : undefined}
              className="h-8 text-xs"
            />
          ) : null}
          <CommandList
            ref={listRef}
            onPointerMoveCapture={markUserMove}
            className="min-h-0 max-h-none flex-1 overscroll-contain"
          >
            {pathMode && suggestions ? (
              <FolderPathGroup
                folders={folders}
                addingKey={suggestions.addingKey}
                onPick={pickFolder}
              />
            ) : null}
            {showProjects ? (
              <CommandGroup
                heading={
                  suggestions ? (
                    <>
                      In Cloudroom{" "}
                      <span className="font-normal opacity-70">
                        {projects.length}
                      </span>
                    </>
                  ) : (
                    "Project"
                  )
                }
              >
                <div
                  className={cn(
                    suggestions && "max-h-[9.5rem] overflow-y-auto",
                  )}
                >
                  {filteredProjects.map((project) => (
                    <CommandItem
                      key={project.id}
                      value={project.id}
                      keywords={[project.name]}
                      aria-current={project.id === value ? "true" : undefined}
                      onSelect={() => selectProject(project.id)}
                      className={PROJECT_PICKER_ITEM_CLASS_NAME}
                    >
                      <Icon
                        name="Folder"
                        className="size-4 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {project.name}
                      </span>
                      <Icon
                        name="Check"
                        className={cn(
                          "ml-auto size-4",
                          project.id === value ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden
                      />
                    </CommandItem>
                  ))}
                </div>
                {showSearch && filteredProjects.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground max-md:py-2">
                    No projects found
                  </div>
                ) : null}
              </CommandGroup>
            ) : null}
            {suggestions && !pathMode && folderResults.length > 0 ? (
              <>
                {showProjects ? <CommandSeparator /> : null}
                <FolderSearchGroup
                  results={folderResults}
                  home={folders.home}
                  addingKey={suggestions.addingKey}
                  onPick={pickFolder}
                />
              </>
            ) : null}
            {suggestions && showRepos ? (
              <>
                {showProjects || folderResults.length > 0 ? (
                  <CommandSeparator />
                ) : null}
                <RepoSuggestionsGroup
                  suggestions={suggestions}
                  repos={visibleRepos}
                  filter={repoFilter}
                  onFilterChange={setRepoFilter}
                  onAdd={addRepo}
                />
              </>
            ) : null}
            {!pathMode && (showActionSeparator || suggestions) ? (
              <CommandSeparator />
            ) : null}
            {!pathMode && (createProjectAction || allowNoProject) ? (
              <CommandGroup
                heading={
                  projects.length === 0 && !suggestions ? "Project" : undefined
                }
              >
                {createProjectAction ? (
                  <CommandItem
                    disabled={createProjectAction.disabled}
                    value="new-project"
                    onSelect={() => {
                      createProjectAction.onCreate();
                      handleOpenChange(false);
                    }}
                    className={PROJECT_PICKER_ITEM_CLASS_NAME}
                  >
                    <Icon
                      name="FolderPlus"
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                    {createProjectLabel}
                  </CommandItem>
                ) : null}
                {allowNoProject ? (
                  <CommandItem
                    value="no-project"
                    aria-current={value === null ? "true" : undefined}
                    onSelect={() => selectProject(null)}
                    className={PROJECT_PICKER_ITEM_CLASS_NAME}
                  >
                    <Icon
                      name="FolderMinus"
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                    Don&apos;t work in a project
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto size-4",
                        value === null ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
          </CommandList>
          {suggestions ? <FolderKeyHints hints={keyHints} /> : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface RepoSuggestionsGroupProps {
  suggestions: ProjectSelectorSuggestions;
  repos: readonly RepoSuggestion[];
  filter: RepoFilter;
  onFilterChange: (filter: RepoFilter) => void;
  onAdd: (repo: RepoSuggestion) => void;
}

function RepoSuggestionsGroup({
  suggestions,
  repos,
  filter,
  onFilterChange,
  onAdd,
}: RepoSuggestionsGroupProps) {
  const now = Date.now();
  const computer = useThisComputer() === "this PC" ? "PC" : COMPUTER_TITLE;
  const loadingMessage = suggestions.isLoading
    ? "Looking for repos…"
    : suggestions.githubLoading && filter !== "mac"
      ? "Checking GitHub…"
      : null;
  const emptyMessage =
    filter === "github" && !suggestions.githubConnected
      ? "GitHub isn't connected."
      : "No other repos found.";
  return (
    <CommandGroup>
      <div className="flex items-center gap-1 px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">
        <span className="mr-auto whitespace-nowrap">Not in Cloudroom yet</span>
        {REPO_FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => onFilterChange(id)}
            className={cn(
              "flex items-center gap-1 rounded-full border px-1.5 text-[0.6875rem] leading-4",
              filter === id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:text-foreground",
            )}
          >
            {id === "all" ? null : (
              <Icon
                name={
                  id === "github" && suggestions.githubLoading
                    ? "Loading"
                    : id === "github"
                      ? "Github"
                      : "Laptop"
                }
                className={cn(
                  "size-2.5",
                  id === "github" && suggestions.githubLoading && "animate-spin",
                )}
                aria-hidden
              />
            )}
            {id === "mac" ? computer : label}
          </button>
        ))}
      </div>
      {repos.map((repo, index) => {
        const key = repoKey(repo);
        const adding = suggestions.addingKey === key;
        return (
          <CommandItem
            key={key}
            value={`repo:${key}`}
            keywords={[repo.name]}
            disabled={suggestions.addingKey !== null && !adding}
            onSelect={() => onAdd(repo)}
            className={cn(
              PROJECT_PICKER_ITEM_CLASS_NAME,
              "group animate-in fade-in slide-in-from-top-1 fill-mode-both duration-300 motion-reduce:animate-none",
            )}
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <Icon
              name={repo.source === "github" ? "Github" : "Laptop"}
              className="size-4 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">
              {repo.name}
              {repo.updatedAt === null ? null : (
                <span className="ml-1.5 text-muted-foreground">
                  {formatRelativeTime({ timestamp: repo.updatedAt, now })}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1 rounded border px-1.5 text-[0.6875rem] leading-4 text-muted-foreground group-data-[selected=true]:border-primary group-data-[selected=true]:bg-primary group-data-[selected=true]:text-primary-foreground">
              {adding ? (
                <>
                  <Icon name="Loading" className="size-3 animate-spin" />
                  Adding
                </>
              ) : (
                "+ Add"
              )}
            </span>
          </CommandItem>
        );
      })}
      {loadingMessage ? (
        <div className="flex items-center gap-2 px-2 py-[0.3125rem] text-xs text-muted-foreground max-md:py-2">
          <Icon name="Loading" className="size-4 animate-spin" aria-hidden />
          {loadingMessage}
        </div>
      ) : repos.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground max-md:py-2">
          {emptyMessage}
        </div>
      ) : null}
    </CommandGroup>
  );
}
