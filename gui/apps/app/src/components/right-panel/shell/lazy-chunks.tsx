import {
  lazy,
  Suspense,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { useAtomValue } from "jotai";
import { Panel } from "react-resizable-panels";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Skeleton } from "@cloudroom/shared-ui/skeleton";
import { secondaryPanelWidthPercentAtom } from "@/components/right-panel/store/panel-prefs";
import {
  CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT,
  PANEL_COLLAPSE_TRANSITION_CLASS,
  THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT,
  THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT,
} from "./panel-tokens";

type ShellMod = typeof import("./panel-shell");
type TreeMod =
  typeof import("@/components/right-panel/tabs/ThreadStorageFileTree");

let cachedShellImport: Promise<ShellMod> | null = null;
const loadShell = () => (cachedShellImport ??= import("./panel-shell"));

export function preloadThreadSecondaryPanel(): void {
  void loadShell().catch(() => {
    cachedShellImport = null;
  });
}

export function SecondaryPanelContentSkeleton() {
  return (
    <div
      className="space-y-2 px-4 py-4"
      data-testid="secondary-panel-content-skeleton"
    >
      <Skeleton className="h-3 w-3/4 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-5/6 rounded-sm" />
      <Skeleton className="h-3 w-2/3 rounded-sm" />
    </div>
  );
}

function lazySlot<P extends object>(
  loader: () => Promise<ComponentType<P>>,
  fallback: ReactNode = <SecondaryPanelContentSkeleton />,
) {
  const LazyComp = lazy(() => loader().then((Comp) => ({ default: Comp })));
  return function SuspendedSlot(props: P) {
    return (
      <Suspense fallback={fallback}>
        <LazyComp {...props} />
      </Suspense>
    );
  };
}

const ShellLazy = lazy(() =>
  loadShell().then((m) => ({ default: m.ThreadSecondaryPanel })),
);
const TreeLazy = lazy(() =>
  import("@/components/right-panel/tabs/ThreadStorageFileTree").then((m) => ({
    default: m.ThreadStorageFileTree,
  })),
);

function ShellPlaceholder({
  isOpen,
  isConversationCollapsed,
  resizablePanelId,
}: {
  isOpen: boolean;
  isConversationCollapsed: boolean;
  resizablePanelId?: string;
}) {
  const widthPct = useAtomValue(secondaryPanelWidthPercentAtom);
  return (
    <Panel
      id={resizablePanelId}
      collapsible
      collapsedSize={0}
      defaultSize={
        isOpen
          ? isConversationCollapsed
            ? CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT
            : widthPct
          : 0
      }
      minSize={THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT}
      maxSize={
        isConversationCollapsed
          ? CONVERSATION_COLLAPSED_PANEL_SIZE_PERCENT
          : THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT
      }
      order={2}
      className={cn(
        "relative min-w-0 overflow-clip transition-[flex-grow,flex-basis]",
        PANEL_COLLAPSE_TRANSITION_CLASS,
        isOpen && !isConversationCollapsed && "border-l border-border-seam",
      )}
      data-testid="thread-secondary-panel-placeholder"
    >
      {isOpen ? (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background pt-12">
          <SecondaryPanelContentSkeleton />
        </div>
      ) : null}
    </Panel>
  );
}

export function LazyThreadSecondaryPanel({
  drawerFallback,
  ...props
}: ComponentProps<ShellMod["ThreadSecondaryPanel"]> & {
  drawerFallback: ReactNode;
}) {
  return (
    <Suspense
      fallback={
        props.renderAsDrawer ? (
          drawerFallback
        ) : (
          <ShellPlaceholder
            isOpen={props.isOpen}
            isConversationCollapsed={props.isConversationCollapsed}
            resizablePanelId={props.resizablePanelId}
          />
        )
      }
    >
      <ShellLazy {...props} />
    </Suspense>
  );
}

export function LazyThreadStorageFileTree({
  fallback,
  ...props
}: ComponentProps<TreeMod["ThreadStorageFileTree"]> & { fallback: ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      <TreeLazy {...props} />
    </Suspense>
  );
}

export const LazyThreadTerminalPanel = lazySlot(() =>
  import("@/components/thread/terminal/ThreadTerminalPanel").then(
    (m) => m.ThreadTerminalPanel,
  ),
);
export const LazyBrowserTabDeck = lazySlot(
  () =>
    import("@/components/right-panel/tabs/browser-tab").then(
      (m) => m.BrowserTabDeck,
    ),
  null,
);
export const LazyNewTabPage = lazySlot(() =>
  import("@/components/right-panel/tabs/new-tab").then((m) => m.NewTabPage),
);
export const LazyFilePreview = lazySlot(() =>
  import("@/components/right-panel/tabs/file-preview").then(
    (m) => m.FilePreview,
  ),
);
export const LazyWorkspaceFilePreviewTabContent = lazySlot(() =>
  import("./file-preview-tabs").then((m) => m.WorkspaceFilePreviewTabContent),
);
export const LazyHostFilePreviewTabContent = lazySlot(() =>
  import("./file-preview-tabs").then((m) => m.HostFilePreviewTabContent),
);
export const LazyHostScopedFilePreviewTabContent = lazySlot(() =>
  import("./file-preview-tabs").then((m) => m.HostScopedFilePreviewTabContent),
);
export const LazyProjectFilePreviewTabContent = lazySlot(() =>
  import("./file-preview-tabs").then((m) => m.ProjectFilePreviewTabContent),
);
export const LazyThreadStorageFilePreviewTabContent = lazySlot(() =>
  import("./file-preview-tabs").then(
    (m) => m.ThreadStorageFilePreviewTabContent,
  ),
);
