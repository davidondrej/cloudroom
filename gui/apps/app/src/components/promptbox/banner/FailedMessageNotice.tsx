import { promptDraftToInput } from "@cloudroom/client-core";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useFailedPromptMessages } from "@/hooks/usePromptDraftStorage";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { PromptBannerActionButton } from "./prompt-banner-actions";

/** A failed send waits here (it may still have landed if `uncertain`). Nothing is resent on its own. */
export function FailedMessageNotice({ storageKey }: { storageKey: string }) {
  const { message, count, uncertain, restore, dismiss } = useFailedPromptMessages(storageKey);
  if (!message) return null;
  const copy = () =>
    void copyToClipboardWithToast(
      promptDraftToInput(message.draft).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n"),
      { successMessage: "Copied. It has an open code block, so paste it where you want it." },
    );
  return (
    <div className="flex w-full max-w-full items-center gap-1.5 px-2 text-xs text-subtle-foreground" aria-label="Failed message">
      <Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {count > 1 ? `${count} messages` : "Message"} {uncertain ? "may not have been sent" : "not sent"} ·{" "}
        {message.draft.text || "attachments"}
      </span>
      <PromptBannerActionButton onClick={() => restore() || copy()}>Restore failed message</PromptBannerActionButton>
      <PromptBannerActionButton onClick={dismiss}>Dismiss</PromptBannerActionButton>
    </div>
  );
}
