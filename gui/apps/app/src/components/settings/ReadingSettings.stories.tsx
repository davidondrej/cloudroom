import { MarkdownPreview } from "@/components/ui/markdown-preview";
import {
  StoryDraftPromptBox,
  useStoryPromptDraft,
} from "@/components/thread/timeline/StoryDraftPromptBox";
import { useApplyReadingPreferences } from "@/lib/reading-preferences";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { ReadingSettings } from "./ReadingSettings";

export default {
  title: "settings/Right-to-left Reading",
};

const ASSISTANT_REPLY = `## خلاصه‌ی تغییرها

فونت فارسی حالا از تنظیمات Appearance انتخاب می‌شود و متن فارسی خودکار راست‌چین است. English paragraphs stay left-to-right.

- اندازه‌ی متن چت قابل تنظیم است
- فاصله‌ی خط هم سه حالت دارد
- Code blocks stay LTR

> نقل‌قول فارسی هم راست‌چین می‌شود.

| فایل | وضعیت |
| --- | --- |
| \`reading-preferences.ts\` | جدید |

\`\`\`ts
const dir = "auto"; // کد چپ‌چین می‌ماند
\`\`\`

שלום! פסקה בעברית נקראת מימין לשמאל.`;

const USER_MESSAGE =
  "سلام! یک تابع بنویس که فایل‌های `.md` را بخواند.\n\nThen add tests.";

export function RightToLeftChat() {
  useApplyReadingPreferences();
  const promptDraft = useStoryPromptDraft();
  return (
    <StoryCard>
      <StoryRow label="settings" hint="Settings > Appearance rows">
        <div className="w-full max-w-[640px] space-y-5">
          <ReadingSettings />
        </div>
      </StoryRow>
      <StoryRow label="user message" hint="right-aligned bubble">
        <div className="flex w-full max-w-[760px] flex-col items-end">
          <div
            data-user-message=""
            className="max-w-full rounded-xl bg-background px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-message dark:bg-surface-recessed"
          >
            <MarkdownPreview content={USER_MESSAGE} />
          </div>
        </div>
      </StoryRow>
      <StoryRow label="assistant reply" hint="Persian, Hebrew and English">
        <div
          data-message-column=""
          className="w-full max-w-[760px] text-sm font-normal leading-relaxed"
        >
          <MarkdownPreview content={ASSISTANT_REPLY} />
        </div>
      </StoryRow>
      <StoryRow label="prompt box" hint="type an RTL line, then an English line">
        <div className="w-full max-w-[760px]">
          <StoryDraftPromptBox draft={promptDraft} />
        </div>
      </StoryRow>
    </StoryCard>
  );
}
