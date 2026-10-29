import { COMPUTER } from "@cloudroom/domain";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { appToast } from "@/components/ui/app-toast";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import { getThreadRoutePath } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";

export function SharedThreadOpener() {
  const navigate = useNavigate();
  useEffect(() => {
    const desktop = getBbDesktopInfo();
    if (!desktop?.onOpenLink) return;
    return desktop.onOpenLink((url) => {
      if (!url.startsWith("cloudroom://share/")) return;
      if (!window.confirm(`Continue a shared thread?\n\nSomeone else wrote it. An agent on this ${COMPUTER} will read their messages. Only continue links from people you trust.`)) return;
      const toast = appToast.loading("Copying the shared thread…");
      void sdk.cloudroom.continueShare(url).then(
        (thread) => {
          appToast.dismiss(toast);
          void navigate(getThreadRoutePath(thread));
        },
        (error: unknown) => {
          appToast.dismiss(toast);
          appToast.error("Couldn't copy the shared thread", { description: error instanceof Error ? error.message : String(error) });
        },
      );
    });
  }, [navigate]);
  return null;
}
