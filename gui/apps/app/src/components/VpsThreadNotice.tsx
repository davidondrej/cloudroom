import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useCloudVps } from "@/components/settings/VpsSettings";
import { fetchWithAppSurface } from "@/lib/app-surface";

const gb = (bytes: number) => Number((bytes / 1024 ** 3).toFixed(1));

async function moveToCloud(threadId: string) {
  const response = await fetchWithAppSurface(`/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const value = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(value?.message ?? `Moving to Cloud failed (HTTP ${response.status}).`);
}

function MoveButton({ threadId, primary = false }: { threadId: string; primary?: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const move = useMutation({
    mutationFn: () => moveToCloud(threadId),
    onSuccess: () => { setOpen(false); void queryClient.invalidateQueries({ queryKey: ["cloudroom-thread", threadId] }); },
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant={primary ? "default" : "outline"} className="h-7 text-xs"><Icon name="Cloud" aria-hidden />Move to Cloud</Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} aria-label="Move to Cloud" className="w-80 space-y-3 p-3.5 text-xs">
        <p className="text-sm font-medium">Move this thread to Cloud?</p>
        <p className="text-muted-foreground">Its files and chat move to a Cloud sandbox, which uses Cloud hours. A running turn stops; send a message to continue there.</p>
        {move.error && <p role="alert" className="text-destructive">{move.error.message}</p>}
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" size="sm" className="h-7 text-xs" disabled={move.isPending} onClick={() => move.mutate()}>{move.isPending && <Icon name="Spinner" className="animate-spin" aria-hidden />}Move to Cloud</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function VpsThreadNotice({ threadId, move, outOfMemory }: { threadId: string; move: "moving" | "failed" | null; outOfMemory: boolean }) {
  const vps = useCloudVps({ poll: 30_000 });
  const critical = vps.data?.critical ?? null;
  const shown = outOfMemory ? "memory-out" : move === "failed" ? "move-failed" : critical ? critical.kind : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (dismissed && dismissed !== shown) setDismissed(null);
  if (move === "moving") {
    return (
      <PromptStackCard ariaLabel="Moving to Cloud" className="flex items-center gap-2 px-3 py-2 text-xs">
        <Icon name="Spinner" className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        <span className="font-medium">Moving this thread to Cloud</span>
        <span className="min-w-0 truncate text-muted-foreground">It continues there in about a minute.</span>
      </PromptStackCard>
    );
  }
  if (!shown || dismissed === shown) return null;
  if (outOfMemory) {
    const health = vps.data?.health;
    return (
      <PromptStackCard ariaLabel="Your VPS ran out of memory" className="space-y-2 border-destructive/40 p-3 text-xs">
        <p className="flex items-center gap-2 text-sm font-medium"><Icon name="AlertCircle" className="size-4 shrink-0 text-destructive" aria-hidden />The agent stopped: your VPS ran out of memory</p>
        <p className="pl-6 text-muted-foreground">
          {health ? `${health.running} ${health.running === 1 ? "agent was" : "agents were"} running on ${vps.data?.name?.split(".")[0] ?? "your VPS"} with ${gb(health.memory.total)} GB of memory. ` : ""}Your work is saved.
        </p>
        <div className="flex gap-1.5 pl-6">
          <MoveButton threadId={threadId} primary />
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setDismissed(shown)}>Stay on VPS</Button>
        </div>
      </PromptStackCard>
    );
  }
  return (
    <PromptStackCard ariaLabel="Your VPS is almost full" className="flex items-center gap-2 border-attention/50 py-1.5 pl-3 pr-1.5 text-xs">
      <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
      {move === "failed" ? (
        <span className="min-w-0 truncate">Couldn't move to Cloud: the copy didn't finish, so the thread stayed on your VPS.</span>
      ) : critical && (
        <>
          <span className="shrink-0 font-medium">Your VPS is almost out of {critical.kind === "memory" ? "memory" : "disk space"}</span>
          <span className="ml-1 h-1 w-16 shrink-0 overflow-hidden rounded-full bg-foreground/10">
            <span className="block h-full rounded-full bg-warning" style={{ width: `${Math.min(100, critical.used / critical.total * 100)}%` }} />
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{gb(critical.used)} / {gb(critical.total)} GB</span>
        </>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <MoveButton threadId={threadId} />
        <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label="Dismiss" onClick={() => setDismissed(shown)}><Icon name="X" aria-hidden /></Button>
      </span>
    </PromptStackCard>
  );
}
