import type { Host } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cloudroom/shared-ui/dialog";
import { ConfirmDeleteDialog } from "@/components/dialogs/ConfirmDeleteDialog";
import { useForgetHost, useRemoveHost } from "@/hooks/mutations/host-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

// An offline machine stuck in cleanup can only be forgotten (#1937).
export function canForgetMachine(host: Host): boolean {
  return (
    host.type === "persistent" &&
    host.machineProviderId !== null &&
    host.status === "disconnected" &&
    host.lifecycle.phase === "removing" &&
    host.lifecycle.teardown?.status === "failed"
  );
}

export function machineRemoveLabel(host: Host): string {
  return canForgetMachine(host) ? "Forget machine" : "Remove machine";
}

export function machineRemovalConsequences(host: Host): string {
  if (canForgetMachine(host)) {
    return "Cloudroom can't reach it, so its files stay on it. Its environments remain as read-only history.";
  }
  if (host.type === "ephemeral") {
    return "The compute and its saved snapshots are deleted. Its environments remain as read-only history.";
  }
  if (host.machineProviderId !== null) {
    return "The provider cleans up resources it owns. Its environments remain as read-only history.";
  }
  return "Project checkouts stay on its disk, but its environments become read-only history and it cannot run new work until paired again.";
}

export function MachineRemoveDialog({
  target,
  onOpenChange,
  onRemoved,
}: {
  target: Host | null;
  onOpenChange: (open: boolean) => void;
  onRemoved?: (host: Host) => void;
}) {
  const removeHost = useRemoveHost();
  const forgetHost = useForgetHost();
  const forget = target !== null && canForgetMachine(target);
  const mutation = forget ? forgetHost : removeHost;

  return (
    <ConfirmDeleteDialog
      modal={false}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          mutation.reset();
          onOpenChange(false);
        }
      }}
    >
      {target === null ? null : (
        <>
          <DialogHeader>
            <DialogTitle>
              {forget ? "Forget" : "Remove"} {target.name}?
            </DialogTitle>
            <DialogDescription>
              This revokes {target.name}'s access to this server.{" "}
              {machineRemovalConsequences(target)}
            </DialogDescription>
          </DialogHeader>
          {mutation.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {getMutationErrorMessage({
                error: mutation.error,
                fallbackMessage: `Couldn't ${forget ? "forget" : "remove"} ${target.name}.`,
              })}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate(target.id, {
                  onSuccess: () => {
                    onOpenChange(false);
                    onRemoved?.(target);
                  },
                })
              }
            >
              {machineRemoveLabel(target)}
            </Button>
          </DialogFooter>
        </>
      )}
    </ConfirmDeleteDialog>
  );
}
