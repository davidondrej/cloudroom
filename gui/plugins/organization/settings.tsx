import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { OrgChange, orgRpcContract, OrgSettings } from "./contract.js";

type Org = NonNullable<OrgSettings["org"]>;
type Change = (change: OrgChange) => Promise<boolean>;
export const button = "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50 enabled:hover:bg-muted";
export const primary = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50";
export const errorText = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

export function SettingsTab() {
  const rpc = useRpc<typeof orgRpcContract>();
  const [view, setView] = useState<OrgSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void rpc.call("settings", {}).then(setView, (failure) => setError(errorText(failure))); }, [rpc]);
  const change: Change = async (input) => {
    setBusy(true); setError(null);
    try { setView(await rpc.call("settings", { change: input })); return true; }
    catch (failure) { setError(errorText(failure)); return false; }
    finally { setBusy(false); }
  };
  const org = view?.org;
  const shown = error && <p role="alert" className="text-xs text-destructive">{error}</p>;
  if (!org) return shown || (!view && <p className="text-xs text-muted-foreground">Loading…</p>);
  return (
    <div className="space-y-6">
      <div className="grid items-start gap-4 md:grid-cols-2">
        <Members org={org} email={view.email} busy={busy} change={change} />
        <Repos org={org} busy={busy} change={change} />
      </div>
      <Permissions org={org} busy={busy} change={change} />
      <Prompts org={org} busy={busy} change={change} />
      <div className="grid gap-4 md:grid-cols-2">
        <Editor title="Your sharing rule" wrap value={org.sharing} max={2000} busy={busy} save={(text) => change({ action: "sharing", text })}
          placeholder="Leave it empty to use the default rule." />
        <SharingNote />
      </div>
      <Leave name={org.name} busy={busy} leave={() => void change({ action: "leave" })} />
      {shown}
    </div>
  );
}

