import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { formatRelativeTime } from "@/lib/relative-time";
import { sdk } from "@/lib/sdk";

const PROMISES = ["Messages only. No tool output or files.", "Secrets and API keys removed.", "Hidden from search engines."];

export function ThreadShareButton({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const queryKey = ["cloudroom-thread-share", threadId];
  const share = useQuery({ queryKey, queryFn: ({ signal }) => sdk.cloudroom.threadShare(threadId, signal) });
  const signedIn = Boolean(useCloudroomAccount().data?.account);
  const copy = (url: string) => void copyToClipboardWithToast(url, { successMessage: "Link copied" });
  const save = useMutation({
    mutationFn: () => sdk.cloudroom.shareThread(threadId),
    onSuccess: (value) => {
      const created = !share.data;
      client.setQueryData(queryKey, value);
      if (created) copy(value.url);
    },
  });
  const stop = useMutation({
    mutationFn: () => sdk.cloudroom.stopSharingThread(threadId),
    onSuccess: () => client.setQueryData(queryKey, null),
  });
  const link = share.data ?? null;
  const error = save.error ?? stop.error;
  const busy = save.isPending || stop.isPending;
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) { save.reset(); stop.reset(); } }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-7 gap-1.5 px-2 text-xs", link ? "text-primary-text" : "text-muted-foreground hover:text-foreground")}
          aria-label={link ? "Shared. Manage share link" : "Share thread"}
        >
          <Icon name="Link" className="size-3.5" />
          {link ? "Shared" : "Share"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} mobileTitle="Share link" className="w-80 p-4">
        <div className="grid gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium"><Icon name="Link" className="size-4" />Share link</p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Globe" className="size-3.5" />Anyone with the link can view it.</p>
          </div>
          {link ? (
            <div className="flex gap-2">
              <input
                readOnly
                value={link.url.replace(/^https?:\/\/(www\.)?/, "")}
                aria-label="Share link"
                onFocus={(event) => event.currentTarget.select()}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none"
              />
              <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => copy(link.url)}><Icon name="Copy" className="size-3.5" />Copy</Button>
            </div>
          ) : null}
          <ul className="grid gap-1.5">
            {PROMISES.map((promise) => (
              <li key={promise} className="flex items-center gap-2 text-xs text-muted-foreground"><Icon name="Check" className="size-3.5 shrink-0 text-primary-text" />{promise}</li>
            ))}
          </ul>
          {error ? <p className="text-xs text-destructive">{error.message}</p> : null}
          {link ? (
            <div className="flex items-center gap-3 border-t border-border pt-3 text-xs">
              <span className="text-muted-foreground">Snapshot from {formatRelativeTime({ timestamp: Date.parse(link.updatedAt), now: Date.now() })}</span>
              <button type="button" disabled={busy} onClick={() => save.mutate()} className="flex items-center gap-1 text-foreground hover:underline disabled:opacity-50">
                <Icon name="RotateCcw" className="size-3" />{save.isPending ? "Updating…" : "Update"}
              </button>
              <button type="button" disabled={busy} onClick={() => stop.mutate()} className="ml-auto text-destructive hover:underline disabled:opacity-50">
                {stop.isPending ? "Stopping…" : "Stop sharing"}
              </button>
            </div>
          ) : signedIn ? (
            <Button type="button" disabled={busy || share.isPending} onClick={() => save.mutate()}>{save.isPending ? "Creating link…" : "Create link"}</Button>
          ) : (
            <p className="text-xs text-muted-foreground">Sign in to Cloudroom to share threads.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
