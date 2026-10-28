import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { atom, useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { BbLogo } from "@/components/ui/bb-logo";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { MACOS_WINDOW_DRAG_CLASS } from "@/lib/bb-desktop";
import { createJsonLocalStorage } from "@/lib/browser-storage";
import { copyToClipboardWithToast } from "@/lib/clipboard";

// Codes whose link was copied on this Mac. They stay "sent" until a friend accepts one.
const sentAtom = atomWithStorage<string[]>("cloudroom.invites.sent", [],
  createJsonLocalStorage<string[]>((value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string")), { getOnInit: true });

const invitesSchema = z.object({
  codes: z.array(z.object({ code: z.string(), used: z.boolean(), url: z.string().optional(), joined: z.object({ name: z.string().nullable(), at: z.string() }).optional() })),
  left: z.number(), created: z.string().nullable(),
});
type Invites = z.infer<typeof invitesSchema>;
type Code = Invites["codes"][number];
type Status = "joined" | "sent" | "ready";
const NEW = "new";
const STAMPS: Record<Status, { text: string; ink?: boolean; sent?: boolean }> = { joined: { text: "JOINED", ink: true }, sent: { text: "SENT", sent: true }, ready: { text: "READY" } };
const DOTS: Record<Status, string> = { joined: "#8d8676", sent: "#e0a21b", ready: "#8fbf00" };
const day = (at: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const pad = (number: number) => String(number).padStart(2, "0");
async function invites(method: "GET" | "POST", signal?: AbortSignal) {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/invites", {
    method, signal, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
  });
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error((value as { message?: string } | null)?.message ?? "Invite codes are unavailable right now.");
  return invitesSchema.parse(value);
}
const format = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const INVITES_KEY = ["cloudroom-invites"];
const manualAtom = atom(false);
const nothingToShare = (data: Invites) => data.left === 0 && data.codes.every((item) => item.used);

export function InviteOffer() {
  const [manual, setManual] = useAtom(manualAtom);
  const list = useQuery({ queryKey: INVITES_KEY, enabled: manual, retry: false, queryFn: ({ signal }) => invites("GET", signal) });
  if (!manual || !list.data) return null;
  return <InviteTickets data={list.data} finish={() => setManual(false)} />;
}

function useInvites() {
  const signedIn = Boolean(useCloudroomAccount().data?.account);
  return useQuery({ queryKey: INVITES_KEY, enabled: signedIn, retry: false, staleTime: 5 * 60_000, queryFn: ({ signal }) => invites("GET", signal) });
}

export function InviteSidebarRow() {
  const list = useInvites();
  const open = useSetAtom(manualAtom);
  if (!list.data || nothingToShare(list.data)) return null;
  return (
    <div className="mt-2 border-t border-sidebar-border pt-2">
      <button type="button" onClick={() => open(true)} data-testid="settings-invite"
        className="flex h-9 w-full items-center gap-2.5 rounded-md bg-primary/15 px-2 text-sm font-semibold text-sidebar-foreground hover:bg-primary/25 dark:bg-primary/8 dark:hover:bg-primary/15">
        <TicketIcon />
        Invite friends
      </button>
    </div>
  );
}

export function InviteSettingsCard() {
  const list = useInvites();
  const open = useSetAtom(manualAtom);
  if (!list.data || nothingToShare(list.data)) return null;
  return (
    <div data-testid="settings-invite-card" className="flex min-h-13 items-center gap-3 rounded-lg bg-surface-recessed py-2 pr-2.5 pl-4">
      <TicketIcon className="text-muted-foreground" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium text-foreground">Enjoying Cloudroom?</span>{" "}
        <span className="text-muted-foreground">Share it with a friend.</span>
      </p>
      <button type="button" onClick={() => open(true)} className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:brightness-95">
        Invite a friend
      </button>
    </div>
  );
}

const INK = "#0e0d0b", LIME = "#bfff00";
const ROOT: CSSProperties = {
  background: `radial-gradient(900px 600px at 76% 52%, rgba(191,255,0,.12), transparent 60%), radial-gradient(700px 500px at 10% 0%, rgba(243,236,219,.06), transparent 60%), ${INK}`,
};

function InviteTickets({ data, finish }: { data: Invites; finish: () => void }) {
  const [sent, setSent] = useAtom(sentAtom);
  // The ticket the member clicked in the stub rail, or NEW for a ticket not made yet. Null shows the next one to send.
  const [picked, setPicked] = useState<string | null>(null);
  const status = (item: Code): Status => item.used ? "joined" : sent.includes(item.code) ? "sent" : "ready";
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () => invites("POST"),
    onSuccess: (result) => {
      client.setQueryData(INVITES_KEY, result);
      setPicked(result.created ?? result.codes.find((item) => status(item) === "ready")?.code ?? null);
    },
  });
  const ticket = data.codes.find((item) => item.code === picked) ?? (picked === NEW ? null
    : data.codes.find((item) => status(item) === "ready") ?? (data.left > 0 ? null : data.codes.find((item) => status(item) === "sent") ?? null));
  const state = ticket ? status(ticket) : null;
  // The link opens the website's invite page (web/app/i/[code]). Older websites send no link, so copy the code.
  // Copying marks the ticket sent on this Mac. The website only knows when a friend accepts it.
  const copy = () => {
    if (!ticket) return;
    void copyToClipboardWithToast(ticket.url ?? format(ticket.code), { successMessage: ticket.url ? "Invite link copied" : "Invite code copied" });
    setPicked(ticket.code);
    if (state === "ready") setSent([...sent, ticket.code]);
  };
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus(); }, []);
  const number = ticket ? data.codes.indexOf(ticket) + 1 : data.codes.length + 1;
  const blanks = Math.min(data.left, 1);
  const shown = data.codes.slice(blanks - 3);
  const done = <button type="button" onClick={finish} className="h-[50px] border border-[#3a372f] px-6 text-[15px] font-semibold text-[#d8d0bd] transition-transform hover:scale-105 hover:border-[#5a564b]">Done</button>;
  const send = {
    title: <>Your {number === 1 ? "first" : "next"}<br /><em>ticket</em>.</>,
    lede: "Send it to a friend who builds with agents.",
  };
  const final = state === "joined" ? {
    title: <>{ticket!.joined?.name ?? "Your friend"}<br />is <em>in</em>.</>,
    lede: ticket!.joined ? `They joined with this ticket on ${day(ticket!.joined.at)}.` : "They joined with this ticket.",
    actions: done,
  } : state === "sent" ? {
    title: <>Ticket<br /><em>sent</em>.</>,
    lede: "It counts once your friend accepts it. Until then, the link still works.",
    actions: <><Primary onClick={copy}><CopyIcon />Copy link again</Primary>{done}</>,
  } : state === "ready" ? { ...send, actions: <><Primary onClick={copy}><CopyIcon />Copy link</Primary>{done}</> } : {
    ...send,
    actions: <>
      <Primary disabled={create.isPending} onClick={() => create.mutate()}>Create my ticket</Primary>
      <button type="button" onClick={finish} className="text-sm text-[#8d8676] underline underline-offset-4 hover:text-[#d8d0bd]">Later</button>
    </>,
  };

  const current = {
    ...final,
    art: <>
      {!data.codes.length && <>
        <Ticket dim style={{ left: 150, top: 110, transform: "rotate(7deg) scale(.9)" }} number="" label="" title="Invite" foot="••••-••••" />
        <Ticket dim style={{ left: 120, top: 170, transform: "rotate(3deg) scale(.95)" }} number="" label="" title="Invite" foot="••••-••••" />
      </>}
      <Ticket style={data.codes.length ? { left: 60, top: 140, transform: "rotate(-4deg) scale(1.15)" } : { left: 80, top: 250, transform: "rotate(-4deg) scale(1.2)" }}
        number={pad(number)} label={`NO. ${number}`} title={state === "joined" ? "Invite" : <Highlight>Invite</Highlight>}
        sub={state === "joined" ? (ticket!.joined ? `${ticket!.joined.name ?? "A friend"} joined · ${day(ticket!.joined.at)}` : "Used") : state === "sent" ? "Sent · not accepted yet" : "One click lets them in."}
        foot={ticket ? format(ticket.code) : "••••-••••"} live={Boolean(ticket)} used={state === "joined"} stamp={state ? STAMPS[state] : { text: "UNUSED" }} />
      {data.codes.length > 0 && (
        <div className="absolute top-[480px] left-9 flex gap-4">
          <p className="absolute -top-[30px] left-0 font-mono text-[11px] tracking-[0.2em] whitespace-nowrap text-[#8d8676] uppercase">Your tickets</p>
          {shown.map((item) => {
            const itemState = status(item);
            return <Stub key={item.code} number={pad(data.codes.indexOf(item) + 1)} code={format(item.code)} state={itemState} on={item === ticket} onClick={() => setPicked(item.code)}
              line={itemState === "joined" ? (item.joined?.name ? `${item.joined.name} joined` : "Joined") : itemState === "sent" ? "Sent · waiting" : "Ready to send"} />;
          })}
          {Array.from({ length: blanks }, (_, index) => (
            <Stub key={index} number={pad(data.codes.length + index + 1)} code={null} line="Not made yet" on={!ticket && index === 0} onClick={() => setPicked(NEW)} />
          ))}
        </div>
      )}
    </>,
  };

  return (
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Invite friends" style={ROOT}
      className="fixed inset-0 z-50 overflow-hidden text-[#f3ecdb] max-md:h-(--bb-shell-height) max-md:overflow-y-auto outline-none duration-300 animate-in fade-in-0">
      <div className={cn("absolute inset-x-0 top-0 h-10", MACOS_WINDOW_DRAG_CLASS)} />
      <div className="flex h-full items-center max-md:h-auto max-md:min-h-full max-md:flex-col max-md:justify-center max-md:pt-[calc(env(safe-area-inset-top)+32px)] max-md:pb-[calc(env(safe-area-inset-bottom)+28px)]">
        <div className="w-[44%] shrink-0 pr-8 pl-[8.5%] max-md:w-full max-md:px-7">
          <div className="flex items-center gap-2.5 font-mono text-xs tracking-[0.2em] text-[#8d8676] uppercase">
            <BbLogo className="size-[22px]" />
            Cloudroom
          </div>
          <h1 className="mt-7 font-serif text-[64px] max-md:mt-5 max-md:text-[42px] leading-[1.02] font-medium tracking-[-0.03em] [&_em]:text-[#bfff00]">{current.title}</h1>
          <p className="mt-5 max-w-[400px] text-lg text-[#bdb5a2] max-md:mt-3 max-md:text-base">{current.lede}</p>
          <div className="mt-10 flex items-center gap-6 max-md:mt-7">
            {current.actions}
          </div>
          {create.error && <p className="mt-4 text-sm text-[#ff8a7a]">{create.error.message}</p>}
        </div>
        <div className="pointer-events-none flex min-w-0 flex-1 items-center justify-center max-md:order-first max-md:h-[330px] max-md:w-full max-md:flex-none">
          <div className="relative h-[640px] w-[620px] shrink-0 max-[1180px]:scale-[.8] max-[980px]:scale-[.65] max-md:scale-[.55]">{current.art}</div>
        </div>
      </div>
    </div>
  );
}

