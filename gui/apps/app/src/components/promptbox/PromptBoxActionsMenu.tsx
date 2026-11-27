import { useCallback, useRef } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { FLOATING_DRAWER_CLASS_NAME } from "@cloudroom/shared-ui/responsive-overlay";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import {
  PluginComposerPlusMenuEntry,
  type PluginComposerPlusMenuContribution,
  type PluginComposerPlusMenuSelection,
} from "@/components/plugin/PluginComposerActions";
import { useResolvedComposerPlusMenuItems } from "@/components/plugin/composer-slot-hooks";
import { useOptionalPluginComposerView } from "@/components/plugin/plugin-composer-host";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import { CREATE_PLUGIN_PROMPT } from "@cloudroom/client-core";
import type { ProviderPromptActionCommand } from "@cloudroom/client-core";

// Mobile sheet: same floating drawer and spacing as the Model, Effort, and Environment pickers.
const COMPACT_SHEET_PADDING_CLASS_NAME =
  "gap-0 px-3.5 pt-0 pb-[max(1.5rem,env(safe-area-inset-bottom))]";
const COMPACT_SEPARATOR_CLASS_NAME = "mx-4 my-2 shrink-0 bg-border";
const COMPACT_ATTACH_ROW_CLASS_NAME =
  "mb-1 min-h-[54px] gap-3.5 rounded-[18px] bg-composer px-4 py-2.5 text-[17px] font-medium text-foreground shadow-message [&>[data-icon-root]]:!size-[22px]";
const COMPACT_ACTION_ROW_CLASS_NAME =
  "min-h-[50px] gap-3.5 rounded-[18px] px-4 py-2.5 text-[17px] text-foreground data-[disabled]:opacity-40 [&>[data-icon-root]]:!size-[22px]";
const COMPACT_PLUGIN_ROW_CLASS_NAME = cn(
  COMPACT_ACTION_ROW_CLASS_NAME,
  "data-[disabled]:order-1",
);

type PromptBoxActionKind = "skills" | "plan" | "goal" | "automation" | "plugin";

export interface PromptBoxAction {
  kind: PromptBoxActionKind;
  text: string;
  command?: ProviderPromptActionCommand;
}

interface PromptBoxActionsMenuProps {
  actions?: readonly PromptBoxAction[];
  isAttaching?: boolean;
  onAttach?: () => void;
  /** Attaches the copied image. Shown only where a keyboard paste cannot do it. */
  onPasteImage?: () => void;
  onAction: (action: PromptBoxAction) => void;
  pluginItems?: readonly PluginComposerPlusMenuContribution[];
}

export function ComposerPlusMenuSlot({
  includePluginContributions = true,
  ...props
}: Omit<PromptBoxActionsMenuProps, "pluginItems"> & {
  includePluginContributions?: boolean;
}) {
  const view = useOptionalPluginComposerView();
  const pluginItems = useResolvedComposerPlusMenuItems(
    includePluginContributions ? (view?.scope.kind ?? null) : null,
  );
  return <PromptBoxActionsMenu {...props} pluginItems={pluginItems} />;
}

export const AUTOMATION_PROMPT_ACTION: PromptBoxAction = {
  kind: "automation",
  command: { trigger: "/", name: "loop", trailingText: " " },
  text: "/loop ",
};

export const CREATE_PLUGIN_PROMPT_ACTION: PromptBoxAction = {
  kind: "plugin",
  text: CREATE_PLUGIN_PROMPT,
};

const PROMPT_ACTION_ORDER: readonly PromptBoxActionKind[] = [
  "skills",
  "plan",
  "goal",
  "automation",
  "plugin",
];

const PROMPT_ACTION_PRESENTATION = {
  skills: {
    label: "Skills",
    icon: "Zap",
  },
  plan: {
    label: "Plan",
    icon: "ListTodo",
  },
  goal: {
    label: "Goal",
    icon: "Target",
  },
  automation: {
    label: "Loop",
    icon: "Repeat",
  },
  plugin: {
    label: "Plugin",
    icon: "Plug02",
  },
} as const satisfies Record<
  PromptBoxActionKind,
  { label: string; icon: IconName }
>;

export function withAppPromptActions(
  actions: readonly PromptBoxAction[],
): PromptBoxAction[] {
  const appActions = [AUTOMATION_PROMPT_ACTION, CREATE_PLUGIN_PROMPT_ACTION];
  return [
    ...actions,
    ...appActions.filter(
      (appAction) => !actions.some((action) => action.kind === appAction.kind),
    ),
  ];
}

function orderedPromptActions(
  actions: readonly PromptBoxAction[],
): PromptBoxAction[] {
  return PROMPT_ACTION_ORDER.flatMap((kind) => {
    const action = actions.find((candidate) => candidate.kind === kind);
    return action ? [action] : [];
  });
}

