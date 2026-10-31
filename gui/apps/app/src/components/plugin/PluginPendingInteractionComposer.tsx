import {
  PendingInteractionShell,
  type PendingInteractionSourceThread,
} from "@/components/thread/pending-interactions/PendingInteractionShell";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Dialog, DialogContent, DialogTitle } from "@cloudroom/shared-ui/dialog";
import type { JsonValue, PendingInteraction } from "@cloudroom/domain";
import { PluginSlotMount } from "./PluginSlotMount";
import { isModalPluginInteraction, resolvePendingInteraction } from "@/lib/plugin-slot-resolvers";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { sdk } from "@/lib/sdk";

export interface PluginPendingInteractionRequest {
  pluginId: string;
  rendererId: string;
  title: string;
  data: JsonValue;
}

interface PluginPendingInteractionComposerProps {
  interaction: Pick<
    PendingInteraction,
    "id" | "threadId" | "createdAt" | "expiresAt"
  >;
  request: PluginPendingInteractionRequest;
  dismissal: "cancel" | "stop-turn";
  sourceThread?: PendingInteractionSourceThread;
}

export function PluginPendingInteractionComposer({
  interaction,
  request,
  dismissal,
  sourceThread,
}: PluginPendingInteractionComposerProps) {
  const { pendingInteractions } = usePluginSlots();
  const stopThread = useStopThread();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const slot = useMemo(
    () =>
      resolvePendingInteraction(
        pendingInteractions,
        request.pluginId,
        request.rendererId,
      ),
    [request.pluginId, request.rendererId, pendingInteractions],
  );
  const submit = useCallback(
    async (value: JsonValue) => {
      setSubmitting(true);
      setError(null);
      try {
        await sdk.threads.interactions.respond({
          interactionId: interaction.id,
          threadId: interaction.threadId,
          value,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        setSubmitting(false);
      }
    },
    [interaction.id, interaction.threadId],
  );

  const cancel = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (dismissal === "stop-turn") {
        await stopThread.mutateAsync(interaction.threadId);
      } else {
        await sdk.threads.interactions.cancel({
          interactionId: interaction.id,
          threadId: interaction.threadId,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSubmitting(false);
    }
  }, [dismissal, interaction.id, interaction.threadId, stopThread]);
  const dismissLabel = dismissal === "cancel" ? "Cancel" : "Stop turn";

  const form = (
    slot ? (
      <PluginSlotMount
        pluginId={slot.pluginId}
        slotKind="pendingInteraction"
        slotId={slot.id}
        crashFallback={
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The plugin form crashed. {dismissLabel} to continue.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void cancel()}
              disabled={submitting}
            >
              {dismissLabel}
            </Button>
          </div>
        }
      >
        <fieldset disabled={submitting}>
          <slot.component
            interaction={{
              id: interaction.id,
              threadId: interaction.threadId,
              title: request.title,
              payload: request.data,
              createdAt: interaction.createdAt,
              expiresAt: interaction.expiresAt ?? null,
            }}
            submit={submit}
            cancel={cancel}
          />
        </fieldset>
      </PluginSlotMount>
    ) : (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The plugin form is unavailable. {dismissLabel} to continue.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void cancel()}
          disabled={submitting}
        >
          {dismissLabel}
        </Button>
      </div>
    )
  );

  if (isModalPluginInteraction(request.pluginId)) {
    return (
      <Dialog open>
        <DialogContent
          ref={dialogRef}
          hideCloseButton
          aria-describedby={undefined}
          overlayClassName="bg-black/35 backdrop-blur-sm"
          className="max-w-[520px] gap-0 rounded-[14px] border-white/15 p-7 outline-none sm:rounded-[14px]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            dialogRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogTitle className="sr-only">{request.title}</DialogTitle>
          {form}
          {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <PendingInteractionShell
      key={interaction.id}
      label={request.title}
      initiallyExpanded
      errorMessage={error}
      sourceThread={sourceThread}
      testId="plugin-interaction-shell"
    >
      {() => (
        <>
          <p className="mb-4 text-xs text-muted-foreground">
            {dismissal === "cancel"
              ? "Requested by "
              : "The agent asks through "}
            <span className="capitalize">{request.pluginId}</span>
          </p>
          {form}
        </>
      )}
    </PendingInteractionShell>
  );
}
