import { COMPUTER, COMPUTER_TITLE } from "@cloudroom/domain";
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CloudEnvironment, CloudEnvironmentChange, CloudSkillsChange } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@cloudroom/shared-ui/command";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { Switch } from "@cloudroom/shared-ui/switch";
import { Textarea } from "@cloudroom/shared-ui/textarea";
import { useCloudroomAccount, useSetCopyLogins } from "@/hooks/queries/cloudroom-queries";
import { sdk } from "@/lib/sdk";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { formatRelativeTime } from "@/lib/relative-time";
import { MAC_MCP_KEY, useMcpSignIn } from "@/components/CloudMcpSignIn";
import { useThisComputer } from "@/hooks/useHostDaemon";

const ENVIRONMENT_KEY = ["cloudroom-environment"];
const SKILLS_KEY = ["cloudroom-cloud-skills"];
const CLIS_KEY = ["cloudroom-mac-clis"];
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREINSTALLED = "Node.js · Git · GitHub CLI · Claude Code · Codex · Pi · Cursor";
// Dimmer than the default placeholder, so the example never reads as saved text.
const DIM_PLACEHOLDER = "placeholder:text-subtle-foreground/60";
const SCRIPT_PLACEHOLDER = "# Runs once in each new cloud sandbox, as the agent. sudo works.\nsudo npm install -g vercel";

export const errorText = (error: unknown) => (error instanceof Error ? error.message : error ? String(error) : null);

export function CloudEnvironmentSettingsSection() {
  const queryClient = useQueryClient();
  const environment = useQuery({
    queryKey: ENVIRONMENT_KEY,
    queryFn: ({ signal }) => sdk.cloudroom.environment(signal),
    refetchInterval: 15_000,
    retry: false,
  });
  const saved = (data: CloudEnvironment) => queryClient.setQueryData(ENVIRONMENT_KEY, data);
  const update = useMutation({ mutationFn: (change: CloudEnvironmentChange) => sdk.cloudroom.updateEnvironment(change), onSuccess: saved });
  const data = environment.data;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Cloud environment</h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-subtle-foreground">
            Every new cloud thread starts with these skills, MCP servers, API keys, GitHub repos, and this setup. Change them here or on your cloudroom.dev dashboard. Both stay in sync.
          </p>
        </div>
        {data && !environment.isError && (
          <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-border bg-surface-recessed px-2.5 py-1 text-2xs text-subtle-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            Synced with cloudroom.dev
          </span>
        )}
      </header>
      {!data ? (
        <div role={environment.isError ? "alert" : "status"} className="rounded-lg bg-surface-recessed px-4 py-6 text-center text-xs text-subtle-foreground">
          {environment.isError ? errorText(environment.error) : "Loading your cloud environment…"}
        </div>
      ) : (
        <>
          <CopyLoginsCard />
          <GithubCard />
          <SkillsCard />
          <McpCard inCloud={data.mcp} onSaved={saved} />
          <VariablesCard environment={data} busy={update.isPending} onChange={(change) => update.mutateAsync(change)} onImported={saved} />
          <ReposCard repos={data.repos} busy={update.isPending} onChange={(change) => update.mutateAsync(change)} />
          <SetupScriptCard setup={data.setup} keys={data.variables.map((variable) => variable.name)} onSave={(setup) => update.mutateAsync({ action: "setup", setup })} />
        </>
      )}
      {update.error && (
        <p role="alert" className="text-xs text-destructive-text">
          {errorText(update.error)}
        </p>
      )}
    </div>
  );
}

