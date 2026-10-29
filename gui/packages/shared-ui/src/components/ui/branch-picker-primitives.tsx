import {
  Fragment,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
} from "./coarse-pointer-sizing";
import { Icon, type IconName } from "./icon";
import { Input } from "./input";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "./menu-item-hover";
import { LIST_HOVER_TRANSITION } from "./motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "./option-display";
import { blurActiveKeyboardInputWithin } from "./overlay-trigger";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const BRANCH_PICKER_ROW_CLASS_NAME =
  "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-left text-xs outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground";
const BRANCH_PICKER_HEADER_BASE_CLASS_NAME =
  "text-xs font-medium text-muted-foreground";
const BRANCH_PICKER_HEADER_STICKY_CLASS_NAME =
  "sticky top-0 z-20 -mx-1 bg-background px-3";
export const BRANCH_PICKER_CONTENT_CLASS_NAME =
  "flex w-full min-w-0 flex-col overflow-hidden p-0 md:w-max md:max-w-[min(18rem,calc(100vw-2rem))] md:max-h-[calc(100vh-6rem)]";

interface BranchPickerSectionHeaderProps {
  label: string;
  subtitle?: string;
  sticky?: boolean;
}

interface BranchPickerRowProps {
  disabled?: boolean;
  icon: IconName;
  selected: boolean;
  title: string;
  onSelect: () => void;
  children: ReactNode;
}

interface BranchPickerSearchProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  enterSelection: string | undefined;
  onEnterSelection: (branch: string) => void;
  onQueryChange: (query: string) => void;
  ariaLabel?: string;
}

export function BranchPickerSectionHeader({
  label,
  subtitle,
  sticky = true,
}: BranchPickerSectionHeaderProps) {
  const positionClassName = sticky
    ? BRANCH_PICKER_HEADER_STICKY_CLASS_NAME
    : "px-2";
  if (subtitle) {
    return (
      <div
        className={cn(
          BRANCH_PICKER_HEADER_BASE_CLASS_NAME,
          positionClassName,
          "py-[0.3125rem] pb-1.5",
        )}
        title={subtitle}
      >
        <div>{label}</div>
        <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground">
          <span className="min-w-0">{subtitle}</span>
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        BRANCH_PICKER_HEADER_BASE_CLASS_NAME,
        positionClassName,
        "flex h-7 items-center",
      )}
    >
      {label}
    </div>
  );
}

export function BranchPickerRow({
  disabled,
  icon,
  selected,
  title,
  onSelect,
  children,
}: BranchPickerRowProps) {
  const { hoverProps } = useMenuItemHover();
  return (
    <button
      type="button"
      className={cn(
        BRANCH_PICKER_ROW_CLASS_NAME,
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        disabled &&
          "cursor-not-allowed text-muted-foreground opacity-60 hover:bg-transparent hover:text-muted-foreground",
      )}
      disabled={disabled}
      title={title}
      onClick={onSelect}
      {...hoverProps}
    >
      <Icon
        name={icon}
        className={cn(
          "text-muted-foreground",
          COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
        )}
      />
      {children}
      <Icon
        name="Check"
        className={cn(
          selected ? "opacity-100" : "opacity-0",
          COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
        )}
      />
    </button>
  );
}

export function BranchPickerSearch({
  inputRef,
  query,
  enterSelection,
  onEnterSelection,
  onQueryChange,
  ariaLabel,
}: BranchPickerSearchProps) {
  return (
    <div className="shrink-0 border-b border-border p-1.5">
      <div className="relative">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          aria-label={ariaLabel}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            if (enterSelection) onEnterSelection(enterSelection);
          }}
          placeholder="Search branches"
          className="h-8 border-0 bg-transparent pl-8 pr-2 text-xs shadow-none focus-visible:ring-0"
        />
      </div>
    </div>
  );
}

export interface StartBranchPickerSection {
  label: string;
  icon: IconName;
  branches: readonly string[];
}

