import { COMPUTER, COMPUTER_TITLE } from "@cloudroom/domain";
import type { MacAccessLevel } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";

export const MAC_ACCESS_LEVELS: { id: MacAccessLevel; label: string; description: string; icon: string; dot: string }[] = [
  { id: "off", label: "Off", description: `Cloud agents can't touch this ${COMPUTER}.`, icon: "Unavailable", dot: "bg-subtle-foreground/60" },
  { id: "read-only", label: "Read", description: "Read files and logs. No changes.", icon: "Eye", dot: "bg-timeline-accent" },
  { id: "ask", label: "Ask", description: "Changes need your one-tap OK.", icon: "SecurityCheck", dot: "bg-attention" },
  { id: "full", label: "Full", description: "Run anything, like you would.", icon: "Zap", dot: "bg-success" },
];

export const MAC_ACCESS_TITLE = `${COMPUTER_TITLE} access`;

export function useMacAccessLevel() {
  const status = useCloudroomAccount();
  const macAccess = useSetMacAccess();
  const pending = macAccess.isPending ? macAccess.variables : undefined;
  const saved = status.data?.macAccessLevel ?? (status.data?.macAccess ? "full" : "off");
  const id = pending === undefined ? saved : pending === true ? "full" : pending === false ? "off" : pending;
  const current = MAC_ACCESS_LEVELS.find((level) => level.id === id) ?? MAC_ACCESS_LEVELS[0]!;
  const select = (level: (typeof MAC_ACCESS_LEVELS)[number]) => {
    if (level === current) return;
    macAccess.mutate(level.id, {
      onSuccess: () => appToast.success(`${MAC_ACCESS_TITLE}: ${level.label}`),
      onError: (error) => appToast.error(error.message),
    });
  };
  return { current, select, saving: macAccess.isPending };
}

export function MacAccessMenu() {
  const { current, select, saving } = useMacAccessLevel();
  return <DropdownMenu>
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-6 gap-1.5 rounded-full bg-foreground/[0.06] pr-2.5 pl-2 text-xs font-normal text-muted-foreground hover:bg-foreground/10 hover:text-foreground data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground" aria-label={`${MAC_ACCESS_TITLE}: ${current.label}`} disabled={saving}>
            <span className={cn("size-1.5 shrink-0 rounded-full", current.dot)} aria-hidden />
            {current.label}
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="top">{MAC_ACCESS_TITLE}: {current.label}</TooltipContent>
    </Tooltip>
    <DropdownMenuContent side="top" align="end" sideOffset={6} mobileTitle={MAC_ACCESS_TITLE} className="w-72 p-1.5">
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{MAC_ACCESS_TITLE}</DropdownMenuLabel>
      <MacAccessMenuItems current={current} select={select} />
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function MacAccessMenuItems({ current, select }: Pick<ReturnType<typeof useMacAccessLevel>, "current" | "select">) {
  // The computer says which levels it supports: Read and Ask need macOS.
  const supported = useCloudroomAccount().data?.macAccessLevels;
  return MAC_ACCESS_LEVELS.map((level) => {
    const selected = level === current;
    const disabled = !!supported && !supported.includes(level.id);
    return <DropdownMenuItem key={level.id} role="menuitemradio" aria-checked={selected} disabled={disabled} className={cn("items-start gap-2.5 py-2", selected && "bg-state-hover")} onSelect={() => select(level)}>
      <Icon name={level.icon} className="mt-0.5 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{level.label}</span>
        <span className="block text-xs text-muted-foreground">{disabled ? "Needs macOS." : level.description}</span>
      </span>
      {selected && <Icon name="Check" className="mt-0.5 text-foreground" aria-hidden />}
    </DropdownMenuItem>;
  });
}

export function MacAccessChip() {
  const status = useCloudroomAccount();
  if (!status.data?.account || status.data.macAccessSupported === false) return null;
  return <SidebarMenuItem data-footer-item="mac-access"><MacAccessMenu /></SidebarMenuItem>;
}