const NOTCHED = "radial-gradient(circle at 100px 0, transparent 13px, #000 13.5px) top/100% 51% no-repeat, radial-gradient(circle at 100px 100%, transparent 13px, #000 13.5px) bottom/100% 51% no-repeat";
const PAPER: CSSProperties = { backgroundColor: "#f3ecdb", backgroundImage: "repeating-linear-gradient(90deg, transparent 0 22px, rgba(120,100,60,.05) 22px 23px)" };

function Ticket({ style, number, label, kicker = "Cloudroom · admit one", title, sub, foot, live, used, stamp, dim }: {
  style: CSSProperties; number: string; label: string; kicker?: string; title: ReactNode; sub?: string; foot: string; live?: boolean; used?: boolean; stamp?: { text: string; ink?: boolean; sent?: boolean }; dim?: boolean;
}) {
  return (
    <div className="absolute" style={{ ...style, filter: dim ? "brightness(.3) drop-shadow(0 20px 30px rgba(0,0,0,.5))" : "drop-shadow(0 30px 40px rgba(0,0,0,.55))" }}>
      <div className="flex h-[188px] w-[440px] text-[#1c1a15]" style={{ mask: NOTCHED }}>
        <div className={cn("flex w-[100px] shrink-0 flex-col items-center justify-center gap-2 border-r-2 border-dashed border-[#b9ad8f]", used ? "bg-[#d3c9b0]" : "bg-[#e9dfc6]")}>
          <b className="font-serif text-[26px] leading-none font-semibold">{number}</b>
          <span className="rotate-180 font-mono text-[11px] font-semibold tracking-[0.18em] text-[#6f6655] [writing-mode:vertical-rl]">{label}</span>
        </div>
        <div className="relative flex-1 px-6 py-5" style={used ? { ...PAPER, backgroundColor: "#ddd4bf" } : PAPER}>
          <p className="font-mono text-[10.5px] font-semibold tracking-[0.22em] text-[#7d735f] uppercase">{kicker}</p>
          <p className="mt-3 font-serif text-[40px] leading-none tracking-[-0.02em]">{title}</p>
          {sub && <p className="mt-2 text-[13px] text-[#6f6655]">{sub}</p>}
          <p className={cn("absolute left-6 font-mono font-semibold", live ? "bottom-5 text-2xl tracking-[0.22em] text-[#1c1a15]" : "bottom-[18px] text-[15px] tracking-[0.28em] text-[#a99d82]", used && "text-[#8d8270] line-through decoration-2")}>{foot}</p>
          {stamp && (
            <div className={cn("absolute grid place-items-center rounded-full text-center font-mono font-bold whitespace-pre-line",
              stamp.ink
                ? "top-10 right-6 size-24 -rotate-[18deg] border-[2.5px] border-[#1c1a15]/55 text-[11px] tracking-[0.14em] text-[#1c1a15]/60"
                : stamp.sent ? "right-5 bottom-4 size-20 -rotate-[10deg] border-2 border-dashed border-[#1c1a15] bg-[#f3ecdb] text-[10px] tracking-[0.12em]"
                : "right-5 bottom-4 size-[76px] -rotate-[14deg] border-2 border-[#1c1a15] bg-[#bfff00] text-[10px] leading-tight tracking-[0.12em]")}>
              {stamp.text === "UNUSED" ? "UN\nUSED" : stamp.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const STUB_NOTCHED = "radial-gradient(circle at 44px 0, transparent 8px, #000 8.5px) top/100% 51% no-repeat, radial-gradient(circle at 44px 100%, transparent 8px, #000 8.5px) bottom/100% 51% no-repeat";

function Stub({ number, code, state, line, on, onClick }: { number: string; code: string | null; state?: Status; line: string; on: boolean; onClick: () => void }) {
  const used = state === "joined";
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={cn("pointer-events-auto text-left drop-shadow-[0_14px_20px_rgba(0,0,0,.5)] transition-transform hover:-translate-y-0.5", on && "outline-2 outline-offset-4 outline-[#bfff00]")}>
      <div className="flex h-[92px] w-[172px] text-[#1c1a15]" style={{ mask: STUB_NOTCHED }}>
        <div className={cn("grid w-11 shrink-0 place-items-center border-r-[1.5px] border-dashed border-[#b9ad8f] font-serif text-[17px] font-semibold", used ? "bg-[#c7bda3]" : "bg-[#e9dfc6]")}>{number}</div>
        <div className={cn("flex min-w-0 flex-1 flex-col justify-between p-3", used ? "bg-[#d3c9b0]" : "bg-[#f3ecdb]")}>
          <span className={cn("font-mono text-[13px] font-semibold tracking-[0.12em]", used && "text-[#7d735f] line-through", !code && "text-[#a99d82]")}>{code ?? "••••-••••"}</span>
          <span className="flex items-center gap-1.5 truncate text-[11.5px] font-semibold text-[#6f6655]">
            <i className="size-[7px] shrink-0 rounded-full" style={{ background: state ? DOTS[state] : "#c9bd9f" }} />{line}
          </span>
        </div>
      </div>
    </button>
  );
}

function Highlight({ children }: { children: ReactNode }) {
  return <i style={{ background: `linear-gradient(transparent 60%, ${LIME} 60%, ${LIME} 92%, transparent 92%)` }}>{children}</i>;
}

function Primary({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="inline-flex h-[50px] items-center gap-2.5 bg-[#bfff00] px-[30px] text-[15.5px] font-bold text-[#0e0d0b] transition-transform hover:brightness-95 enabled:hover:scale-105 disabled:opacity-60">
      {children}
    </button>
  );
}

const TicketIcon = ({ className = "text-primary" }: { className?: string }) => <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" /><path d="M13 5v2M13 11v2M13 17v2" /></svg>;
const CopyIcon = () => <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="5" width="8.5" height="8.5" /><path d="M2.5 10.5v-8h8" /></svg>;
