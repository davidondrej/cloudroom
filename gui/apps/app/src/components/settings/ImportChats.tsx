import { COMPUTER } from "@cloudroom/domain";
import { useState, type CSSProperties, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { appToast } from "@/components/ui/app-toast";
import { SettingsSection } from "@/components/ui/settings-section.js";
import { useImportSessions, useNativeSessions } from "@/hooks/queries/cloudroom-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";

export const DAY_MS = 86_400_000;
const APPS = [["claude-code", "Claude Code"], ["codex", "Codex"], ["pi", "Pi"], ["acp-hermes-agent", "Hermes"], ["t3code", "T3 Code"]] as const;
export const RANGES = [["last 7 days", 7], ["last 30 days", 30], ["all time", null]] as const;
export const PALETTE = {
  "--ic-ink": "var(--ob-ink, var(--foreground))",
  "--ic-card": "var(--ob-card, var(--card))",
  "--ic-muted": "var(--ob-muted, var(--muted-foreground))",
  "--ic-lime": "var(--ob-lime, var(--primary))",
  "--ic-bg": "var(--ob-bg, var(--background))",
} as CSSProperties;
export const CARD = "border-[1.5px] border-(--ic-ink) bg-(--ic-card) px-6 py-5 text-(--ic-ink) shadow-[6px_6px_0_var(--ic-lime)]";
export const BUTTON = "inline-flex h-[46px] items-center justify-center gap-2 bg-(--ic-ink) px-6 text-[15px] font-semibold whitespace-nowrap text-(--ic-bg) transition-opacity hover:opacity-90 disabled:opacity-40";
const CHIP = "mx-0.5 my-1 inline-flex items-center gap-2 border-[1.5px] border-(--ic-ink) bg-(--ic-card) px-3 py-0.5 align-middle font-semibold whitespace-nowrap shadow-[inset_0_-5px_0_var(--ic-lime)] hover:bg-(--ic-bg)";

type Harness = (typeof APPS)[number][0];

function AppLogo({ id }: { id: Harness }) {
  const provider = useSystemProviders().data?.find((entry) => entry.id === id);
  const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
  return <span className="flex shrink-0" style={provider && getProviderIconTintStyle(provider)}><Logo className="size-5" /></span>;
}

export function Chip({ children, menu }: { children: ReactNode; menu: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={CHIP}>
          {children}
          <Icon name="ChevronDown" className="size-3.5" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{menu}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ImportChats({ onStart, empty }: { onStart?: () => void; empty?: ReactNode }) {
  const sessions = useNativeSessions();
  const importSessions = useImportSessions();
  const { localHostId } = useHostDaemon();
  const [days, setDays] = useState<number | null>(30);
  const [off, setOff] = useState<Set<Harness>>(new Set());
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  if (sessions.isPending) return <p className="text-sm text-(--ic-muted)" style={PALETTE}>Looking for chats on this {COMPUTER}…</p>;
  if (sessions.error) return <p role="alert" className="text-sm text-destructive">{sessions.error.message}</p>;
  const list = sessions.data.sessions;
  const apps = APPS.filter(([id]) => list.some((session) => session.harness === id));
  if (!apps.length) return empty ?? <p className="text-sm text-(--ic-muted)" style={PALETTE}>No new agent chats on this {COMPUTER}.</p>;

  const recent = list.filter((session) => days === null || Date.now() - session.updatedAt < days * DAY_MS);
  const picked = apps.filter(([id]) => !off.has(id));
  const chosen = recent.filter((session) => !off.has(session.harness));
  const count = (id: Harness) => recent.filter((session) => session.harness === id).length;
  const toggle = (id: Harness, on: boolean) => setOff((current) => {
    const next = new Set(current);
    if (on) next.delete(id);
    else next.add(id);
    return next;
  });
  const appMenu = apps.map(([id, name]) => (
    <DropdownMenuCheckboxItem key={id} checked={!off.has(id)} disabled={!off.has(id) && picked.length === 1} onCheckedChange={(on) => toggle(id, on === true)}>
      {name} · {count(id)} chats{id === "acp-hermes-agent" && " · text only"}
    </DropdownMenuCheckboxItem>
  ));
  const rangeMenu = RANGES.map(([label, value]) => (
    <DropdownMenuItem key={label} onSelect={() => setDays(value)}>
      <Icon name="Check" className={value === days ? "size-3.5" : "size-3.5 opacity-0"} aria-hidden />
      {label[0]!.toUpperCase() + label.slice(1)}
    </DropdownMenuItem>
  ));
  const start = () => {
    if (!localHostId) return appToast.error(`This ${COMPUTER} is not connected yet. Try again in a moment.`);
    setProgress({ done: 0, total: chosen.length });
    // mutateAsync, not mutate callbacks: the toasts still show after this screen closes.
    importSessions.mutateAsync({ hostId: localHostId, sessions: chosen.map(({ harness, id }) => ({ harness, id })), onProgress: (done) => setProgress((current) => ({ ...current, done })) }).then(
      ({ imported, skipped }) => {
        appToast.success(`Imported ${imported.length} chat${imported.length === 1 ? "" : "s"}`);
        if (skipped.length) appToast.error(`${skipped.length} skipped. First reason: ${skipped[0]!.reason}`);
      },
      (error: Error) => appToast.error(error.message),
    );
    // Big imports take minutes, so the caller can move on while it runs.
    onStart?.();
  };

  return (
    <div style={PALETTE} className={CARD}>
      <p className="text-[21px] leading-[1.85] font-medium">
        Import my{" "}
        {picked.map(([id, name], index) => (
          <span key={id}>
            {index > 0 && (index === picked.length - 1 ? " and " : ", ")}
            <Chip menu={appMenu}><AppLogo id={id} />{name}</Chip>
          </span>
        ))}{" "}
        chats
        <br />
        from the <Chip menu={rangeMenu}>{RANGES.find(([, value]) => value === days)![0]}</Chip>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          disabled={!chosen.length || importSessions.isPending}
          onClick={start}
          className={BUTTON}
        >
          {importSessions.isPending && <Icon name="Loading" className="size-4 animate-spin" aria-hidden />}
          {importSessions.isPending ? `Importing ${progress.done} of ${progress.total} chats…` : `Import ${chosen.length} chat${chosen.length === 1 ? "" : "s"}`}
        </button>
        <span className="text-sm whitespace-nowrap text-(--ic-muted)">
          {importSessions.isPending ? "This keeps going if you leave this screen." : picked.map(([id, name]) => `${count(id)} ${name}`).join(" · ")}
        </span>
      </div>
    </div>
  );
}

export function ImportChatsSettingsSection() {
  return (
    <SettingsSection
      title="Import chats"
      description="Bring your Claude Code, Codex, Pi, Hermes, and T3 Code chats over as Local threads. The agent keeps its full memory. Hermes chats, and T3 Code chats from agents other than Claude Code and Codex, come over as text. Your originals stay untouched."
    >
      <ImportChats />
    </SettingsSection>
  );
}