function Leave({ name, busy, leave }: { name: string; busy: boolean; leave: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return (
    <div className="flex justify-end">
      <button type="button" className="text-xs text-muted-foreground enabled:hover:text-destructive disabled:opacity-50" disabled={busy} onClick={() => setAsking(true)}>Leave organization</button>
    </div>
  );
  return (
    <div role="alertdialog" aria-labelledby="leave-title" className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface-raised px-4 py-3">
      <div>
        <p id="leave-title" className="text-sm font-medium text-foreground">Leave {name}?</p>
        <p className="text-xs text-muted-foreground">You lose access to the team's system prompts and threads.</p>
      </div>
      <span className="flex shrink-0 gap-2">
        <button type="button" autoFocus className={button} onClick={() => setAsking(false)}>Cancel</button>
        <button type="button" className={primary} disabled={busy} onClick={() => { setAsking(false); leave(); }}>Leave</button>
      </span>
    </div>
  );
}

function Section({ title, count, action, children }: { title: ReactNode; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <header className="flex h-7 items-center gap-2">
        <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
        {count !== undefined && <span className="text-xs text-muted-foreground">{count}</span>}
        <span className="flex-1" />
        {action}
      </header>
      <div className="flex-1 overflow-hidden rounded-xl border border-border bg-surface-raised">{children}</div>
    </section>
  );
}

function Members({ org, email, busy, change }: { org: Org; email: string; busy: boolean; change: Change }) {
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState("");
  const admin = org.role === "admin";
  const send = async (event: FormEvent) => { event.preventDefault(); if (invite.trim() && await change({ action: "invite", email: invite })) { setInvite(""); setInviting(false); } };
  return (
    <Section title="Members" count={org.members.length} action={admin && (
      <button type="button" className={inviting ? button : primary} onClick={() => setInviting(!inviting)}><Icon name={inviting ? "X" : "Plus"} className="size-3.5" />{inviting ? "Cancel" : "Invite"}</button>
    )}>
      {inviting && (
        <form className="flex gap-2 border-b border-border p-3" onSubmit={send}>
          <input autoFocus type="email" value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="teammate@company.com" aria-label="Email to invite"
            className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 py-1.5 text-xs outline-none focus:border-foreground/30" />
          <button className={primary} disabled={busy || !invite.trim()}>Send invite</button>
        </form>
      )}
      <ul className="divide-y divide-border">{org.members.map((member) => {
        const you = member.email === email, role = member.joined ? member.role : "invited", next = member.role === "admin" ? "member" : "admin";
        const roleClass = `text-xs ${role === "admin" ? "text-primary" : "text-muted-foreground"}`;
        return (
          <li key={member.email} className="flex items-center gap-3 px-4 py-2.5">
            <span className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${role === "admin" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}>{member.email[0]?.toUpperCase()}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{member.email}{you && <span className="text-muted-foreground"> (you)</span>}</span>
            {admin && !you && member.joined
              ? <button type="button" className={`${roleClass} enabled:hover:underline`} disabled={busy} title={`Make ${next}`}
                onClick={() => confirm(`Make ${member.email} ${next === "admin" ? "an admin" : "a member"}?`) && void change({ action: "role", email: member.email, role: next })}>{role}</button>
              : <span className={roleClass}>{role}</span>}
            {admin && !you && (
              <button type="button" className="text-muted-foreground enabled:hover:text-destructive" disabled={busy} aria-label={`Remove ${member.email}`}
                onClick={() => confirm(`Remove ${member.email}?`) && void change({ action: "remove", email: member.email })}><Icon name="Trash2" className="size-3.5" /></button>
            )}
          </li>
        );
      })}</ul>
    </Section>
  );
}

const RECENT = 8;
const repoFromText = (text: string) => text.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").split(/[/?#]/).slice(0, 2).join("/").replace(/\.git$/i, "").toLowerCase();

function Repos({ org, busy, change }: { org: Org; busy: boolean; change: Change }) {
  const rpc = useRpc<typeof orgRpcContract>();
  const [github, setGithub] = useState<{ login: string | null; repos: string[] } | null>(null);
  const [search, setSearch] = useState("");
  const admin = org.role === "admin";
  useEffect(() => { if (admin) void rpc.call("githubRepos", {}).then(setGithub, () => setGithub({ login: null, repos: [] })); }, [rpc, admin]);
  const picked = (repo: string) => org.repos.includes(repo.toLowerCase());
  const toggle = (repo: string) => { const key = repo.toLowerCase(); void change({ action: "repos", repos: picked(key) ? org.repos.filter((each) => each !== key) : [...org.repos, key] }); };
  const label = (repo: string) => (github?.login && repo.split("/")[0]?.toLowerCase() === github.login.toLowerCase() ? repo.split("/")[1] : repo);
  const chip = (repo: string, on: boolean, onClick?: () => void) => (
    <button key={repo} type="button" title={repo} aria-pressed={on} disabled={!onClick || busy} onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${on ? "border-primary/40 bg-primary/15 text-primary" : "border-dashed border-border text-muted-foreground enabled:hover:text-foreground"}`}>
      <Icon name={on ? "Check" : "Plus"} className="size-3" />{label(repo)}
    </button>
  );
  if (!admin) return (
    <Section title="Repos" count={org.repos.length}>
      <div className="flex flex-wrap gap-1.5 p-4">{org.repos.length ? org.repos.map((repo) => chip(repo, true)) : <p className="text-xs text-muted-foreground">No repos yet. Admins pick them.</p>}</div>
    </Section>
  );
  const available = github?.repos ?? [], query = search.trim().toLowerCase(), typed = repoFromText(search);
  const recent = available.slice(0, RECENT);
  const shown = query ? [...available, ...org.repos.filter((repo) => !available.some((each) => each.toLowerCase() === repo))].filter((repo) => repo.toLowerCase().includes(query) || repo.toLowerCase() === typed).slice(0, 30)
    : [...recent, ...org.repos.filter((repo) => !recent.some((each) => each.toLowerCase() === repo))];
  const addTyped = /^[\w.-]+\/[\w.-]+$/.test(typed) && !shown.some((repo) => repo.toLowerCase() === typed);
  return (
    <Section title="Repos" count={org.repos.length}>
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {shown.map((repo) => chip(repo, picked(repo), () => toggle(repo)))}
          {addTyped && chip(typed, false, () => { if (!picked(typed)) toggle(typed); setSearch(""); })}
        </div>
        <label className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground focus-within:border-foreground/30">
          <Icon name="Search" className="size-3.5" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search GitHub repos"
            placeholder={available.length ? `Search all ${available.length} repos, or paste a link` : "Paste a GitHub link, or connect GitHub in Settings → Cloud environment"}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
    </Section>
  );
}

function Permissions({ org, busy, change }: { org: Org; busy: boolean; change: Change }) {
  const admin = org.role === "admin";
  const save = (next: Partial<{ rulesEditors: string; memberView: string; adminView: boolean }>) =>
    void change({ action: "permissions", rulesEditors: org.rules_editors, memberView: org.member_view, adminView: org.admin_view, ...next });
  const pick = (label: string, about: string, value: string, options: [string, string][], onPick: (value: string) => void) => (
    <li key={label} className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="flex items-center gap-1.5 text-sm">{label}<span title={about} aria-label={about} className="text-muted-foreground"><Icon name="Info" className="size-3.5" /></span></span>
      <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-full border border-border p-0.5">{options.map(([id, text]) => (
        <button key={id} type="button" role="radio" aria-checked={id === value} disabled={!admin || busy} onClick={() => id !== value && onPick(id)}
          className={`rounded-full px-3 py-1 text-xs ${id === value ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground enabled:hover:text-foreground"}`}>{text}</button>
      ))}</div>
    </li>
  );
  return (
    <Section title="Permissions">
      <ul className="divide-y divide-border">
        {pick("Who edits the system prompt", "Who can change the team and repo system prompts.", org.rules_editors, [["admins", "Admins"], ["everyone", "Everyone"]], (rulesEditors) => save({ rulesEditors }))}
        {pick("What members see", "Which teammates' Cloud threads members can open. Only threads in team repos count.", org.member_view, [["shared", "What owners share"], ["all", "Everything"], ["none", "Nothing"]], (memberView) => save({ memberView }))}
        {pick("What admins see", "Which teammates' Cloud threads admins can open. Everything includes locked threads.", org.admin_view ? "all" : "same", [["same", "Same as members"], ["all", "Everything"]], (view) => save({ adminView: view === "all" }))}
      </ul>
    </Section>
  );
}

