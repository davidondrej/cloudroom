import { createContext, useContext } from "react";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";

const SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR =
  "[data-sidebar-thread-shortcut-target]";

export const SIDEBAR_WINDOWED_NAV_ATTRIBUTE = "data-sidebar-windowed-nav";

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
  includeWindowedPlaceholders: boolean,
): SidebarThreadShortcutTarget[] {
  if (!root) {
    return [];
  }

  const selector = includeWindowedPlaceholders
    ? `${SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR}, [${SIDEBAR_WINDOWED_NAV_ATTRIBUTE}]`
    : SIDEBAR_THREAD_SHORTCUT_TARGET_SELECTOR;
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
      const encoded = element.getAttribute(SIDEBAR_WINDOWED_NAV_ATTRIBUTE);
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
  return collectSidebarThreadTargets(root, MAX_SIDEBAR_THREAD_SHORTCUTS, false);
}

export function getSidebarThreadNavigationTargets(
  root: HTMLElement | null,
): SidebarThreadShortcutTarget[] {
  return collectSidebarThreadTargets(root, Number.POSITIVE_INFINITY, true);
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

export function useSidebarThreadShortcut(
  threadId: string,
): SidebarThreadShortcutPresentation | undefined {
  return useContext(SidebarThreadShortcutKeysContext).get(threadId);
}
