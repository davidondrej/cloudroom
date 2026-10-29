import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { Button } from "@cloudroom/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Switch } from "@cloudroom/shared-ui/switch";
import { Textarea } from "@cloudroom/shared-ui/textarea";
import {
  DEFAULT_THREAD_NAMING_RULES,
  THREAD_PURPOSE_CLAUDE_MODEL,
} from "@cloudroom/domain";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import {
  useSystemConfig,
  useSystemExecutionOptions,
} from "@/hooks/queries/system-queries";
import { threadPurposeShowInSidebarAtom } from "@/components/thread/ThreadPurposeHoverCard";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";
import {
  SETTINGS_DROPDOWN_CONTENT_CLASS,
  SETTINGS_DROPDOWN_TRIGGER_CLASS,
} from "./settings-dropdown";
import {
  SettingsDropdown,
  ThreadNamingModelPicker,
} from "./ThreadNamingModelPicker";

const threadNamingModelAtom = createSyncedPreferenceAtom("threadNaming.model");
const threadNamingRulesAtom = createSyncedPreferenceAtom("threadNaming.rules");
const renameSensitivityAtom = createSyncedPreferenceAtom(
  "threadNaming.renameSensitivity",
);
const threadPurposeEnabledAtom = createSyncedPreferenceAtom(
  "threadPurpose.enabled",
);
const threadPurposeModelAtom = createSyncedPreferenceAtom("threadPurpose.model");
const threadPurposeEffortAtom = createSyncedPreferenceAtom(
  "threadPurpose.reasoningEffort",
);
const PURPOSE_EFFORT_OPTIONS = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;
// The switch saves the default sensitivity; 1 means off.
const RENAME_SENSITIVITY_ON = 3;
const RENAME_SENSITIVITY_OFF = 1;

export function ThreadNamingSettingsSection() {
  const [model, setModel] = useAtom(threadNamingModelAtom);
  const [rules, setRules] = useAtom(threadNamingRulesAtom);
  const [renameSensitivity, setRenameSensitivity] = useAtom(
    renameSensitivityAtom,
  );
  const [draftRules, setDraftRules] = useState(rules);

  useEffect(() => setDraftRules(rules), [rules]);

  const saveRules = () => {
    const next = draftRules.trim() || DEFAULT_THREAD_NAMING_RULES;
    setDraftRules(next);
    if (next !== rules) setRules(next);
  };

  return (
    <SettingsSection
      title="Thread naming"
      description="Names new threads after your first message."
    >
      <div className="space-y-4">
        <SettingsWithControl
          label="Model"
          description="Falls back to your other harness if it fails."
        >
          <NamingModelDropdown value={model} onChange={setModel} />
        </SettingsWithControl>
        <SettingsWithControl
          label="Rules"
          description="How titles should look. It also sees your other thread names, so new names stand out. Saved when you click away."
          controlPlacement="below"
        >
          <Textarea
            aria-label="Thread naming rules"
            className="min-h-[80px] text-sm"
            maxLength={4_000}
            value={draftRules}
            onChange={(event) => setDraftRules(event.target.value)}
            onBlur={saveRules}
          />
        </SettingsWithControl>
        <SettingsWithControl
          label="Rename vague titles"
          description="After the first reply, gives a vague title a clearer name once. Titles you set are never changed."
        >
          <Switch
            aria-label="Rename vague titles"
            checked={renameSensitivity > RENAME_SENSITIVITY_OFF}
            onCheckedChange={(on) =>
              setRenameSensitivity(
                on ? RENAME_SENSITIVITY_ON : RENAME_SENSITIVITY_OFF,
              )
            }
          />
        </SettingsWithControl>
      </div>
    </SettingsSection>
  );
}

interface NamingModelDropdownProps {
  /** Saved `harness/model` value; null is Automatic. */
  value: string | null;
  onChange: (value: string | null) => void;
}

