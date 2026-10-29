import { useMemo, type ComponentType } from "react";
import type { PermissionMode } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { LIST_HOVER_TRANSITION } from "@cloudroom/shared-ui/motion";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { OptionPicker, type PickerOption } from "./OptionPicker";

type PermissionModeOption = PickerOption<PermissionMode>;

function getPermissionModeCompactLabel(value: PermissionMode): string {
  switch (value) {
    case "full":
      return "Full";
    case "accept-edits":
      return "Manual";
    case "auto":
      return "Auto";
  }
}

const PERMISSION_MODE_ICONS = Object.fromEntries(
  PERMISSION_MODE_OPTIONS.map(({ value, iconName }) => [
    value,
    ({ className }: { className?: string }) => (
      <Icon name={iconName} className={className} />
    ),
  ]),
) as Record<PermissionMode, ComponentType<{ className?: string }>>;

function addPermissionModePresentation(
  options: readonly PermissionModeOption[],
): PermissionModeOption[] {
  return options.map((option) => ({
    ...option,
    compactLabel:
      option.compactLabel ?? getPermissionModeCompactLabel(option.value),
    icon: option.icon ?? PERMISSION_MODE_ICONS[option.value],
  }));
}

export interface PermissionModePickerProps {
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
  className?: string;
  muted?: boolean;
  defaultOpen?: boolean;
  modal?: boolean;
  align?: "start" | "center" | "end";
  displayOverride?: {
    label: string;
    compactLabel?: string;
    description?: string;
    title?: string;
  };
  disabled?: boolean;
  showChevronWhenDisabled?: boolean;
  showWhenSingleOption?: boolean;
}

export function PermissionModePicker({
  value,
  options,
  onChange,
  supported,
  className,
  muted = true,
  defaultOpen,
  modal,
  align = "end",
  displayOverride,
  disabled,
  showChevronWhenDisabled,
  showWhenSingleOption = false,
}: PermissionModePickerProps) {
  const compactOptions = useMemo(
    () => addPermissionModePresentation(options),
    [options],
  );
  if (
    !supported ||
    value === undefined ||
    (!showWhenSingleOption && options.length <= 1)
  ) {
    return null;
  }
  return (
    <OptionPicker
      label="Permission mode"
      value={value}
      options={compactOptions}
      onChange={onChange}
      className={cn(LIST_HOVER_TRANSITION, className)}
      caretClassName="text-subtle-foreground/75"
      contentClassName="w-64 p-1.5"
      muted={muted}
      defaultOpen={defaultOpen}
      modal={modal}
      align={align}
      displayOverride={displayOverride}
      disabled={disabled || options.length <= 1}
      showChevronWhenDisabled={showChevronWhenDisabled}
      tiles
    />
  );
}
