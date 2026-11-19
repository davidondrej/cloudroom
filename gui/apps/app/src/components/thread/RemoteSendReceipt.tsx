import { useMutationState } from "@tanstack/react-query";
import { Icon } from "@cloudroom/shared-ui/icon";
import { viewingOtherMac } from "@/cloud/mac-connection";
import { REMOTE_SEND_MUTATION_KEY } from "@/cloud/remote-cloud-send";
import type { SendThreadMessageMutationRequest } from "@/hooks/mutations/mutation-request-types";
import type { SendThreadMessageTransaction } from "@/hooks/cache-owners/thread-runtime-cache-owner";

export function RemoteSendReceipt({ threadId, messageId }: { threadId: string; messageId: string }) {
  return viewingOtherMac() ? <Receipt threadId={threadId} messageId={messageId} /> : null;
}

function Receipt({ threadId, messageId }: { threadId: string; messageId: string }) {
  const taggedUuid = /^app_[a-f0-9]{12}_([a-f0-9]{32})$/i.exec(messageId)?.[1];
  const statuses = useMutationState({
    filters: {
      mutationKey: REMOTE_SEND_MUTATION_KEY,
      predicate: ({ state }) => {
        const request = state.variables as SendThreadMessageMutationRequest | undefined;
        if (!request?.recoverCloudDelivery || request.id !== threadId || !request.requestId) return false;
        const context = state.context as SendThreadMessageTransaction | undefined;
        // Cloud prefixes the sending install's tag and removes dashes from a UUID.
        return messageId === request.requestId || taggedUuid === request.requestId.replaceAll("-", "") ||
          (context?.kind === "queued-message" && messageId === context.optimisticQueuedMessageId);
      },
    },
    select: mutation => mutation.state.status,
  });
  const status = statuses.at(-1);
  if (status !== "pending" && status !== "success") return null;
  const sent = status === "success";
  return (
    <span role="status" className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
      {sent ? <Icon name="Check" className="size-3.5" aria-hidden /> :
        <span aria-hidden className="size-3 rounded-full border border-warning/35 border-t-warning motion-safe:animate-spin" />}
      {sent ? "Sent" : "Checking delivery…"}
    </span>
  );
}
