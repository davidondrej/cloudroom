import { atomWithStorage } from "jotai/utils";
import { useAtom } from "jotai";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { createLocalStorageEnumStorage } from "@/lib/browser-storage";
import {
  SETTINGS_DROPDOWN_CONTENT_CLASS,
  SETTINGS_DROPDOWN_TRIGGER_CLASS,
} from "./settings-dropdown";

const HARNESS_ICON_MODES = [
  { value: "off", label: "Off" },
  { value: "beside", label: "Next to Local/Cloud" },
  { value: "instead", label: "Instead of Local/Cloud" },
  { value: "hover", label: "On hover" },
] as const;

export type HarnessIconMode = (typeof HARNESS_ICON_MODES)[number]["value"];

export const HARNESS_ICONS_SETTING_LABEL = "Harness icons";

export const harnessIconModeAtom = atomWithStorage<HarnessIconMode>(
  "bb.sidebar.harnessIcons",
  "off",
  createLocalStorageEnumStorage<HarnessIconMode>(
    (value): value is HarnessIconMode =>
      HARNESS_ICON_MODES.some((mode) => mode.value === value),
  ),
  { getOnInit: true },
);

export function HarnessIconsSetting() {
  const [mode, setMode] = useAtom(harnessIconModeAtom);

  return (
    <SettingsWithControl
      label={HARNESS_ICONS_SETTING_LABEL}
      description="Show each thread's harness (Claude Code, Codex…) in the sidebar. On hover swaps it in for the Local/Cloud icon."
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            aria-label={HARNESS_ICONS_SETTING_LABEL}
          >
            {HARNESS_ICON_MODES.find((option) => option.value === mode)?.label}
            <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {HARNESS_ICON_MODES.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => setMode(option.value)}
            >
              {option.label}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto size-3.5",
                  mode !== option.value && "opacity-0",
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}
