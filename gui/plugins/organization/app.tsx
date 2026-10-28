import { useCallback, useEffect, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, Markdown, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { STATE_CHANNEL, type OrgMessage, type orgRpcContract, type OrgState, type SharedThread } from "./contract.js";
import { button, errorText, primary, SettingsTab } from "./settings.js";

// Organizations v1 (docs/scopes/organizations.md): the Organization page (Settings, like the website's /org, and
// teammates' Threads), the lock button, and the invite popup.
type View = { state: OrgState | null; error: string | null };
const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function useOrg(): [View | null, (view: View) => void] {
  const rpc = useRpc<typeof orgRpcContract>();
  const [view, setView] = useState<View | null>(null);
  const load = useCallback(() => { void rpc.call("state", {}).then(setView, () => {}); }, [rpc]);
  useEffect(load, [load]);
  useRealtime(STATE_CHANNEL, load);
  return [view, setView];
}

function OrgPanel() {
  const rpc = useRpc<typeof orgRpcContract>();
  const navigate = useBbNavigate();
  const [view, setView] = useOrg();
  const [tab, setTab] = useState<"settings" | "threads">("settings");
  const [threads, setThreads] = useState<SharedThread[] | null>(null);
  const [open, setOpen] = useState<SharedThread | null>(null);
  const [messages, setMessages] = useState<OrgMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const org = view?.state?.org ?? null;
  const loadList = useCallback(() => {
    setProblem(null);
    void rpc.call("list", {}).then(({ threads: list }) => setThreads(list), (failure) => setProblem(errorText(failure)));
  }, [rpc]);
  useEffect(() => { if (org) loadList(); }, [org?.name, loadList]);
  const pick = (next: "settings" | "threads") => { setTab(next); setOpen(null); setProblem(null); if (next === "threads") loadList(); };
  const show = (thread: SharedThread) => {
    setOpen(thread); setMessages(null); setProblem(null);
    void rpc.call("view", { owner: thread.owner, thread: thread.thread }).then(({ messages: list }) => setMessages(list), (failure) => setProblem(errorText(failure)));
  };
  const takeOver = async (thread: SharedThread) => {
    setBusy(true); setProblem(null);
    try {
      const { threadId } = await rpc.call("takeover", { owner: thread.owner, thread: thread.thread });
      setOpen(null);
      loadList();
      navigate.toThread(threadId);
    } catch (failure) { setProblem(errorText(failure)); }
    finally { setBusy(false); }
  };
  const answer = async (orgId: string, accept: boolean) => {
    setBusy(true);
    try { setView(await rpc.call("invite", { orgId, accept })); } catch (failure) { setProblem(errorText(failure)); } finally { setBusy(false); }
  };
  const tabs = [["settings", "Settings", "Settings"], ["threads", "Threads", "MessageSquare"]] as const;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Organization</p>
        <h1 className="mt-1 truncate text-2xl font-semibold text-foreground">{org?.name ?? "Work as a team."}</h1>
        {!org && <p className="mt-1 text-sm text-muted-foreground">Share agent instructions, see each other's Cloud threads, and take them over.</p>}
        {org && (
          <div role="tablist" className="mt-4 flex gap-6 border-b border-border">
            {tabs.map(([id, label, icon]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => pick(id)}
                className={`-mb-px inline-flex items-center gap-2 border-b-2 pb-2.5 text-sm ${tab === id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                <Icon name={icon} className="size-3.5" />{label}{id === "threads" && threads !== null && <span className="text-muted-foreground">{threads.length}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="mt-5 space-y-3">
          {!view && <p className="text-xs text-muted-foreground">Loading…</p>}
          {view?.error && !view.state && <p className="text-xs text-destructive">{view.error}</p>}
          {view?.state && !org && (
            <>
              {view.state.invites.map((invite) => (
                <div key={invite.orgId} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3">
                  <span className="text-sm">You're invited to join <b>{invite.name}</b>.</span>
                  <span className="flex gap-2">
                    <button type="button" className={button} disabled={busy} onClick={() => void answer(invite.orgId, false)}>Decline</button>
                    <button type="button" className={primary} disabled={busy} onClick={() => void answer(invite.orgId, true)}>Accept</button>
                  </span>
                </div>
              ))}
              {!view.state.invites.length && <p className="text-xs text-muted-foreground">You're not in an organization. Ask your team's admin to invite you.</p>}
            </>
          )}
          {org && tab === "settings" && <SettingsTab />}
          {org && tab === "threads" && !open && (
            <>
              {threads === null && !problem && <p className="text-xs text-muted-foreground">Loading…</p>}
              {threads?.length === 0 && <p className="text-xs text-muted-foreground">Nothing shared yet. Jev shares teammates' new Cloud threads in your organization's repos, based on each person's sharing rule.</p>}
              {!!threads?.length && (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised">
                  {threads.map((thread) => (
                    <li key={`${thread.owner}/${thread.thread}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                      <button type="button" onClick={() => show(thread)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-foreground">{thread.ownerName[0]?.toUpperCase()}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{thread.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">{[thread.ownerName, thread.repo, thread.model ?? thread.harness].filter(Boolean).join(" · ")}</span>
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
          {org && tab === "threads" && open && (
            <>
              <div className="flex items-center justify-between gap-3">
                <button type="button" className={button} onClick={() => setOpen(null)}>Back</button>
                <button type="button" className={primary} disabled={busy} onClick={() => void takeOver(open)}>{busy ? "Taking over…" : "Take over"}</button>
              </div>
              <div>
                <div className="text-sm font-medium text-foreground">{open.title}</div>
                <div className="text-xs text-muted-foreground">{open.ownerName}'s thread · {open.repo}. Read-only: take it over to continue it in your own Cloud thread.</div>
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
          {problem && <p className="text-xs text-destructive">{problem}</p>}
        </div>
      </div>
    </div>
  );
}

// Next to the thread's "…" menu: private (lock) or shared with the organization. Only on the owner's Cloud threads in
// the organization's repos. It overrides Jev.
function LockButton({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof orgRpcContract>();
  const [status, setStatus] = useState<{ eligible: boolean; shared: boolean; adminsSee: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void rpc.call("thread", { threadId }).then(setStatus, () => setStatus(null)); }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime(STATE_CHANNEL, load);
  if (!status?.eligible) return null;
  const toggle = async () => {
    setBusy(true);
    try { setStatus({ eligible: true, adminsSee: status.adminsSee, ...(await rpc.call("share", { threadId, shared: !status.shared })) }); } catch { load(); } finally { setBusy(false); }
  };
  const label = status.shared ? "Your teammates can see this thread. Click to hide it from them."
    : status.adminsSee ? "Hidden from teammates. Admins can still see it. Click to share it with your team." : "Private. Click to share it with your team.";
  return (
    <button type="button" title={label} aria-label={label} disabled={busy} onClick={() => void toggle()}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
      <Icon name={status.shared ? "UserRound" : "Lock"} className="size-3.5" />
    </button>
  );
}

function InvitePopup() {
  const rpc = useRpc<typeof orgRpcContract>();
  const [view, setView] = useOrg();
  const [busy, setBusy] = useState(false);
  const invite = view?.state?.invites[0];
  if (!invite) return null;
  const answer = async (accept: boolean) => {
    setBusy(true);
    try { setView(await rpc.call("invite", { orgId: invite.orgId, accept })); } finally { setBusy(false); }
  };
  return (
    <div className="fixed right-4 top-14 z-50 w-80 space-y-3 rounded-xl border border-border bg-surface-raised p-4 shadow-lg">
      <p className="text-sm">You're invited to join <b>{invite.name}</b> on Cloudroom. Your team shares agent instructions and Cloud threads.</p>
      <div className="flex justify-end gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void answer(false)}>Decline</button>
        <button type="button" className={primary} disabled={busy} onClick={() => void answer(true)}>Accept</button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "organization", title: "Organization", icon: "UserRound", path: "org", component: OrgPanel });
  app.slots.experimental_threadHeaderAction({ id: "lock", title: "Share with organization", component: LockButton });
  app.slots.experimental_appOverlay({ id: "invites", component: InvitePopup });
});
