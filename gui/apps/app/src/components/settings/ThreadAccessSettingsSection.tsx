import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ThreadAccessLevel } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { sdk } from "@/lib/sdk";
import { Card, errorText } from "./CloudEnvironmentSettingsSection";
import { SETTINGS_DROPDOWN_CONTENT_CLASS, SETTINGS_DROPDOWN_TRIGGER_CLASS } from "./settings-dropdown";

const KEY = ["cloudroom-thread-access"];
const LEVELS: { id: ThreadAccessLevel; label: string; description: string; icon: string }[] = [
  { id: "off", label: "Off", description: "Agents can't read or message other threads.", icon: "Unavailable" },
  { id: "read", label: "Read", description: "Read other threads' chats. No messages.", icon: "Eye" },
  { id: "full", label: "Full", description: "Read and message other threads.", icon: "Zap" },
];

export function ThreadAccessSettingsSection() {
  const queryClient = useQueryClient();
  const setting = useQuery({ queryKey: KEY, queryFn: ({ signal }) => sdk.cloudroom.threadAccess(signal), retry: false });
  const save = useMutation({
    mutationFn: (level: ThreadAccessLevel) => sdk.cloudroom.setThreadAccess(level),
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  });
  const current = LEVELS.find((level) => level.id === setting.data?.level);
  const problem = errorText(setting.error ?? save.error);

  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold text-foreground">Thread access</h2>
      <Card
        icon="MessageSquare"
        title="Agents reach your other threads"
        description="Local and Cloud, never another account's. Threads always reach their own subagents."
        action={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                disabled={!setting.data || save.isPending}
                aria-label="Thread access"
              >
                <span className="min-w-0 truncate">{current?.label ?? "…"}</span>
                <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={SETTINGS_DROPDOWN_CONTENT_CLASS}>
              {LEVELS.map((level) => (
                <DropdownMenuItem key={level.id} className="items-start gap-2.5" onSelect={() => level.id !== current?.id && save.mutate(level.id)}>
                  <Icon name={level.icon} className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block">{level.label}</span>
                    <span className="block text-xs text-muted-foreground">{level.description}</span>
                  </span>
                  <Icon name="Check" className={cn("ml-auto mt-0.5 size-3.5 shrink-0", level.id !== current?.id && "opacity-0")} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive-text">
          {problem}
        </p>
      )}
    </div>
  );
}
