import type { IconName } from "@cloudroom/shared-ui/icon";

export const CLOUDROOM_LOCAL_PRIMARY = "Local";
export const CLOUDROOM_LOCAL_WORKTREE = "Local Worktree";
export const CLOUDROOM_CLOUD_PRIMARY = "Cloud";
export const CLOUDROOM_CLOUD_WORKTREE = "Cloud Worktree";

export function cloudroomEnvironmentPresentation(
  providerId: string | null | undefined,
  place: "local" | "cloud",
): { label: string; icon: IconName } | null {
  if (providerId === "project-checkout") {
    return place === "cloud"
      ? { label: CLOUDROOM_CLOUD_PRIMARY, icon: "Cloud" }
      : { label: CLOUDROOM_LOCAL_PRIMARY, icon: "Laptop" };
  }
  if (providerId === "git-worktree") {
    return place === "cloud"
      ? { label: CLOUDROOM_CLOUD_WORKTREE, icon: "Cloud" }
      : { label: CLOUDROOM_LOCAL_WORKTREE, icon: "Laptop" };
  }
  return null;
}
