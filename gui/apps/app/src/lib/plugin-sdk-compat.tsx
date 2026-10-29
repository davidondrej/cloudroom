// Plugin SDK 0.6 frontend APIs (BB desktop 0.46.1) that Cloudroom's app had no
// host for. Cheap ones are real; the sidebar-replacement and thread-action
// surfaces (BB's navigation rail, not ported) return empty, neutral state so
// plugins load and render without them.
import type { PluginSdkApp } from "@get-bb/plugin-sdk";
import { experimental_THREAD_ACTION_GROUPS } from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { usePluginId } from "@/components/plugin/plugin-context";
import { useComposer } from "./plugin-sdk-hooks";
import { useSidebarThreads } from "./plugin-sidebar-hooks";

type Compat = Pick<
  PluginSdkApp,
  | "ThreadTitle"
  | "experimental_THREAD_ACTION_GROUPS"
  | "experimental_ThreadActionsContextMenu"
  | "experimental_ThreadActionsMenu"
  | "experimental_ThreadStatusGlyph"
  | "experimental_VoiceInputTextarea"
  | "experimental_copyToClipboard"
  | "experimental_saveFile"
  | "experimental_useArchiveEnvironmentThreads"
  | "experimental_usePluginId"
  | "experimental_useQuestionFormHost"
  | "experimental_useThreadActionRegistrations"
  | "experimental_useThreadActions"
  | "useComposers"
  | "useEnvironmentProviders"
  | "useSidebarSplitLayout"
  | "useSidebarThreadDraft"
  | "useSidebarThreadDraftIds"
  | "useSidebarThreadRowStatus"
  | "useSidebarThreadRowStatuses"
  | "useSidebarThreadShortcut"
>;

const NO_DRAFT_IDS: ReadonlySet<string> = new Set();
const NO_ROW_STATUSES = new Map<string, never>();
const NO_SHORTCUTS = new Map<string, never>();
const NO_ACTIONS: readonly never[] = [];
const NO_DRAFT = { hasUnsubmittedDraft: false };
const NO_ENVIRONMENT_PROVIDERS = { status: "ready", providers: [] } as const;
const NO_QUESTION_FORM_HOST = {
  shortcuts: NO_SHORTCUTS,
  registerChoiceHandler: () => () => {},
};

function useComposers() {
  const composer = useComposer();
  return useMemo(() => [composer], [composer]);
}

function unsupported(name: string): never {
  throw new Error(`${name} is not supported in Cloudroom yet.`);
}

export const pluginSdkCompat: Compat = {
  experimental_usePluginId: usePluginId,
  experimental_THREAD_ACTION_GROUPS,
  useComposers,
  ThreadTitle({ threadId }) {
    const { threads } = useSidebarThreads();
    const thread = threads.find((row) => row.id === threadId);
    return thread === undefined ? null : <>{thread.displayTitle}</>;
  },
  async experimental_copyToClipboard({ text, html }) {
    try {
      if (html !== undefined && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      return true;
    } catch {
      return false;
    }
  },
  async experimental_saveFile(request) {
    try {
      const href =
        "url" in request ? request.url : URL.createObjectURL(request.blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = request.fileName;
      link.click();
      if (!("url" in request)) setTimeout(() => URL.revokeObjectURL(href), 0);
      return "started";
    } catch {
      return "failed";
    }
  },
  experimental_VoiceInputTextarea({ onValueChange, ...props }) {
    return (
      <textarea
        {...props}
        onChange={(event) => onValueChange(event.target.value)}
      />
    );
  },
  experimental_useQuestionFormHost: () => NO_QUESTION_FORM_HOST,
  experimental_useArchiveEnvironmentThreads: () => async () =>
    unsupported("experimental_useArchiveEnvironmentThreads"),
  experimental_useThreadActions: () => NO_ACTIONS,
  experimental_useThreadActionRegistrations: () => NO_ACTIONS,
  experimental_ThreadActionsMenu: () => null,
  experimental_ThreadActionsContextMenu: ({ children }) => <>{children}</>,
  experimental_ThreadStatusGlyph: () => null,
  useEnvironmentProviders: () => NO_ENVIRONMENT_PROVIDERS,
  useSidebarSplitLayout: () => null,
  useSidebarThreadDraft: () => NO_DRAFT,
  useSidebarThreadDraftIds: () => NO_DRAFT_IDS,
  useSidebarThreadRowStatus: () => null,
  useSidebarThreadRowStatuses: () => NO_ROW_STATUSES,
  useSidebarThreadShortcut: () => null,
};
