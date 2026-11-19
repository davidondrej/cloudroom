import { useEffect, useState } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { Board as BoardData, BoardCard, orgRpcContract } from "./contract.js";
import { errorText } from "./settings.js";

// The team board (docs/scopes/organizations.md#team-board, ADR 20261118-201443): one column per teammate you may see,
// their threads as cards. Refreshes every 30 s while open, never in the background.
type Status = BoardCard["status"];
type Actions = { read: (card: BoardCard) => void; fork: (card: BoardCard) => void; takeOver: (card: BoardCard) => void; busy: boolean };
const REFRESH_MS = 30_000, ORDER: Status[] = ["waiting", "working", "idle", "done"];
const TONE: Record<Status, { dot: string; text: string }> = {
  working: { dot: "bg-primary", text: "text-primary" },
  waiting: { dot: "bg-warning", text: "text-warning-text" },
  idle: { dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  done: { dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
};
const small = "inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-foreground enabled:hover:bg-muted/70 disabled:opacity-50";
const ago = (at: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  return minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
};

function Stat({ n, label, status }: { n: number; label: string; status?: Status }) {
  return (
    <div>
      <div className={`text-3xl font-semibold leading-none tabular-nums ${status ? TONE[status].text : "text-foreground"}`}>{n}</div>
      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">{status && <span className={`size-1.5 rounded-full ${TONE[status].dot}`} />}{label}</div>
    </div>
  );
}

function Card({ card, actions }: { card: BoardCard; actions: Actions }) {
  const tone = TONE[card.status], pr = card.pr;
  const label = { working: "Working", waiting: `Needs ${card.ownerName}`, idle: "Idle", done: "Done" }[card.status];
  // A Local thread's chat stays on its owner's computer; a done one can be read but not continued.
  const cloud = !card.local, open = cloud && card.status !== "done";
  return (
    <li className={`group relative overflow-hidden rounded-xl bg-composer p-3 shadow-message ${card.status === "done" ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium">
        {card.status === "done" ? <Icon name="Check" className="size-3 text-muted-foreground" /> : <span className={`size-1.5 rounded-full ${tone.dot}`} />}
        <span className={tone.text}>{label}</span>
        <span className="ml-auto font-normal text-muted-foreground">{ago(card.at)}</span>
      </div>
      <button type="button" disabled={!cloud} onClick={() => actions.read(card)} className="mt-1.5 block w-full text-left">
        <span className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">{card.title}</span>
        {card.purpose && <span className="mt-1 line-clamp-3 text-xs leading-snug text-muted-foreground">{card.purpose}</span>}
      </button>
      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        {pr && (
          <a href={pr.url} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 hover:underline ${pr.state === "merged" ? "text-pr-merged" : pr.checks === "failing" ? "text-destructive-text" : "text-foreground"}`}>
            <Icon name={pr.state === "merged" ? "GitMerge" : pr.state === "draft" ? "GitPullRequestDraft" : pr.state === "closed" ? "GitPullRequestClosed" : "GitPullRequest"} className="size-3" />
            #{pr.number}
            <span className="text-muted-foreground">{pr.state !== "open" ? pr.state : pr.checks === "none" ? "open" : `checks ${pr.checks}`}</span>
          </a>
        )}
        {card.local && <span className="inline-flex items-center gap-1"><Icon name="Laptop" className="size-3" />On {card.ownerName}'s computer</span>}
        <span className="ml-auto truncate">{card.model ?? ""}</span>
      </div>
      {cloud && (
        <div className="mt-2.5 hidden gap-1.5 group-focus-within:flex group-hover:flex">
          <button type="button" className={small} onClick={() => actions.read(card)}><Icon name="Eye" className="size-3" />Read</button>
          {open && <button type="button" className={small} disabled={actions.busy} onClick={() => actions.fork(card)}><Icon name="Fork" className="size-3" />Fork</button>}
          {open && <button type="button" className={small} disabled={actions.busy} onClick={() => actions.takeOver(card)}><Icon name="ArrowRight" className="size-3" />Take over</button>}
        </div>
      )}
      {card.status === "working" && card.percent !== null && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-muted"><div className="h-full bg-primary" style={{ width: `${card.percent}%` }} /></div>
      )}
    </li>
  );
}

