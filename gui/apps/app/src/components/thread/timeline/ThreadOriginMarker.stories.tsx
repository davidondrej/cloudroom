import type { TimelineRow } from "@cloudroom/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { ConversationTimeline } from "@/components/ui/conversation.js";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { ThreadOriginMarker, type ThreadOrigin } from "./ThreadOriginMarker";

export default {
  title: "thread/timeline/ThreadOriginMarker",
};

const THREAD_ID = "thr_origin_marker";
const base = {
  threadId: THREAD_ID,
  sourceSeqStart: 1,
  sourceSeqEnd: 1,
  startedAt: 0,
  createdAt: 0,
  kind: "conversation" as const,
  attachments: null,
};
const rows: TimelineRow[] = [
  {
    ...base,
    id: "origin-user",
    turnId: "origin-turn",
    role: "user",
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    mentions: [],
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
    text: "Make the warning less scary, but keep the number.",
  },
  {
    ...base,
    id: "origin-assistant",
    turnId: "origin-turn",
    role: "assistant",
    turnRequest: null,
    text: "Done. The banner now says `You've used 80% of this month's credits` and links to Billing.",
  },
];

const href = "/projects/proj-1/threads/thr_source_demo";
const origins: { label: string; origin: ThreadOrigin }[] = [
  {
    label: "fork",
    origin: { relationship: "fork", title: "🔥 credit burn warnings", href },
  },
  {
    label: "side chat",
    origin: {
      relationship: "side-chat",
      title: "Investigate flaky test",
      href,
    },
  },
  {
    label: "child thread",
    origin: { relationship: "parent", title: "Release v131", href },
  },
  {
    label: "long title truncates",
    origin: {
      relationship: "fork",
      title:
        "Investigate why cloud sandboxes sometimes wake up slowly after a long idle period on Upstash",
      href,
    },
  },
];

export function Overview() {
  return (
    <StoryCard>
      {origins.map(({ label, origin }) => (
        <StoryRow key={label} label={label}>
          <div className="w-full max-w-[720px] rounded-md border border-border bg-background p-4">
            <ConversationTimeline>
              <ThreadOriginMarker origin={origin} />
              <ThreadTimelineRows
                threadId={THREAD_ID}
                threadRuntimeDisplayStatus="idle"
                workspaceRootPath={undefined}
                timelineRows={rows}
              />
            </ConversationTimeline>
          </div>
        </StoryRow>
      ))}
    </StoryCard>
  );
}
