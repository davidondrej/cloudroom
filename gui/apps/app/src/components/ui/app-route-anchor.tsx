import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  matchPath,
  Router,
  UNSAFE_createBrowserHistory as createBrowserHistory,
  useNavigate,
  type NavigateOptions,
} from "react-router";
import { useStore } from "jotai";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { isRoutePath, resolveRouteHref } from "@/lib/route-paths";
import { markThreadNavigation } from "@/lib/perf";
import { getDesktopBrowserApi } from "@/lib/room-desktop";
import { openPaneContentInSplit } from "@/lib/split-layout/openPaneContentInSplit";
import { paneContentForPathname } from "@/views/thread-detail/splitThreadNavigation";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { usePublishPluginDetailOpener } from "@/components/plugin/plugin-detail-opener";

interface RouteNavigationProviderProps {
  children: ReactNode;
}

interface RouteAnchorProps extends Omit<ComponentPropsWithoutRef<"a">, "href"> {
  href: string | undefined;
}

interface ShouldHandleRouteAnchorClickArgs {
  event: ReactMouseEvent<HTMLAnchorElement>;
}

interface RouteNavigateOptions {
  replace?: boolean;
  state?: NavigateOptions["state"];
}

type RouteNavigate = (path: string, options?: RouteNavigateOptions) => void;

interface RouteNavigation {
  navigate: RouteNavigate;
  openInSplit: (path: string) => boolean;
}

// A thread route change still rendering after this gets a default-priority copy.
const ROUTE_TRANSITION_BUDGET_MS = 300;

/**
 * BrowserRouter, except a slow thread route change can't be starved: React
 * restarts a transition on every sync update (a plugin's useSyncExternalStore
 * ticker), so a cached big thread could wait for React's 5 s transition expiry.
 * Default updates never interrupt a running transition, so this only takes
 * over after an interruption.
 */
export function AppBrowserRouter({ children }: { children: ReactNode }) {
  const [history] = useState(() => createBrowserHistory({ v5Compat: true }));
  const [route, setRoute] = useState({
    action: history.action,
    location: history.location,
  });
  useLayoutEffect(() => {
    let latest: object | null = null;
    return history.listen(({ action, location }) => {
      const next = { action, location };
      latest = next;
      const content = paneContentForPathname(location.pathname);
      const threadId =
        content?.kind === "thread"
          ? content.threadId
          : (matchPath(
              { path: "/threads/:threadId", end: false },
              location.pathname,
            )?.params.threadId ?? null);
      markThreadNavigation(threadId);
      startTransition(() => setRoute(next));
      // Other pages can be lazy: a default update would swap them for a blank fallback.
      if (threadId === null) return;
      window.setTimeout(() => {
        // Checked again at render: a later navigation can land before React runs this update.
        if (latest === next)
          setRoute((current) => (latest === next ? next : current));
      }, ROUTE_TRANSITION_BUDGET_MS);
    });
  }, [history]);
  return (
    <Router
      location={route.location}
      navigationType={route.action}
      navigator={history}
    >
      {children}
    </Router>
  );
}

const RouteNavigationContext = createContext<RouteNavigation | null>(null);
const PluginDetailRouteNavigationContext = createContext<
  ((pluginId: string) => boolean) | null
>(null);

const RouteNavigationPendingContext = createContext(false);

export function useIsRouteNavigationPending(): boolean {
  return useContext(RouteNavigationPendingContext);
}

export function useRouteNavigate(): RouteNavigate {
  return (
    useContext(RouteNavigationContext)?.navigate ?? navigateWithoutProvider
  );
}

function navigateWithoutProvider(path: string): void {
  throw new Error(
    `useRouteNavigate: no <RouteNavigationProvider> above the caller (navigating to "${path}")`,
  );
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

function shouldHandleRouteAnchorClick({
  event,
}: ShouldHandleRouteAnchorClickArgs): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false;
  }

  const target = event.currentTarget.getAttribute("target");
  return target === null || target === "" || target === "_self";
}

