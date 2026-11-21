import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, experimental_Icon as Icon, Markdown, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { usePortalScopeProps } from "@cloudroom/shared-ui/lib/portal-scope";
import { useSidebarCards } from "@cloudroom/shared-ui/lib/sidebar-cards";
import { STATE_CHANNEL, type Invite, type Person, type SharedMessage, type SharedThread, type SharePage, type sharesRpcContract, type Teammate } from "./contract.js";

// Shared projects (docs/scopes/shared-projects.md): "Share project" in every project's menu, the page it opens, the
// lock button on threads in shared projects, and the invite card in the sidebar.
const PAGE = "share", BILLING_URL = "https://www.cloudroom.dev/billing";
const button = "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50 enabled:hover:bg-muted";
const primary = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50";
const card = "overflow-hidden rounded-xl border border-border bg-surface-raised";
const errorText = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));
const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
type View = { name: string; repo: string | null; page: SharePage | null };

function ShareProjectPage({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof sharesRpcContract>();
  const navigate = useBbNavigate();
  const [view, setView] = useState<View | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [open, setOpen] = useState<SharedThread | null>(null);
  const [messages, setMessages] = useState<SharedMessage[] | null>(null);
  // Loads when the page opens and after each click here, never on a timer.
  const run = useCallback(async (call: () => Promise<View>) => {
    setBusy(true); setProblem(null);
    try { setView(await call()); return true; } catch (failure) { setProblem(errorText(failure)); return false; } finally { setBusy(false); }
  }, []);
  const load = useCallback(() => void run(() => rpc.call("page", { projectId })), [rpc, projectId, run]);
  useEffect(() => { setView(null); setOpen(null); load(); }, [load]);

  const page = view?.page ?? null, limit = page?.limit ?? null;
  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => rpc.call("share", { projectId, email: email.trim() }))) setEmail("");
  };
  const remove = async (id: string) => { setConfirm(null); await run(() => rpc.call("remove", { projectId, id })); };
  const show = (thread: SharedThread) => {
    setOpen(thread); setMessages(null); setProblem(null);
    void rpc.call("view", { projectId, owner: thread.owner, thread: thread.thread }).then(({ messages: list }) => setMessages(list), (failure) => setProblem(errorText(failure)));
  };
  const takeOver = async (thread: SharedThread) => {
    setBusy(true); setProblem(null);
    try { navigate.toThread((await rpc.call("takeover", { projectId, owner: thread.owner, thread: thread.thread })).threadId); }
    catch (failure) { setProblem(errorText(failure)); }
    finally { setBusy(false); }
  };
  const others = page?.people.filter((person) => !person.you && person.joined).length ?? 0;
  const full = !!limit && limit.max !== null && limit.used >= limit.max;
  const team = page?.team ?? [], unshared = team.filter((mate) => mate.state === "none").length;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Share project</p>
          <h1 className="mt-1 truncate text-2xl font-semibold text-foreground">{view?.name ?? (problem ? "This project" : "Loading…")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The people you share with see this project's Cloud threads, and you see theirs. Each of you can read them and take them over. Local threads and your other projects stay private.
          </p>
        </div>
        {view && !view.repo && <p className="text-sm text-muted-foreground">Only projects on GitHub can be shared.</p>}
        {page && !open && (
          <>
            {limit?.max === 0 ? (
              <div className={`${card} flex items-center justify-between gap-3 px-4 py-3`}>
                <span className="text-sm">Sharing a project needs a paid plan. The people you invite don't need one.</span>
                <button type="button" className={primary} onClick={() => navigate.openUrl(BILLING_URL)}>See plans</button>
              </div>
            ) : (
              <form onSubmit={(event) => void invite(event)} className={`${card} space-y-2 px-4 py-3`}>
                {!!team.length && (
                  <div className="space-y-2 pb-1">
                    <div className="flex min-h-7 items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">Your team</span>
                      {unshared > 1 && <button type="button" className={button} disabled={busy || full} onClick={() => void run(() => rpc.call("share", { projectId, team: true }))}>Share with whole team</button>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {team.map((mate) => <TeammateChip key={mate.email} mate={mate} disabled={busy || full} onShare={() => void run(() => rpc.call("share", { projectId, email: mate.email }))} />)}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Their email" aria-label="Email to share this project with"
                    disabled={full} className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50" />
                  <button type="submit" className={primary} disabled={busy || full || !email.trim()}>Share</button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {full ? `${limit.used} of ${limit.max} shares used. Remove one, or ` : "They get an email, and accept in the Cloudroom app."}
                  {full && <button type="button" className="underline hover:text-foreground" onClick={() => navigate.openUrl(BILLING_URL)}>upgrade for more</button>}
                  {full ? "." : limit && limit.max !== null ? ` ${limit.used} of ${limit.max} shares used.` : ""}
                </p>
              </form>
            )}
            {!!page.people.length && (
              <ul className={`${card} divide-y divide-border`}>
                {page.people.map((person, index) => (
                  <li key={person.id ?? `${person.name}/${index}`} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-foreground">{person.name[0]?.toUpperCase()}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{person.email ?? person.name}</span>
                      <span className="block text-xs text-muted-foreground">{status(person)}</span>
                    </span>
                    {person.id && person.role === "member" && (confirm === person.id ? (
                      <span className="flex gap-2">
                        <button type="button" className={button} onClick={() => setConfirm(null)}>Cancel</button>
                        <button type="button" className={`${button} text-destructive`} disabled={busy} onClick={() => void remove(person.id!)}>{person.you ? "Leave" : "Remove"}</button>
                      </span>
                    ) : (
                      <button type="button" className={button} onClick={() => setConfirm(person.id)}>{person.you ? "Leave" : "Remove"}</button>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {!!page.people.length && (
              <div className="flex items-center justify-between gap-3 pt-2">
                <h2 className="text-sm font-medium text-foreground">Their Cloud threads</h2>
                <button type="button" className={button} disabled={busy} onClick={load}>Refresh</button>
              </div>
            )}
            {page.paused && <p className="text-xs text-muted-foreground">Sharing is paused: the plan of the person who shared this project no longer includes it. Nothing was deleted.</p>}
            {!!page.people.length && !page.threads.length && !page.paused && (
              <p className="text-xs text-muted-foreground">{others ? "No open Cloud threads here yet. Theirs show as soon as they start one in this project." : "Nobody has joined yet. Their Cloud threads in this project show here once they accept."}</p>
            )}
            {!!page.threads.length && (
              <ul className={`${card} divide-y divide-border`}>
                {page.threads.map((thread) => (
                  <li key={`${thread.owner}/${thread.thread}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                    <button type="button" onClick={() => show(thread)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-foreground">{thread.ownerName[0]?.toUpperCase()}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{thread.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{[thread.ownerName, thread.model ?? thread.harness].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{when(thread.at)}</span>
                    </button>
                    <button type="button" className={button} disabled={busy} onClick={() => void takeOver(thread)}>Take over</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {page && open && (
          <>
            <div className="flex items-center justify-between gap-3">
              <button type="button" className={button} onClick={() => setOpen(null)}>Back</button>
              <button type="button" className={primary} disabled={busy} onClick={() => void takeOver(open)}>{busy ? "Taking over…" : "Take over"}</button>
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">{open.title}</div>
              <div className="text-xs text-muted-foreground">{open.ownerName}'s thread. Read-only: take it over to continue it in your own Cloud thread.</div>
            </div>
            {messages === null && !problem && <p className="text-xs text-muted-foreground">Loading…</p>}
            {messages?.map((item, index) => (
              <div key={index} className={item.role === "user" ? "rounded-xl bg-muted/50 px-4 py-3" : "px-1"}>
                <div className="mb-1 text-xs text-muted-foreground">{item.role === "user" ? open.ownerName : "Agent"}</div>
                <Markdown content={item.text} />
              </div>
            ))}
          </>
        )}
        {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}
      </div>
    </div>
  );
}

// One teammate, one click. Someone already invited or sharing shows as that; they are removed in the list below.
function TeammateChip({ mate, disabled, onShare }: { mate: Teammate; disabled: boolean; onShare: () => void }) {
  const initial = <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold text-foreground">{mate.name[0]?.toUpperCase()}</span>;
  const shape = "inline-flex items-center gap-1.5 rounded-full border border-border py-1 pl-1 pr-2.5 text-xs";
  if (mate.state !== "none") {
    return (
      <span title={mate.email} className={`${shape} bg-muted/50 text-muted-foreground`}>
        {initial}{mate.name}<Icon name="Check" className="size-3" /><span>{mate.state === "joined" ? "Joined" : "Invited"}</span>
      </span>
    );
  }
  return (
    <button type="button" title={`Share with ${mate.email}`} aria-label={`Share with ${mate.email}`} disabled={disabled} onClick={onShare}
      className={`${shape} text-foreground disabled:opacity-50 enabled:hover:bg-muted`}>
      {initial}{mate.name}<Icon name="Plus" className="size-3 text-muted-foreground" />
    </button>
  );
}

const status = (person: Person) => [person.role === "owner" ? "Shared this project" : person.joined ? "Joined" : "Invited", person.you && "You"].filter(Boolean).join(" · ");

// Next to the thread's "…" menu, only on the owner's Cloud threads in a shared project: shown to the people the
// project is shared with, or hidden from them (lock).
function LockButton({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof sharesRpcContract>();
  const [state, setState] = useState<{ eligible: boolean; hidden: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void rpc.call("thread", { threadId }).then(setState, () => setState(null)); }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime(STATE_CHANNEL, load);
  if (!state?.eligible) return null;
  const toggle = async () => {
    setBusy(true);
    try { setState({ eligible: true, ...(await rpc.call("hide", { threadId, hidden: !state.hidden })) }); } catch { load(); } finally { setBusy(false); }
  };
  const label = state.hidden ? "Hidden from the people you share this project with. Click to show it to them." : "The people you share this project with can see this thread. Click to hide it from them.";
  return (
    <button type="button" title={label} aria-label={label} disabled={busy} onClick={() => void toggle()}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
      <Icon name={state.hidden ? "Lock" : "UserRound"} className="size-3.5" />
    </button>
  );
}

function InviteCard() {
  const rpc = useRpc<typeof sharesRpcContract>();
  const navigate = useBbNavigate();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(() => { void rpc.call("invites", {}).then(({ invites: list }) => setInvites(list), () => {}); }, [rpc]);
  useEffect(load, [load]);
  useRealtime(STATE_CHANNEL, load);
  // Back in the app, perhaps from the invite email: look for invites now. The plugin's server spaces these out.
  useEffect(() => {
    const check = () => { void rpc.call("refresh", {}).catch(() => {}); };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [rpc]);
  const spot = useSidebarCards();
  // The card renders outside the plugin's slot, so it carries the plugin's style scope itself.
  const scopeProps = usePortalScopeProps();
  const invite = invites[0];
  if (!invite || !spot) return null;
  const answer = async (accept: boolean) => {
    setBusy(true); setProblem(null);
    try {
      const { projectId } = await rpc.call("answer", { id: invite.id, accept });
      load();
      if (projectId) { spot.close(); navigate.toPluginPanel(PAGE, { subPath: projectId }); }
    } catch (failure) { setProblem(errorText(failure)); } finally { setBusy(false); }
  };
  // In the sidebar, above the plan card. While the sidebar is hidden, the invite waits.
  return createPortal(
    <section {...scopeProps} aria-label="Project invite" className="rounded-lg border border-border bg-surface-raised-solid p-3">
      <p className="truncate text-xs text-muted-foreground">{invite.from} shared a project</p>
      <p title={`github.com/${invite.repo}`} className="mt-1 truncate text-sm font-medium text-foreground">{invite.repo}</p>
      <p className="mt-2 text-xs text-muted-foreground">You'll both see each other's Cloud threads in it, and can take them over.</p>
      {problem && <p role="alert" className="mt-2 text-xs text-destructive">{problem}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void answer(false)}>Decline</button>
        <button type="button" className={primary} disabled={busy} onClick={() => void answer(true)}>Accept</button>
      </div>
    </section>,
    spot.element,
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_projectAction({ id: PAGE, title: "Share project", icon: "UserRoundPlus", badge: "NEW", component: ShareProjectPage });
  app.slots.experimental_threadHeaderAction({ id: "lock", title: "Share with project", component: LockButton });
  app.slots.experimental_appOverlay({ id: "invites", component: InviteCard });
});