export function Card({ icon, title, description, action, children }: { icon: string; title: string; description?: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg bg-surface-recessed">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-recessed text-subtle-foreground">
            <Icon name={icon} className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            {description && <p className="text-xs text-subtle-foreground">{description}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function CopyLoginsCard() {
  const account = useCloudroomAccount();
  const setCopyLogins = useSetCopyLogins();
  const enabled = setCopyLogins.isPending ? setCopyLogins.variables : account.data?.copyLogins === true;
  return (
    <Card
      icon="Key"
      title="Auth my agents in the cloud automatically"
      description="Cloud threads will use this computer's auth for inference providers"
      action={<Switch aria-label="Auth my agents in the cloud automatically" checked={enabled} disabled={!account.data || setCopyLogins.isPending} onCheckedChange={(on) => setCopyLogins.mutate(on)} />}
    >
      {setCopyLogins.error && <p role="alert" className="border-t border-border px-4 py-3 text-xs text-destructive-text">{errorText(setCopyLogins.error)}</p>}
    </Card>
  );
}

/** The GitHub account cloud agents clone and push as. Separate from how the user signs in to Cloudroom. */
function GithubCard() {
  const queryClient = useQueryClient();
  const requestId = useRef<string | null>(null);
  const status = useQuery({
    queryKey: ["cloudroom-github-auth"],
    queryFn: ({ signal }) => sdk.cloudroom.githubAuth(signal),
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === "waiting" ? 1500 : false),
  });
  const state = status.data?.state;
  const connected = state === "connected";
  const account = useQuery({ queryKey: ["cloudroom-github-account"], queryFn: ({ signal }) => sdk.cloudroom.githubAccount(signal), enabled: connected, retry: false });
  // A switch or reconnect may land on another account.
  useEffect(() => { if (connected) void queryClient.invalidateQueries({ queryKey: ["cloudroom-github-account"] }); }, [connected, queryClient]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["cloudroom-github-auth"] });
  const connect = useMutation({
    mutationFn: async () => {
      requestId.current = crypto.randomUUID();
      const result = await sdk.cloudroom.githubLogin(requestId.current);
      if (result.state === "waiting" && result.verification_url && new URL(result.verification_url).origin !== "https://github.com") throw new Error("Unexpected GitHub sign-in page.");
    },
    onSettled: refresh,
  });
  const cancel = useMutation({ mutationFn: () => sdk.cloudroom.cancelGithubLogin(requestId.current ?? status.data?.login_id ?? ""), onSettled: refresh });
  const disconnect = useMutation({ mutationFn: () => sdk.cloudroom.disconnectGithub(), onSettled: refresh });
  const code = state === "waiting" ? status.data?.user_code : null;
  const url = state === "waiting" ? status.data?.verification_url : null;
  const copyAndOpen = async (value: string) => {
    await copyToClipboardWithToast(value, { successMessage: "Code copied. Paste it on github.com." });
    if (url && new URL(url).origin === "https://github.com") openUrlInExternalBrowser(url);
  };
  const busy = connect.isPending || disconnect.isPending;
  const user = account.data;
  const problem = errorText(status.error ?? connect.error ?? disconnect.error) ?? (state === "error" || state === "expired" ? status.data?.message : null);

  return (
    <Card icon="Github" title="GitHub" description="Every cloud thread clones, pushes, and opens PRs as this account.">
      <div className="space-y-3 border-t border-border px-4 py-3">
        {code ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-lg font-semibold tracking-[0.2em] text-foreground">{code}</span>
            <p className="min-w-0 flex-1 text-xs text-subtle-foreground">Paste this code on github.com. It connects the account signed in there, so switch accounts there first if needed.</p>
            <Button size="sm" variant="outline" onClick={() => void copyAndOpen(code)}><Icon name="Copy" className="size-3.5" />Copy & open GitHub</Button>
            <Button size="sm" variant="ghost" className="text-subtle-foreground" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            {connected ? (
              <div className="flex min-w-0 items-center gap-2.5">
                {user?.avatarUrl ? <img src={user.avatarUrl} alt="" className="size-7 shrink-0 rounded-full" /> : <Icon name="Github" className="size-5 shrink-0 text-subtle-foreground" />}
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">
                    {user ? <>@{user.login}{user.name && <span className="ml-1.5 text-xs text-subtle-foreground">{user.name}</span>}</> : "GitHub"}
                  </p>
                  <p className="text-xs text-subtle-foreground">Connected</p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-subtle-foreground">{status.isPending ? "Checking GitHub…" : "Not connected. Cloud agents can only clone public repos."}</p>
            )}
            {!status.isPending && !status.isError && (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant={connected ? "outline" : "default"} disabled={busy} onClick={() => connect.mutate()}>
                  {connected ? "Switch account" : <><Icon name="Github" className="size-3.5" />Connect GitHub</>}
                </Button>
                {connected && <Button size="sm" variant="ghost" className="text-destructive-text" disabled={busy} onClick={() => disconnect.mutate()}>Disconnect</Button>}
              </div>
            )}
          </div>
        )}
        {problem && <p role="alert" className="text-xs text-destructive-text">{problem}</p>}
      </div>
    </Card>
  );
}

