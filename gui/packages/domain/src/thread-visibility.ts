import { z } from "zod";

export const threadVisibilityValues = ["visible", "hidden"] as const;
export const threadVisibilitySchema = z.enum(threadVisibilityValues);
export type ThreadVisibility = z.infer<typeof threadVisibilitySchema>;

export const DIRECTOR_PLUGIN_ID = "director";

/** Hidden threads that stay taggable in `@` mentions like any normal thread. */
export function isMentionableHiddenThread(thread: {
  originPluginId: string | null;
  parentThreadId: string | null;
  visibility: ThreadVisibility;
}): boolean {
  return (
    thread.visibility === "hidden" &&
    thread.originPluginId === DIRECTOR_PLUGIN_ID &&
    thread.parentThreadId === null
  );
}
