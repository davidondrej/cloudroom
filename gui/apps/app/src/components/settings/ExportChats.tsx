import { useState } from "react";
import { DropdownMenuItem } from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { appToast } from "@/components/ui/app-toast";
import { SettingsSection } from "@/components/ui/settings-section.js";
import { useExportableChats, useExportChats } from "@/hooks/queries/cloudroom-queries";
import { BUTTON, CARD, Chip, DAY_MS, PALETTE, RANGES } from "./ImportChats";

const SCOPES = [["Local and Cloud", "all"], ["Local", "local"], ["Cloud", "cloud"]] as const;
const FORMATS = [["Markdown", "markdown"], ["JSON", "json"]] as const;

type Option<T> = readonly [string, T];
const label = <T,>(options: readonly Option<T>[], value: T) => options.find(([, each]) => each === value)![0];
const menu = <T,>(options: readonly Option<T>[], value: T, pick: (value: T) => void) => options.map(([name, each]) => (
  <DropdownMenuItem key={name} onSelect={() => pick(each)}>
    <Icon name="Check" className={each === value ? "size-3.5" : "size-3.5 opacity-0"} aria-hidden />
    {name[0]!.toUpperCase() + name.slice(1)}
  </DropdownMenuItem>
));

function ExportChats() {
  const chats = useExportableChats();
  const exportChats = useExportChats();
  const [scope, setScope] = useState<(typeof SCOPES)[number][1]>("all");
  const [days, setDays] = useState<number | null>(null);
  const [format, setFormat] = useState<(typeof FORMATS)[number][1]>("markdown");

  if (chats.error) return <p role="alert" className="text-sm text-destructive">{chats.error.message}</p>;
  const recent = (chats.data?.threads ?? []).filter((thread) => days === null || Date.now() - thread.updatedAt < days * DAY_MS);
  const local = recent.filter((thread) => thread.target === "local").length, cloud = recent.length - local;
  const count = scope === "all" ? recent.length : scope === "local" ? local : cloud;
  const start = () => exportChats.mutate({ scope, days, format }, {
    onSuccess: (result) => appToast.success(`Exported ${result.count.toLocaleString()} chat${result.count === 1 ? "" : "s"} to ${result.folder}`),
    onError: (error) => appToast.error(error.message),
  });

  return (
    <div style={PALETTE} className={CARD}>
      <p className="text-[21px] leading-[1.85] font-medium">
        Export my{" "}
        <Chip menu={menu(SCOPES, scope, setScope)}>
          {scope !== "cloud" && <Icon name="Laptop" className="size-5" aria-hidden />}
          {scope !== "local" && <Icon name="Cloud" className="size-5" aria-hidden />}
          {label(SCOPES, scope)}
        </Chip>{" "}
        chats
        <br />
        from <Chip menu={menu(RANGES, days, setDays)}>{label(RANGES, days)}</Chip> as <Chip menu={menu(FORMATS, format, setFormat)}>{label(FORMATS, format)}</Chip>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" disabled={!count || exportChats.isPending} onClick={start} className={BUTTON}>
          <Icon name={exportChats.isPending ? "Loading" : "Download"} className={exportChats.isPending ? "size-4 animate-spin" : "size-4"} aria-hidden />
          {exportChats.isPending ? `Exporting ${count.toLocaleString()} chats…` : `Export ${count.toLocaleString()} chat${count === 1 ? "" : "s"}`}
        </button>
        <span className="text-sm whitespace-nowrap text-(--ic-muted)">{chats.isPending ? "Counting chats…" : `${local.toLocaleString()} Local · ${cloud.toLocaleString()} Cloud · archived included`}</span>
      </div>
    </div>
  );
}

export function ExportChatsSettingsSection() {
  return (
    <SettingsSection
      title="Export chats"
      description="Save a copy of your threads in your Downloads folder: one file per thread, in a folder per project. Markdown keeps the messages. JSON keeps everything, tool calls included."
    >
      <ExportChats />
    </SettingsSection>
  );
}
