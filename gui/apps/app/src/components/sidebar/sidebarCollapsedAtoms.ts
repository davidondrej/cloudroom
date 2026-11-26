import {
  PERSONAL_PROJECT_ID,
  type SidebarChronologicalSort,
  type SidebarOrganizationMode,
} from "@cloudroom/domain";
import { atom } from "jotai";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

export type {
  CollapsibleSidebarSectionId,
  SidebarSectionId,
} from "@cloudroom/client-core";

export type { SidebarChronologicalSort, SidebarOrganizationMode };

export const collapsedProjectIdsAtom = createSyncedPreferenceAtom(
  "sidebar.collapsedProjects",
);

export const collapsedThreadIdsAtom = createSyncedPreferenceAtom(
  "sidebar.collapsedThreads",
);

export const collapseChildThreadsAtom = createSyncedPreferenceAtom(
  "sidebar.collapseChildThreads",
);

export const showSubagentBarAtom = createSyncedPreferenceAtom(
  "appearance.showSubagentBar",
);

export const expandedThreadIdsAtom = createSyncedPreferenceAtom(
  "sidebar.expandedThreads",
);

export const collapsedSidebarSectionIdsAtom = createSyncedPreferenceAtom(
  "sidebar.collapsedSections",
);

export const sidebarSectionOrderAtom = createSyncedPreferenceAtom(
  "sidebar.sectionOrder",
);

export const sidebarManualSectionOrderAtom = createSyncedPreferenceAtom(
  "sidebar.manualSectionOrder",
);

export const sidebarMachineSectionOrderAtom = createSyncedPreferenceAtom(
  "sidebar.machineSectionOrder",
);

export const sidebarHarnessSectionOrderAtom = createSyncedPreferenceAtom(
  "sidebar.harnessSectionOrder",
);

export const sidebarOrganizationModeAtom = createSyncedPreferenceAtom(
  "sidebar.organizationMode",
);

export const sidebarChronologicalSortAtom = createSyncedPreferenceAtom(
  "sidebar.chronologicalSort",
);

export const sidebarSortDirectionAtom = createSyncedPreferenceAtom(
  "sidebar.sortDirection",
);

export const sidebarSectionSortsAtom = createSyncedPreferenceAtom(
  "sidebar.sectionSorts",
);

export const sidebarCollapsedThreadSectionsAtom = createSyncedPreferenceAtom(
  "sidebar.collapsedThreadSections",
);

export const sidebarCollapsedMachinesAtom = createSyncedPreferenceAtom(
  "sidebar.collapsedMachines",
);

export const sidebarCollapsedHarnessesAtom = createSyncedPreferenceAtom(
  "sidebar.collapsedHarnesses",
);

export const revealedSelectedThreadKeyAtom = atom<string | null>(null);

export interface SidebarProjectRevealRequest {
  id: number;
  projectId: string;
}

export const sidebarProjectRevealRequestAtom =
  atom<SidebarProjectRevealRequest | null>(null);

let nextSidebarProjectRevealId = 0;

export const requestSidebarProjectRevealAtom = atom(
  null,
  (_get, set, projectId: string) => {
    nextSidebarProjectRevealId += 1;
    set(sidebarProjectRevealRequestAtom, {
      id: nextSidebarProjectRevealId,
      projectId,
    });
  },
);

export type SidebarProjectRevealState =
  | { status: "idle" }
  | { status: "waiting-expand" }
  | { status: "skip"; id: number }
  | { status: "ready"; id: number; projectId: string };

const IDLE_SIDEBAR_PROJECT_REVEAL_STATE: SidebarProjectRevealState = {
  status: "idle",
};

const WAITING_EXPAND_SIDEBAR_PROJECT_REVEAL_STATE: SidebarProjectRevealState = {
  status: "waiting-expand",
};

export const sidebarProjectRevealStateAtom = atom<SidebarProjectRevealState>(
  (get) => {
    const request = get(sidebarProjectRevealRequestAtom);
    if (request === null) return IDLE_SIDEBAR_PROJECT_REVEAL_STATE;
    if (get(sidebarOrganizationModeAtom) !== "project") {
      return { status: "skip", id: request.id };
    }
    const isCollapsed =
      request.projectId === PERSONAL_PROJECT_ID
        ? get(collapsedSidebarSectionIdsAtom).includes("threads")
        : get(collapsedProjectIdsAtom).includes(request.projectId);
    if (isCollapsed) return WAITING_EXPAND_SIDEBAR_PROJECT_REVEAL_STATE;
    return { status: "ready", id: request.id, projectId: request.projectId };
  },
);
