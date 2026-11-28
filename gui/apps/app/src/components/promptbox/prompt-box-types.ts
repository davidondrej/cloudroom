// The prompt box's public contract: what callers pass in and what they get back.
import type {
  OrderedMentionSuggestions,
  PluginMentionTrigger,
  PromptDraftAttachment,
  PromptDraftState,
  ProviderCommandSuggestion,
} from "@cloudroom/client-core";
import {
  newestModel,
  type PromptMentionCommandTrigger,
  type PromptTextMention,
} from "@cloudroom/domain";
import type { IconName } from "@cloudroom/shared-ui/icon";
import { appToast } from "@/components/ui/app-toast";
import type { ComposerView } from "@get-bb/plugin-sdk";
import type { ComponentType, ReactNode, Ref } from "react";
import type { VoiceUnsupportedReason } from "@/hooks/voice-input-support";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import type { ComposerEditorLayout } from "./ComposerEditorSlot";
import type { PromptMentionLinkResolver } from "./editor/prompt-mention-link";
import type { ExecutionControlsProps } from "./ExecutionControls";
import type { LocationCommandSuggestion } from "./mentions/typeahead-types";
import type { PromptBoxAction } from "./PromptBoxActionsMenu";

export type { PromptBoxAction };

export const DEFAULT_COMPOSER_SCOPE = {
  kind: "new-thread",
  projectId: null,
} as const;

export interface PromptBoxSubmissionConfig {
  isSubmitting?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
  icon?: IconName;
  title?: string;
  isRunning?: boolean;
  onStop?: () => void;
  onModifierSubmit?: () => void;
  onHardQueueSubmit?: () => void;
}

export interface TypeaheadMentionConfig {
  triggers?: readonly PluginMentionTrigger[];
  results: OrderedMentionSuggestions;
  isLoading: boolean;
  isError: boolean;
  onQueryChange: (
    query: string | null,
    trigger: PluginMentionTrigger | null,
  ) => void;
  resolveLink?: PromptMentionLinkResolver;
}

export interface TypeaheadCommandConfig {
  trigger: PromptMentionCommandTrigger | null;
  /** Optional unfiltered catalog for single-pass indexing; falls back to `suggestions`. */
  catalog?: readonly ProviderCommandSuggestion[];
  suggestions: readonly ProviderCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
  onQueryChange: (query: string | null) => void;
  onEditorFocus?: () => void;
}

export interface ControlledTypeaheadConfig {
  kind?: "controlled";
  mention: TypeaheadMentionConfig;
  command: TypeaheadCommandConfig;
}

/**
 * Self-contained live typeahead descriptor. `ComposerTypeaheadIsland` owns the
 * query state and data hooks, so typing `/` or `@` never re-renders the parent composer.
 */
export interface LiveTypeaheadConfig {
  kind: "live";
  projectId: string | undefined;
  mentionsProjectId: string | undefined;
  providerId: string | undefined;
  commandScope: "new-thread" | "thread";
  environmentId: string | null;
  hostId?: string | null;
  currentThreadId?: string;
  threadStorageThreadId?: string;
  skillsTrigger: PromptMentionCommandTrigger | null;
  promptActions?: readonly PromptBoxAction[];
  resolveLink?: PromptMentionLinkResolver;
}

export type TypeaheadConfig = ControlledTypeaheadConfig | LiveTypeaheadConfig;

export function resolveTypeaheadMentionLink(
  config: TypeaheadConfig,
): PromptMentionLinkResolver | undefined {
  return config.kind === "live" ? config.resolveLink : config.mention.resolveLink;
}

/** A command config for composers that have no `/` menu. */
export const INERT_TYPEAHEAD_COMMAND_CONFIG: TypeaheadCommandConfig = {
  trigger: null,
  suggestions: [],
  isLoading: false,
  isError: false,
  onQueryChange: () => {},
};

export interface AttachmentFailure {
  name: string;
  reason: string;
}

export interface AttachmentsConfig {
  items?: PromptDraftAttachment[];
  isAttaching?: boolean;
  error?: string | null;
  failures?: readonly AttachmentFailure[];
  onDismissFailure?: (index: number) => void;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemove?: (path: string) => void;
  projectId?: string;
}

export interface HistoryConfig {
  currentDraft: PromptDraftState;
  entries: readonly PromptDraftState[];
  onSelectEntry: (draft: PromptDraftState) => void;
  resetKey?: string | number;
}

export interface PromptVoiceConfig {
  state: "idle" | "recording" | "transcribing" | "error";
  isSupported: boolean;
  unsupportedReason?: VoiceUnsupportedReason | null;
  stream: MediaStream | null;
  start: () => void | Promise<void>;
  stop: () => void;
  stopAndSend?: () => void;
  cancel: () => void;
}

export interface PromptBoxHandle {
  attachFiles: (files: File[]) => void;
  /** Focuses the editor and keeps the caret where it was. */
  focus: () => void;
  focusEnd: () => void;
  captureHeightForLayoutChange: () => void;
  insertTextAtCursor: (text: string) => void;
  submit: () => void;
  getTextBeforeCursor: () => string | undefined;
  playVoiceCompletionTransition: () => Promise<void>;
}

export interface PromptFastMode {
  enabled: boolean;
  label: string;
  onToggle: () => void;
  /** `/ultrafast`, when the selected model offers Ultra Fast. */
  ultra?: { enabled: boolean; onToggle: () => void };
}

export interface PromptModelShortcut {
  name: string;
  description: string;
  /** The harness logo, so the row shows where the switch lands. */
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void | Promise<void>;
}

