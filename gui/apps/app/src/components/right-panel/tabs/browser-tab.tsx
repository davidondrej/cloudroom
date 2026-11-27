import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ROOM_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH,
  clampRoomDesktopBrowserViewBounds,
  type RoomDesktopBrowserApi,
  type RoomDesktopBrowserControl,
  type RoomDesktopBrowserFindInPageRequest,
  type RoomDesktopBrowserState,
  type RoomDesktopBrowserTarget,
  type RoomDesktopBrowserViewBounds,
} from "@cloudroom/desktop-contract";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { PluginBrowserToolbarActions } from "@/components/plugin/PluginBrowserToolbarActions";
import type { BrowserFixedPanelTab } from "@/components/right-panel/store/tab-model";
import type { UpdateBrowserTabArgs } from "@/components/right-panel/store/use-panel-tabs";
import {
  useIsBrowserDimmingModalOpen,
  useNativeBrowserViewShown,
} from "@/hooks/useBrowserDimmingModal";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import {
  useBrowserHistory,
  type BrowserHistoryEntry,
} from "@/lib/browser-history";
import {
  getBrowserUrlHost,
  getBrowserUrlSecurity,
  resolveBrowserAddressInput,
} from "@/lib/browser-url";
import { BROWSER_VIEW_BOUNDS_SYNC_EVENT } from "@/lib/browser-view-bounds-sync";
import { isLocalOnlyUrl } from "@/lib/loopback-hostname";
import { formatRelativeTime } from "@/lib/relative-time";
import { getDesktopBrowserApi, getRoomDesktopInfo } from "@/lib/room-desktop";
import {
  BrowserTabLifecycleObserver,
  buildBrowserTabIdSet,
  createBrowserViewVisibilityCoordinator,
  registerBrowserView,
  selectActiveBrowserTab,
  type BrowserViewVisibilityCoordinator,
} from "./browser-visibility";
export {
  BrowserTabLifecycleObserver,
  buildBrowserTabIdSet,
  selectActiveBrowserTab,
};
import {
  LAUNCHER_ROW_BASE_CLASS,
  LAUNCHER_ROW_ICON_CLASS,
  LauncherRowTrailing,
  LauncherSectionHeader,
} from "./tab-primitives";

export interface BrowserAddressFocusRequest {
  requestId: number;
  tabId: string;
}

export interface BrowserFindMatches {
  activeMatchOrdinal: number;
  matches: number;
}

const ZERO_BOUNDS: RoomDesktopBrowserViewBounds = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};

