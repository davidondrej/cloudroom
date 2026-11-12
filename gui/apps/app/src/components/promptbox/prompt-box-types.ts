// The prompt box's public contract: what callers pass in and what they get back.
import type {
  OrderedMentionSuggestions,
  PluginMentionTrigger,
  PromptDraftAttachment,
  PromptDraftState,
  ProviderCommandSuggestion,
} from "@cloudroom/client-core";
import type {
  PromptMentionCommandTrigger,
  PromptTextMention,
} from "@cloudroom/domain";
import type { IconName } from "@cloudroom/shared-ui/icon";
import type { ComposerView } from "@get-bb/plugin-sdk";
import type { ComponentType, ReactNode, Ref } from "react";
import type { VoiceUnsupportedReason } from "@/hooks/voice-input-support";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import type { ComposerEditorLayout } from "./ComposerEditorSlot";
import type { PromptMentionLinkResolver } from "./editor/prompt-mention-link";
import type { ExecutionControlsProps } from "./ExecutionControls";
import type { LocationCommandSuggestion } from "./mentions/MentionMenu";
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
  suggestions: readonly ProviderCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  onQueryChange: (query: string | null) => void;
  onEditorFocus?: () => void;
}

export interface TypeaheadConfig {
  mention: TypeaheadMentionConfig;
  command: TypeaheadCommandConfig;
}

/** A command config for composers that have no `/` menu. */
export const INERT_TYPEAHEAD_COMMAND_CONFIG: TypeaheadCommandConfig = {
  trigger: null,
  suggestions: [],
  isLoading: false,
  isError: false,
  hasMore: false,
  isLoadingMore: false,
  loadMore: () => {},
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
}

export interface PromptModelShortcut {
  name: string;
  description: string;
  /** The harness logo, so the row shows where the switch lands. */
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void;
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

/** The `/fast` command, for providers that have a fast tier. */
export function promptFastModeCommand(
  serviceTier: ExecutionControlsProps["serviceTier"],
): PromptFastMode | undefined {
  if (!serviceTier?.supported) return undefined;
  const enabled = serviceTier.value === "fast";
  return {
    enabled,
    label: serviceTier.fastLabel?.trim() || "Fast",
    onToggle: () => serviceTier.onChange(enabled ? "default" : "fast"),
  };
}

const MODEL_SHORTCUTS = [
  ["fable", "claude-code", "claude-fable-5-2", "Fable 5.2 in Claude Code"],
  ["opus", "claude-code", "claude-opus-5-5[1m]", "Opus 5.5 in Claude Code"],
  ["astra", "codex", "gpt-6-astra", "GPT-6 Astra in Codex"],
] as const;

/** The `/fable`, `/opus` and `/astra` commands, for the harnesses this install has. */
export function promptModelShortcuts({
  provider,
  selectModel,
}: Pick<ExecutionControlsProps, "provider" | "selectModel">):
  | PromptModelShortcut[]
  | undefined {
  if (!selectModel) return undefined;
  const shortcuts: PromptModelShortcut[] = [];
  for (const [name, providerId, model, label] of MODEL_SHORTCUTS) {
    const harness = provider.options?.find(({ value }) => value === providerId);
    if (!harness) continue;
    shortcuts.push({
      name,
      description: `Switch to ${label}`,
      icon: harness.icon,
      onSelect: () => selectModel({ providerId, model }),
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
