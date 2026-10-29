import { useEffect, useRef } from "react";
import { appToast } from "@/components/ui/app-toast";
import { useSystemVersion } from "@/hooks/queries/system-queries";

const TOAST_ID = "server-updated";

function composerHasContent(): boolean {
  return (
    [...document.querySelectorAll("[data-promptbox-editor-content]")].some(
      (editor) => editor.textContent?.trim(),
    ) || document.querySelector("[data-promptbox-attachments]") !== null
  );
}

export function useServerUpdateReload(): void {
  const version = useSystemVersion().data?.desktopVersion;
  const loaded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!version) return;
    loaded.current ??= version;
    if (version === loaded.current) return;
    if (!composerHasContent()) {
      window.location.reload();
      return;
    }
    appToast.message("Cloudroom was updated", {
      id: TOAST_ID,
      duration: Infinity,
      description: `Reload to use ${version}.`,
      action: { label: "Reload", onClick: () => window.location.reload() },
    });
  }, [version]);
}
