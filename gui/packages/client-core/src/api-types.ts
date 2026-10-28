import type { ThreadOriginKind } from "@cloudroom/domain";
import type { CreateThreadRequest } from "@cloudroom/server-contract";

export type AppCreateThreadRequest = Omit<
  CreateThreadRequest,
  "origin" | "startedOnBehalfOf" | "originKind"
> &
  Partial<Pick<CreateThreadRequest, "startedOnBehalfOf" | "originKind">>;

export interface ThreadListFilters {
  projectId?: string;
  parentThreadId?: string;
  sourceThreadId?: string;
  sectionId?: string;
  unsectioned?: boolean;
  hasParent?: boolean;
  originKind?: ThreadOriginKind;
  archived: boolean;
  limit?: number;
  offset?: number;
}

export interface ThreadSearchFilters {
  query: string;
  limitPerGroup?: number;
}
