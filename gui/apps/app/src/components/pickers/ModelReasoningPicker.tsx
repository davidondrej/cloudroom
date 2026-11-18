import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
} from "react";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@cloudroom/server-contract";
import type { ReasoningLevel } from "@cloudroom/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { getSettingsRoutePath } from "@/lib/route-paths";
import {
  stripModelBrandPrefix,
  type ProviderPickerOption,
} from "./model-brand-prefix";
import { fastServiceTierLabel } from "@/lib/reasoning-labels";
import { showUltraEffortsAtom, withoutHiddenUltraEfforts } from "@/lib/ultra-efforts";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cloudroom/shared-ui/popover";
import { Skeleton } from "@cloudroom/shared-ui/skeleton";
import { Switch } from "@cloudroom/shared-ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { LIST_HOVER_TRANSITION } from "@cloudroom/shared-ui/motion";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "@cloudroom/shared-ui/menu-item-hover";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  prefetchSystemExecutionOptions,
  useSystemExecutionOptions,
} from "@/hooks/queries/system-queries";
import {
  resolveModelCatalogSelection,
  resolveModelReasoningLevel,
} from "@/hooks/thread-creation-options/model-catalog-selection";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { FLOATING_DRAWER_CLASS_NAME } from "@cloudroom/shared-ui/responsive-overlay";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@cloudroom/shared-ui/option-display";
import { type PickerOption } from "./OptionPicker";
import { ModelPickerHarnessStrip, useEdgeFade } from "./ModelPickerHarnessStrip";
import { PickerLoadingRows } from "./PickerLoadingRows";
import {
  ModelUnavailable,
  restartProviderModels,
  useRoutedHostId,
} from "./ModelUnavailable";
import { useProviderLogin } from "@/components/settings/ProviderLoginButton";
import type { ModelPickerOption } from "./model-picker-option";
import { searchPickerOptions } from "./picker-search";
import { useResetPickerScroll } from "./useResetPickerScroll";
import { formatModelLoadErrorText } from "./model-load-error-message";
import {
  useAppCommandContext,
  useAppCommandHandler,
  useAppCommandShortcut,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import {
  AppCommandShortcutHint,
  AppCommandShortcutPill,
} from "@/components/commands/AppCommandShortcutHint";
import {
  isEditableKeyboardTarget,
  type AppShortcutPresentation,
} from "@/lib/app-keybindings";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import {
  ownsModelPickerCycleChord,
  resolveModelPickerToggle,
  type ModelPickerScope,
} from "./modelPickerToggle";
import {
  cycleReasoningValue,
  nextCycleValue,
  previousCycleValue,
} from "./modelPickerCycle";

interface ModelLabelParts {
  base: string;
  tag: string | null;
}

interface ResolvedProviderPreview {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  supportsServiceTier: boolean;
}

export interface ModelReasoningPickerSelection {
  providerId: string;
  model: string;
  reasoningLevel?: ReasoningLevel;
}

const FAILED_TO_LOAD_MODELS_LABEL = "Failed to load models";
const EMPTY_MODEL_OPTIONS: readonly ModelPickerOption[] = [];
const preserveModelLabel = (displayName: string): string => displayName;
const MODEL_CYCLE_COMMANDS = [
  "modelPicker.cycleModel",
  "modelPicker.cycleModelBackward",
] as const;
const PROVIDER_CYCLE_COMMANDS = [
  "modelPicker.cycleProvider",
  "modelPicker.cycleProviderBackward",
] as const;
const REASONING_CYCLE_COMMANDS = [
  "modelPicker.cycleReasoning",
  "modelPicker.cycleReasoningBackward",
] as const;

const MODEL_SEARCH_MIN_OPTIONS = 5;
const FIVE_MODEL_ROWS =
  "max-h-[calc(5*var(--model-row-height))] [&>button]:h-(--model-row-height) [&>button]:shrink-0";
// The chat input's own surface: no outline, a soft shadow.
const QUIET_SURFACE_CLASS_NAME = "rounded-xl border-0 bg-composer shadow-message";

const COMPACT_SHEET_PADDING_CLASS_NAME =
  "px-3.5 pt-0 pb-[max(1.5rem,env(safe-area-inset-bottom))]";
const COMPACT_ROW_CLASS_NAME = "min-h-[42px] rounded-[15px] px-3.5";
const COMPACT_SELECTED_ROW_CLASS_NAME = "bg-composer font-medium shadow-message";

function splitModelLabelTag(label: string): ModelLabelParts {
  const match = label.match(/^(.*\S)\s*\(([^()]+)\)$/u);
  if (!match) {
    return { base: label, tag: null };
  }
  return { base: match[1], tag: match[2] };
}

type ModelNavRow =
  | { kind: "model"; option: ModelPickerOption }
  | { kind: "more-toggle" };

export function buildModelNavRows({
  modelOptions,
  moreModelOptions,
  isSearching,
  showMoreModels,
}: {
  modelOptions: readonly ModelPickerOption[];
  moreModelOptions: readonly ModelPickerOption[];
  isSearching: boolean;
  showMoreModels: boolean;
}): ModelNavRow[] {
  const rows: ModelNavRow[] = modelOptions.map((option): ModelNavRow => ({
    kind: "model",
    option,
  }));
  if (moreModelOptions.length === 0) return rows;

  if (isSearching) {
    for (const option of moreModelOptions) rows.push({ kind: "model", option });
    return rows;
  }

  rows.push({ kind: "more-toggle" });
  if (showMoreModels) {
    for (const option of moreModelOptions) {
      rows.push({ kind: "model", option });
    }
  }
  return rows;
}

interface ModelReasoningPickerProps {
  providerRouting?: SystemProvidersQuery;
  providerOptions: readonly ProviderPickerOption[];
  selectedProviderId: string;
  onSelectedProviderChange?: (value: string) => void;
  onProviderPreviewResolved?: (value: ResolvedProviderPreview) => void;
  requireVerifiedProviderPreview?: boolean;
  hasMultipleProviders: boolean;
  modelValue: string;
  modelOptions: readonly ModelPickerOption[];
  moreModelOptions?: readonly ModelPickerOption[];
  modelIsLoading?: boolean;
  modelLoadFailed?: boolean;
  modelLoadError?: SystemExecutionOptionsModelLoadError | null;
  onModelChange: (value: string) => void;
  formatModelLabel?: (displayName: string) => string;
  reasoningValue: ReasoningLevel;
  reasoningOptions: readonly PickerOption<ReasoningLevel>[];
  onReasoningChange: (value: ReasoningLevel) => void;
  fastModeEnabled: boolean;
  onFastModeChange: (enabled: boolean) => void;
  showFastModeToggle: boolean;
  commandShortcutsEnabled?: boolean;
  serviceTierSupportByProvider?: Record<string, boolean>;
  className?: string;
  fastModeLabel?: string;
  muted?: boolean;
  modal?: boolean;
  align?: "start" | "center" | "end";
  disabled?: boolean;
  lockModelSelection?: boolean;
  /**
   * An existing thread's picker: every model pick, on any provider tab, reports the provider too.
   * Picking another provider switches the thread's harness in place (ADR 0211).
   */
  onSelectModel?: (selection: ModelReasoningPickerSelection) => void;
}

export function ModelReasoningPicker({
  providerOptions,
  providerRouting,
  selectedProviderId,
  onSelectedProviderChange,
  onProviderPreviewResolved,
  requireVerifiedProviderPreview = false,
  hasMultipleProviders,
  modelValue,
  modelOptions,
  moreModelOptions = [],
  modelIsLoading = false,
  modelLoadFailed = false,
  modelLoadError,
  onModelChange,
  formatModelLabel,
  reasoningValue,
  reasoningOptions: allReasoningOptions,
  onReasoningChange,
  fastModeEnabled,
  onFastModeChange,
  showFastModeToggle,
  commandShortcutsEnabled = true,
  serviceTierSupportByProvider,
  className,
  fastModeLabel,
  muted,
  modal = true,
  align = "start",
  disabled,
  lockModelSelection = false,
  onSelectModel,
}: ModelReasoningPickerProps) {
  const showUltraEfforts = useAtomValue(showUltraEffortsAtom);
  const reasoningOptions = useMemo(
    () => withoutHiddenUltraEfforts(allReasoningOptions, reasoningValue, showUltraEfforts),
    [allReasoningOptions, reasoningValue, showUltraEfforts],
  );
  const isCompactViewport = useIsCompactViewport();
  const inRouter = useInRouterContext();
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const registeredToggleShortcut = useAppCommandShortcut("modelPicker.toggle");
  const toggleShortcut = commandShortcutsEnabled
    ? registeredToggleShortcut
    : null;
  const registeredReasoningShortcut = useAppCommandShortcut(
    "modelPicker.cycleReasoning",
  );
  const reasoningShortcut = commandShortcutsEnabled
    ? registeredReasoningShortcut
    : null;
  const registeredReasoningBackwardShortcut = useAppCommandShortcut(
    "modelPicker.cycleReasoningBackward",
  );
  const reasoningBackwardShortcut = commandShortcutsEnabled
    ? registeredReasoningBackwardShortcut
    : null;
  const [searchQuery, setSearchQuery] = useState("");
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const listFade = useEdgeFade(listRef, "y");
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeHarnessRef = useRef<HTMLButtonElement>(null);
  const isSearching = searchQuery.trim().length > 0;
  const navId = useId();
  const listboxId = `${navId}-listbox`;
  const optionDomId = (index: number) => `${navId}-opt-${index}`;

  const [previewProviderId, setPreviewProviderId] = useState<string | null>(
    null,
  );
  const [showMoreModels, setShowMoreModels] = useState(false);
  const [trackedSelectedProviderId, setTrackedSelectedProviderId] =
    useState(selectedProviderId);

  if (trackedSelectedProviderId !== selectedProviderId) {
    setTrackedSelectedProviderId(selectedProviderId);
    setPreviewProviderId(null);
    setShowMoreModels(false);
    setSearchQuery("");
    setActiveIndex(-1);
  }

  const activeProviderId = previewProviderId ?? selectedProviderId;

  const selectedProvider = providerOptions.find(
    (p) => p.value === selectedProviderId,
  );
  const ProviderIcon = selectedProvider?.icon;
  const selectedModelOption = modelOptions.find((m) => m.value === modelValue);
  const selectedModelLabel = selectedModelOption?.label ?? modelValue;
  const hasSelectedModel = selectedModelLabel.trim().length > 0;
  const selectedProviderLabel = selectedProvider?.label ?? selectedProviderId;
  const selectedModelLoadErrorMatches =
    modelLoadError?.providerId === selectedProviderId;
  const selectedModelLoadFailed =
    modelLoadFailed || selectedModelLoadErrorMatches;
  const canSwitchProviders =
    hasMultipleProviders &&
    (onSelectedProviderChange !== undefined || onSelectModel !== undefined) &&
    providerOptions.length > 1;
  const queryClient = useQueryClient();
  // Signs in on the machine that checks models (in a Cloud thread, this Mac),
  // then reloads them. It lives here because the popover closes for its drawer.
  const loginProviderId = useRef<string | null>(null);
  const providerLogin = useProviderLogin(
    useRoutedHostId(providerRouting, open),
    () => {
      if (loginProviderId.current === null) return;
      void restartProviderModels(
        queryClient,
        loginProviderId.current,
        providerRouting,
      ).catch(() => undefined);
    },
  );
  const prefetchRoutingEnvironmentId = providerRouting?.environmentId;
  const prefetchRoutingHostId = providerRouting?.hostId;
  const siblingIdsKey = providerOptions
    .map((option) => option.value)
    .filter((id) => id !== selectedProviderId)
    .join("\0");
  useEffect(() => {
    if (!open || !canSwitchProviders || siblingIdsKey.length === 0) {
      return;
    }
    prefetchSystemExecutionOptions(queryClient, {
      routing: {
        environmentId: prefetchRoutingEnvironmentId,
        hostId: prefetchRoutingHostId,
      },
      providerIds: siblingIdsKey.split("\0"),
    });
  }, [
    canSwitchProviders,
    open,
    prefetchRoutingEnvironmentId,
    prefetchRoutingHostId,
    queryClient,
    siblingIdsKey,
  ]);
  const hasAlternateSelectionPath =
    modelOptions.length > 0 ||
    (selectedModelLoadErrorMatches && canSwitchProviders);
  const selectedModelLoadErrorText =
    selectedModelLoadErrorMatches && modelLoadError
      ? formatModelLoadErrorText({
          error: modelLoadError,
          providerLabel: selectedProviderLabel,
        })
      : "Could not load models.";
  const triggerModelLabel = modelIsLoading
    ? "Loading models..."
    : hasSelectedModel
      ? stripModelBrandPrefix(selectedModelLabel, selectedProvider?.brandPrefix)
      : selectedModelLoadFailed
        ? hasAlternateSelectionPath
          ? "Select model"
          : FAILED_TO_LOAD_MODELS_LABEL
        : modelOptions.length === 0
          ? canSwitchProviders
            ? "Select model"
            : selectedProvider?.signInCommand
              ? `Sign in to ${selectedProviderLabel}`
              : "No models available"
          : "Select model";
  const triggerModelValueIsDestructive =
    triggerModelLabel === FAILED_TO_LOAD_MODELS_LABEL;
  const { base: triggerModelBase, tag: triggerModelTag } =
    splitModelLabelTag(triggerModelLabel);

  const selectedReasoningOption = reasoningOptions.find(
    (r) => r.value === reasoningValue,
  );
  const reasoningLabel = selectedReasoningOption?.label ?? "Effort";
  const showEffortControl =
    hasSelectedModel && !modelIsLoading && reasoningOptions.length > 0;
  if (effortOpen && (!showEffortControl || disabled)) {
    setEffortOpen(false);
  }

  const isPreviewing =
    previewProviderId !== null && previewProviderId !== selectedProviderId;
  const previewQuery = useSystemExecutionOptions({
    enabled: isPreviewing,
    ...providerRouting,
    providerId: isPreviewing ? previewProviderId : undefined,
  });
  const previewCatalogIsVerified =
    isPreviewing &&
    previewQuery.data !== undefined &&
    !previewQuery.isPlaceholderData &&
    !previewQuery.isError &&
    previewQuery.data.modelLoadError === null;
  const previewSelectionBlocked =
    requireVerifiedProviderPreview && isPreviewing && !previewCatalogIsVerified;

  const previewProvider = useMemo(
    () =>
      isPreviewing
        ? previewQuery.data?.providers.find(
            (provider) => provider.id === previewProviderId,
          )
        : undefined,
    [isPreviewing, previewProviderId, previewQuery.data?.providers],
  );
  const previewSelection = useMemo(
    () =>
      isPreviewing
        ? resolveModelCatalogSelection({
            models: previewQuery.data?.models ?? [],
            selectedOnlyModels: previewQuery.data?.selectedOnlyModels ?? [],
            selectedModel: "",
            preferredReasoningLevel: reasoningValue,
            provider: previewProvider,
            catalogIsVerified: previewCatalogIsVerified,
            formatModelLabel: formatModelLabel ?? preserveModelLabel,
          })
        : null,
    [
      formatModelLabel,
      isPreviewing,
      previewCatalogIsVerified,
      previewProvider,
      previewQuery.data?.models,
      previewQuery.data?.selectedOnlyModels,
      reasoningValue,
    ],
  );
  const previewModelOptions = previewSelection?.modelOptions ?? modelOptions;
  const previewMoreModelOptions =
    previewSelection?.moreModelOptions ?? moreModelOptions;
  useEffect(() => {
    if (
      !previewCatalogIsVerified ||
      !previewProviderId ||
      !previewSelection?.selectedModel
    ) {
      return;
    }
    const provider = previewQuery.data?.providers.find(
      (candidate) => candidate.id === previewProviderId,
    );
    onProviderPreviewResolved?.({
      providerId: previewProviderId,
      model: previewSelection.selectedModel,
      reasoningLevel: previewSelection.reasoningLevel,
      supportsServiceTier: provider?.capabilities.supportsServiceTier ?? false,
    });
  }, [
    onProviderPreviewResolved,
    previewCatalogIsVerified,
    previewProviderId,
    previewQuery.data?.providers,
    previewSelection,
  ]);
  const activeModelLoadError = isPreviewing
    ? (previewQuery.data?.modelLoadError ?? null)
    : (modelLoadError ?? null);
  const activeModelIsLoading = isPreviewing
    ? previewQuery.isLoading
    : modelIsLoading;
  const activeProvider = providerOptions.find(
    (p) => p.value === activeProviderId,
  );
  const activeProviderLabel = activeProvider?.label ?? activeProviderId;
  const activeModelLoadErrorMatches =
    activeModelLoadError?.providerId === activeProviderId;
  const activeModelLoadFailed = isPreviewing
    ? previewQuery.isError || activeModelLoadErrorMatches
    : modelLoadFailed || activeModelLoadErrorMatches;
  const canRestartModelDiscovery =
    activeModelLoadErrorMatches && activeModelLoadError?.canRestart === true;
  const activeModelOptions = canRestartModelDiscovery
    ? EMPTY_MODEL_OPTIONS
    : previewModelOptions;
  const activeMoreModelOptions =
    previewSelectionBlocked || canRestartModelDiscovery
      ? EMPTY_MODEL_OPTIONS
      : previewMoreModelOptions;
  const hasActiveModelOptions = activeModelOptions.length > 0;
  const activeModelErrorIsProviderSpecific =
    activeModelLoadErrorMatches && activeModelLoadError !== null;
  const isShowingModelError =
    !activeModelIsLoading && !hasActiveModelOptions && activeModelLoadFailed;
  const showProviderTabs =
    canSwitchProviders &&
    providerOptions.length > 1 &&
    (!isShowingModelError || activeModelErrorIsProviderSpecific);

  const activeBrandPrefix = activeProvider?.brandPrefix;
  const filteredModelOptions = useMemo(() => {
    if (!isSearching) {
      return activeModelOptions;
    }
    return searchPickerOptions({
      options: [...activeModelOptions, ...activeMoreModelOptions],
      query: searchQuery,
      getLabel: (option) =>
        stripModelBrandPrefix(option.label, activeBrandPrefix),
      getAliases: (option) =>
        option.routeProviderId
          ? [option.routeProviderId, option.value]
          : [option.value],
    });
  }, [
    activeBrandPrefix,
    activeModelOptions,
    activeMoreModelOptions,
    isSearching,
    searchQuery,
  ]);
  const filteredMoreModelOptions = isSearching
    ? EMPTY_MODEL_OPTIONS
    : activeMoreModelOptions;

  const navRows = useMemo(
    () =>
      buildModelNavRows({
        modelOptions: filteredModelOptions,
        moreModelOptions: filteredMoreModelOptions,
        isSearching,
        showMoreModels,
      }),
    [
      filteredModelOptions,
      filteredMoreModelOptions,
      isSearching,
      showMoreModels,
    ],
  );

  const highlightedIndex =
    activeIndex >= 0 && activeIndex < navRows.length ? activeIndex : -1;

  const effectiveShowFastModeToggle =
    showFastModeToggle &&
    !isPreviewing &&
    hasActiveModelOptions &&
    (!serviceTierSupportByProvider ||
      serviceTierSupportByProvider[activeProviderId] === true);
  const effectiveFastModeLabel = isPreviewing
    ? fastServiceTierLabel(previewProvider)
    : (fastModeLabel ?? "Fast");
  const fastModeText = `${effectiveFastModeLabel} mode`;
  const showSelectedFastMode =
    hasSelectedModel && fastModeEnabled && modelOptions.length > 0;

  const resetBrowseState = useCallback(() => {
    setPreviewProviderId(null);
    setShowMoreModels(false);
    setSearchQuery("");
    setActiveIndex(-1);
  }, []);
  const handleMobileContentAnimationEnd = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        resetBrowseState();
      }
    },
    [resetBrowseState],
  );

  const handleModelSelect = useCallback(
    (model: string, close = true) => {
      if (previewSelectionBlocked || lockModelSelection) return;
      if (close) setOpen(false);
      if (onSelectModel) {
        // Same provider: send no level, so an unpicked one stays unset (#656).
        onSelectModel({
          providerId: activeProviderId,
          model,
          ...(isPreviewing
            ? {
                reasoningLevel: resolveModelReasoningLevel(
                  [
                    ...(previewQuery.data?.models ?? []),
                    ...(previewQuery.data?.selectedOnlyModels ?? []),
                  ].find((candidate) => candidate.model === model) ??
                    previewSelection?.activeModel,
                  reasoningValue,
                ),
              }
            : {}),
        });
      } else {
        onModelChange(model);
      }
      setPreviewProviderId(null);
    },
    [
      activeProviderId,
      isPreviewing,
      onModelChange,
      onSelectModel,
      previewQuery.data,
      previewSelection,
      lockModelSelection,
      previewSelectionBlocked,
      reasoningValue,
    ],
  );

  const handleProviderSelect = useCallback(
    (providerId: string) => {
      onSelectedProviderChange?.(providerId);
      const nextPreviewProviderId =
        open && providerId !== selectedProviderId ? providerId : null;
      setPreviewProviderId(nextPreviewProviderId);
      setSearchQuery("");
      setActiveIndex(-1);
    },
    [onSelectedProviderChange, open, selectedProviderId],
  );

  const handleReasoningSelect = useCallback(
    (level: ReasoningLevel) => {
      onReasoningChange(level);
      setPreviewProviderId(null);
    },
    [onReasoningChange],
  );

  const paneContext = useOptionalPaneContext();
  const isFocusedPane = paneContext?.isFocused ?? true;
  const isSplitPane = paneContext?.isSplitPane ?? false;
  const resolveCommandScope = useCallback(
    (target: EventTarget | null): ModelPickerScope => {
      const pickerComposer =
        triggerRef.current?.closest("[data-app-composer]") ?? null;
      const caretComposer =
        target instanceof HTMLElement
          ? target.closest("[data-app-composer]")
          : null;
      const pickerPane =
        triggerRef.current?.closest("[data-split-pane-id]") ?? null;
      const caretPane = caretComposer?.closest("[data-split-pane-id]") ?? null;
      return {
        disabled: disabled ?? false,
        isFocusedPane,
        isSplitPane,
        isPrimaryComposer:
          pickerComposer?.getAttribute("data-app-composer-role") !==
          "secondary",
        caretInThisComposer:
          caretComposer !== null && caretComposer === pickerComposer,
        caretInOtherComposerOfPane:
          caretComposer !== null &&
          caretComposer !== pickerComposer &&
          pickerPane !== null &&
          caretPane === pickerPane,
        editableOutsideComposer:
          caretComposer === null && isEditableKeyboardTarget(target),
      };
    },
    [disabled, isFocusedPane, isSplitPane],
  );
  const anyMenuOpen = open || effortOpen;
  useAppCommandContext(
    "modelPickerOpen",
    commandShortcutsEnabled && anyMenuOpen && !disabled,
  );
  const ownsCycleChord = (target: EventTarget | null): boolean =>
    commandShortcutsEnabled &&
    ownsModelPickerCycleChord({
      open: anyMenuOpen,
      ...resolveCommandScope(target),
    });
  useAppCommandHandler(
    "modelPicker.toggle",
    ({ target }) => {
      if (!commandShortcutsEnabled) return false;
      const action = resolveModelPickerToggle({
        open,
        ...resolveCommandScope(target),
      });
      if (action === "ignore") return false;
      setOpen(action === "open");
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    MODEL_CYCLE_COMMANDS,
    (index, { target }) => {
      if (lockModelSelection || !ownsCycleChord(target)) return false;
      const next =
        index === 0
          ? nextCycleValue(modelOptions, modelValue)
          : previousCycleValue(modelOptions, modelValue);
      if (next !== null) {
        onModelChange(next);
        setPreviewProviderId(null);
      }
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    PROVIDER_CYCLE_COMMANDS,
    (index, { target }) => {
      if (lockModelSelection || !ownsCycleChord(target)) return false;
      if (canSwitchProviders && onSelectedProviderChange !== undefined) {
        const next =
          index === 0
            ? nextCycleValue(providerOptions, selectedProviderId)
            : previousCycleValue(providerOptions, selectedProviderId);
        if (next !== null) {
          handleProviderSelect(next);
        }
      }
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  useIndexedAppCommandHandlers(
    REASONING_CYCLE_COMMANDS,
    (index, { target }) => {
      if (!ownsCycleChord(target)) return false;
      const next = cycleReasoningValue(
        reasoningOptions,
        reasoningValue,
        index === 0 ? "forward" : "backward",
      );
      if (next !== null) {
        onReasoningChange(next);
        setPreviewProviderId(null);
      }
      return true;
    },
    50,
    commandShortcutsEnabled,
  );
  const reasoningIndex = reasoningOptions.findIndex(
    (option) => option.value === reasoningValue,
  );
  const reasoningStepTarget = (delta: 1 | -1) =>
    reasoningIndex < 0 ? undefined : reasoningOptions[reasoningIndex + delta];
  const stepReasoning = (delta: 1 | -1) => {
    const next = reasoningStepTarget(delta);
    if (next) handleReasoningSelect(next.value);
  };
  const handleReasoningArrowKeyDown: KeyboardEventHandler<HTMLElement> = (
    event,
  ) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      disabled ||
      !showEffortControl ||
      isPreviewing ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
    ) {
      return;
    }
    if (
      isEditableKeyboardTarget(event.target) &&
      (event.target !== searchInputRef.current || searchQuery.length > 0)
    ) {
      return;
    }
    if (reasoningIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    stepReasoning(event.key === "ArrowRight" ? 1 : -1);
  };

  const handleQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
    setActiveIndex(-1);
  }, []);

  const handleSearchKeyDown = useCallback<
    KeyboardEventHandler<HTMLInputElement>
  >(
    (event) => {
      const total = navRows.length;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (total === 0) return;
        setActiveIndex((current) => {
          const from = current >= total ? -1 : current;
          return from >= total - 1 ? 0 : from + 1;
        });
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (total === 0) return;
        setActiveIndex((current) => {
          const from = current >= total ? -1 : current;
          return from <= 0 ? total - 1 : from - 1;
        });
        return;
      }

      if (event.key === "Enter") {
        if (highlightedIndex < 0) return;
        const row = navRows[highlightedIndex];
        if (!row) return;
        event.preventDefault();
        if (row.kind === "model") {
          handleModelSelect(row.option.value);
        } else {
          setShowMoreModels((current) => !current);
        }
      }
    },
    [navRows, highlightedIndex, handleModelSelect],
  );

  useEffect(() => {
    if (highlightedIndex < 0) return;
    const el = document.getElementById(`${navId}-opt-${highlightedIndex}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, navId]);

  const TriggerIcon =
    hasSelectedModel || modelIsLoading ? ProviderIcon : undefined;
  const triggerTitleModelLabel = modelIsLoading
    ? "Loading models..."
    : selectedModelLoadFailed
      ? selectedModelLoadErrorText
      : triggerModelLabel;
  const triggerTitle = [
    `${selectedProviderLabel}: ${triggerTitleModelLabel}`,
    showSelectedFastMode ? " (Fast mode)" : "",
  ].join("");
  const halfClassName = cn(
    OPTION_BASE_CLASS_NAME,
    OPTION_INTERACTIVE_CLASS_NAME,
    LIST_HOVER_TRANSITION,
    "h-full rounded-none px-2 first:rounded-l-lg last:rounded-r-lg",
    muted && OPTION_MUTED_CLASS_NAME,
    muted && "font-normal",
    disabled && "cursor-default disabled:opacity-100",
  );
  const chevronColorClassName = muted
    ? "text-subtle-foreground/75"
    : "text-muted-foreground";
  const chevron = disabled ? null : (
    <Icon
      name="ChevronDown"
      className={cn("size-3.5 shrink-0", chevronColorClassName)}
    />
  );
  const showReasoningStepper =
    !disabled && !isPreviewing && reasoningOptions.length > 1;
  // Every level shares one grid cell so the label keeps the widest level's
  // width and the step buttons stay put between clicks.
  const reasoningLabels = showReasoningStepper
    ? [...new Set([reasoningLabel, ...reasoningOptions.map((o) => o.label)])]
    : [reasoningLabel];
  const trigger = (
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      size="sm"
      aria-label={
        toggleShortcut
          ? `Provider and model (${toggleShortcut.label})`
          : "Provider and model"
      }
      aria-keyshortcuts={toggleShortcut?.ariaKeyshortcuts}
      disabled={disabled}
      onKeyDown={handleReasoningArrowKeyDown}
      className={cn(halfClassName, "min-w-0 shrink")}
    >
      <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME} title={triggerTitle}>
        {modelIsLoading ? (
          <>
            {TriggerIcon ? (
              <TriggerIcon className="size-4 shrink-0" />
            ) : (
              <Icon
                name="Spinner"
                className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            )}
            <span className="sr-only">Loading models</span>
            <Skeleton
              aria-hidden
              data-model-loading-placeholder="trigger-model"
              className="h-3 w-10 shrink-0 rounded-sm"
            />
            <Skeleton
              aria-hidden
              data-model-loading-placeholder="trigger-reasoning"
              className="h-3 w-8 shrink-0 rounded-sm"
            />
          </>
        ) : showSelectedFastMode ? (
          <Icon
            name="Zap"
            className="size-3.5 shrink-0 fill-current text-subtle-foreground"
          />
        ) : TriggerIcon ? (
          <TriggerIcon className="size-4 shrink-0" />
        ) : null}
        {modelIsLoading ? null : (
          <>
            <span
              className={cn(
                "min-w-0 truncate",
                triggerModelValueIsDestructive && "text-destructive-text",
              )}
            >
              {triggerModelBase}
            </span>
            {triggerModelTag ? (
              <span className="shrink-0 text-subtle-foreground">
                {triggerModelTag}
              </span>
            ) : null}
          </>
        )}
      </span>
      {showEffortControl ? null : chevron}
      <AppCommandShortcutHint
        shortcut={disabled ? null : toggleShortcut}
        className="ml-1"
      />
    </Button>
  );

  const effortTrigger = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Reasoning effort: ${reasoningLabel}`}
      aria-keyshortcuts={reasoningShortcut?.ariaKeyshortcuts}
      disabled={disabled}
      onKeyDown={handleReasoningArrowKeyDown}
      className={cn(halfClassName, "min-w-0 shrink-[0.001] rounded-r-lg")}
    >
      <span
        className="grid min-w-0 text-left text-subtle-foreground"
        title={`Reasoning effort: ${reasoningLabel}`}
      >
        {reasoningLabels.map((label) => (
          <span
            key={label}
            aria-hidden={label === reasoningLabel ? undefined : true}
            className={cn(
              "col-start-1 row-start-1 min-w-0 truncate",
              label !== reasoningLabel && "invisible pointer-coarse:hidden",
            )}
          >
            {label}
          </span>
        ))}
      </span>
    </Button>
  );

  const renderSplit = (modelPart: ReactNode) => (
    <div
      className={cn(
        "group/model-effort inline-flex h-8 min-w-0 max-w-full items-center rounded-lg",
        className,
      )}
    >
      {modelPart}
      {providerLogin.drawer}
      {showEffortControl ? (
        <>
          <span aria-hidden className="h-4 w-px shrink-0 bg-foreground/10" />
          {disabled ? (
            effortTrigger
          ) : (
            <ReasoningEffortMenu
              open={effortOpen}
              onOpenChange={setEffortOpen}
              modal={modal}
              align={align}
              value={reasoningValue}
              options={reasoningOptions}
              shortcut={reasoningShortcut}
              onSelect={handleReasoningSelect}
            >
              {effortTrigger}
            </ReasoningEffortMenu>
          )}
          {showReasoningStepper ? (
            <ReasoningStepButtons
              colorClassName={chevronColorClassName}
              canLower={reasoningStepTarget(-1) !== undefined}
              canRaise={reasoningStepTarget(1) !== undefined}
              lowerShortcut={reasoningBackwardShortcut}
              raiseShortcut={reasoningShortcut}
              onStep={stepReasoning}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );

  if (disabled) {
    return renderSplit(trigger);
  }

  const showSearchInput =
    !lockModelSelection &&
    hasActiveModelOptions &&
    !activeModelIsLoading &&
    !isShowingModelError &&
    activeModelOptions.length + activeMoreModelOptions.length >
      MODEL_SEARCH_MIN_OPTIONS;

  return renderSplit(
    <Popover open={open} onOpenChange={setOpen} modal={modal}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={isCompactViewport ? undefined : 6}
        mobileTitle="Model"
        mobileClassName={cn(FLOATING_DRAWER_CLASS_NAME, "border-foreground/10 bg-composer")}
        onKeyDown={handleReasoningArrowKeyDown}
        onMobileContentAnimationEnd={handleMobileContentAnimationEnd}
        autoFocusRef={
          showSearchInput ? searchInputRef : showProviderTabs ? activeHarnessRef : undefined
        }
        className={cn(
          "group/model-picker flex min-h-0 flex-col",
          isCompactViewport
            ? cn(
                "w-[19rem] overflow-y-hidden [--model-row-height:42px]",
                COMPACT_SHEET_PADDING_CLASS_NAME,
              )
            : cn(
                "max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] w-80 max-w-[calc(100vw-1rem)] overflow-hidden p-0 [--model-row-height:1.75rem]",
                QUIET_SURFACE_CLASS_NAME,
                // Opening upward, a fixed height keeps the harness row still.
                !lockModelSelection && "data-[side=top]:h-[16.5rem]",
              ),
        )}
      >
        <ResetBrowseStateOnContentUnmount onReset={resetBrowseState} />
        <div className="flex min-h-0 flex-1 flex-col">
          {showProviderTabs ? (
            <ModelPickerHarnessStrip
              options={providerOptions}
              activeId={activeProviderId}
              activeButtonRef={activeHarnessRef}
              onSelect={handleProviderSelect}
            >
              {inRouter && <ConnectHarnessButton onClose={() => setOpen(false)} />}
            </ModelPickerHarnessStrip>
          ) : null}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {showSearchInput ? (
              <ModelSearchInput
                inputRef={searchInputRef}
                query={searchQuery}
                onQueryChange={handleQueryChange}
                onKeyDown={handleSearchKeyDown}
                listboxId={listboxId}
                activeOptionId={
                  highlightedIndex >= 0
                    ? optionDomId(highlightedIndex)
                    : undefined
                }
              />
            ) : null}

            <MenuHoverProvider>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {lockModelSelection ? (
                  <div className="flex h-10 shrink-0 items-center gap-2 px-3 text-xs">
                    {TriggerIcon ? (
                      <TriggerIcon className="size-4 shrink-0" />
                    ) : null}
                    <span className="min-w-0 truncate font-medium">
                      {triggerModelBase}
                      {triggerModelTag ? (
                        <span className="ml-1.5 font-normal text-subtle-foreground">
                          {triggerModelTag}
                        </span>
                      ) : null}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-subtle-foreground">
                      Fixed in this thread
                      <Icon name="Lock" className="size-3" aria-hidden />
                    </span>
                  </div>
                ) : (
                  <div
                    ref={listRef}
                    key={activeProviderId || "no-provider"}
                    role={showSearchInput ? "listbox" : undefined}
                    id={showSearchInput ? listboxId : undefined}
                    aria-label={showSearchInput ? "Models" : undefined}
                    onScroll={isCompactViewport ? undefined : listFade.measure}
                    style={isCompactViewport ? undefined : listFade.style}
                    className={cn(
                      "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain [scrollbar-width:thin]",
                      isCompactViewport
                        ? cn(
                            "my-1 px-0",
                            hasActiveModelOptions && !activeModelIsLoading && FIVE_MODEL_ROWS,
                          )
                        : cn(
                            "px-1.5 pb-1.5 group-data-[side=top]/model-picker:max-h-none",
                            !showSearchInput &&
                              (!showProviderTabs
                                ? "pt-1.5"
                                : hasActiveModelOptions && !activeModelIsLoading
                                  ? "pt-1"
                                  : undefined),
                            // Five rows plus the bottom padding, then scroll.
                            hasActiveModelOptions &&
                              !activeModelIsLoading &&
                              "max-h-[calc(5*var(--model-row-height)+0.5rem)] [&>button]:h-(--model-row-height) [&>button]:shrink-0",
                          ),
                    )}
                  >
                    {activeModelIsLoading ? (
                      <PickerLoadingRows
                        label="Loading models"
                        rowDataAttribute="data-model-loading-row"
                      />
                    ) : hasActiveModelOptions ? (
                      <>
                        {navRows.map((row, index) => {
                          const active = highlightedIndex === index;
                          const domId = optionDomId(index);
                          if (row.kind === "more-toggle") {
                            return (
                              <MoreModelsToggleRow
                                key="more-toggle"
                                id={domId}
                                isActive={active}
                                expanded={showMoreModels}
                                onToggle={() =>
                                  setShowMoreModels((current) => !current)
                                }
                              />
                            );
                          }
                          const option = row.option;
                          return (
                            <MenuRowButton
                              key={option.value}
                              id={domId}
                              role={showSearchInput ? "option" : undefined}
                              isActive={active}
                              label={stripModelBrandPrefix(
                                option.label,
                                activeBrandPrefix,
                              )}
                              qualifier={option.routeProviderId}
                              selected={
                                !isPreviewing && option.value === modelValue
                              }
                              disabled={previewSelectionBlocked}
                              onClick={() => handleModelSelect(option.value)}
                            />
                          );
                        })}
                        {isSearching && navRows.length === 0 ? (
                          <div
                            className={cn(
                              "px-2 text-xs",
                              isCompactViewport
                                ? "py-2 text-muted-foreground"
                                : "py-1.5 text-subtle-foreground",
                            )}
                          >
                            No models match your search
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <ModelUnavailable
                        key={`${activeProviderId}:${providerRouting?.environmentId ?? providerRouting?.hostId ?? "primary"}`}
                        providerId={activeProviderId}
                        providerLabel={activeProviderLabel}
                        {...(activeProvider?.icon === undefined
                          ? {}
                          : { providerIcon: activeProvider.icon })}
                        routing={providerRouting}
                        error={
                          activeModelLoadErrorMatches
                            ? activeModelLoadError
                            : null
                        }
                        failed={activeModelLoadFailed}
                        {...(activeProvider?.installUrl === undefined
                          ? {}
                          : { installUrl: activeProvider.installUrl })}
                        {...(activeProvider?.signInCommand === undefined
                          ? {}
                          : {
                              signInCommand: activeProvider.signInCommand,
                              onSignIn: () => {
                                setOpen(false);
                                loginProviderId.current = activeProviderId;
                                providerLogin.start(
                                  activeProvider.signInCommand!,
                                  activeProviderLabel,
                                );
                              },
                            })}
                        {...(activeProvider?.signInHint === undefined
                          ? {}
                          : { signInHint: activeProvider.signInHint })}
                      />
                    )}
                  </div>
                )}

                {effectiveShowFastModeToggle ? (
                  isCompactViewport ? (
                    <>
                      <div className="shrink-0 border-t border-foreground/10" />
                      <div className="shrink-0 p-1">
                        <label className="flex min-h-6 cursor-pointer items-center justify-between gap-3 rounded-sm px-2 text-xs text-muted-foreground">
                          <span className="flex min-w-0 items-center gap-2">
                            <Icon
                              name="Zap"
                              className="size-3.5 fill-current text-muted-foreground"
                            />
                            <span>{fastModeText}</span>
                          </span>
                          <Switch
                            checked={fastModeEnabled}
                            onCheckedChange={onFastModeChange}
                            aria-label={fastModeText}
                            className={cn(
                              LIST_HOVER_TRANSITION,
                              "focus-visible:ring-foreground/50 data-[state=unchecked]:bg-foreground/15 data-[state=checked]:border-transparent data-[state=checked]:bg-foreground/60 [&>span]:size-3.5 [&>span]:bg-background",
                            )}
                          />
                        </label>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="h-px shrink-0 bg-foreground/[0.07]" />
                      <label className="flex h-9 shrink-0 cursor-pointer items-center gap-2 px-3 text-xs text-muted-foreground">
                        <Icon name="Zap" className="size-3.5 fill-current" />
                        <span className="mr-auto">{fastModeText}</span>
                        <Switch
                          checked={fastModeEnabled}
                          onCheckedChange={onFastModeChange}
                          aria-label={fastModeText}
                          className={cn(LIST_HOVER_TRANSITION, "[&>span]:size-3.5")}
                        />
                      </label>
                    </>
                  )
                ) : null}
              </div>
            </MenuHoverProvider>
          </div>
        </div>
      </PopoverContent>
    </Popover>,
  );
}

function MoreModelsToggleRow({
  expanded,
  onToggle,
  isActive,
  id,
}: {
  expanded: boolean;
  onToggle: () => void;
  isActive?: boolean;
  id?: string;
}) {
  const { hoverProps } = useMenuItemHover();
  const isCompactViewport = useIsCompactViewport();
  return (
    <button
      type="button"
      id={id}
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-1 px-2 text-xs outline-none hover:bg-state-hover hover:text-foreground",
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        isActive && "bg-state-active text-foreground",
        isCompactViewport
          ? cn(COMPACT_ROW_CLASS_NAME, "text-muted-foreground")
          : "rounded-lg text-subtle-foreground",
      )}
      {...hoverProps}
    >
      <span>{expanded ? "Fewer models" : "More models"}</span>
      <Icon
        name={expanded ? "ChevronUp" : "ChevronDown"}
        className="size-3.5 shrink-0"
      />
    </button>
  );
}

function ResetBrowseStateOnContentUnmount({
  onReset,
}: {
  onReset: () => void;
}) {
  useEffect(() => onReset, [onReset]);
  return null;
}

function MenuRowButton({
  label,
  qualifier,
  selected,
  disabled = false,
  onClick,
  isActive,
  id,
  role,
}: {
  label: string;
  qualifier?: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  isActive?: boolean;
  id?: string;
  role?: React.AriaRole;
}) {
  const { hoverProps } = useMenuItemHover();
  const isCompactViewport = useIsCompactViewport();
  const { base, tag } = splitModelLabelTag(label);
  return (
    <button
      type="button"
      id={id}
      role={role}
      disabled={disabled}
      aria-selected={role === "option" ? Boolean(isActive) : undefined}
      onClick={onClick}
      className={cn(
        "relative flex w-full cursor-default select-none items-center justify-between gap-3 px-2 text-xs outline-none hover:bg-state-hover hover:text-foreground",
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        isActive && "bg-state-active text-foreground",
        disabled && "cursor-not-allowed opacity-60",
        isCompactViewport
          ? cn(COMPACT_ROW_CLASS_NAME, selected && "bg-foreground/5 font-medium")
          : cn("rounded-lg", selected ? "text-foreground" : "text-muted-foreground"),
      )}
      {...hoverProps}
    >
      <span
        className="truncate"
        title={qualifier ? `${label} · ${qualifier}` : label}
      >
        {base}
        {tag ? (
          <span className="ml-1.5 text-subtle-foreground">{tag}</span>
        ) : null}
        {qualifier ? (
          <span className="ml-1.5 text-subtle-foreground">{qualifier}</span>
        ) : null}
      </span>
      <Icon
        name="Check"
        className={cn(
          COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
          isCompactViewport ? "text-muted-foreground" : "text-foreground",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}

function ReasoningEffortMenu({
  open,
  onOpenChange,
  modal,
  align,
  value,
  options,
  shortcut,
  onSelect,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modal: boolean;
  align: "start" | "center" | "end";
  value: ReasoningLevel;
  options: readonly PickerOption<ReasoningLevel>[];
  shortcut: AppShortcutPresentation | null;
  onSelect: (value: ReasoningLevel) => void;
  children: ReactNode;
}) {
  const isCompactViewport = useIsCompactViewport();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={modal}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        mobileTitle="Effort"
        mobileClassName={FLOATING_DRAWER_CLASS_NAME}
        sideOffset={isCompactViewport ? undefined : 6}
        className={cn(
          "min-w-36",
          isCompactViewport
            ? COMPACT_SHEET_PADDING_CLASS_NAME
            : cn("p-1.5", QUIET_SURFACE_CLASS_NAME),
        )}
      >
        <DropdownMenuLabel className="font-normal text-subtle-foreground">
          Effort
        </DropdownMenuLabel>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <DropdownMenuItem
              key={option.value}
              role="menuitemradio"
              aria-checked={selected}
              onSelect={() => onSelect(option.value)}
              className={cn(
                isCompactViewport
                  ? cn(
                      COMPACT_ROW_CLASS_NAME,
                      selected && COMPACT_SELECTED_ROW_CLASS_NAME,
                    )
                  : cn(
                      "justify-between gap-3 rounded-lg py-1.5",
                      selected ? "text-foreground" : "text-muted-foreground",
                    ),
              )}
            >
              {option.label}
              {isCompactViewport ? null : (
                <Icon
                  name="Check"
                  className={cn(
                    "size-3.5 shrink-0 text-foreground",
                    selected ? "opacity-100" : "opacity-0",
                  )}
                />
              )}
            </DropdownMenuItem>
          );
        })}
        {shortcut ? (
          <>
            <DropdownMenuSeparator
              className={isCompactViewport ? undefined : "bg-foreground/[0.07]"}
            />
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-subtle-foreground">
              Cycle
              <AppCommandShortcutPill shortcut={shortcut} ariaHidden={false} />
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Hidden until the model picker is hovered; no layout shift because the
// buttons keep their space. Keyboard uses ←/→, touch uses the effort menu.
function ReasoningStepButtons({
  colorClassName,
  canLower,
  canRaise,
  lowerShortcut,
  raiseShortcut,
  onStep,
}: {
  colorClassName: string;
  canLower: boolean;
  canRaise: boolean;
  lowerShortcut: AppShortcutPresentation | null;
  raiseShortcut: AppShortcutPresentation | null;
  onStep: (delta: 1 | -1) => void;
}) {
  const steps = [
    {
      delta: -1,
      verb: "Lower",
      icon: "ChevronDown",
      enabled: canLower,
      shortcut: lowerShortcut,
    },
    {
      delta: 1,
      verb: "Raise",
      icon: "ChevronUp",
      enabled: canRaise,
      shortcut: raiseShortcut,
    },
  ] as const;
  return (
    <TooltipProvider delayDuration={300}>
      <span className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity duration-100 group-hover/model-effort:opacity-100 motion-reduce:transition-none pointer-coarse:hidden">
        {steps.map((step) => (
          <Tooltip key={step.verb}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                tabIndex={-1}
                aria-label={`${step.verb} reasoning effort`}
                aria-keyshortcuts={step.shortcut?.ariaKeyshortcuts}
                disabled={!step.enabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onStep(step.delta)}
                className={cn("h-6 w-5.5 px-0", colorClassName)}
              >
                <Icon name={step.icon} className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {step.shortcut
                ? `${step.verb} effort (${step.shortcut.label})`
                : `${step.verb} effort`}
            </TooltipContent>
          </Tooltip>
        ))}
      </span>
    </TooltipProvider>
  );
}

function ConnectHarnessButton({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Connect agent"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            void navigate(getSettingsRoutePath("providers"));
          }}
          className="group/connect flex h-8 w-7 shrink-0 items-center justify-center text-subtle-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none pointer-coarse:size-10"
        >
          <span className="flex size-5 items-center justify-center rounded-md bg-foreground/5 group-hover/connect:bg-foreground/10 group-focus-visible/connect:bg-foreground/10 pointer-coarse:size-7">
            <Icon name="Plus" className="size-3" aria-hidden />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">Connect agent</TooltipContent>
    </Tooltip>
  );
}

interface ModelSearchInputProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  listboxId: string;
  activeOptionId: string | undefined;
}

function ModelSearchInput({
  inputRef,
  query,
  onQueryChange,
  onKeyDown,
  listboxId,
  activeOptionId,
}: ModelSearchInputProps) {
  const isCompactViewport = useIsCompactViewport();
  const input = (
    <Input
      ref={inputRef}
      value={query}
      onChange={(event) => onQueryChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Search models"
      aria-label="Search models"
      role="combobox"
      aria-expanded
      aria-controls={listboxId}
      aria-autocomplete="list"
      aria-activedescendant={activeOptionId}
      className={
        isCompactViewport
          ? "h-10 rounded-full border-transparent bg-surface-recessed pl-10 pr-4 text-xs text-foreground shadow-none placeholder:text-subtle-foreground focus-visible:ring-0"
          : "h-7 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-xs text-foreground shadow-none placeholder:text-subtle-foreground focus-visible:ring-0 dark:bg-transparent"
      }
    />
  );
  if (!isCompactViewport) {
    return (
      <label className="flex h-8 shrink-0 items-center gap-2 px-3">
        <Icon name="Search" className="size-3.5 shrink-0 text-subtle-foreground" />
        {input}
      </label>
    );
  }
  return (
    <div className="shrink-0 pt-2.5">
      <div className="relative">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        {input}
      </div>
    </div>
  );
}
