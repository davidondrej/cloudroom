import { createContext, useContext } from "react";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";

const SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR =
  "[data-sidebar-thread-shortcut-target]";

export const SIDEBAR_WINDOWED_NAV_ATTRIBUTE = "data-sidebar-windowed-nav";

/** Threads of a collapsed section that still take Cmd+1–9 (the Pinned section). */
export const SIDEBAR_COLLAPSED_NAV_ATTRIBUTE = "data-sidebar-collapsed-nav";

export interface SidebarWindowedNavigationEntry {
  threadId: string;
  projectId: string;
  isChild?: boolean;
}

export function encodeSidebarWindowedNavigationEntries(
  entries: readonly SidebarWindowedNavigationEntry[],
): string {
  return entries
    .map(
      (entry) =>
        `${entry.threadId}:${entry.projectId}${entry.isChild ? ":child" : ""}`,
    )
    .join(" ");
}

const MAX_SIDEBAR_THREAD_SHORTCUTS = 9;

export interface SidebarThreadShortcutTarget {
  element: HTMLAnchorElement | null;
  key: string;
  threadId: string;
  projectId: string | null;
  isChild: boolean;
}

export type SidebarThreadShortcutPresentation = AppShortcutPresentation;

export const EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS: ReadonlyMap<
  string,
  SidebarThreadShortcutPresentation
> = new Map();

export const SidebarThreadShortcutKeysContext = createContext<
  ReadonlyMap<string, SidebarThreadShortcutPresentation>
>(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);

function collectSidebarThreadTargets(
  root: HTMLElement | null,
  limit: number,
  placeholderAttribute: string,
): SidebarThreadShortcutTarget[] {
  if (!root) {
    return [];
  }

  const selector = `${SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR}, [${placeholderAttribute}]`;
  const elements = root.querySelectorAll<HTMLElement>(selector);
  const targets: SidebarThreadShortcutTarget[] = [];

  for (const element of elements) {
    if (element instanceof HTMLAnchorElement) {
      const threadId = element.dataset.sidebarThreadId;
      if (!threadId) {
        continue;
      }
      targets.push({
        element,
        key: String(targets.length + 1),
        threadId,
        projectId: element.dataset.sidebarProjectId ?? null,
        isChild: element.dataset.sidebarThreadChild !== undefined,
      });
    } else {
      const encoded = element.getAttribute(placeholderAttribute);
      if (!encoded) {
        continue;
      }
      for (const pair of encoded.split(" ")) {
        const [threadId, projectId, childFlag] = pair.split(":");
        if (!threadId || !projectId) {
          continue;
        }
        targets.push({
          element: null,
          key: String(targets.length + 1),
          threadId,
          projectId,
          isChild: childFlag === "child",
        });
        if (targets.length === limit) {
          break;
        }
      }
    }
    if (targets.length === limit) {
      break;
    }
  }

  return targets;
}

export function getSidebarThreadShortcutTargets(
  root: HTMLElement | null,
): SidebarThreadShortcutTarget[] {
  return collectSidebarThreadTargets(
    root,
    MAX_SIDEBAR_THREAD_SHORTCUTS,
    SIDEBAR_COLLAPSED_NAV_ATTRIBUTE,
  );
}

export function getSidebarThreadNavigationTargets(
  root: HTMLElement | null,
): SidebarThreadShortcutTarget[] {
  return collectSidebarThreadTargets(
    root,
    Number.POSITIVE_INFINITY,
    SIDEBAR_WINDOWED_NAV_ATTRIBUTE,
  );
}

const MAX_REVEAL_FRAMES = 30;

const MAX_STICKY_ADJUSTMENTS = 10;

function getStickyTierOverlap(root: HTMLElement, row: HTMLElement): number {
  const { top: rowTop, bottom: rowBottom } = row.getBoundingClientRect();
  let coveredBottom = rowTop;
  for (const tier of root.querySelectorAll("[data-sidebar-sticky-tier]")) {
    if (tier.contains(row)) continue;
    const rect = tier.getBoundingClientRect();
    const shield = parseFloat(getComputedStyle(tier, "::after").height) || 0;
    if (rect.top >= rowBottom || rect.bottom + shield <= rowTop) continue;
    coveredBottom = Math.max(coveredBottom, rect.bottom + shield);
  }
  return coveredBottom - rowTop;
}

