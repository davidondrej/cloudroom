import { useThisComputer } from "@/hooks/useHostDaemon";
import { COMPUTER_TITLE } from "@cloudroom/domain";
import { useMemo, useRef, useState } from "react";
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
import { searchPickerOptions } from "./picker-search";
import { useResetPickerScroll } from "./useResetPickerScroll";

const PROJECT_SEARCH_MIN_OPTIONS = 5;
const NO_HIGHLIGHT_VALUE = "__project-picker-idle__";
const PROJECT_PICKER_ITEM_CLASS_NAME = "py-[0.3125rem] text-xs max-md:py-2";
const VISIBLE_REPO_SUGGESTIONS = 5;
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

/** Repos on this Mac and GitHub that are not projects yet, newest first. `onAdd` resolves to the new project's id. */
export interface ProjectSelectorSuggestions {
  repos: readonly RepoSuggestion[];
  githubConnected: boolean;
  isLoading: boolean;
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
  const [highlightedValue, setHighlightedValue] = useState(NO_HIGHLIGHT_VALUE);
  const [repoFilter, setRepoFilter] = useState<RepoFilter>("all");
  const commandRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const disabled = disabledProp || isLoading;
  const suggestions = createProject?.suggestions;
  const showSearch =
    projects.length + (suggestions?.repos.length ?? 0) >
    PROJECT_SEARCH_MIN_OPTIONS;
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
  const visibleRepos = useMemo(() => {
    const repos = (suggestions?.repos ?? []).filter(
      (repo) => repoFilter === "all" || repo.source === repoFilter,
    );
    return searchPickerOptions({
      options: repos,
      query: searchQuery,
      getLabel: (repo) => repo.name,
    }).slice(0, VISIBLE_REPO_SUGGESTIONS);
  }, [repoFilter, searchQuery, suggestions?.repos]);
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
    setHighlightedValue(NO_HIGHLIGHT_VALUE);
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
          className="min-h-0"
        >
          {showSearch ? (
            <CommandInput
              ref={searchInputRef}
              aria-label="Search projects"
              placeholder={
                suggestions ? "Search projects and repos" : "Search projects"
              }
              value={searchQuery}
              onValueChange={setSearchQuery}
              className="h-8 text-xs"
            />
          ) : null}
          <CommandList
            ref={listRef}
            className="min-h-0 max-h-none flex-1 overscroll-contain"
          >
            {projects.length > 0 ? (
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
            {suggestions ? (
              <>
                {projects.length > 0 ? <CommandSeparator /> : null}
                <RepoSuggestionsGroup
                  suggestions={suggestions}
                  repos={visibleRepos}
                  filter={repoFilter}
                  onFilterChange={setRepoFilter}
                  onAdd={addRepo}
                />
              </>
            ) : null}
            {showActionSeparator || suggestions ? <CommandSeparator /> : null}
            {createProjectAction || allowNoProject ? (
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
  const emptyMessage = suggestions.isLoading
    ? "Looking for repos…"
    : filter === "github" && !suggestions.githubConnected
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
                name={id === "github" ? "Github" : "Laptop"}
                className="size-2.5"
                aria-hidden
              />
            )}
            {id === "mac" ? computer : label}
          </button>
        ))}
      </div>
      {repos.map((repo) => {
        const key = repoKey(repo);
        const adding = suggestions.addingKey === key;
        return (
          <CommandItem
            key={key}
            value={`repo:${key}`}
            keywords={[repo.name]}
            disabled={suggestions.addingKey !== null && !adding}
            onSelect={() => onAdd(repo)}
            className={cn(PROJECT_PICKER_ITEM_CLASS_NAME, "group")}
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
      {repos.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground max-md:py-2">
          {emptyMessage}
        </div>
      ) : null}
    </CommandGroup>
  );
}