export function RouteNavigationProvider({
  children,
}: RouteNavigationProviderProps) {
  const navigate = useNavigate();
  const store = useStore();
  const isCompact = useIsCompactViewport();
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const [isNavigationPending, startNavigationTransition] = useTransition();
  const navigateRoute = useCallback<RouteNavigate>(
    (path, options) => {
      startNavigationTransition(() => {
        if (options === undefined) {
          navigateRef.current(path);
          return;
        }
        navigateRef.current(path, options);
      });
    },
    [startNavigationTransition],
  );
  const openInSplit = useCallback<RouteNavigation["openInSplit"]>(
    (path) => {
      const content = paneContentForPathname(path.split(/[?#]/)[0] ?? path);
      if (content === null) return false;
      openPaneContentInSplit({
        store,
        navigate: navigateRoute,
        content,
        route: path,
        enabled: !isCompact,
      });
      return true;
    },
    [isCompact, navigateRoute, store],
  );
  useEffect(() => {
    const browserApi = getDesktopBrowserApi();
    if (browserApi === null) {
      return;
    }
    return browserApi.onOpenTab(({ url }) => {
      if (!isRoutePath({ path: url })) {
        return;
      }
      navigateRoute(url);
    });
  }, [navigateRoute]);

  const value = useMemo<RouteNavigation>(
    () => ({ navigate: navigateRoute, openInSplit }),
    [navigateRoute, openInSplit],
  );
  return (
    <RouteNavigationContext.Provider value={value}>
      <RouteNavigationPendingContext.Provider value={isNavigationPending}>
        {children}
      </RouteNavigationPendingContext.Provider>
    </RouteNavigationContext.Provider>
  );
}

export function PluginDetailRouteNavigationProvider({
  children,
  onOpenPluginDetail,
}: {
  children: ReactNode;
  onOpenPluginDetail: (pluginId: string) => boolean;
}) {
  const pane = useOptionalPaneContext();
  usePublishPluginDetailOpener(
    ({ pluginId }) => onOpenPluginDetail(pluginId),
    pane?.isFocused ?? true,
  );
  return (
    <PluginDetailRouteNavigationContext.Provider value={onOpenPluginDetail}>
      {children}
    </PluginDetailRouteNavigationContext.Provider>
  );
}

export function useRouteAnchorDelegate(): (
  event: ReactMouseEvent<HTMLElement>,
) => void {
  const navigation = useContext(RouteNavigationContext);
  const openPluginDetail = useContext(PluginDetailRouteNavigationContext);
  return useCallback(
    (event) => {
      if (navigation === null || event.defaultPrevented) return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (anchor === null || !event.currentTarget.contains(anchor)) return;
      const target = anchor.getAttribute("target");
      if (target !== null && target !== "" && target !== "_self") return;
      if (event.button !== 0 || event.altKey || event.shiftKey) return;
      const origin = currentOrigin();
      if (origin === null) return;
      const route = resolveRouteHref({
        currentOrigin: origin,
        href: anchor.getAttribute("href") ?? "",
      });
      if (route === null) return;
      const content = paneContentForPathname(
        route.path.split(/[?#]/)[0] ?? route.path,
      );
      if (
        content?.kind === "plugin-detail" &&
        openPluginDetail?.(content.pluginId)
      ) {
        event.preventDefault();
        return;
      }
      const opensBeside =
        event.metaKey || event.ctrlKey || content?.kind === "plugin-detail";
      if (opensBeside) {
        if (navigation.openInSplit(route.path)) event.preventDefault();
        return;
      }
      event.preventDefault();
      navigation.navigate(route.path);
    },
    [navigation, openPluginDetail],
  );
}

export function RouteAnchor({
  href,
  onClick,
  rel,
  target,
  ...anchorProps
}: RouteAnchorProps) {
  const navigation = useContext(RouteNavigationContext);
  const route = useMemo(() => {
    const origin = currentOrigin();
    return origin === null || href === undefined
      ? null
      : resolveRouteHref({ currentOrigin: origin, href });
  }, [href]);
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>): void => {
      onClick?.(event);
      if (
        route === null ||
        navigation === null ||
        !shouldHandleRouteAnchorClick({ event })
      ) {
        return;
      }

      event.preventDefault();
      navigation.navigate(route.path);
    },
    [navigation, onClick, route],
  );

  return (
    <a
      {...anchorProps}
      href={href}
      rel={route === null ? rel : undefined}
      target={route === null ? target : undefined}
      onClick={handleClick}
    />
  );
}
