import { useState } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useSystemVersion } from "@/hooks/queries/system-queries";
import { useDesktopUpdate, useInstallDesktopUpdate } from "@/hooks/queries/cloudroom-queries";
import { CHROME_ROW_CLASS, getBbDesktopInfo } from "@/lib/bb-desktop";

export function CloudroomVersionMark() {
  const app = getBbDesktopInfo()?.version;
  const live = useSystemVersion().data?.desktopVersion;
  const [server, setServer] = useState<string>();
  if (live && server === undefined) setServer(live);
  if (app === undefined || app.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-2 bottom-1 z-[48] select-none text-[9px] leading-none text-neutral-500">
      <DesktopUpdateNote />
      {server && server !== app ? `server ${server} · app ${app}` : app}
    </div>
  );
}

function DesktopUpdateNote() {
  const update = useDesktopUpdate().data;
  const install = useInstallDesktopUpdate();
  if (!update) return null;
  if (update.installing || install.isPending || install.isSuccess) return <>restarting for {update.version} · </>;
  const when = update.minutes === null ? "after agents finish" : `in ~${update.minutes} min`;
  return (
    <>
      {update.version} installs {when} ·{" "}
      <button type="button" className="pointer-events-auto underline-offset-2 hover:text-foreground hover:underline" onClick={() => install.mutate()}>
        restart now
      </button>
      {" · "}
    </>
  );
}

export function CompactHeaderVersionMark() {
  const version = useSystemVersion().data?.desktopVersion;
  if (version === undefined || version.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        CHROME_ROW_CLASS,
        "pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-10 justify-center select-none text-[10px] leading-none text-muted-foreground/60",
      )}
    >
      {version}
    </div>
  );
}
