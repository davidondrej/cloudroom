import { useMemo, type ReactNode } from "react";
import type { Host } from "@cloudroom/domain";
import { CHROME_SECTION_LABEL_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@cloudroom/shared-ui/motion";
import { OptionDisplay } from "@cloudroom/shared-ui/option-display";
import {
  OptionPicker,
  type PickerOption,
} from "@/components/pickers/OptionPicker";

const ROW_LAYOUT = `group flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-left ${LIST_HOVER_TRANSITION} focus-visible:outline-none ${COARSE_POINTER_TEXT_SM_CLASS}`;

export const LAUNCHER_ROW_BASE_CLASS = `${ROW_LAYOUT} focus-visible:ring-1 focus-visible:ring-ring`;
export const LAUNCHER_ACTION_ROW_BASE_CLASS = `${ROW_LAYOUT} focus-visible:bg-state-hover focus-visible:text-foreground`;
export const LAUNCHER_ROW_ICON_CLASS = `flex shrink-0 items-center justify-center overflow-hidden text-muted-foreground ${COARSE_POINTER_ICON_SIZE_CLASS}`;

export function LauncherRowTrailing({
  idle,
  isActive,
}: {
  idle: ReactNode;
  isActive: boolean;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center justify-end">
      <span
        className={cn(
          "whitespace-nowrap text-muted-foreground",
          COARSE_POINTER_TEXT_SM_CLASS,
          isActive ? "hidden" : "group-hover:hidden",
        )}
      >
        {idle}
      </span>
      <span
        className={cn(
          "items-center gap-1 text-subtle-foreground",
          COARSE_POINTER_TEXT_SM_CLASS,
          isActive ? "flex" : "hidden group-hover:flex",
        )}
        aria-hidden
      >
        <Icon
          name="ArrowUpRight"
          className="size-3 max-md:pointer-coarse:size-4"
          aria-hidden
        />
        open
      </span>
    </span>
  );
}

export function LauncherSectionHeader({
  label,
  count,
  action,
  sticky = false,
  className,
}: {
  label: ReactNode;
  count?: number;
  action?: ReactNode;
  sticky?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 px-2 pb-2",
        CHROME_SECTION_LABEL_CLASS,
        sticky && "sticky top-0 z-10 bg-sidebar",
        className,
      )}
    >
      <span>{label}</span>
      {count !== undefined ? (
        <span
          className={cn(
            "font-mono text-muted-foreground opacity-80",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        >
          {count}
        </span>
      ) : null}
      {action ? (
        <div className="ml-auto flex items-center">{action}</div>
      ) : null}
    </div>
  );
}

const HOST_SELECTOR_CLASS = "h-6 max-w-40 px-1.5 text-xs";

export function resolveTerminalHost({
  hosts,
  preferredHostId,
  primaryHostId,
}: {
  hosts: readonly Host[];
  preferredHostId: string | null;
  primaryHostId: string | null;
}): Host | null {
  const byId = (id: string | null) =>
    id === null ? null : (hosts.find((h) => h.id === id) ?? null);
  const preferred = byId(preferredHostId);
  if (preferred?.status === "connected") return preferred;
  const primary = byId(primaryHostId);
  if (primary?.status === "connected") return primary;
  return (
    hosts.find((h) => h.status === "connected") ??
    preferred ??
    primary ??
    hosts[0] ??
    null
  );
}

export function TerminalHostSelector({
  disabled,
  hosts,
  isLoading,
  onChange,
  selectedHostId,
}: {
  disabled: boolean;
  hosts: readonly Host[];
  isLoading: boolean;
  onChange: (hostId: string) => void;
  selectedHostId: string | null;
}) {
  const items = useMemo<readonly PickerOption<string>[]>(
    () =>
      hosts.map((h) => ({
        value: h.id,
        label: h.name,
        ...(h.status === "connected"
          ? {}
          : { disabled: true, disabledReason: "Offline" }),
      })),
    [hosts],
  );

  if (isLoading || hosts.length === 0) {
    return (
      <OptionDisplay
        label="Machine"
        value={isLoading ? "Loading…" : "No machines"}
        className={HOST_SELECTOR_CLASS}
      />
    );
  }

  const current = hosts.find((h) => h.id === selectedHostId) ?? hosts[0];
  if (!current) return null;
  if (hosts.length === 1) {
    return (
      <OptionDisplay
        label="Machine"
        value={current.name}
        className={HOST_SELECTOR_CLASS}
      />
    );
  }

  return (
    <OptionPicker
      align="end"
      label="Machine"
      value={current.id}
      options={items}
      onChange={onChange}
      disabled={disabled}
      muted
      className={HOST_SELECTOR_CLASS}
      contentClassName="max-w-72"
    />
  );
}
