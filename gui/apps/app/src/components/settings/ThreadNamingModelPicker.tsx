import { useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SettingsWithControl } from "@/components/ui/settings-section";
import {
  useSystemConfig,
  useSystemExecutionOptions,
} from "@/hooks/queries/system-queries";
import {
  SETTINGS_DROPDOWN_CONTENT_CLASS,
  SETTINGS_DROPDOWN_TRIGGER_CLASS,
} from "./settings-dropdown";

export interface DropdownOption {
  value: string | null;
  label: string;
}

interface SettingsDropdownProps {
  label: string;
  options: DropdownOption[];
  selected: string | null;
  triggerLabel: string;
  onSelect: (value: string | null) => void;
}

export function SettingsDropdown(props: SettingsDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
          aria-label={props.label}
        >
          <span className="min-w-0 truncate">{props.triggerLabel}</span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        mobileTitle={props.label}
      >
        {props.options.map((option) => (
          <DropdownMenuItem
            key={option.value ?? "none"}
            onSelect={() => props.onSelect(option.value)}
          >
            <span className="min-w-0 truncate">{option.label}</span>
            <Icon
              name="Check"
              className={cn(
                "ml-auto",
                props.selected !== option.value && "opacity-0",
                COARSE_POINTER_ICON_SIZE_CLASS,
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ThreadNamingModelPickerProps {
  /** Label prefix, e.g. "Fallback" gives "Fallback harness". */
  prefix?: string;
  harnessDescription: string;
  /** Saved `harness/model` value. */
  value: string | null;
  /** Model used when nothing is saved. */
  defaultValue: string | null;
  /** Offer "None" as a harness, which clears the value. */
  allowNone?: boolean;
  scope?: string;
  defaultLabel?: string;
  onChange: (value: string | null) => void;
}

export function ThreadNamingModelPicker(props: ThreadNamingModelPickerProps) {
  const [pickedHarness, setPickedHarness] = useState<string | null>(null);
  const current = props.value ?? props.defaultValue;
  const savedHarness = current?.split("/")[0] ?? null;
  const harness = pickedHarness ?? savedHarness;
  const options = useSystemExecutionOptions(
    harness ? { providerId: harness } : {},
  ).data;
  const services = useSystemConfig().data?.aiServices.services ?? [];

  const harnessOptions: DropdownOption[] = [
    ...(props.allowNone ? [{ value: null, label: "None" }] : []),
    ...services
      .filter((service) => service.kinds.includes("inference"))
      .map((service) => ({
        value: service.id,
        label:
          options?.providers.find((provider) => provider.id === service.id)
            ?.displayName ?? service.displayName,
      })),
  ];
  const modelOptions: DropdownOption[] = (options?.models ?? []).map(
    (model) => ({ value: `${harness}/${model.id}`, label: model.displayName }),
  );
  const labelOf = (list: DropdownOption[], value: string | null) =>
    list.find((option) => option.value === value)?.label ?? value ?? "None";
  const modelLabel = pickedHarness
    ? "Choose a model"
    : props.value === null
      ? `Default (${props.defaultLabel ?? labelOf(modelOptions, current)})`
      : labelOf(modelOptions, current);
  const name = (text: string) =>
    props.prefix ? `${props.prefix} ${text.toLowerCase()}` : text;

  const selectHarness = (next: string | null) => {
    setPickedHarness(next === savedHarness ? null : next);
    if (next === null) props.onChange(null);
  };
  const selectModel = (next: string | null) => {
    setPickedHarness(null);
    props.onChange(next);
  };

  return (
    <>
      <SettingsWithControl
        label={name("Harness")}
        description={props.harnessDescription}
      >
        <SettingsDropdown
          label={`${props.scope ?? "Thread naming"} ${name("Harness").toLowerCase()}`}
          options={harnessOptions}
          selected={harness}
          triggerLabel={labelOf(harnessOptions, harness)}
          onSelect={selectHarness}
        />
      </SettingsWithControl>
      {harness ? (
        <SettingsWithControl label={name("Model")}>
          <SettingsDropdown
            label={`${props.scope ?? "Thread naming"} ${name("Model").toLowerCase()}`}
            options={modelOptions}
            selected={pickedHarness ? null : current}
            triggerLabel={modelLabel}
            onSelect={selectModel}
          />
        </SettingsWithControl>
      ) : null}
    </>
  );
}