function scrollRowBelowStickyTiers(root: HTMLElement, row: HTMLElement): void {
  const scroller = row.closest('[data-sidebar="content"]');
  if (!scroller) return;
  for (let attempt = 0; attempt < MAX_STICKY_ADJUSTMENTS; attempt++) {
    const overlap = getStickyTierOverlap(root, row);
    if (overlap <= 0.5) return;
    const scrollTop = scroller.scrollTop;
    scroller.scrollTop = scrollTop - overlap;
    if (scroller.scrollTop === scrollTop) return;
  }
}

export function revealSidebarThread(
  root: HTMLElement | null,
  threadId: string,
  framesLeft = MAX_REVEAL_FRAMES,
): void {
  if (!root) return;
  const row = [
    ...root.querySelectorAll<HTMLAnchorElement>(
      SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR,
    ),
  ].find((element) => element.dataset.sidebarThreadId === threadId);
  if (row) {
    row.scrollIntoView({ block: "nearest" });
    scrollRowBelowStickyTiers(root, row);
    return;
  }
  const placeholder = [
    ...root.querySelectorAll(`[${SIDEBAR_WINDOWED_NAV_ATTRIBUTE}]`),
  ].find((element) =>
    element
      .getAttribute(SIDEBAR_WINDOWED_NAV_ATTRIBUTE)
      ?.split(" ")
      .some((pair) => pair.startsWith(`${threadId}:`)),
  );
  placeholder?.scrollIntoView({ block: "nearest" });
  if (framesLeft > 0) {
    requestAnimationFrame(() =>
      revealSidebarThread(root, threadId, framesLeft - 1),
    );
  }
}

function findSidebarProjectSection(
  root: HTMLElement,
  projectId: string,
): HTMLElement | null {
  if (projectId === PERSONAL_PROJECT_ID) {
    return root.querySelector<HTMLElement>(
      '[data-sidebar-section-id="threads"]',
    );
  }
  return (
    [
      ...root.querySelectorAll<HTMLElement>(
        "[data-sidebar-sticky-project-item][data-sidebar-project-id]",
      ),
    ].find((element) => element.dataset.sidebarProjectId === projectId) ?? null
  );
}

function scrollProjectSectionToTop(section: HTMLElement): void {
  section.scrollIntoView({ block: "start" });
  const scroller = section.closest<HTMLElement>('[data-sidebar="content"]');
  const stack = section.closest<HTMLElement>("[data-sidebar-sticky-stack]");
  if (!scroller || !stack) return;
  const paddingTop = parseFloat(getComputedStyle(stack).paddingTop) || 0;
  // A plugin row (the Director) pins above the labels and covers the top.
  const topSlot =
    stack.querySelector<HTMLElement>("[data-sidebar-top-slot]")?.offsetHeight ??
    0;
  const overlap =
    scroller.getBoundingClientRect().top +
    paddingTop +
    topSlot -
    section.getBoundingClientRect().top;
  if (overlap > 0.5) {
    scroller.scrollTop = Math.max(0, scroller.scrollTop - overlap);
  }
}

export function revealSidebarProject(
  root: HTMLElement | null,
  projectId: string,
  onDone?: () => void,
  framesLeft = MAX_REVEAL_FRAMES,
): () => void {
  if (!root) {
    onDone?.();
    return () => {};
  }
  let cancelled = false;
  let frameId: number | null = null;
  const attempt = (remaining: number) => {
    if (cancelled) return;
    const section = findSidebarProjectSection(root, projectId);
    if (section) {
      scrollProjectSectionToTop(section);
      onDone?.();
      return;
    }
    if (remaining > 0) {
      frameId = requestAnimationFrame(() => attempt(remaining - 1));
      return;
    }
    onDone?.();
  };
  attempt(framesLeft);
  return () => {
    cancelled = true;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
    }
  };
}

export function useSidebarThreadShortcut(
  threadId: string,
): SidebarThreadShortcutPresentation | undefined {
  return useContext(SidebarThreadShortcutKeysContext).get(threadId);
}
