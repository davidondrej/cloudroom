import { useEffect, useState } from "react";
import { definePluginApp, useRpc, type StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@cloudroom/shared-ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { Switch } from "@cloudroom/shared-ui/switch";
import type { repoSyncRpcContract } from "./server.js";

type Row = StandardSchemaV1InferOutput<(typeof repoSyncRpcContract)["change"]["output"]>[number];
type Change = { repo: string; on?: boolean; branch?: string; every?: number; remove?: boolean };

const EVERY = [
  { value: 30, label: "30 sec" },
  { value: 60, label: "1 min" },
  { value: 300, label: "5 min" },
  { value: 900, label: "15 min" },
];
const GRID = "grid grid-cols-[minmax(0,1fr)_7rem_7rem_2.25rem_1.75rem] items-center gap-x-4";
const PICKER = "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ago = (at: number) => {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
};

function Picker({ label, value, children, onOpen }: { label: string; value: string; children: React.ReactNode; onOpen?: () => void }) {
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen?.()}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={label} className={PICKER}>
          <span className="min-w-0 truncate">{value}</span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RepoSyncSettings() {
  const rpc = useRpc<typeof repoSyncRpcContract>();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [pushed, setPushed] = useState<Record<string, number>>({});
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("get", null).then(
      (view) => {
        setRows(view.rows);
        setAvailable(view.available);
        setPushed(view.pushed);
      },
      (failure: unknown) => setError(message(failure)),
    );
  }, [rpc]);

  /** Shows the change at once; the website's answer replaces it, and a failure puts the last saved rows back. */
  const change = (input: Change) => {
    const before = rows;
    setError(null);
    if (before) setRows(input.remove ? before.filter((row) => row.repo !== input.repo) : before.map((row) => (row.repo === input.repo ? { ...row, ...input } : row)));
    rpc.call("change", input).then(setRows, (failure: unknown) => {
      setRows(before);
      setError(message(failure));
    });
  };
  const loadBranches = (repo: string) => {
    if (branches[repo]) return;
    rpc.call("branches", { repo }).then((list) => setBranches((all) => ({ ...all, [repo]: list })), () => {});
  };

  if (!rows) {
    return <p className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{error ?? "Loading your repos…"}</p>;
  }
  const listed = (repo: string) => rows.some((row) => row.repo.toLowerCase() === repo.toLowerCase());
  const query = search.trim().toLowerCase();
  const choices = available.filter((repo) => !listed(repo) && (!query || repo.toLowerCase().includes(query)));
  const typed = search.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const addTyped = /^[\w.-]+\/[\w.-]+$/.test(typed) && !listed(typed) && !available.some((repo) => repo.toLowerCase() === typed.toLowerCase());
  const add = (repo: string) => {
    setAdding(false);
    setSearch("");
    setError(null);
    rpc.call("change", { repo }).then(setRows, (failure: unknown) => setError(message(failure)));
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        When an agent finishes a turn, its work in these repos is committed and pushed to the branch you pick, from any branch, at most once per
        interval. Commits from other people's branches, files named like secrets, and files over 50 MB stay out. This applies on every computer.
      </p>
      <div className="overflow-hidden rounded-lg bg-surface-recessed">
        {rows.length > 0 && (
          <div className={`${GRID} border-b border-border px-4 py-2 text-2xs uppercase tracking-wide text-subtle-foreground`}>
            <span>Repo</span>
            <span>Push to</span>
            <span>Every</span>
            <span />
            <span />
          </div>
        )}
        <div className="divide-y divide-border">
          {rows.map((row) => {
            const last = pushed[row.repo];
            return (
              <div key={row.repo} className={`${GRID} px-4 py-2.5`}>
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-foreground">{row.repo}</p>
                  <p className="mt-0.5 text-xs text-subtle-foreground/75">
                    {row.on ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-1.5 rounded-full bg-success" />
                        {last ? `Last push ${ago(last)}` : "Syncing"}
                      </span>
                    ) : (
                      "Not syncing"
                    )}
                  </p>
                </div>
                <Picker label={`Branch for ${row.repo}`} value={row.branch} onOpen={() => loadBranches(row.repo)}>
                  {(branches[row.repo] ?? [row.branch]).map((branch) => (
                    <DropdownMenuItem key={branch} onSelect={() => change({ repo: row.repo, branch })} className="font-mono text-xs">
                      {branch}
                    </DropdownMenuItem>
                  ))}
                </Picker>
                <Picker label={`How often to push ${row.repo}`} value={EVERY.find((each) => each.value === row.every)?.label ?? `${row.every} s`}>
                  {EVERY.map((each) => (
                    <DropdownMenuItem key={each.value} onSelect={() => change({ repo: row.repo, every: each.value })} className="text-xs">
                      {each.label}
                    </DropdownMenuItem>
                  ))}
                </Picker>
                <Switch aria-label={`Sync ${row.repo}`} checked={row.on} onCheckedChange={(on) => change({ repo: row.repo, on })} />
                <Button variant="ghost" size="icon" aria-label={`Remove ${row.repo}`} className="size-7 text-subtle-foreground" onClick={() => change({ repo: row.repo, remove: true })}>
                  <Icon name="Trash2" className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
        {!rows.length && <p className="px-4 py-4 text-xs text-subtle-foreground">No repos yet. Add one to push its cloud work to GitHub automatically.</p>}
        <div className="border-t border-border px-2 py-1.5">
          <Popover open={adding} onOpenChange={(open) => { setAdding(open); if (!open) setSearch(""); }}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="text-subtle-foreground">
                <Icon name="Plus" />
                Add a GitHub repo
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" aria-label="Add a GitHub repo" className="w-96 p-0">
              <Command shouldFilter={false} label="Search GitHub repos">
                <CommandInput value={search} onValueChange={setSearch} placeholder="Search your GitHub repos, or paste a link" className="h-9 text-xs" />
                <CommandList className="max-h-72">
                  {addTyped && (
                    <CommandItem value={`add:${typed}`} onSelect={() => add(typed)} className="gap-2 text-xs">
                      <Icon name="Plus" className="size-3.5" />
                      Add <span className="font-mono">{typed}</span>
                    </CommandItem>
                  )}
                  {choices.map((repo) => (
                    <CommandItem key={repo} value={repo} onSelect={() => add(repo)} className="gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate font-mono">{repo}</span>
                      {pushed[repo] && <span className="shrink-0 text-2xs text-subtle-foreground">{ago(pushed[repo])}</span>}
                    </CommandItem>
                  ))}
                  {!addTyped && !choices.length && (
                    <p className="px-3 py-4 text-center text-xs text-subtle-foreground">
                      {query ? "No repos match. Paste a GitHub link to add any repo." : "Connect GitHub in Cloud environment to pick from your repos."}
                    </p>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "repos", component: RepoSyncSettings });
});
