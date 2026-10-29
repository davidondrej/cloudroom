import type { ReactNode } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { openUpgrade, useUpgradePromptViewed, type UpgradePrompt } from "@/lib/upgrade-prompt";

export function UpgradeTip({ where, wrap = false, className, children }: { where: UpgradePrompt; wrap?: boolean; className?: string; children: ReactNode }) {
  useUpgradePromptViewed(where);
  return (
    <p aria-live="polite" className={cn("flex min-w-0 items-center gap-2 text-xs text-muted-foreground", className)}>
      <Icon name="Zap" className="size-3.5 shrink-0 text-primary-text" aria-hidden />
      <span className={cn(!wrap && "truncate")}>{children}</span>
      <Button type="button" variant="link" size="sm" className="h-auto shrink-0 gap-0.5 p-0 text-xs font-semibold" onClick={() => openUpgrade(where)}>
        Upgrade<Icon name="ArrowRight" aria-hidden />
      </Button>
    </p>
  );
}