export interface PromptLocationCommand {
  name: LocationCommandSuggestion["name"];
  description: string;
  onSelect: () => void;
}

export interface PromptBoxProps {
  id?: string;
  value: string;
  mentionRanges: readonly PromptTextMention[];
  onChange: (value: string, mentionRanges: PromptTextMention[]) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  /** Runs on the Enter key only, before it submits. Return true to skip the submit. */
  onEnterKey?: () => boolean;
  blurOnPointerSubmit?: boolean;
  placeholder?: string;
  placeholderHint?: string;
  ghostText?: string | null;
  onGhostText?: (action: "shown" | "accepted") => void;
  autoFocus?: boolean;
  allowSoftKeyboardAutoFocus?: boolean;
  textEffects?: readonly ComposerTextEffectSource[];
  onComposerLayoutChange?: (layout: ComposerView["layout"]) => void;
  header?: ReactNode;
  modeHeader?: ReactNode;
  footerStart?: ReactNode;
  submission?: PromptBoxSubmissionConfig;
  minHeight?: number;
  typeahead: TypeaheadConfig;
  reasoning?: ExecutionControlsProps["reasoning"];
  fastMode?: PromptFastMode;
  modelShortcuts?: readonly PromptModelShortcut[];
  locationCommands?: readonly PromptLocationCommand[];
  mentionMenuPlacement: "top" | "bottom";
  attachments?: AttachmentsConfig;
  promptActions?: readonly PromptBoxAction[];
  suppressPluginComposerCustomizations?: boolean;
  editorLayout?: ComposerEditorLayout;
  onCollapse?: () => void;
  compact?: { isCompact: boolean; placeholder?: string };
  containerCompactPlaceholder?: string;
  heightAnimationKey?: string | number;
  history?: HistoryConfig;
  voice?: PromptVoiceConfig;
  promptBoxRef?: Ref<PromptBoxHandle>;
  focusEndKey?: string | number;
}

/** The `/fast` and `/ultrafast` commands, for providers that have those tiers. */
export function promptFastModeCommand(
  serviceTier: ExecutionControlsProps["serviceTier"],
): PromptFastMode | undefined {
  if (!serviceTier?.supported) return undefined;
  const enabled = serviceTier.value === "fast";
  return {
    enabled,
    label: serviceTier.fastLabel?.trim() || "Fast",
    onToggle: () => serviceTier.onChange(enabled ? "default" : "fast"),
    ...(serviceTier.ultraFast
      ? {
          ultra: {
            enabled: serviceTier.value === "ultrafast",
            onToggle: () =>
              serviceTier.onChange(
                serviceTier.value === "ultrafast" ? "default" : "ultrafast",
              ),
          },
        }
      : {}),
  };
}

// Each shortcut names a model family, never a version: it takes the newest one in the harness's own list.
const MODEL_SHORTCUTS = [
  ["fable", "claude-code", "Claude Code"],
  ["opus", "claude-code", "Claude Code"],
  ["astra", "codex", "Codex"],
  ["neon", "acp-antigravity", "Antigravity"],
] as const;

/** New drafts load the harness's models on pick. An existing thread already owns its harness and models. */
export function promptModelShortcuts(
  { provider, selectModel }: Pick<ExecutionControlsProps, "provider" | "selectModel">,
  source:
    | { providerId: string; models: readonly string[] }
    | { loadModels: (providerId: string) => Promise<readonly string[]> },
): PromptModelShortcut[] | undefined {
  if (!selectModel) return undefined;
  const shortcuts: PromptModelShortcut[] = [];
  for (const [name, providerId, harnessName] of MODEL_SHORTCUTS) {
    const harness = provider.options?.find(({ value }) => value === providerId);
    // A thread switches only within its own harness, to a model its list already has.
    const known = "models" in source && source.providerId === providerId ? newestModel(source.models, name) : null;
    if ("models" in source ? !known : !harness) continue;
    shortcuts.push({
      name,
      description: `Switch to ${known ?? `the newest ${name.charAt(0).toUpperCase()}${name.slice(1)}`} in ${harnessName}`,
      icon: harness?.icon,
      onSelect:
        "models" in source
          ? () => {
              // Existing threads already know the model and wait for the switch inside useSendThreadMessage.
              void Promise.resolve(selectModel({ providerId, model: known! })).catch(() => {});
            }
          : async () => {
              const model = newestModel(await source.loadModels(providerId), name);
              // Rejecting drops a held Enter, so the prompt never goes to the old model.
              if (!model) {
                appToast.error(`${harnessName} lists no ${name} model.`);
                throw new Error(`${harnessName} lists no ${name} model`);
              }
              await selectModel({ providerId, model });
            },
    });
  }
  return shortcuts.length > 0 ? shortcuts : undefined;
}

/** True when two drafts hold the same text and the same mentions. */
export function arePromptEditorValuesEqual(
  left: { text: string; mentions: readonly PromptTextMention[] } | null,
  right: { text: string; mentions: readonly PromptTextMention[] },
): boolean {
  if (left === null || left.text !== right.text) return false;
  if (left.mentions === right.mentions) return true;
  if (left.mentions.length !== right.mentions.length) return false;
  return left.mentions.every((mention, index) => {
    const other = right.mentions[index]!;
    if (mention === other) return true;
    return (
      mention.start === other.start &&
      mention.end === other.end &&
      (mention.resource === other.resource ||
        JSON.stringify(mention.resource) === JSON.stringify(other.resource))
    );
  });
}