interface StartBranchPickerProps {
  label: string;
  /** Muted text before an emphasized label, e.g. "Branch from:". Hidden when the prompt box is compact. */
  prefix?: string;
  title?: string;
  sections: readonly StartBranchPickerSection[];
  selected: string | null;
  badges?: Readonly<Record<string, string>>;
  /** Shown under the first section; disables every branch except the selected one and `availableWhenBlocked`. */
  blockedReason?: string | null;
  availableWhenBlocked?: string | null;
  note?: string;
  isLoading?: boolean;
  disabled?: boolean;
  onSelect: (branch: string) => void;
  onOpen?: () => void;
  onQueryChange?: (query: string) => void;
}

/** The "start from" branch menu shared by Local and Cloud threads: search, then branches grouped by where they live. */
export function StartBranchPicker({
  label,
  prefix,
  title,
  sections,
  selected,
  badges,
  blockedReason,
  availableWhenBlocked = null,
  note,
  isLoading = false,
  disabled = false,
  onSelect,
  onOpen,
  onQueryChange,
}: StartBranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const visible = sections
    .map((section) => {
      const branches = section.branches.filter((branch) =>
        branch.toLowerCase().includes(needle),
      );
      return {
        ...section,
        branches:
          selected !== null && branches.includes(selected)
            ? [selected, ...branches.filter((branch) => branch !== selected)]
            : branches,
      };
    })
    .filter((section) => section.branches.length > 0);
  const updateQuery = (next: string) => {
    setQuery(next);
    onQueryChange?.(next);
  };
  const updateOpen = (next: boolean) => {
    if (next) {
      onOpen?.();
    } else {
      blurActiveKeyboardInputWithin(inputRef.current);
      updateQuery("");
    }
    setOpen(next);
  };
  const select = (branch: string) => {
    onSelect(branch);
    updateOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label="Branch"
          role="combobox"
          aria-expanded={open}
          className={cn(
            LIST_HOVER_TRANSITION,
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            OPTION_MUTED_CLASS_NAME,
          )}
        >
          <span
            className={OPTION_TRIGGER_CONTENT_CLASS_NAME}
            title={title ?? label}
          >
            <Icon
              name="GitMerge"
              className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
            />
            {prefix ? (
              <span className="flex min-w-0 items-baseline gap-1">
                <span
                  data-promptbox-hide-compact=""
                  className="shrink-0 text-muted-foreground"
                >
                  {prefix}
                </span>
                <span className="min-w-0 truncate font-medium text-foreground">
                  {label}
                </span>
              </span>
            ) : (
              <span className="min-w-0 truncate">{label}</span>
            )}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              "shrink-0 text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        mobileTitle="Start from"
        autoFocusRef={inputRef}
        className={cn(BRANCH_PICKER_CONTENT_CLASS_NAME, "md:min-w-56")}
      >
        <MenuHoverProvider>
          <BranchPickerSearch
            inputRef={inputRef}
            query={query}
            enterSelection={blockedReason ? undefined : visible[0]?.branches[0]}
            onEnterSelection={select}
            onQueryChange={updateQuery}
            ariaLabel="Search branches"
          />
          <div
            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 md:max-h-80"
            onWheel={(event) => event.stopPropagation()}
          >
            {visible.map((section, index) => (
              <Fragment key={section.label}>
                <BranchPickerSectionHeader
                  label={section.label}
                  subtitle={index === 0 ? (blockedReason ?? undefined) : undefined}
                  sticky={false}
                />
                {section.branches.map((branch) => (
                  <BranchPickerRow
                    key={branch}
                    icon={section.icon}
                    selected={branch === selected}
                    disabled={
                      Boolean(blockedReason) &&
                      branch !== selected &&
                      branch !== availableWhenBlocked
                    }
                    title={branch}
                    onSelect={() => select(branch)}
                  >
                    <span className="min-w-0 flex-1 truncate">{branch}</span>
                    {badges?.[branch] ? (
                      <span className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">
                        {badges[branch]}
                      </span>
                    ) : null}
                  </BranchPickerRow>
                ))}
              </Fragment>
            ))}
            {visible.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {isLoading ? "Loading branches..." : "No branches found."}
              </p>
            ) : null}
          </div>
          {note ? (
            <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {note}
            </div>
          ) : null}
        </MenuHoverProvider>
      </PopoverContent>
    </Popover>
  );
}