function VariablesCard({
  environment,
  busy,
  onChange,
  onImported,
}: {
  environment: CloudEnvironment;
  busy: boolean;
  onChange: (change: CloudEnvironmentChange) => Promise<unknown>;
  onImported: (data: CloudEnvironment) => void;
}) {
  const here = useThisComputer();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  // Scans this Mac's shell on open, so keys the cloud lacks show up without a click.
  const mac = useQuery({ queryKey: ["cloudroom-mac-variables"], queryFn: ({ signal }) => sdk.cloudroom.macVariables(signal), retry: false });
  const importKeys = useMutation({ mutationFn: (names: string[]) => sdk.cloudroom.importMacVariables(names), onSuccess: onImported });
  const saved = new Set(environment.variables.map((variable) => variable.name));
  const missing = (mac.data?.names ?? []).filter((macName) => !saved.has(macName));
  const locked = busy || importKeys.isPending;
  // Typed text keeps the form open even if the Mac scan finishes late.
  const showForm = adding || Boolean(name || value) || (!environment.variables.length && !missing.length);
  const nameProblem = name && !VARIABLE_NAME.test(name) ? "Names start with a letter or underscore." : null;
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!name || !value.trim() || nameProblem) return;
    void onChange({ action: "set", variables: { [name]: value } }).then(() => {
      setName("");
      setValue("");
      setAdding(false);
    }, () => {});
  };
  const pasteLine = (event: ClipboardEvent<HTMLInputElement>) => {
    const line = event.clipboardData.getData("text").trim().replace(/^export\s+/, "");
    const at = line.indexOf("=");
    if (at < 1) return;
    event.preventDefault();
    setName(line.slice(0, at).trim());
    setValue(line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, "$2"));
  };
  return (
    <Card icon="Lock" title="API keys" description="Cloud threads get all of these as environment variables. Each Cloud loop gets only the ones picked for it. Values are hidden after saving.">
      {environment.variables.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {environment.variables.map((variable) => (
            <li key={variable.name} className="group flex items-center gap-3 px-4 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{variable.name}</code>
              {environment.loops?.[variable.name] ? (
                <span title="Cloud loops that picked this key" className="rounded-full border border-border px-1.5 text-2xs text-subtle-foreground">
                  {environment.loops[variable.name]} {environment.loops[variable.name] === 1 ? "loop" : "loops"}
                </span>
              ) : null}
              <span className="rounded-full border border-primary/30 px-1.5 text-2xs text-primary-text">in cloud</span>
              <span className="font-mono text-xs tracking-wider text-subtle-foreground" aria-label="Hidden value">
                ••••••••{variable.hint}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-subtle-foreground hover:text-destructive-text"
                aria-label={`Remove ${variable.name}`}
                disabled={locked}
                onClick={() => void onChange({ action: "remove", name: variable.name }).catch(() => {})}
              >
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-3 border-t border-border bg-primary/5 px-4 py-2">
            <p className="text-xs text-foreground">
              <span className="font-semibold">{missing.length} more on {here}</span>
              <span className="text-subtle-foreground"> · from your shell</span>
            </p>
            <Button size="sm" disabled={locked} onClick={() => importKeys.mutate(missing)}>
              {importKeys.isPending ? "Importing…" : missing.length > 1 ? `Import all ${missing.length}` : "Import"}
            </Button>
          </div>
          <ul className="divide-y divide-border border-t border-border bg-primary/[0.02]">
            {missing.map((macName) => (
              <li key={macName} className="flex items-center gap-3 px-4 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{macName}</code>
                <Button size="sm" variant="outline" className="h-7" disabled={locked} onClick={() => importKeys.mutate([macName])}>
                  <Icon name="Plus" />
                  Import
                </Button>
              </li>
            ))}
          </ul>
          {importKeys.error && (
            <p role="alert" className="border-t border-border px-4 py-2 text-xs text-destructive-text">
              {errorText(importKeys.error)}
            </p>
          )}
        </>
      )}
      {showForm ? (
        <form onSubmit={add} className="flex flex-col gap-2 border-t border-border bg-surface-recessed/40 px-4 py-3 sm:flex-row sm:items-start">
          <div className="sm:w-60">
            <Input
              className={`h-8 font-mono text-xs ${DIM_PLACEHOLDER}`}
              placeholder="OPENROUTER_API_KEY"
              aria-label="Variable name"
              aria-invalid={nameProblem !== null}
              autoComplete="off"
              spellCheck={false}
              autoFocus={adding}
              value={name}
              onPaste={pasteLine}
              onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            />
            {nameProblem && <p className="mt-1 text-2xs text-destructive-text">{nameProblem}</p>}
          </div>
          <Input
            className={`h-8 min-w-0 flex-1 font-mono text-xs ${DIM_PLACEHOLDER}`}
            type="password"
            placeholder="Value"
            aria-label="Variable value"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={locked || !name || !value.trim() || nameProblem !== null}>
            <Icon name="Plus" />
            Add
          </Button>
        </form>
      ) : (
        <div className="border-t border-border px-2 py-1.5">
          <Button size="sm" variant="ghost" className="text-subtle-foreground" onClick={() => setAdding(true)}>
            <Icon name="Plus" />
            Add a key manually
          </Button>
        </div>
      )}
    </Card>
  );
}

function SkillsCard() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const here = useThisComputer();
  // Refreshes, so skills added on this Mac and background upload problems show up.
  const skills = useQuery({ queryKey: SKILLS_KEY, queryFn: ({ signal }) => sdk.cloudroom.cloudSkills(signal), refetchInterval: 15_000, retry: false });
  const change = useMutation({
    mutationFn: (change: CloudSkillsChange) => sdk.cloudroom.setCloudSkills(change),
    onSuccess: (data) => queryClient.setQueryData(SKILLS_KEY, data),
  });
  const data = skills.data;
  const all = data?.skills ?? [];
  const query = search.trim().toLowerCase();
  const shown = query ? all.filter((skill) => skill.name.includes(query) || skill.description.toLowerCase().includes(query)) : all;
  const set = (cloud: boolean) => {
    const names = shown.filter((skill) => skill.cloud !== cloud).map((skill) => skill.name);
    if (names.length) change.mutate({ names, cloud });
  };
  return (
    <Card
      icon="Brain"
      title="Skills"
      description="Click a skill to add it to or remove it from every new cloud thread."
      action={
        all.length > 0 && (
          <div className="relative w-56 shrink-0">
            <Icon name="Search" className="absolute inset-y-0 left-2.5 my-auto size-3.5 text-subtle-foreground" />
            <Input
              className={`h-8 pl-8 text-xs ${DIM_PLACEHOLDER}`}
              placeholder={`Search ${all.length} skills…`}
              aria-label="Search skills"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        )
      }
    >
      {!data ? (
        <p role={skills.isError ? "alert" : "status"} className="border-t border-border px-4 py-3 text-xs text-subtle-foreground">
          {skills.isError ? errorText(skills.error) : `Looking for skills on ${here}…`}
        </p>
      ) : !all.length ? (
        <p className="border-t border-border px-4 py-3 text-xs text-subtle-foreground">
          No skills on {here} yet. Add them to <code>~/.agents/skills</code>.
        </p>
      ) : (
        <>
          <div className="max-h-52 overflow-y-auto border-t border-border">
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {shown.map((skill) => (
                <button
                  key={skill.name}
                  type="button"
                  title={skill.description || undefined}
                  aria-pressed={skill.cloud}
                  disabled={change.isPending}
                  onClick={() => change.mutate({ names: [skill.name], cloud: !skill.cloud })}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs transition-colors disabled:cursor-wait ${
                    skill.cloud
                      ? "border-primary/40 bg-primary/15 text-primary-text hover:bg-primary/25"
                      : "border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  }`}
                >
                  <Icon name={skill.cloud ? "Check" : "Plus"} className="size-3" />
                  {skill.name}
                </button>
              ))}
              {!shown.length && <p className="py-1 text-xs text-subtle-foreground">No skills match “{search}”.</p>}
            </div>
            {/* Fades the cut-off row while there is more to scroll; at the end it is just bottom padding. */}
            <div className="pointer-events-none sticky bottom-0 h-3 bg-gradient-to-t from-card to-transparent" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-recessed/40 px-4 py-2">
            <label className="flex items-center gap-2 text-xs text-subtle-foreground">
              <Switch checked={data.auto} disabled={change.isPending} onCheckedChange={(auto) => change.mutate({ auto })} />
              New skills go to the cloud automatically
            </label>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs text-subtle-foreground">
                {all.filter((skill) => skill.cloud).length} of {all.length} in cloud
              </span>
              <Button size="sm" variant="ghost" className="text-subtle-foreground" disabled={change.isPending || shown.every((skill) => skill.cloud)} onClick={() => set(true)}>
                Select all
              </Button>
              <Button size="sm" variant="ghost" className="text-subtle-foreground" disabled={change.isPending || shown.every((skill) => !skill.cloud)} onClick={() => set(false)}>
                Clear
              </Button>
            </div>
          </div>
        </>
      )}
      {(change.error || data?.issue) && (
        <p role="alert" className="border-t border-border px-4 py-2 text-xs text-destructive-text">
          {change.error ? errorText(change.error) : `Skills could not be copied to the cloud: ${data?.issue}`}
        </p>
      )}
    </Card>
  );
}

/** MCP servers from this Mac's Claude Code and Codex. The Cloud environment says which ones are in the cloud. */
function McpCard({ inCloud, onSaved }: { inCloud: string[]; onSaved: (data: CloudEnvironment) => void }) {
  const here = useThisComputer();
  const mac = useQuery({ queryKey: MAC_MCP_KEY, queryFn: ({ signal }) => sdk.cloudroom.macMcpServers(signal), refetchInterval: 15_000, retry: false });
  const signIn = useMcpSignIn();
  const change = useMutation({ mutationFn: (change: { names: string[]; cloud: boolean }) => sdk.cloudroom.setCloudMcp(change), onSuccess: onSaved });
  const found = mac.data?.servers ?? [];
  // A server removed from this Mac stays listed while it is in the cloud, so it can be removed there too.
  const servers = [...found, ...inCloud.filter((name) => !found.some((server) => server.name === name)).map((name) => ({ name, macOnly: false }))]
    .map((server) => ({ ...server, cloud: inCloud.includes(server.name) }))
    .sort((a, b) => Number(a.macOnly) - Number(b.macOnly) || a.name.localeCompare(b.name));
  const usable = servers.filter((server) => !server.macOnly);
  const needSignIn = servers.filter((server) => server.cloud && "signIn" in server && server.signIn === "needed");
  const set = (cloud: boolean) => {
    const names = usable.filter((server) => server.cloud !== cloud).map((server) => server.name);
    if (names.length) change.mutate({ names, cloud });
  };
  return (
    <Card icon="Plug02" title="MCP servers" description={`${here === "this PC" ? "Your PC" : `Your ${COMPUTER}`}'s MCP servers from Claude Code and Codex. Click one to add it to every new cloud thread.`}>
      {!mac.data ? (
        <p role={mac.isError ? "alert" : "status"} className="border-t border-border px-4 py-3 text-xs text-subtle-foreground">
          {mac.isError ? errorText(mac.error) : `Looking for MCP servers on ${here}…`}
        </p>
      ) : !servers.length ? (
        <p className="border-t border-border px-4 py-3 text-xs text-subtle-foreground">
          No MCP servers on {here} yet. Add one with <code>claude mcp add --scope user</code>.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3">
            {servers.map((server) =>
              server.macOnly ? (
                <span
                  key={server.name}
                  title={`It runs a program or uses a folder that only ${here} has.`}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 font-mono text-xs text-subtle-foreground/60"
                >
                  {server.name}
                  <span className="font-sans text-2xs">· {here === "this PC" ? "PC" : COMPUTER_TITLE} only</span>
                </span>
              ) : (
                <button
                  key={server.name}
                  type="button"
                  aria-pressed={server.cloud}
                  disabled={change.isPending}
                  onClick={() => change.mutate({ names: [server.name], cloud: !server.cloud })}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs transition-colors disabled:cursor-wait ${
                    server.cloud
                      ? "border-primary/40 bg-primary/15 text-primary-text hover:bg-primary/25"
                      : "border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  }`}
                >
                  <Icon name={server.cloud ? "Check" : "Plus"} className="size-3" />
                  {server.name}
                </button>
              ),
            )}
          </div>
          {/* Servers that use OAuth need one sign-in for the cloud; the Mac's own login stays on the Mac. */}
          {needSignIn.map((server) => (
            <div key={server.name} className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5 text-xs">
                <Icon name="Lock" className="size-3.5 shrink-0 text-subtle-foreground" />
                <span className="truncate font-mono text-foreground">{server.name}</span>
                <span className="shrink-0 text-subtle-foreground">needs a cloud sign-in</span>
              </div>
              <Button size="sm" variant="outline" disabled={signIn.waitingFor === server.name} onClick={() => signIn.start(server.name)}>
                {signIn.waitingFor === server.name ? "Waiting for your browser…" : "Sign in"}
              </Button>
            </div>
          ))}
          {signIn.error && (
            <p role="alert" className="border-t border-border px-4 py-2 text-xs text-destructive-text">
              {errorText(signIn.error)}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-recessed/40 px-4 py-2">
            <span className="text-xs text-subtle-foreground">Keys in these servers are stored encrypted, like API keys.</span>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs text-subtle-foreground">
                {usable.filter((server) => server.cloud).length} of {usable.length} in cloud
              </span>
              <Button size="sm" variant="ghost" className="text-subtle-foreground" disabled={change.isPending || usable.every((server) => server.cloud)} onClick={() => set(true)}>
                Select all
              </Button>
              <Button size="sm" variant="ghost" className="text-subtle-foreground" disabled={change.isPending || usable.every((server) => !server.cloud)} onClick={() => set(false)}>
                Clear
              </Button>
            </div>
          </div>
        </>
      )}
      {change.error && (
        <p role="alert" className="border-t border-border px-4 py-2 text-xs text-destructive-text">
          {errorText(change.error)}
        </p>
      )}
    </Card>
  );
}

const RECENT_REPOS = 8;
/** `owner/name` from a GitHub link, or the text as typed. */
const repoFromText = (text: string) => text.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").split(/[/?#]/).slice(0, 2).join("/").replace(/\.git$/i, "");

function ReposCard({ repos, busy, onChange }: { repos: string[]; busy: boolean; onChange: (change: CloudEnvironmentChange) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // The account's GitHub repos, most recently pushed first.
  const github = useQuery({
    queryKey: ["cloudroom-github-repos"],
    queryFn: () => sdk.cloudroom.updateEnvironment({ action: "githubRepos" }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const available = github.data?.available ?? [];
  const picked = (repo: string) => repos.find((each) => each.toLowerCase() === repo.toLowerCase());
  const toggle = (repo: string) => {
    const saved = picked(repo);
    void onChange(saved ? { action: "removeRepo", repo: saved } : { action: "addRepo", repo }).catch(() => {});
  };
  // The latest repos, then picks that are older, so every pick stays visible.
  const recent = available.slice(0, RECENT_REPOS);
  const chips = [...recent, ...repos.filter((repo) => !recent.some((each) => each.toLowerCase() === repo.toLowerCase()))];
  const label = (repo: string) => (repo.split("/")[0].toLowerCase() === github.data?.login?.toLowerCase() ? repo.split("/")[1] : repo);
  const query = search.trim().toLowerCase();
  const matches = query ? available.filter((repo) => repo.toLowerCase().includes(query)) : available;
  const typed = repoFromText(search);
  const addTyped = /^[\w.-]+\/[\w.-]+$/.test(typed) && !available.some((repo) => repo.toLowerCase() === typed.toLowerCase());
  const now = Date.now();
  return (
    <Card icon="Github" title="GitHub repos" description="Click a GitHub repo to clone it into every cloud sandbox, next to the project.">
      <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3">
        {chips.map((repo) => {
          const on = Boolean(picked(repo));
          return (
            <button
              key={repo}
              type="button"
              title={repo}
              aria-pressed={on}
              disabled={busy}
              onClick={() => toggle(repo)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs transition-colors disabled:cursor-wait ${
                on ? "border-primary/40 bg-primary/15 text-primary-text hover:bg-primary/25" : "border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              }`}
            >
              <Icon name={on ? "Check" : "Plus"} className="size-3" />
              {label(repo)}
            </button>
          );
        })}
        <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1.5 rounded-full bg-surface-recessed px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">
              <Icon name="Search" className="size-3" />
              {available.length > chips.length ? `All ${available.length} repos…` : "Add a GitHub repo…"}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" aria-label="GitHub repos" className="w-96 p-0">
            <Command shouldFilter={false} label="Search GitHub repos">
              <CommandInput value={search} onValueChange={setSearch} placeholder="Search your GitHub repos, or paste a link" className="h-9 text-xs" />
              <CommandList className="max-h-72">
                {addTyped && (
                  <CommandItem value={`add:${typed}`} onSelect={() => { toggle(typed); setSearch(""); }} className="gap-2 text-xs">
                    <Icon name="Plus" className="size-3.5" />
                    Add <span className="font-mono">{typed}</span>
                  </CommandItem>
                )}
                {matches.map((repo) => {
                  const on = Boolean(picked(repo));
                  const pushed = github.data?.pushed?.[repo];
                  return (
                    <CommandItem key={repo} value={repo} onSelect={() => toggle(repo)} disabled={busy} className="gap-2 text-xs">
                      <span className={`flex size-4 shrink-0 items-center justify-center rounded border ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                        {on && <Icon name="Check" className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono">{repo}</span>
                      {pushed && <span className="shrink-0 text-2xs text-subtle-foreground">{formatRelativeTime({ timestamp: pushed, now })}</span>}
                    </CommandItem>
                  );
                })}
                {!addTyped && !matches.length && (
                  <p className="px-3 py-4 text-center text-xs text-subtle-foreground">
                    {github.isPending ? "Loading your GitHub repos…" : query ? "No repos match. Paste a GitHub link to add any repo." : "Connect GitHub above to pick from your repos, or paste a link."}
                  </p>
                )}
              </CommandList>
              <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-2xs text-subtle-foreground">
                <span>↑↓ move · Enter picks</span>
                <span>{repos.length} in every sandbox</span>
              </div>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-recessed/40 px-4 py-2 text-xs text-subtle-foreground">
        <span>
          {repos.length ? <><span className="text-foreground">{repos.length} GitHub {repos.length === 1 ? "repo" : "repos"}</span> clone into <code>/repos</code> in every cloud sandbox</> : <>Picked repos clone into <code>/repos</code> in every cloud sandbox</>}
        </span>
        {available.length > 0 && <span>Most recently pushed first</span>}
      </div>
    </Card>
  );
}

/** CLI chips add or remove their Linux install lines, so the script stays the one place they live. */
function SetupScriptCard({ setup, keys, onSave }: { setup: string; keys: string[]; onSave: (setup: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const clis = useQuery({ queryKey: CLIS_KEY, queryFn: ({ signal }) => sdk.cloudroom.macClis(signal), retry: false }).data?.clis ?? [];
  const script = draft ?? setup;
  const dirty = draft !== null && draft !== setup;
  const toggle = (install: string) => {
    const part = [`\n\n${install}`, `${install}\n\n`, install].find((text) => script.includes(text));
    setDraft(part ? script.replace(part, "") : script.trim() ? `${script.trimEnd()}\n\n${install}` : install);
  };
  const unsigned = clis.filter((cli) => cli.key && script.includes(cli.install) && !keys.includes(cli.key));
  const save = () => {
    setSaving(true);
    void onSave(script).then(() => setDraft(null), () => {}).finally(() => setSaving(false));
  };
  return (
    <Card icon="Terminal" title="Setup script" description="Runs once in each new cloud sandbox, in the background. Output: /var/log/cloudroom/setup.log">
      {clis.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs text-subtle-foreground">Add a CLI from your {COMPUTER}. A click adds its Linux install lines below.</p>
          <div className="flex flex-wrap gap-1.5">
            {clis.map((cli) => {
              const added = script.includes(cli.install);
              return (
                <button
                  key={cli.name}
                  type="button"
                  title={cli.title}
                  aria-pressed={added}
                  disabled={saving}
                  onClick={() => toggle(cli.install)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs transition-colors disabled:cursor-wait ${
                    added
                      ? "border-primary/40 bg-primary/15 text-primary-text hover:bg-primary/25"
                      : "border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  }`}
                >
                  <Icon name={added ? "Check" : "Plus"} className="size-3" />
                  {cli.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="border-t border-border p-3">
        <Textarea
          className={`min-h-36 resize-y font-mono text-xs leading-relaxed ${DIM_PLACEHOLDER}`}
          placeholder={SCRIPT_PLACEHOLDER}
          aria-label="Setup script"
          spellCheck={false}
          value={script}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
      {unsigned.map((cli) => (
        <p key={cli.name} className="flex items-center gap-2.5 border-t border-border px-4 py-2.5 text-xs text-subtle-foreground">
          <Icon name="Lock" className="size-3.5 shrink-0" />
          <span>
            <span className="font-mono text-foreground">{cli.name}</span> signs in with <code className="font-mono text-foreground/80">{cli.key}</code>. Add it under API keys.
          </span>
        </p>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-recessed/40 px-4 py-3">
        <p className="min-w-0 text-xs text-subtle-foreground">
          Already installed: <span className="text-foreground/80">{PREINSTALLED}</span>
        </p>
        <div className="flex gap-2">
          {dirty && (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : dirty ? "Save script" : "Saved"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
