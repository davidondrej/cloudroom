import { memo } from "react";
import { OptionDisplay } from "@cloudroom/shared-ui/option-display";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import type { WorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import {
  MachineLabel,
  type MachineLabelHost,
} from "@/components/machines/MachineLabel";
import type { MachineProviderPresentation } from "@/components/plugin/MachineProviderIcon";

const CHECKOUT_CHIP_BASE_CLASS_NAME =
  "flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground";
const CHECKOUT_CHIP_BUTTON_CLASS_NAME = `${CHECKOUT_CHIP_BASE_CLASS_NAME} cursor-pointer transition-colors hover:bg-state-hover hover:text-foreground`;

interface ThreadEnvironmentSummaryProps {
  projectName?: string;
  environmentLabel?: string;
  environmentCompactLabel?: string;
  environmentIcon?: IconName;
  environmentProviderName?: string;
  environmentHost?: MachineLabelHost;
  environmentMachineProvider?: MachineProviderPresentation | null;
  environmentCheckout?: WorkspaceCheckoutDisplay;
  onCreateNewThreadInEnvironment?: () => void;
  onTeleportToCloud?: () => void;
  onTeleportToLocal?: () => void;
}

export const ThreadEnvironmentSummary = memo(function ThreadEnvironmentSummary({
  projectName,
  environmentLabel,
  environmentCompactLabel,
  environmentIcon,
  environmentProviderName,
  environmentHost,
  environmentMachineProvider,
  environmentCheckout,
  onCreateNewThreadInEnvironment,
  onTeleportToCloud,
  onTeleportToLocal,
}: ThreadEnvironmentSummaryProps) {
  if (
    !projectName &&
    !environmentLabel &&
    !environmentHost &&
    !environmentCheckout &&
    !onCreateNewThreadInEnvironment
  ) {
    return null;
  }

  const checkoutCopyValue = environmentCheckout?.copyValue ?? null;
  const staleDot = environmentCheckout?.stale ? (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
  ) : null;
  const environmentNode = environmentHost ? (
    <MachineLabel
      host={environmentHost}
      machineProvider={environmentMachineProvider}
      className="h-6 w-fit max-w-full shrink px-1 text-xs leading-tight text-muted-foreground"
      iconClassName="size-4"
    />
  ) : environmentLabel ? (
    <div className="inline-flex h-6 w-fit max-w-full min-w-0 shrink items-center justify-start gap-1.5 px-1 text-xs leading-tight text-muted-foreground">
      {environmentIcon &&
      environmentProviderName &&
      environmentProviderName !== environmentLabel ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              tabIndex={0}
              aria-label={environmentProviderName}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Icon name={environmentIcon} className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{environmentProviderName}</TooltipContent>
        </Tooltip>
      ) : environmentIcon ? (
        <Icon
          name={environmentIcon}
          className={cn(
            "size-4 shrink-0",
            environmentIcon === "Loading" && "animate-spin",
          )}
        />
      ) : null}
      <OptionDisplay
        label="Environment"
        value={environmentLabel}
        compactValue={environmentCompactLabel}
        className="h-6 min-w-0 shrink px-0"
      />
    </div>
  ) : null;
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2 pr-1.5">
      {projectName ? (
        <OptionDisplay
          label="Project"
          value={projectName}
          compactValue={projectName}
          leading={<Icon name="Folder" className="size-4 shrink-0" />}
          className="h-6 min-w-0 max-w-[10rem] shrink"
        />
      ) : null}
      {environmentNode && (onTeleportToCloud || onTeleportToLocal) ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Environment actions"
              className="inline-flex min-w-0 shrink cursor-pointer rounded-md transition-colors hover:bg-state-hover"
            >
              {environmentNode}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={4}>
            {onTeleportToCloud ? (
              <DropdownMenuItem onSelect={onTeleportToCloud}>
                <Icon
                  name="Cloud"
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                Teleport to Cloud
              </DropdownMenuItem>
            ) : null}
            {onTeleportToLocal ? (
              <DropdownMenuItem onSelect={onTeleportToLocal}>
                <Icon
                  name="Laptop"
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                Teleport to Local
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        environmentNode
      )}
      {environmentCheckout && checkoutCopyValue !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-promptbox-hide-branch-compact=""
              className={CHECKOUT_CHIP_BUTTON_CLASS_NAME}
              onClick={() => {
                void copyToClipboardWithToast(checkoutCopyValue, {
                  successMessage:
                    environmentCheckout.copySuccessMessage ?? "Value copied",
                  errorMessage:
                    environmentCheckout.copyErrorMessage ??
                    "Failed to copy value",
                });
              }}
            >
              <Icon name="GitBranch" className="size-3.5 shrink-0" />
              <span className="truncate">{environmentCheckout.label}</span>
              {staleDot}
            </button>
          </TooltipTrigger>
          <TooltipContent>{environmentCheckout.title}</TooltipContent>
        </Tooltip>
      ) : environmentCheckout ? (
        <span
          data-promptbox-hide-branch-compact=""
          className={CHECKOUT_CHIP_BASE_CLASS_NAME}
          title={environmentCheckout.title}
        >
          <Icon name="GitBranch" className="size-3.5 shrink-0" />
          <span className="truncate">{environmentCheckout.label}</span>
          {staleDot}
        </span>
      ) : null}
      {onCreateNewThreadInEnvironment ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="New thread in this environment"
              onClick={onCreateNewThreadInEnvironment}
              className={cn(
                "-ml-1 inline-flex cursor-pointer shrink-0 items-center justify-center rounded-md px-1 py-0.5 transition-colors hover:bg-state-hover",
                CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
              )}
            >
              <Icon name="MessageSquarePlus" className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>New thread in this environment</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
});
