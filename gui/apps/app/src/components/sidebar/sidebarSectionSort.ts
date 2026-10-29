import { useCallback } from "react";
import { useAtomValue } from "jotai";
import type { SidebarSectionSort } from "@cloudroom/domain";
import type { SidebarSectionId, ThreadComparator } from "@cloudroom/client-core";
import {
  sidebarChronologicalSortAtom,
  sidebarSectionSortsAtom,
  sidebarSortDirectionAtom,
} from "./sidebarCollapsedAtoms";

export type { SidebarSectionSort };

export type SidebarSectionComparator = (
  sectionId: SidebarSectionId,
) => ThreadComparator;

export function getDefaultSortDirection(
  sort: SidebarSectionSort["sort"],
): SidebarSectionSort["direction"] {
  return sort === "alpha" || sort === "manual" ? "ascending" : "descending";
}

/** Each section keeps its own sort. Unsaved sections fall back to the old global sort. */
export function useSidebarSectionSort(): (
  sectionId: SidebarSectionId,
) => SidebarSectionSort {
  const sorts = useAtomValue(sidebarSectionSortsAtom);
  const globalSort = useAtomValue(sidebarChronologicalSortAtom);
  const globalDirection = useAtomValue(sidebarSortDirectionAtom);
  return useCallback(
    (sectionId) => {
      const saved = sorts[sectionId];
      if (saved) return saved;
      const sort = globalSort === "none" ? "updated" : globalSort;
      return {
        sort,
        direction:
          globalDirection === "default"
            ? getDefaultSortDirection(sort)
            : globalDirection,
      };
    },
    [globalDirection, globalSort, sorts],
  );
}
