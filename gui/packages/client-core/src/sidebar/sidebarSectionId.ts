export type SidebarSectionId =
  | "pinned"
  | "threads"
  | `project:${string}`
  | `section:${string}`
  | `machine:${string}`
  | `harness:${string}`;
export type CollapsibleSidebarSectionId = "pinned" | "threads";