export function Board({ actions }: { actions: Actions }) {
  const rpc = useRpc<typeof orgRpcContract>();
  const [data, setData] = useState<BoardData | null>(null);
  const [found, setFound] = useState<BoardCard[] | null>(null);
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void rpc.call("board", {}).then((next) => { if (live) { setData(next); setProblem(null); } }, (failure) => live && setProblem(errorText(failure)));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [rpc]);
  // Search reaches 90 days back, archived threads too; the board itself shows the last 2 weeks.
  useEffect(() => {
    if (!query.trim()) { setFound(null); return; }
    let live = true;
    const timer = setTimeout(() => void rpc.call("search", { query }).then(({ cards }) => live && setFound(cards), (failure) => live && setProblem(errorText(failure))), 300);
    return () => { live = false; clearTimeout(timer); };
  }, [rpc, query]);

  if (!data) return problem ? <p className="text-xs text-destructive">{problem}</p> : <p className="text-xs text-muted-foreground">Loading…</p>;
  const cards = found ?? data.cards;
  const count = (status: Status) => data.cards.filter((card) => card.status === status).length;
  const shown = cards.filter((card) => filter === "all" || card.status === filter);
  const filters = [["all", "Everything", data.cards.length], ["working", "Working", count("working")], ["waiting", "Needs a person", count("waiting")],
    ["idle", "Idle", count("idle")], ["done", "Done today", count("done")]] as const;
  const people = found ? data.people.filter((person) => found.some((card) => card.owner === person.owner)) : data.people;
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-6">
        <div className="flex gap-10">
          <Stat n={count("working")} label="agents working" status="working" />
          <Stat n={count("waiting")} label="waiting on a person" status="waiting" />
          <Stat n={data.cards.filter((card) => card.pr?.state === "open" || card.pr?.state === "draft").length} label="pull requests open" />
          <Stat n={count("done")} label="done today" />
        </div>
        <label className="flex h-9 w-72 items-center gap-2 rounded-xl bg-composer px-3 shadow-message">
          <Icon name="Search" className="size-3.5 text-muted-foreground" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the team's threads" aria-label="Search the team's threads"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
      <div className="flex gap-1.5">
        {filters.map(([id, label, n]) => (
          <button key={id} type="button" onClick={() => setFilter(id)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${filter === id ? "bg-foreground font-medium text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
            {label}<span className="opacity-60">{n}</span>
          </button>
        ))}
      </div>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      {!people.length && <p className="text-xs text-muted-foreground">{found ? "No teammate thread matches." : "Your organization shows you no teammates' threads yet."}</p>}
      <div className="grid items-start gap-4" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(people.length, 4))}, minmax(0, 1fr))` }}>
        {people.map((person) => {
          const theirs = shown.filter((card) => card.owner === person.owner).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
          const working = cards.filter((card) => card.owner === person.owner && card.status === "working").length;
          const waiting = cards.filter((card) => card.owner === person.owner && card.status === "waiting").length;
          return (
            <section key={person.owner} className="min-w-0">
              <div className="flex items-center gap-2.5 px-1 pb-3">
                <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold text-foreground">
                  {person.name[0]?.toUpperCase()}
                  {working > 0 && <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-primary" />}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">{person.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{[working && `${working} working`, waiting && `${waiting} waiting`].filter(Boolean).join(" · ") || "Nothing running"}</div>
                </div>
              </div>
              <ul className="space-y-2">{theirs.map((card) => <Card key={`${card.owner}/${card.thread}`} card={card} actions={actions} />)}</ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
