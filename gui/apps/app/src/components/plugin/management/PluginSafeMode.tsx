import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import { appToast } from "@/components/ui/app-toast";
import {
  applyPluginSafeMode,
  invalidatePluginList,
} from "@/hooks/cache-owners/plugin-cache-owner";
import {
  setPluginSafeMode,
  usePluginSafeMode,
} from "@/hooks/queries/plugin-settings-queries";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";

// Safe mode stops every plugin that doesn't ship with Cloudroom, so a broken
// plugin can be ruled out in one click. Turning it off restores the rest.
function usePluginSafeModeToggle() {
  const queryClient = useQueryClient();
  const safeMode = usePluginSafeMode().data;
  const toggle = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (enabled: boolean) => setPluginSafeMode(fetch, enabled),
    onSuccess: (result) => {
      applyPluginSafeMode({ queryClient, enabled: result.enabled });
      if (result.problems.length > 0) {
        appToast.warning("Some plugins did not start", {
          description: result.problems.join("\n"),
        });
      } else {
        appToast.success(
          result.enabled ? "Plugin safe mode is on" : "Plugin safe mode is off",
        );
      }
    },
    onError: (error, enabled) => {
      appToast.error(
        `Failed to turn ${enabled ? "on" : "off"} plugin safe mode`,
        { description: pluginAdminErrorMessage(error) },
      );
    },
    onSettled: () => invalidatePluginList({ queryClient }),
  });
  return { safeMode, toggle };
}

export function PluginSafeModeButton() {
  const { safeMode, toggle } = usePluginSafeModeToggle();
  if (safeMode !== false) return null;
  const label = "Turn on safe mode: stop every plugin that doesn't ship with Cloudroom";
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid="plugin-safe-mode-on"
            className="size-8 shrink-0 rounded-md border border-input bg-background p-0 text-muted-foreground"
            aria-label={label}
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(true)}
          >
            <Icon
              name={toggle.isPending ? "Spinner" : "SecurityCheck"}
              className={toggle.isPending ? "size-4 animate-spin" : "size-4"}
              aria-hidden
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PluginSafeModeBanner() {
  const { safeMode, toggle } = usePluginSafeModeToggle();
  if (safeMode !== true) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
    >
      <Icon name="SecurityCheck" className="size-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1 text-sm text-foreground">
        Plugin safe mode is on. Only plugins that ship with Cloudroom are running.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(false)}
      >
        {toggle.isPending ? "Turning off…" : "Turn off"}
      </Button>
    </div>
  );
}
