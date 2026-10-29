import type {
  SidebarChronologicalSort,
  SidebarOrganizationMode,
} from "@cloudroom/domain";
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