export function PromptBoxActionsMenu({
  actions = [],
  isAttaching = false,
  onAttach,
  onPasteImage,
  onAction,
  pluginItems = [],
}: PromptBoxActionsMenuProps) {
  const selectedItemRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pluginSelectionRef = useRef<PluginComposerPlusMenuSelection | null>(
    null,
  );
  const visibleActions = orderedPromptActions(actions).filter(
    (action) => action.text.length > 0,
  );
  const clearSelectedActionAfterClose = useCallback(() => {
    const clear = () => {
      selectedItemRef.current = false;
      pluginSelectionRef.current = null;
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(clear);
      return;
    }
    setTimeout(clear, 0);
  }, []);
  const restorePluginComposerFocus = useCallback(
    (selection: PluginComposerPlusMenuSelection) => {
      const activeElement = document.activeElement;
      const pluginMovedFocus =
        activeElement !== null &&
        activeElement !== document.body &&
        activeElement !== triggerRef.current &&
        activeElement !== selection.selectedElement &&
        activeElement.isConnected;
      if (!pluginMovedFocus) {
        selection.restoreComposerFocus();
      }
    },
    [],
  );

  const isCompactViewport = useIsCompactViewport();

  if (visibleActions.length === 0 && !onAttach && pluginItems.length === 0) {
    return null;
  }

  const pluginEntries = pluginItems.map((contribution) => (
    <PluginComposerPlusMenuEntry
      key={contribution.key}
      contribution={contribution}
      className={isCompactViewport ? COMPACT_PLUGIN_ROW_CLASS_NAME : undefined}
      iconClassName={isCompactViewport ? "text-muted-foreground" : undefined}
      onSelected={(selection) => {
        selectedItemRef.current = true;
        pluginSelectionRef.current = selection;
        queueMicrotask(() => restorePluginComposerFocus(selection));
      }}
    />
  ));

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          clearSelectedActionAfterClose();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Prompt actions"
          className={cn(
            COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
            CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            "-ml-1.5",
            "max-md:pointer-coarse:size-11 max-md:pointer-coarse:rounded-full max-md:pointer-coarse:px-0 max-md:pointer-coarse:text-foreground max-md:pointer-coarse:[&_[data-icon-root]]:size-6 max-md:pointer-coarse:[&_[data-icon-root]_path]:stroke-[1.75]",
          )}
        >
          <Icon name="Plus" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="Prompt actions"
        align="start"
        side="bottom"
        sideOffset={4}
        className={cn(
          "w-36",
          isCompactViewport && COMPACT_SHEET_PADDING_CLASS_NAME,
        )}
        mobileTitle="Add to message"
        mobileClassName={FLOATING_DRAWER_CLASS_NAME}
        onCloseAutoFocus={(event) => {
          if (selectedItemRef.current) {
            event.preventDefault();
            const pluginSelection = pluginSelectionRef.current;
            if (pluginSelection) {
              restorePluginComposerFocus(pluginSelection);
            }
          }
        }}
      >
        {isCompactViewport ? (
          <div className="shrink-0 px-4 pt-1 pb-2 text-sm text-subtle-foreground">
            Add to message
          </div>
        ) : null}
        {onAttach ? (
          <>
            <DropdownMenuItem
              disabled={isAttaching}
              className={
                isCompactViewport ? COMPACT_ATTACH_ROW_CLASS_NAME : undefined
              }
              onSelect={() => {
                selectedItemRef.current = true;
                onAttach();
              }}
            >
              <Icon
                name={isAttaching ? "Spinner" : "Paperclip"}
                className={cn(
                  isCompactViewport
                    ? "text-primary"
                    : "size-4 text-muted-foreground",
                  isAttaching && "animate-spin",
                )}
                aria-hidden
              />
              Attach files
            </DropdownMenuItem>
            {onPasteImage ? (
              <DropdownMenuItem
                disabled={isAttaching}
                className={
                  isCompactViewport ? COMPACT_ACTION_ROW_CLASS_NAME : undefined
                }
                onSelect={() => {
                  selectedItemRef.current = true;
                  onPasteImage();
                }}
              >
                <Icon
                  name="Image"
                  className={cn(
                    "text-muted-foreground",
                    !isCompactViewport && "size-4",
                  )}
                  aria-hidden
                />
                Paste image
              </DropdownMenuItem>
            ) : null}
            {visibleActions.length > 0 && !isCompactViewport ? (
              <DropdownMenuSeparator />
            ) : null}
          </>
        ) : null}
        {visibleActions.map((action) => {
          const presentation = PROMPT_ACTION_PRESENTATION[action.kind];
          return (
            <DropdownMenuItem
              key={action.kind}
              className={
                isCompactViewport ? COMPACT_ACTION_ROW_CLASS_NAME : undefined
              }
              onSelect={() => {
                selectedItemRef.current = true;
                onAction(action);
              }}
            >
              <Icon
                name={presentation.icon}
                className={cn(
                  "text-muted-foreground",
                  !isCompactViewport && "size-4",
                )}
                aria-hidden
              />
              {presentation.label}
            </DropdownMenuItem>
          );
        })}
        {pluginItems.length > 0 && (onAttach || visibleActions.length > 0) ? (
          <DropdownMenuSeparator
            className={
              isCompactViewport ? COMPACT_SEPARATOR_CLASS_NAME : undefined
            }
          />
        ) : null}
        {isCompactViewport && pluginItems.length > 0 ? (
          <div className="flex flex-col">{pluginEntries}</div>
        ) : (
          pluginEntries
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
