import type { IconName } from "@cloudroom/shared-ui/icon";
import { Icon } from "@cloudroom/shared-ui/icon";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";

export function getFileNameFromPath({ path }: { path: string }): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) || path : path;
}

export function resolveRightPanelFileIconName(path: string): IconName {
  const fileName = getFileNameFromPath({ path });
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";

  const isMarkdown = ext === "md" || ext === "markdown";
  const isHtml = ext === "html" || ext === "htm";

  if (isMarkdown || isHtml) {
    const dirs = path.toLowerCase().split("/").slice(0, -1);
    if (dirs.includes("reports")) return "ChartColumn";
    return isMarkdown ? "File" : "AppWindow";
  }

  return "Code";
}

export function RightPanelFileTabIcon({ path }: { path: string }) {
  return (
    <Icon
      name={resolveRightPanelFileIconName(path)}
      className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
      aria-hidden
    />
  );
}
