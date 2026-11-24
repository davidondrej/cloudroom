import { useState } from "react";
import { COMPUTER, COMPUTER_TITLE } from "@cloudroom/domain";
import type { MacAccessLevel } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverAnchor, PopoverContent } from "@cloudroom/shared-ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { useOnboardingOpen } from "@/components/Onboarding";
import { appToast } from "@/components/ui/app-toast";
import { usePopupSlot } from "@/lib/popups";
import { useIsMutating } from "@tanstack/react-query";
import { MAC_ACCESS_MUTATION_KEY, useCloudroomAccount, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";

export const MAC_ACCESS_LEVELS: { id: MacAccessLevel; label: string; description: string; icon: string; dot: string }[] = [
  { id: "off", label: "Off", description: `Cloud agents can't touch this ${COMPUTER}.`, icon: "Unavailable", dot: "bg-subtle-foreground/60" },
  { id: "read-only", label: "Read", description: "Read files and logs. No changes.", icon: "Eye", dot: "bg-timeline-accent" },
  { id: "ask", label: "Ask", description: "Changes need your one-tap OK.", icon: "SecurityCheck", dot: "bg-attention" },
  { id: "full", label: "Full", description: "Run anything, like you would.", icon: "Zap", dot: "bg-success" },
];

export const MAC_ACCESS_TITLE = `${COMPUTER_TITLE} access`;

const saved = (access: boolean | MacAccessLevel) => appToast.success(`${MAC_ACCESS_TITLE}: ${MAC_ACCESS_LEVELS.find((level) => level.id === access)?.label ?? access}`);

/** Every menu that shows the level reads the same account cache, so they all change at the same moment (#109). */
export function useMacAccessLevel() {
  const status = useCloudroomAccount();
  const macAccess = useSetMacAccess(saved);
  const saving = useIsMutating({ mutationKey: MAC_ACCESS_MUTATION_KEY }) > 0;
  const id = status.data?.macAccessLevel ?? (status.data?.macAccess ? "full" : "off");
  const current = MAC_ACCESS_LEVELS.find((level) => level.id === id) ?? MAC_ACCESS_LEVELS[0]!;
  const select = (level: (typeof MAC_ACCESS_LEVELS)[number]) => {
    if (level !== current) macAccess.mutate(level.id);
  };
  return { current, select, saving };
}

export function MacAccessMenu({ open, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const { current, select, saving } = useMacAccessLevel();
  return <DropdownMenu open={open} onOpenChange={onOpenChange}>
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
  // The computer says which levels it supports: Read and Ask need macOS, so other systems list only Off and Full (#958).
  const supported = useCloudroomAccount().data?.macAccessLevels;
  return MAC_ACCESS_LEVELS.filter((level) => !supported || supported.includes(level.id)).map((level) => {
    const selected = level === current;
    return <DropdownMenuItem key={level.id} role="menuitemradio" aria-checked={selected} className={cn("items-start gap-2.5 py-2", selected && "bg-state-hover")} onSelect={() => select(level)}>
      <Icon name={level.icon} className="mt-0.5 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{level.label}</span>
        <span className="block text-xs text-muted-foreground">{level.description}</span>
      </span>
      {selected && <Icon name="Check" className="mt-0.5 text-foreground" aria-hidden />}
    </DropdownMenuItem>;
  });
}

export function MacAccessChip({ hidden = false }: { hidden?: boolean } = {}) {
  const status = useCloudroomAccount();
  const onboardingOpen = useOnboardingOpen();
  const { isCompactViewport, state, openMobile } = useSidebar();
  const sidebarVisible = !hidden && (isCompactViewport ? openMobile : state === "expanded");
  // Windows (#958): new there, so until the user picks, a card above the chip asks while the sidebar is visible.
  const wants = Boolean(
    status.data?.account && status.data.macAccessSupported !== false && status.data.computerOs === "windows"
    && status.data.macAccessLevel == null && !status.data.signingIn && !onboardingOpen && sidebarVisible,
  );
  const ask = usePopupSlot("computer-access", wants);
  if (!status.data?.account || status.data.macAccessSupported === false) return null;
  return <SidebarMenuItem data-footer-item="mac-access">{ask ? <NewComputerAccess /> : <MacAccessMenu />}</SidebarMenuItem>;
}

function NewComputerAccess() {
  const choose = useSetMacAccess(saved);
  const [menuOpen, setMenuOpen] = useState(false);
  return <Popover open={!menuOpen}>
    <PopoverAnchor asChild><span className="inline-flex"><MacAccessMenu open={menuOpen} onOpenChange={setMenuOpen} /></span></PopoverAnchor>
    <PopoverContent side="top" align="end" sideOffset={8} className="w-72 p-3" onOpenAutoFocus={(event) => event.preventDefault()}>
      <p className="text-sm font-medium text-foreground">New: let Cloud agents use this PC</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Cloud threads can then run commands and copy files here, as you. Turn it off anytime from this chip.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={choose.isPending} onClick={() => choose.mutate("off")}>Not now</Button>
        <Button size="sm" disabled={choose.isPending} onClick={() => choose.mutate("full")}>Turn on</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
