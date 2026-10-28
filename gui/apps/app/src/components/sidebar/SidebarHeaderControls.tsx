import { createContext, useContext, useState, type ReactNode } from "react";
import { useAtom, useSetAtom } from "jotai";
import type { SidebarSectionId } from "@cloudroom/client-core";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@cloudroom/shared-ui/dropdown-menu";
import {
  sidebarOrganizationModeAtom,
  sidebarSectionSortsAtom,
} from "./sidebarCollapsedAtoms";
import { useSidebarSectionSort } from "./sidebarSectionSort";
import { SidebarControlButton, SidebarRowControls } from "./SidebarRowControls";
import { SIDEBAR_CONTROL_BUTTON_CLASS } from "./sidebarRowClasses";

interface HeaderCreationActions {
  onNewProject?: () => void;
  isCreatingProject?: boolean;
}

const HeaderCreationContext = createContext<HeaderCreationActions>({});
export const SidebarHeaderActionsProvider = HeaderCreationContext.Provider;

const SIDEBAR_ORGANIZE_OPTIONS = [
  { label: "By project", mode: "project" },
  { label: "By machine", mode: "machine" },
  { label: "By harness", mode: "harness" },
  { label: "Custom", mode: "chronological" },
] as const;

const SIDEBAR_SORT_OPTIONS = [
  { label: "Updated at", sort: "updated", direction: "descending" },
  { label: "Created at", sort: "created", direction: "descending" },
  { label: "Alphabetical", sort: "alpha", direction: "ascending" },
] as const;

// Only Pinned has a saved drag order.
const PINNED_SORT_OPTIONS = [
  { label: "Drag order", sort: "manual", direction: "ascending" },
  ...SIDEBAR_SORT_OPTIONS,
] as const;

function SidebarViewItems({
  page,
  sectionId,
}: {
  page: "organize" | "sort";
  sectionId: SidebarSectionId;
}) {
  const [organization, setOrganization] = useAtom(sidebarOrganizationModeAtom);
  const setSectionSorts = useSetAtom(sidebarSectionSortsAtom);
  const current = useSidebarSectionSort()(sectionId);
  const sortOptions =
    sectionId === "pinned" ? PINNED_SORT_OPTIONS : SIDEBAR_SORT_OPTIONS;
  return (
    <DropdownMenuGroup
      aria-label={page === "organize" ? "Organize" : "Sort by"}
    >
      {page === "organize"
        ? SIDEBAR_ORGANIZE_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.mode}
              role="menuitemradio"
              aria-checked={organization === option.mode}
              onSelect={() => {
                setOrganization(option.mode);
              }}
            >
              {option.label}
              <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
                {organization === option.mode && (
                  <Icon name="Check" className="size-4" />
                )}
              </span>
            </DropdownMenuItem>
          ))
        : sortOptions.map((option) => {
            const selected = current.sort === option.sort;
            const manual = option.sort === "manual";
            const direction = selected ? current.direction : option.direction;
            const nextDirection =
              selected && !manual
                ? direction === "ascending"
                  ? "descending"
                  : "ascending"
                : option.direction;
            const announceDirection = selected && !manual;
            return (
              <DropdownMenuItem
                key={option.sort}
                role="menuitemradio"
                aria-checked={selected}
                aria-label={
                  announceDirection
                    ? `${option.label}, ${direction}. Sort ${nextDirection}`
                    : option.label
                }
                onSelect={(event) => {
                  event.preventDefault();
                  setSectionSorts((sorts) => ({
                    ...sorts,
                    [sectionId]: {
                      sort: option.sort,
                      direction: nextDirection,
                    },
                  }));
                }}
              >
                {option.label}
                {announceDirection && (
                  <span className="sr-only">
                    , {direction}. Sort {nextDirection}
                  </span>
                )}
                <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
                  {selected && (
                    <Icon
                      name={
                        manual
                          ? "Check"
                          : direction === "ascending"
                            ? "ArrowUp"
                            : "ArrowDown"
                      }
                      className="size-4"
                    />
                  )}
                </span>
              </DropdownMenuItem>
            );
          })}
    </DropdownMenuGroup>
  );
}

export function SidebarHeaderControls({
  label,
  sectionId,
  onNewThread,
  showNewThread = true,
  children,
  open,
  onOpenChange,
}: {
  label: string;
  sectionId: SidebarSectionId;
  onNewThread?: () => void;
  showNewThread?: boolean;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const creation = useContext(HeaderCreationContext);
  const compact = useIsCompactViewport();
  const [page, setPage] = useState<"organize" | "sort" | null>(null);
  const changeOpen = (next: boolean) => {
    if (!next) setPage(null);
    onOpenChange?.(next);
  };
  return (
    <SidebarRowControls
      primaryAction={
        showNewThread ? (
          <SidebarControlButton
            label={`New thread in ${label}`}
            icon="MessageSquarePlus"
            onClick={() => onNewThread?.()}
            disabled={!onNewThread}
          />
        ) : null
      }
    >
      <DropdownMenu open={open} onOpenChange={changeOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${label} actions`}
            className={SIDEBAR_CONTROL_BUTTON_CLASS}
          >
            <Icon
              name="MoreHorizontal"
              className={COARSE_POINTER_ICON_SIZE_CLASS}
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          mobileTitle={
            page === "organize"
              ? "Organize"
              : page === "sort"
                ? "Sort by"
                : `${label} actions`
          }
        >
          {compact && page ? (
            <>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setPage(null);
                }}
              >
                <Icon name="ChevronLeft" />
                Back
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <SidebarViewItems page={page} sectionId={sectionId} />
            </>
          ) : (
            <>
              <DropdownMenuItem
                disabled={!creation.onNewProject || creation.isCreatingProject}
                onSelect={creation.onNewProject}
              >
                <Icon name="FolderPlus" />
                New project
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {(
                [
                  { page: "organize", label: "Organize", icon: "Layers" },
                  { page: "sort", label: "Sort by", icon: "Sort" },
                ] as const
              ).map((item) =>
                compact ? (
                  <DropdownMenuItem
                    key={item.page}
                    onSelect={(event) => {
                      event.preventDefault();
                      setPage(item.page);
                    }}
                  >
                    <Icon name={item.icon} />
                    {item.label}
                    <Icon name="ChevronRight" className="ml-auto" />
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuSub key={item.page}>
                    <DropdownMenuSubTrigger>
                      <Icon name={item.icon} />
                      {item.label}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent className="min-w-32">
                        <SidebarViewItems
                          page={item.page}
                          sectionId={sectionId}
                        />
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                ),
              )}
              {children && (
                <>
                  <DropdownMenuSeparator />
                  {children}
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarRowControls>
  );
}

export function SidebarSectionMenuItems({
  onRename,
  onRemove,
}: {
  onRename?: () => void;
  onRemove?: () => void;
}) {
  return (
    <>
      {onRename && (
        <DropdownMenuItem onSelect={onRename}>
          <Icon name="Edit" />
          Rename
        </DropdownMenuItem>
      )}
      {onRemove && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Icon name="Trash2" />
            Remove
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