/** One dropdown: Automatic, then each naming harness's models. */
function NamingModelDropdown(props: NamingModelDropdownProps) {
  const config = useSystemConfig().data?.aiServices;
  const current = props.value ?? config?.inference ?? null;
  const [harness, modelId] = current?.split("/") ?? [];
  const currentModels =
    useSystemExecutionOptions({
      enabled: harness !== undefined,
      ...(harness ? { providerId: harness } : {}),
    }).data?.models ?? [];
  const currentLabel =
    currentModels.find((model) => model.id === modelId)?.displayName ??
    modelId ??
    "None";
  const services = (config?.services ?? []).filter((service) =>
    service.kinds.includes("inference"),
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(SETTINGS_DROPDOWN_TRIGGER_CLASS, "sm:w-56")}
          aria-label="Thread naming model"
        >
          <span className="min-w-0 truncate">
            {props.value === null
              ? `Automatic (${currentLabel})`
              : currentLabel}
          </span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={cn(
          SETTINGS_DROPDOWN_CONTENT_CLASS,
          "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto",
        )}
        mobileTitle="Thread naming model"
      >
        <ModelItem
          label="Automatic (recommended)"
          selected={props.value === null}
          onSelect={() => props.onChange(null)}
        />
        {services.map((service) => (
          <HarnessModels
            key={service.id}
            harness={service.id}
            fallbackLabel={service.displayName}
            value={props.value}
            onChange={props.onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface HarnessModelsProps {
  harness: string;
  fallbackLabel: string;
  value: string | null;
  onChange: (value: string) => void;
}

function HarnessModels(props: HarnessModelsProps) {
  const options = useSystemExecutionOptions({
    providerId: props.harness,
  }).data;
  const models = options?.models ?? [];
  if (models.length === 0) return null;
  const label =
    options?.providers.find((provider) => provider.id === props.harness)
      ?.displayName ?? props.fallbackLabel;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {models.map((model) => {
        const value = `${props.harness}/${model.id}`;
        return (
          <ModelItem
            key={value}
            label={model.displayName}
            selected={props.value === value}
            onSelect={() => props.onChange(value)}
          />
        );
      })}
    </>
  );
}

interface ModelItemProps {
  label: string;
  selected: boolean;
  onSelect: () => void;
}

function ModelItem(props: ModelItemProps) {
  return (
    <DropdownMenuItem onSelect={props.onSelect}>
      <span className="min-w-0 truncate">{props.label}</span>
      <Icon
        name="Check"
        className={cn(
          "ml-auto",
          !props.selected && "opacity-0",
          COARSE_POINTER_ICON_SIZE_CLASS,
        )}
      />
    </DropdownMenuItem>
  );
}

export function ThreadPurposeSettingsSection() {
  const [enabled, setEnabled] = useAtom(threadPurposeEnabledAtom);
  const [model, setModel] = useAtom(threadPurposeModelAtom);
  const [effort, setEffort] = useAtom(threadPurposeEffortAtom);
  const [showInSidebar, setShowInSidebar] = useAtom(
    threadPurposeShowInSidebarAtom,
  );

  return (
    <SettingsSection
      title="Thread purpose"
      description="Hover a thread's title to see what it is for and how far along it is. Updated after every reply. Off when neither Claude Code nor Codex is signed in."
    >
      <div className="space-y-4">
        <SettingsWithControl
          label="Thread purpose"
          description="Uses a small model call after each reply."
        >
          <Switch
            aria-label="Thread purpose"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </SettingsWithControl>
        {enabled ? (
          <>
            <SettingsWithControl
              label="Show in sidebar"
              description="Preview the purpose when you hover a sidebar thread for 1.5s. Hovering the open thread's title always works."
            >
              <Switch
                aria-label="Show thread purpose in sidebar"
                checked={showInSidebar}
                onCheckedChange={setShowInSidebar}
              />
            </SettingsWithControl>
            <ThreadNamingModelPicker
              harnessDescription="Default: Haiku 5.5 on Claude Code, or GPT-6 Luna on Codex without Claude."
              scope="Thread purpose"
              value={model}
              defaultValue={THREAD_PURPOSE_CLAUDE_MODEL}
              defaultLabel="Haiku 5.5, or GPT-6 Luna"
              onChange={setModel}
            />
            <SettingsWithControl label="Reasoning effort">
              <SettingsDropdown
                label="Thread purpose reasoning effort"
                options={[...PURPOSE_EFFORT_OPTIONS]}
                selected={effort}
                triggerLabel={
                  PURPOSE_EFFORT_OPTIONS.find((option) => option.value === effort)
                    ?.label ?? effort
                }
                onSelect={(value) => {
                  const next = PURPOSE_EFFORT_OPTIONS.find(
                    (option) => option.value === value,
                  );
                  if (next) setEffort(next.value);
                }}
              />
            </SettingsWithControl>
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}