function measureClampedBounds(el: HTMLElement): RoomDesktopBrowserViewBounds {
  const rect = el.getBoundingClientRect();
  return clampRoomDesktopBrowserViewBounds({
    bounds: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
}

function sameBounds(
  a: RoomDesktopBrowserViewBounds,
  b: RoomDesktopBrowserViewBounds,
): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

export function BrowserChromeIconButton({
  icon,
  label,
  disabled,
  onClick,
  shortcut,
}: {
  icon:
    | "ChevronLeft"
    | "ChevronRight"
    | "ChevronUp"
    | "ChevronDown"
    | "RotateCcw"
    | "X"
    | "ExternalLink";
  label: string;
  disabled?: boolean;
  onClick: () => void;
  shortcut?: AppShortcutPresentation | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={shortcut ? `${label} (${shortcut.label})` : label}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      className={cn(
        "flex shrink-0 items-center justify-center transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
        CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
      )}
    >
      <Icon name={icon} aria-hidden />
    </button>
  );
}

export function BrowserFindBar({
  inputRef,
  query,
  matches,
  onQueryChange,
  onFindNext,
  onFindPrevious,
  onClose,
  shortcut,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  matches: BrowserFindMatches | null;
  onQueryChange: (query: string) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
  shortcut: AppShortcutPresentation | null;
}) {
  const hasMatches = matches !== null && matches.matches > 0;
  const zeroMatches = matches !== null && matches.matches === 0;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) onFindPrevious();
      else onFindNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      data-testid="browser-find-bar"
      role="search"
      aria-label="Find in page"
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border/70 bg-sidebar py-1 pl-2 pr-2"
    >
      <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in page"
          aria-label={
            shortcut ? `Find in page (${shortcut.label})` : "Find in page"
          }
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          autoComplete="off"
          spellCheck={false}
          maxLength={ROOM_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        />
        {matches !== null ? (
          <span
            data-testid="browser-find-match-count"
            aria-live="polite"
            className={cn(
              "shrink-0 tabular-nums",
              zeroMatches ? "text-destructive" : "text-muted-foreground",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
          >
            {`${matches.activeMatchOrdinal}/${matches.matches}`}
          </span>
        ) : null}
      </div>
      <BrowserChromeIconButton
        icon="ChevronUp"
        label="Previous match"
        disabled={!hasMatches}
        onClick={onFindPrevious}
      />
      <BrowserChromeIconButton
        icon="ChevronDown"
        label="Next match"
        disabled={!hasMatches}
        onClick={onFindNext}
      />
      <BrowserChromeIconButton
        icon="X"
        label="Close find bar"
        onClick={onClose}
      />
    </div>
  );
}

export function BrowserNewTabScreen({
  onNavigateInput,
  recent,
  onClearRecent,
}: {
  onNavigateInput: (rawInput: string) => void;
  recent: readonly BrowserHistoryEntry[];
  onClearRecent: () => void;
}) {
  if (recent.length === 0) return null;
  const now = Date.now();

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 pb-6 pt-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <section>
          <LauncherSectionHeader
            label="Recently visited"
            count={recent.length}
            action={
              <button
                type="button"
                onClick={onClearRecent}
                aria-label="Clear recently visited"
                className={cn(
                  "rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  COARSE_POINTER_TEXT_SM_CLASS,
                )}
              >
                Clear
              </button>
            }
          />
          <ul aria-label="Recently visited" className="flex flex-col gap-px">
            {recent.map((entry) => {
              const host = getBrowserUrlHost(entry.url);
              const trimmedTitle = entry.title?.trim();
              const primary = trimmedTitle || host;
              return (
                <li key={entry.url}>
                  <button
                    type="button"
                    onClick={() => onNavigateInput(entry.url)}
                    title={entry.url}
                    className={cn(
                      LAUNCHER_ROW_BASE_CLASS,
                      "hover:bg-state-hover",
                    )}
                  >
                    <span className={LAUNCHER_ROW_ICON_CLASS}>
                      <Icon
                        name="Browser"
                        className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
                        aria-hidden
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="truncate text-foreground">
                        {primary}
                      </span>
                      {primary !== host ? (
                        <span className="truncate font-mono text-muted-foreground [flex-shrink:9999]">
                          {host}
                        </span>
                      ) : null}
                    </span>
                    <LauncherRowTrailing
                      idle={formatRelativeTime({
                        timestamp: entry.visitedAt,
                        now,
                      })}
                      isActive={false}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

function BrowserToolbar({
  addressDraft,
  isEditing,
  state,
  currentUrl,
  addressInputRef,
  onAddressChange,
  onAddressFocus,
  onAddressBlur,
  onSubmit,
  onBack,
  onForward,
  onReloadOrStop,
  onOpenExternal,
  locationShortcut,
  reloadShortcut,
  pluginActions,
}: {
  addressDraft: string;
  isEditing: boolean;
  state: RoomDesktopBrowserState | null;
  currentUrl: string;
  addressInputRef: RefObject<HTMLInputElement | null>;
  onAddressChange: (value: string) => void;
  onAddressFocus: () => void;
  onAddressBlur: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
  onForward: () => void;
  onReloadOrStop: () => void;
  onOpenExternal: () => void;
  locationShortcut: AppShortcutPresentation | null;
  reloadShortcut: AppShortcutPresentation | null;
  pluginActions: ReactNode;
}) {
  const isLoading = state?.isLoading ?? false;
  const security = getBrowserUrlSecurity(currentUrl);

  return (
    <div
      data-testid="browser-tab-nav-bar"
      data-state="expanded"
      role="region"
      aria-label="Browser navigation"
      tabIndex={-1}
      className="relative h-11 shrink-0 overflow-hidden bg-sidebar focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring max-md:pointer-coarse:h-[52px]"
    >
      <div
        data-testid="browser-tab-nav-controls"
        className="absolute inset-x-0 top-0 flex h-11 translate-y-0 items-center gap-1 py-1.5 pl-2 pr-4 opacity-100 max-md:pointer-coarse:h-[52px]"
      >
        <BrowserChromeIconButton
          icon="ChevronLeft"
          label="Go back"
          disabled={!state?.canGoBack}
          onClick={onBack}
        />
        <BrowserChromeIconButton
          icon="ChevronRight"
          label="Go forward"
          disabled={!state?.canGoForward}
          onClick={onForward}
        />
        <BrowserChromeIconButton
          icon={isLoading ? "X" : "RotateCcw"}
          label={isLoading ? "Stop loading" : "Reload"}
          shortcut={isLoading ? null : reloadShortcut}
          onClick={onReloadOrStop}
        />
        <form onSubmit={onSubmit} className="min-w-0 flex-1">
          <div className="flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 max-md:pointer-coarse:h-10">
            {security === "secure" ? (
              <Icon
                name="Lock"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-success",
                )}
                aria-label="Secure connection"
              />
            ) : security === "insecure" ? (
              <Icon
                name="AlertTriangle"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-warning",
                )}
                aria-label="Connection not secure"
              />
            ) : (
              <Icon
                name="Search"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-muted-foreground",
                )}
                aria-hidden
              />
            )}
            <input
              ref={addressInputRef}
              type="text"
              value={isEditing ? addressDraft : currentUrl}
              onChange={(e) => onAddressChange(e.target.value)}
              onFocus={onAddressFocus}
              onBlur={onAddressBlur}
              placeholder="Enter a URL"
              aria-label={
                locationShortcut
                  ? `Address and search bar (${locationShortcut.label})`
                  : "Address and search bar"
              }
              aria-keyshortcuts={locationShortcut?.ariaKeyshortcuts}
              autoComplete="off"
              spellCheck={false}
              className={cn(
                "min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground",
                COARSE_POINTER_TEXT_SM_CLASS,
              )}
            />
          </div>
        </form>
        {pluginActions}
        <BrowserChromeIconButton
          icon="ExternalLink"
          label="Open in external browser"
          disabled={currentUrl.length === 0}
          onClick={onOpenExternal}
        />
        {isLoading ? (
          <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
            <span className="block h-full w-1/3 animate-pulse bg-ring/70 motion-reduce:animate-none" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function BrowserPageLoadError({
  errorText,
  url,
  onRetry,
  onOpenExternal,
}: {
  errorText: string;
  url: string;
  onRetry: () => void;
  onOpenExternal: () => void;
}) {
  const local = isLocalOnlyUrl(url);
  const title = local
    ? "Server not reachable"
    : errorText.includes("ERR_BLOCKED_BY_CLIENT")
      ? "Page blocked"
      : "Page unavailable";
  const host = getBrowserUrlHost(url);
  const description = local
    ? `The browser could not reach ${host || "this local server"}. Start the server, then reload.`
    : "The browser could not load this page. Try reloading or opening it externally.";

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex w-full max-w-sm flex-col items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-lg border border-border bg-surface-recessed text-muted-foreground">
          <Icon name="Globe" className="size-6" aria-hidden />
        </span>
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p
            className={cn(
              "mt-1 text-muted-foreground",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
          >
            {description}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-state-hover"
          >
            <Icon name="RotateCcw" className="size-3.5" aria-hidden />
            Reload
          </button>
          <button
            type="button"
            onClick={onOpenExternal}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
            Open externally
          </button>
        </div>
        <p className="max-w-full truncate pt-1 font-mono text-[11px] text-subtle-foreground">
          {errorText}
        </p>
      </div>
    </div>
  );
}

export function BrowserTabContent({
  tabId,
  existingOnly,
  initialUrl,
  addressFocusRequest,
  onAddressFocusRequestConsumed,
  canShowNativeBrowserView,
  canHandleBrowserCommands = canShowNativeBrowserView,
  onNativeFocus,
  visibilityCoordinator,
  environmentId,
  threadId,
  onUpdate,
}: {
  tabId: string;
  existingOnly?: true;
  initialUrl: string;
  addressFocusRequest: BrowserAddressFocusRequest | null;
  onAddressFocusRequestConsumed?: (request: BrowserAddressFocusRequest) => void;
  canShowNativeBrowserView: boolean;
  canHandleBrowserCommands?: boolean;
  onNativeFocus?: () => void;
  visibilityCoordinator: BrowserViewVisibilityCoordinator | null;
  environmentId: string | null;
  threadId: string;
  onUpdate: (args: UpdateBrowserTabArgs) => void;
}) {
  const locationShortcut = useAppCommandShortcut("browser.focusLocation");
  const reloadShortcut = useAppCommandShortcut("browser.reload");
  const findShortcut = useAppCommandShortcut("browser.find");
  const desktopBrowser = useMemo<RoomDesktopBrowserApi | null>(
    () => getDesktopBrowserApi(),
    [],
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const isCoarse = usePointerCoarse();
  const isCompactViewport = useIsCompactViewport();
  const {
    entries: recent,
    recordVisit,
    clear: clearRecent,
  } = useBrowserHistory(threadId);

  const [state, setState] = useState<RoomDesktopBrowserState | null>(null);
  const [control, setControl] = useState<RoomDesktopBrowserControl | null>(
    null,
  );
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [addressDraft, setAddressDraft] = useState(initialUrl);
  const [isEditing, setIsEditing] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<BrowserFindMatches | null>(
    null,
  );
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [attachedKey, setAttachedKey] = useState<string | null>(null);

  const isFindOpenRef = useRef(false);
  const onUpdateRef = useRef(onUpdate);
  const recordVisitRef = useRef(recordVisit);
  useLayoutEffect(() => {
    isFindOpenRef.current = isFindOpen;
    onUpdateRef.current = onUpdate;
    recordVisitRef.current = recordVisit;
  });
  const initialUrlRef = useRef(initialUrl);
  const lastBoundsRef = useRef<RoomDesktopBrowserViewBounds | null>(null);

  const expectedKey = `${environmentId ?? ""}\0${threadId}\0${tabId}`;
  const isAttached = attachedKey === expectedKey;
  const hasPage = currentUrl.length > 0;
  const pageError = state?.errorText ?? null;
  const hasLoadError = pageError !== null && hasPage;
  const dimmingOpen = useIsBrowserDimmingModalOpen();
  const supportsUnfocusedShow =
    desktopBrowser?.focus !== undefined &&
    desktopBrowser.onFocus !== undefined &&
    desktopBrowser.setVisibleWithoutFocus !== undefined;

  const pushBounds = useCallback(
    (force: boolean) => {
      const el = viewportRef.current;
      if (!el || !desktopBrowser) return;
      const next = measureClampedBounds(el);
      if (
        !force &&
        lastBoundsRef.current &&
        sameBounds(lastBoundsRef.current, next)
      ) {
        return;
      }
      lastBoundsRef.current = next;
      desktopBrowser.setBounds({ tabId, bounds: next });
    },
    [desktopBrowser, tabId],
  );
  const syncBoundsForce = useCallback(() => pushBounds(true), [pushBounds]);
  const syncBoundsIfChanged = useCallback(
    () => pushBounds(false),
    [pushBounds],
  );

  // Remote agent control lease listener
  useEffect(() => {
    let active = true;
    let sawEvent = false;
    setControl(null);

    const accept = (msg: {
      tabId: string;
      threadId: string;
      control: RoomDesktopBrowserControl | null;
    }) => {
      if (active && msg.tabId === tabId && msg.threadId === threadId) {
        setControl(msg.control);
      }
    };

    const unsub = desktopBrowser?.onControl?.((msg) => {
      if (msg.tabId !== tabId || msg.threadId !== threadId) return;
      sawEvent = true;
      accept(msg);
    });
    void desktopBrowser
      ?.getControl?.(tabId)
      .then((msg) => {
        if (msg !== null && !sawEvent) accept(msg);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unsub?.();
    };
  }, [desktopBrowser, tabId, threadId]);

  // Attach native browser view & subscribe to state / snapshots / find results
  useEffect(() => {
    if (!desktopBrowser) return;
    const initialBounds = viewportRef.current
      ? measureClampedBounds(viewportRef.current)
      : ZERO_BOUNDS;
    lastBoundsRef.current = viewportRef.current ? initialBounds : null;

    registerBrowserView({ environmentId, tabId, threadId });
    desktopBrowser.attach({
      tabId,
      threadId,
      ...(existingOnly === true ? { existingOnly: true } : {}),
      url: initialUrlRef.current,
      bounds: initialBounds,
      visible: false,
    });
    setAttachedKey(`${environmentId ?? ""}\0${threadId}\0${tabId}`);

    let prevState: RoomDesktopBrowserState | null = null;
    const unsubState = desktopBrowser.onState((next) => {
      if (next.tabId !== tabId) return;
      if (
        prevState &&
        (prevState.url !== next.url || (next.isLoading && !prevState.isLoading))
      ) {
        setFindMatches(null);
      }
      prevState = next;
      setState(next);
      setCurrentUrl(next.url);
      onUpdateRef.current({ tabId, url: next.url, title: next.title });
      if (!next.isLoading && next.url.length > 0) {
        recordVisitRef.current({ url: next.url, title: next.title });
      }
    });

    const unsubSnapshot = desktopBrowser.onSnapshot?.((snap) => {
      if (snap.tabId === tabId) setSnapshotUrl(snap.dataUrl);
    });
    const unsubFind = desktopBrowser.onFindResult?.((res) => {
      if (res.tabId === tabId) {
        setFindMatches({
          activeMatchOrdinal: res.activeMatchOrdinal,
          matches: res.matches,
        });
      }
    });

    return () => {
      unsubState();
      unsubSnapshot?.();
      unsubFind?.();
      if (isFindOpenRef.current) {
        desktopBrowser.stopFindInPage?.({ tabId, action: "clearSelection" });
      }
      visibilityCoordinator?.release(tabId);
    };
  }, [
    desktopBrowser,
    environmentId,
    existingOnly,
    tabId,
    threadId,
    visibilityCoordinator,
  ]);

  // Keep native bounds synced with layout
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !desktopBrowser) return;
    const ro = new ResizeObserver(syncBoundsIfChanged);
    ro.observe(el);
    window.addEventListener(
      BROWSER_VIEW_BOUNDS_SYNC_EVENT,
      syncBoundsIfChanged,
    );
    window.addEventListener("resize", syncBoundsIfChanged);
    return () => {
      ro.disconnect();
      window.removeEventListener(
        BROWSER_VIEW_BOUNDS_SYNC_EVENT,
        syncBoundsIfChanged,
      );
      window.removeEventListener("resize", syncBoundsIfChanged);
    };
  }, [desktopBrowser, syncBoundsIfChanged]);

  const isPaneHidden = useOptionalPaneContext()?.isHidden ?? false;
  const isViewVisible =
    !isPaneHidden &&
    canShowNativeBrowserView &&
    (canHandleBrowserCommands || supportsUnfocusedShow) &&
    hasPage &&
    !hasLoadError &&
    isAttached &&
    !dimmingOpen;

  useNativeBrowserViewShown(isViewVisible);

  useLayoutEffect(() => {
    if (!visibilityCoordinator) return;
    if (isViewVisible) {
      visibilityCoordinator.show(tabId, syncBoundsForce, {
        focus: canHandleBrowserCommands,
      });
      return () => visibilityCoordinator.hide(tabId);
    }
    visibilityCoordinator.hide(tabId);
  }, [
    canHandleBrowserCommands,
    isViewVisible,
    syncBoundsForce,
    tabId,
    visibilityCoordinator,
  ]);

  useEffect(() => {
    if (!desktopBrowser?.onFocus || !onNativeFocus) return;
    return desktopBrowser.onFocus((focusedId) => {
      if (focusedId === tabId) onNativeFocus();
    });
  }, [desktopBrowser, onNativeFocus, tabId]);

  useEffect(() => {
    if (isViewVisible && canHandleBrowserCommands) {
      desktopBrowser?.focus?.(tabId);
    }
  }, [canHandleBrowserCommands, desktopBrowser, isViewVisible, tabId]);

  useEffect(() => {
    if (!addressFocusRequest || addressFocusRequest.tabId !== tabId) return;
    if (isCoarse) {
      onAddressFocusRequestConsumed?.(addressFocusRequest);
      return;
    }
    setAddressDraft(currentUrl);
    setIsEditing(true);
    addressRef.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      addressRef.current?.focus({ preventScroll: true });
      onAddressFocusRequestConsumed?.(addressFocusRequest);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    addressFocusRequest,
    currentUrl,
    isCoarse,
    onAddressFocusRequestConsumed,
    tabId,
  ]);

  const navigateToInput = useCallback(
    (raw: string) => {
      const resolved = resolveBrowserAddressInput(raw);
      if (resolved === null) return;
      setCurrentUrl(resolved);
      setIsEditing(false);
      desktopBrowser?.navigate({ tabId, url: resolved });
    },
    [desktopBrowser, tabId],
  );

  const handleReloadOrStop = useCallback(() => {
    if (state?.isLoading) desktopBrowser?.stop(tabId);
    else desktopBrowser?.reload(tabId);
  }, [desktopBrowser, state?.isLoading, tabId]);

  const handleOpenExternal = useCallback(() => {
    getRoomDesktopInfo()?.openExternalUrl(currentUrl);
  }, [currentUrl]);

  // Find-in-page handlers
  const canFind =
    canShowNativeBrowserView &&
    desktopBrowser !== null &&
    desktopBrowser.findInPage !== undefined &&
    hasPage;

  const runFind = useCallback(
    (args: Omit<RoomDesktopBrowserFindInPageRequest, "tabId">) => {
      desktopBrowser?.findInPage?.({ tabId, ...args });
    },
    [desktopBrowser, tabId],
  );

  const clearFind = useCallback(() => {
    desktopBrowser?.stopFindInPage?.({ tabId, action: "clearSelection" });
    setFindMatches(null);
  }, [desktopBrowser, tabId]);

  useEffect(() => {
    if (isFindOpen && !canFind) {
      setIsFindOpen(false);
      clearFind();
    }
  }, [canFind, clearFind, isFindOpen]);

  useAppCommandHandler(
    "browser.focusLocation",
    useCallback(() => {
      if (!canHandleBrowserCommands || !desktopBrowser) return false;
      setAddressDraft(currentUrl);
      setIsEditing(true);
      addressRef.current?.focus({ preventScroll: true });
      window.requestAnimationFrame(() => {
        addressRef.current?.focus({ preventScroll: true });
        addressRef.current?.select();
      });
      return true;
    }, [canHandleBrowserCommands, currentUrl, desktopBrowser]),
    100,
  );

  useAppCommandHandler(
    "browser.find",
    useCallback(() => {
      if (!canFind) return false;
      setIsFindOpen(true);
      if (findQuery.length > 0) {
        runFind({ text: findQuery, forward: true, newSession: true });
      }
      findRef.current?.focus({ preventScroll: true });
      window.requestAnimationFrame(() => {
        findRef.current?.focus({ preventScroll: true });
        findRef.current?.select();
      });
      return true;
    }, [canFind, findQuery, runFind]),
    100,
  );

  useAppCommandHandler(
    "browser.reload",
    useCallback(() => {
      if (!canHandleBrowserCommands || !desktopBrowser || !hasPage)
        return false;
      desktopBrowser.reload(tabId);
      return true;
    }, [canHandleBrowserCommands, desktopBrowser, hasPage, tabId]),
    100,
  );

  if (!desktopBrowser) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="flex size-11 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
          <Icon name="Globe" className="size-6" aria-hidden />
        </span>
        <div className="text-sm font-medium text-foreground">
          Browser tabs need the desktop app
        </div>
        <p
          className={cn(
            "max-w-xs text-muted-foreground",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        >
          The in-app web browser runs in the Cloudroom desktop app. Open this
          thread there to browse the web.
        </p>
      </div>
    );
  }

  return (
    <div data-app-browser className="flex h-full min-h-0 flex-col">
      <BrowserToolbar
        addressDraft={addressDraft}
        isEditing={isEditing}
        state={state}
        currentUrl={currentUrl}
        addressInputRef={addressRef}
        onAddressChange={setAddressDraft}
        onAddressFocus={() => {
          setAddressDraft(currentUrl);
          setIsEditing(true);
        }}
        onAddressBlur={() => setIsEditing(false)}
        onSubmit={(e) => {
          e.preventDefault();
          navigateToInput(addressDraft);
        }}
        onBack={() => desktopBrowser.goBack(tabId)}
        onForward={() => desktopBrowser.goForward(tabId)}
        onReloadOrStop={handleReloadOrStop}
        onOpenExternal={handleOpenExternal}
        locationShortcut={locationShortcut}
        reloadShortcut={reloadShortcut}
        pluginActions={
          <PluginBrowserToolbarActions
            threadId={threadId}
            tabId={tabId}
            url={currentUrl}
            isCompactViewport={isCompactViewport}
          />
        }
      />

      {control ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-recessed px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">
            {control.controllerLabel} is controlling this tab
          </span>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-state-hover"
            onClick={() => desktopBrowser.releaseControl?.(tabId)}
          >
            Stop
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-state-hover"
            onClick={() => {
              desktopBrowser.releaseControl?.(tabId);
              desktopBrowser.focus?.(tabId);
            }}
          >
            Take over
          </button>
        </div>
      ) : null}

      {isFindOpen ? (
        <BrowserFindBar
          inputRef={findRef}
          query={findQuery}
          matches={findMatches}
          onQueryChange={(raw) => {
            const q = raw.slice(0, ROOM_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH);
            setFindQuery(q);
            if (!q) clearFind();
            else runFind({ text: q, forward: true, newSession: true });
          }}
          onFindNext={() => {
            if (findQuery)
              runFind({ text: findQuery, forward: true, newSession: false });
          }}
          onFindPrevious={() => {
            if (findQuery)
              runFind({ text: findQuery, forward: false, newSession: false });
          }}
          onClose={() => {
            setIsFindOpen(false);
            clearFind();
          }}
          shortcut={findShortcut}
        />
      ) : null}

      <div ref={viewportRef} className="relative min-h-0 flex-1">
        {hasLoadError ? (
          <BrowserPageLoadError
            errorText={pageError}
            url={currentUrl}
            onRetry={handleReloadOrStop}
            onOpenExternal={handleOpenExternal}
          />
        ) : hasPage && !dimmingOpen ? null : (
          <BrowserNewTabScreen
            onNavigateInput={navigateToInput}
            recent={recent}
            onClearRecent={clearRecent}
          />
        )}
        {hasPage && snapshotUrl ? (
          <img
            src={snapshotUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full"
          />
        ) : null}
      </div>
    </div>
  );
}

export function BrowserTabDeck({
  browserTabs,
  activeBrowserTabId,
  addressFocusRequest = null,
  onAddressFocusRequestConsumed,
  environmentId,
  canShowNativeBrowserView,
  canHandleBrowserCommands = canShowNativeBrowserView,
  onNativeFocus,
  threadId,
  onUpdate,
}: {
  browserTabs: readonly BrowserFixedPanelTab[];
  activeBrowserTabId: string | null;
  addressFocusRequest?: BrowserAddressFocusRequest | null;
  onAddressFocusRequestConsumed?: (request: BrowserAddressFocusRequest) => void;
  environmentId: string | null;
  canShowNativeBrowserView: boolean;
  canHandleBrowserCommands?: boolean;
  onNativeFocus?: () => void;
  threadId: string;
  onUpdate: (args: UpdateBrowserTabArgs) => void;
}) {
  const desktopBrowser = useMemo(() => getDesktopBrowserApi(), []);
  const coordinator = useMemo(
    () =>
      desktopBrowser
        ? createBrowserViewVisibilityCoordinator(desktopBrowser)
        : null,
    [desktopBrowser],
  );

  const activeTab = selectActiveBrowserTab(browserTabs, activeBrowserTabId);
  const target = activeTab?.desktopTarget;
  const [verifiedTarget, setVerifiedTarget] =
    useState<RoomDesktopBrowserTarget | null>(null);

  useEffect(() => {
    let alive = true;
    setVerifiedTarget(null);
    if (target?.hostId !== undefined) {
      void desktopBrowser
        ?.getTarget?.()
        .then((actual) => {
          if (alive) setVerifiedTarget(actual);
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [desktopBrowser, target?.generation, target?.hostId, target?.instanceId]);

  if (!activeTab) return null;

  if (
    target &&
    (verifiedTarget?.hostId !== target.hostId ||
      verifiedTarget.instanceId !== target.instanceId ||
      verifiedTarget.generation !== target.generation)
  ) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        This browser tab is unavailable on this desktop connection.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
      <BrowserTabContent
        key={activeTab.id}
        tabId={activeTab.id}
        existingOnly={target ? true : undefined}
        initialUrl={activeTab.url}
        addressFocusRequest={
          addressFocusRequest?.tabId === activeTab.id
            ? addressFocusRequest
            : null
        }
        onAddressFocusRequestConsumed={onAddressFocusRequestConsumed}
        canShowNativeBrowserView={canShowNativeBrowserView}
        canHandleBrowserCommands={canHandleBrowserCommands}
        onNativeFocus={onNativeFocus}
        visibilityCoordinator={coordinator}
        environmentId={environmentId}
        threadId={threadId}
        onUpdate={onUpdate}
      />
    </div>
  );
}
