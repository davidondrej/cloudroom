import type { PromptMentionResource } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { useThreadTitleMentionResources } from "@/components/thread/ThreadTitleMentions";
import { promptMentionIconName } from "./prompt-mention-display";

export function ThreadLocationIcon({
  className,
  isCloud,
}: {
  className?: string;
  isCloud: boolean;
}) {
  return (
    <Icon
      name={isCloud ? "Cloud" : "Laptop"}
      className={cn(className, isCloud && "text-primary [&_path]:stroke-[1.9]")}
      aria-hidden
    />
  );
}

function ThreadMentionIcon({
  className,
  threadId,
}: {
  className?: string;
  threadId: string;
}) {
  const { threadById } = useThreadTitleMentionResources();
  return (
    <ThreadLocationIcon
      isCloud={threadById.get(threadId)?.executionTarget === "cloud"}
      className={className}
    />
  );
}

export function PromptMentionIcon({
  className,
  resource,
}: {
  className?: string;
  resource: PromptMentionResource;
}) {
  if (resource.kind === "plugin") {
    return (
      <PluginIcon
        pluginId={resource.pluginId}
        icon={resource.icon ?? null}
        className={className}
      />
    );
  }
  if (resource.kind === "thread") {
    return (
      <ThreadMentionIcon threadId={resource.threadId} className={className} />
    );
  }
  return (
    <Icon
      name={promptMentionIconName(resource)}
      className={className}
      aria-hidden
    />
  );
}