function Prompts({ org, busy, change }: { org: Org; busy: boolean; change: Change }) {
  const global = <Editor title="Global system prompt" value={org.instructions} placeholder={"Use pnpm. Never push to main.\nRun the tests before opening a PR."} max={4000} busy={busy}
    readOnly={!org.canEditRules} save={(text) => change({ action: "instructions", text })} />;
  if (!org.repos.length) return global;
  return (
    <div className="grid items-start gap-4 md:grid-cols-[2fr_3fr]">
      {global}
      <div className="space-y-4">{org.repos.map((repo) => (
        <Editor key={repo} title={<RepoName repo={repo} />} label={`System prompt for ${repo}`} value={org.repo_rules[repo] ?? ""} max={4000} busy={busy} readOnly={!org.canEditRules}
          placeholder={org.canEditRules ? "Only for this repo." : "No system prompt for this repo."} save={(text) => change({ action: "repoRules", repo, text })} />
      ))}</div>
    </div>
  );
}

function RepoName({ repo }: { repo: string }) {
  const [owner, name] = repo.split("/");
  return <span className="flex items-center gap-1.5"><Icon name="Github" className="size-3.5" /><span><span className="text-muted-foreground">{owner}/</span>{name}</span></span>;
}

function SharingNote() {
  const mark = "bg-[linear-gradient(transparent_45%,color-mix(in_srgb,var(--primary)_85%,transparent)_45%)] px-0.5 text-inherit";
  return (
    <div className="flex flex-col pt-9">
      <aside className="relative flex-1 rotate-[0.8deg] rounded-sm bg-[#f4f0e4] px-6 pb-5 pt-7 text-[#1a1a1a] shadow-[0_18px_40px_rgba(0,0,0,.45)]">
        <span aria-hidden="true" className="absolute -top-3 left-1/2 h-6 w-28 -translate-x-1/2 -rotate-2 bg-primary/70" />
        <h4 className="mb-3 text-[15px] font-bold">How sharing works</h4>
        <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed">
          <li>Write a rule in <mark className={mark}>plain English</mark>: what is fine to share, and what stays private.</li>
          <li>Start a Cloud thread in a team repo. <mark className={mark}>Jev</mark> reads its first messages.</li>
          <li>Jev <mark className={mark}>shares it</mark> with your team, or keeps it private.</li>
        </ol>
        <p className="mt-3.5 text-xs text-[#5a5a5a]">The lock button always wins. Local threads are never shared.</p>
      </aside>
    </div>
  );
}

function Editor({ title, label, wrap = false, value, placeholder, max, busy, readOnly = false, save }: { title: ReactNode; label?: string; wrap?: boolean; value: string; placeholder: string; max: number; busy: boolean; readOnly?: boolean; save: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value, dirty = draft !== null && draft !== value;
  const rows = Math.max(3, (text || placeholder).split("\n").length + 1);
  const submit = async () => { if (dirty && !busy && !readOnly && await save(text)) setDraft((current) => (current === text ? null : current)); };
  return (
    <Section title={title} action={readOnly ? <span title="Only admins edit this" className="text-muted-foreground"><Icon name="Lock" className="size-3.5" /></span> : dirty && <button type="button" className={primary} disabled={busy} onClick={() => void submit()}>Save</button>}>
      <textarea value={text} rows={rows} wrap={wrap ? "soft" : "off"} spellCheck={false} placeholder={placeholder} maxLength={max} readOnly={readOnly} aria-label={label ?? String(title)}
        onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); void submit(); } }}
        className={`block h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground ${wrap ? "whitespace-pre-wrap" : "whitespace-pre"}`} />
    </Section>
  );
}
