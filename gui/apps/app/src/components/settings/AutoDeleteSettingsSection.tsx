import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutoDeleteDays } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { UpgradeTip } from "@/components/UpgradeTip";
import { sdk } from "@/lib/sdk";
import { Card, errorText } from "./CloudEnvironmentSettingsSection";
import { SETTINGS_DROPDOWN_CONTENT_CLASS, SETTINGS_DROPDOWN_TRIGGER_CLASS } from "./settings-dropdown";

const KEY = ["cloudroom-auto-delete"];
const OPTIONS: { days: Exclude<AutoDeleteDays, null>; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
];

type Row = { label: string; shows: number | null; save: AutoDeleteDays; locked: boolean };

export function AutoDeleteSettingsSection() {
  const queryClient = useQueryClient();
  const setting = useQuery({ queryKey: KEY, queryFn: ({ signal }) => sdk.cloudroom.autoDelete(signal), retry: false });
  const save = useMutation({
    mutationFn: (days: AutoDeleteDays) => sdk.cloudroom.setAutoDelete(days),
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  });
  const [wanted, setWanted] = useState<string | null>(null);
  const plan = setting.data?.plan ?? null;
  const upgrade = setting.data?.upgrade ?? null;
  const kept = setting.data ? (setting.data.kept ?? setting.data.days) : undefined;
  const limit: Row | null = plan ? { label: `${plan.label} · ${plan.name} limit`, shows: plan.days, save: null, locked: false } : null;
  const rows: Row[] = OPTIONS.map((option) =>
    limit && option.days === limit.shows
      ? limit
      : { label: option.label, shows: option.days, save: option.days, locked: plan !== null && option.days > plan.days },
  );
  if (!plan || !limit) rows.push({ label: "Never", shows: null, save: null, locked: false });
  else if (!rows.includes(limit)) {
    const at = rows.findIndex((row) => row.shows !== null && row.shows > plan.days);
    rows.splice(at < 0 ? rows.length : at, 0, limit);
  }
  const chosen = (row: Row) => row.shows === kept;
  const pick = (row: Row) => {
    if (row.locked) {
      setWanted(row.label);
      return;
    }
    setWanted(null);
    if (row.save !== setting.data?.days) save.mutate(row.save);
  };
  const problem = errorText(setting.error ?? save.error);

  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold text-foreground">Auto-delete</h2>
      <Card
        icon="Clock"
        title="Delete unused cloud threads after"
        action={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                disabled={!setting.data || save.isPending}
                aria-label="Delete unused cloud threads after"
              >
                <span className="min-w-0 truncate">{(setting.data && rows.find(chosen)?.label) ?? "…"}</span>
                <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={SETTINGS_DROPDOWN_CONTENT_CLASS}>
              {rows.map((row) => (
                <DropdownMenuItem key={row.label} className={cn(row.locked && "text-muted-foreground")} onSelect={() => pick(row)}>
                  {row.label}
                  {row.locked && upgrade && <span className="sr-only">, needs {upgrade.name}</span>}
                  <Icon name={row.locked ? "Lock" : "Check"} className={cn("ml-auto size-3.5", !row.locked && !chosen(row) && "opacity-0")} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {plan && upgrade && (
        <UpgradeTip where="auto_delete" wrap>
          {wanted
            ? `Keeping them ${wanted} needs ${upgrade.name}.`
            : `${plan.name} keeps unused cloud threads ${plan.label}. ${upgrade.name} keeps them up to ${upgrade.label}.`}
        </UpgradeTip>
      )}
      {problem && (
        <p role="alert" className="text-xs text-destructive-text">
          {problem}
        </p>
      )}
    </div>
  );
}
