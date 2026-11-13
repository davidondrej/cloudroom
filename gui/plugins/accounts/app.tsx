import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { hideEmail, usePrivacyMode } from "@cloudroom/shared-ui/lib/privacy-mode";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Switch } from "@cloudroom/shared-ui/switch";
import {
  ACCOUNTS_CHANGED,
  LOCAL,
  MAX_ACCOUNTS,
  type AccountView,
  type Provider,
  type accountsRpcContract,
} from "./src/contract.js";

type Rpc = ReturnType<typeof useRpc<typeof accountsRpcContract>>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function until(timestamp: number): string {
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${minutes % 60}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function windowLabel(label: string): string {
  return label
    .replace("Five-hour limit", "5h")
    .replace("Weekly limit", "7d")
    .replace("Weekly", "7d")
    .replace("Plan usage", "Plan")
    .replace("On-demand spend", "Spend");
}

// `resetsAt` adds a second line with the limit's reset. Undefined: no bar in this row has one, so the row stays one line.
function Meter({
  label,
  usedPercent,
  resetsAt,
}: {
  label: string;
  usedPercent: number;
  resetsAt?: number | null;
}) {
  const hot = usedPercent >= 90;
  return (
    <div className="w-32 text-xs tabular-nums text-subtle-foreground">
      <div className="flex items-center gap-2">
        <span className="min-w-5">{windowLabel(label)}</span>
        <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-border">
          <span
            className={cn("block h-full", hot ? "bg-warning-text" : "bg-muted-foreground")}
            style={{ width: `${Math.min(100, usedPercent)}%` }}
          />
        </span>
        <span className={cn("w-8 text-right", hot && "text-warning-text")}>
          {Math.round(usedPercent)}%
        </span>
      </div>
      {resetsAt === undefined ? null : resetsAt === null ? (
        <div aria-hidden>&nbsp;</div>
      ) : (
        <div
          className="whitespace-nowrap text-right"
          title={new Date(resetsAt).toLocaleString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        >
          Resets in {until(resetsAt)}
        </div>
      )}
    </div>
  );
}

function fallbackName(account: AccountView, index: number): string {
  return account.id === LOCAL
    ? `This ${COMPUTER_TITLE}`
    : (account.email ?? `Account ${index + 1}`);
}

function AccountRow({
  account: loaded,
  index,
  picking,
  locked,
  onUse,
  onRename,
  onRemove,
  onSignInAgain,
}: {
  account: AccountView;
  index: number;
  // This row is being switched to.
  picking: boolean;
  // A switch is running: no row can be picked.
  locked: boolean;
  onUse: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onSignInAgain?: () => void;
}) {
  // The page can stay open past a reset, so a limit or a bar whose reset has passed clears here.
  const now = Date.now();
  const account = {
    ...loaded,
    limitedUntil:
      loaded.limitedUntil !== null && loaded.limitedUntil > now
        ? loaded.limitedUntil
        : null,
    windows: loaded.windows.map((window) =>
      window.resetsAt !== null && window.resetsAt <= now
        ? { ...window, usedPercent: 0, resetsAt: null }
        : window,
    ),
  };
  // The page shows two bars. Each says when it resets, so "Resets in" alone shows only for a limit they don't show:
  // one on a hidden bar, or one that lasts longer than the full bar shown.
  const shown = account.windows.slice(0, 2);
  const resets = shown.some((window) => window.resetsAt !== null);
  const full = shown.some(
    (window) =>
      Math.round(window.usedPercent) >= 100 &&
      window.resetsAt !== null &&
      window.resetsAt >= (account.limitedUntil ?? 0) - 60_000,
  );
  const [editing, setEditing] = useState(false);
  const [privacy] = usePrivacyMode();
  const local = account.id === LOCAL;
  // A name belongs to a login, so "This Mac" needs one to be named.
  const renamable = !local || account.email !== null;
  // Privacy mode hides emails. A name the user wrote stays.
  const real = account.name ?? fallbackName(account, index);
  const fallback = hideEmail(fallbackName(account, index), privacy);
  const name = hideEmail(real, privacy);
  const detail = [
    real === account.email ? null : hideEmail(account.email ?? "", privacy),
    account.plan,
    local && account.name ? fallback : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const pickable = !account.inUse && !locked && !editing;
  // During a switch the highlight is already on the picked row, so the old row drops its mark.
  const marked = account.inUse && !locked;
  // The whole row picks the account. The name field, links, buttons, and the ⋯ menu keep their own clicks.
  // A click that only closes the name field must not switch accounts too.
  const closing = useRef(false);
  const pick = (event: MouseEvent) => {
    const control = (event.target as Element).closest("button, input, [role=menu]");
    const closed = closing.current;
    closing.current = false;
    if (
      pickable &&
      !closed &&
      (control === null || control.getAttribute("role") === "radio")
    )
      onUse();
  };
  return (
    <div
      onMouseDown={() => {
        closing.current = editing;
      }}
      onClick={pick}
      className={cn(
        "group/account flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pl-3.5 pr-2 text-sm transition-colors",
        pickable && "cursor-pointer hover:bg-surface-recessed",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={account.inUse}
        aria-busy={picking}
        aria-label={`Use ${name}`}
        className={cn(
          "-m-1.5 grid size-7 shrink-0 place-items-center rounded-full",
          !pickable && "cursor-default",
        )}
      >
        {picking ? (
          <Icon name="Spinner" className="size-4 animate-spin text-foreground" />
        ) : (
          <span
            className={cn(
              "grid size-4 place-items-center rounded-full border-[1.5px] transition-colors",
              marked ? "border-foreground" : "border-subtle-foreground/60",
              pickable && "group-hover/account:border-foreground",
            )}
          >
            {marked ? <span className="size-2 rounded-full bg-foreground" /> : null}
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            aria-label="Account name"
            defaultValue={account.name ?? ""}
            placeholder={fallback}
            maxLength={60}
            className="w-full rounded border border-border bg-transparent px-1.5 py-0.5 text-sm text-foreground outline-none focus:border-foreground/50"
            onKeyDown={(event) => {
              if (event.key === "Escape")
                event.currentTarget.value = account.name ?? "";
              if (event.key === "Enter" || event.key === "Escape")
                event.currentTarget.blur();
            }}
            onBlur={(event) => {
              setEditing(false);
              if (event.currentTarget.value.trim() !== (account.name ?? ""))
                onRename(event.currentTarget.value);
            }}
          />
        ) : (
          <div className="flex items-center gap-2 font-medium text-foreground">
            <span className="truncate" title={name}>
              {name}
            </span>
            {marked ? (
              <span className="shrink-0 rounded bg-foreground/10 px-1.5 text-xs font-semibold leading-4">
                In use
              </span>
            ) : null}
          </div>
        )}
        {detail ? (
          <div className="truncate text-xs text-subtle-foreground" title={detail}>
            {detail}
          </div>
        ) : null}
        {account.error && !account.limitedUntil ? (
          <div className="truncate text-xs text-warning-text" title={account.error}>
            {account.error}
          </div>
        ) : null}
        {account.limitedLogin && onSignInAgain ? (
          <button
            type="button"
            onClick={onSignInAgain}
            className="block max-w-full truncate text-left text-xs text-primary-text hover:underline"
          >
            Sign in again for claude.ai connectors
          </button>
        ) : null}
      </div>
      {/* On a narrow screen the usage drops to its own line, under the name. */}
      <div className="order-last flex basis-full flex-wrap items-center gap-x-5 gap-y-1 pl-7 sm:order-none sm:basis-auto sm:justify-end sm:pl-0">
        {account.limitedUntil && !full ? (
          <span className="whitespace-nowrap text-xs text-subtle-foreground">
            Resets in {until(account.limitedUntil)}
          </span>
        ) : null}
        {shown.map((window) => (
          <Meter
            key={window.label}
            label={window.label}
            usedPercent={window.usedPercent}
            resetsAt={resets ? window.resetsAt : undefined}
          />
        ))}
        {account.inUse && account.needsSignIn ? (
          <Button variant="outline" size="sm" onClick={onUse}>
            Approve for Cloud
          </Button>
        ) : null}
      </div>
      {/* "This Mac" signed out has nothing to do: no login to name, and the computer's own login is never removed here. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild disabled={!renamable}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="Account actions"
          >
            <Icon name="MoreHorizontal" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          // Keep focus on the rename field instead of the menu button.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Icon name="Edit" /> Rename
          </DropdownMenuItem>
          {onSignInAgain ? (
            <DropdownMenuItem onSelect={onSignInAgain}>
              <Icon name="RotateCcw" /> Sign in again
            </DropdownMenuItem>
          ) : null}
          {/* Removing This Mac would sign the computer out. */}
          {local ? null : (
            <DropdownMenuItem
              onSelect={onRemove}
              className="text-destructive-text focus:text-destructive-text"
            >
              <Icon name="Trash2" /> Remove
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SignInRow({
  provider,
  mac,
  id,
  rpc,
  close,
}: {
  provider: Provider;
  mac: boolean;
  id: string | null;
  rpc: Rpc;
  close: () => void;
}) {
  const navigate = useBbNavigate();
  const [step, setStep] = useState<{
    sessionId: string;
    url: string;
    userCode: string | null;
    second: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const start =
      provider === "claude-code"
        ? rpc
            .call("claude.start", mac || id ? { mac, id: id ?? undefined } : null)
            .then((started) => ({
              sessionId: started.sessionId,
              url: started.authorizeUrl,
              userCode: null,
              second: false,
            }))
        : rpc.call("codex.start", null).then((started) => ({
            sessionId: started.sessionId,
            url: started.verificationUri,
            userCode: started.userCode,
            second: false,
          }));
    start.then(
      (next) => {
        if (cancelled) return;
        setStep(next);
        navigate.openUrl(next.url);
      },
      (cause: unknown) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [provider, mac, id, rpc]);

  useEffect(() => {
    if (step === null || error !== null) return;
    const timer = window.setInterval(() => {
      void rpc
        .call(provider === "codex" ? "codex.poll" : "claude.poll", {
          sessionId: step.sessionId,
        })
        .then((result) => {
          if (result.status === "complete") close();
          if (result.status === "error") setError(result.message);
          if (result.authorizeUrl && result.authorizeUrl !== step.url) {
            setStep({ ...step, url: result.authorizeUrl, second: true });
            navigate.openUrl(result.authorizeUrl);
          }
        });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [provider, step, error, rpc, close]);

  const copy = () => {
    if (!step) return;
    void navigator.clipboard.writeText(step.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <div className="flex items-center gap-3 py-2.5 text-sm">
      {error ? (
        <Icon
          name="AlertCircle"
          className="size-4 shrink-0 text-destructive-text"
        />
      ) : (
        <Icon
          name="Spinner"
          className="size-4 shrink-0 animate-spin text-primary"
        />
      )}
      <div className="min-w-0 flex-1 truncate text-muted-foreground">
        {error ? (
          <span className="text-destructive-text" title={error}>
            {error}
          </span>
        ) : step === null ? (
          "Starting sign-in…"
        ) : (
          <>
            {step.userCode ? (
              <>
                Enter code{" "}
                <span className="font-mono text-foreground">
                  {step.userCode}
                </span>
              </>
            ) : provider === "claude-code" ? (
              mac ? (
                "Approve this Mac's account for Cloud"
              ) : step.second ? (
                "Approve once more, for Cloud · 2 of 2"
              ) : (
                "Waiting for sign-in · 1 of 2"
              )
            ) : (
              "Waiting for sign-in"
            )}
            {" · "}
            <button
              type="button"
              onClick={copy}
              className="text-primary-text hover:underline"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="Cancel"
        onClick={close}
      >
        <Icon name="X" />
      </Button>
    </div>
  );
}

/** Cursor accounts are added with a user API key, Cursor's own way to use a second account. */
function KeyRow({ rpc, close }: { rpc: Rpc; close: () => void }) {
  const navigate = useBbNavigate();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    setBusy(true);
    setError(null);
    rpc.call("cursor.add", { apiKey: key }).then(close, (cause: unknown) => {
      setError(errorText(cause));
      setBusy(false);
    });
  };
  return (
    <div className="space-y-2 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="password"
          aria-label="Cursor API key"
          placeholder="Cursor API key"
          value={key}
          disabled={busy}
          onChange={(event) => setKey(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && key.trim()) add();
            if (event.key === "Escape") close();
          }}
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm text-foreground outline-none focus:border-foreground/50"
        />
        <Button size="sm" disabled={busy || !key.trim()} onClick={add}>
          {busy ? "Checking…" : "Add"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label="Cancel"
          onClick={close}
        >
          <Icon name="X" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {error ? (
          <span className="text-destructive-text">{error}</span>
        ) : (
          <>
            Sign in to the other Cursor account and create a key in{" "}
            <button
              type="button"
              onClick={() =>
                navigate.openUrl("https://cursor.com/dashboard?tab=integrations")
              }
              className="text-primary-text hover:underline"
            >
              Cursor's dashboard
            </button>
            .
          </>
        )}
      </p>
    </div>
  );
}

function AccountsSection({ provider, name }: { provider: Provider; name: string }) {
  const rpc = useRpc<typeof accountsRpcContract>();
  const { providers } = useProviders();
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [adding, setAdding] = useState<{
    mac: boolean;
    id: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The account being switched to, and the one a finished switch names for a few seconds.
  const [picking, setPicking] = useState<string | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  const [privacy] = usePrivacyMode();
  const load = useCallback(() => {
    rpc
      .call("accounts.list", { provider })
      .then(setAccounts, (cause: unknown) => setError(errorText(cause)));
  }, [provider, rpc]);
  useEffect(load, [load]);
  useRealtime(ACCOUNTS_CHANGED, load);
  useEffect(() => {
    if (switched === null) return;
    const timer = window.setTimeout(() => setSwitched(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [switched]);

  // The highlight moves to the picked row at once, and back if the switch fails. Rows never move.
  const use = async (id: string, name: string) => {
    setPicking(id);
    setSwitched(null);
    setError(null);
    try {
      await rpc.call("accounts.use", { provider, id });
      setAccounts(await rpc.call("accounts.list", { provider }));
      setSwitched(name);
    } catch (cause) {
      setError(errorText(cause));
      load();
    }
    setPicking(null);
  };
  // One highlight per list, placed over the row in use: it slides instead of jumping.
  const rows = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<{ top: number; height: number } | null>(null);
  const marked = accounts?.findIndex((account) =>
    picking === null ? account.inUse : account.id === picking,
  );
  useLayoutEffect(() => {
    const list = rows.current;
    if (!list) return;
    const place = () => {
      const row = list.children[marked ?? -1];
      const next =
        row instanceof HTMLElement
          ? { top: row.offsetTop, height: row.offsetHeight }
          : null;
      setHighlight((before) =>
        before?.top === next?.top && before?.height === next?.height ? before : next,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => observer.disconnect();
  }, [marked, accounts]);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    }
    load();
  };

  // The usage box's "+" links here with ?agent=<provider>.
  const section = useRef<HTMLElement>(null);
  const loaded = accounts !== null;
  useEffect(() => {
    if (
      loaded &&
      new URLSearchParams(window.location.search).get("agent") === provider
    )
      section.current?.scrollIntoView({ block: "nearest" });
  }, [loaded, provider]);

  const count = accounts?.filter((account) => account.id !== LOCAL).length ?? 0;
  return (
    <section ref={section} className="space-y-2">
      <div className="flex items-center gap-2 pl-0.5">
        <ProviderIcon
          providerKind="agent"
          provider={
            providers.find((info) => info.id === provider) ?? { id: provider }
          }
          fallback="Bot"
          className="size-4 shrink-0"
          aria-hidden
        />
        <h2 className="flex-1 text-sm font-semibold text-foreground">{name}</h2>
        <p
          role="status"
          className="hidden min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground sm:flex"
        >
          {switched ? (
            <>
              <Icon name="Check" className="size-3.5 shrink-0" />
              All threads now use
              <span className="truncate font-medium text-foreground">
                {hideEmail(switched, privacy)}
              </span>
            </>
          ) : null}
        </p>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Add ${name} account`}
          disabled={adding !== null || count >= MAX_ACCOUNTS}
          onClick={() => setAdding({ mac: false, id: null })}
        >
          <Icon name="Plus" /> Add
        </Button>
      </div>
      {accounts === null ? (
        <p className="py-2.5 text-xs text-muted-foreground">Loading…</p>
      ) : accounts.length > 0 ? (
        <div
          role="radiogroup"
          aria-label={`${name} accounts`}
          className="relative overflow-hidden rounded-lg border border-border"
        >
          {highlight ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 border-l-[3px] border-foreground bg-accent transition-[transform,height] duration-300 ease-out motion-reduce:transition-none"
              style={{
                transform: `translateY(${highlight.top}px)`,
                height: highlight.height,
              }}
            />
          ) : null}
          <div ref={rows} className="relative divide-y divide-border">
            {accounts.map((account, index) => (
              <AccountRow
                key={account.id}
                account={account}
                index={index}
                picking={account.id === picking}
                locked={picking !== null}
                onUse={() =>
                  // The Mac's own Claude login needs one approval before Cloud can follow it.
                  account.needsSignIn
                    ? setAdding({ mac: true, id: null })
                    : void use(
                        account.id,
                        account.name ?? fallbackName(account, index),
                      )
                }
                onRename={(name) =>
                  void run(() =>
                    rpc.call("accounts.rename", {
                      provider,
                      id: account.id,
                      name,
                    }),
                  )
                }
                onRemove={() =>
                  void run(() =>
                    rpc.call("accounts.remove", { provider, id: account.id }),
                  )
                }
                onSignInAgain={
                  provider === "claude-code" && account.id !== LOCAL && adding === null
                    ? () => setAdding({ mac: false, id: account.id })
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      ) : null}
      {adding ? (
        <div className="rounded-lg border border-dashed border-border px-3.5">
          {provider === "acp-cursor" ? (
            <KeyRow
              rpc={rpc}
              close={() => {
                setAdding(null);
                load();
              }}
            />
          ) : (
            <SignInRow
              provider={provider}
              mac={adding.mac}
              id={adding.id}
              rpc={rpc}
              close={() => {
                setAdding(null);
                load();
              }}
            />
          )}
        </div>
      ) : null}
      {provider === "acp-cursor" ? (
        <p className="text-xs text-subtle-foreground">
          Grok signs in with your X subscription. One login covers it, so there's nothing to add here.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive-text">{error}</p> : null}
    </section>
  );
}

type AntigravityLogin = {
  state: "missing" | "waiting" | "connected" | "unavailable" | "error" | "expired";
  message: string | null;
  login_id: string | null;
  verification_url: string | null;
  host_id?: string;
};
type AntigravityLimit = { label: string; usedPercent: number; resetsAt: number | null };
/** One model group's limits, like "gemini" with its five-hour and weekly one. */
type AntigravityGroup = { name: string; limits: AntigravityLimit[] };

/** Calls the Antigravity provider plugin, which owns its CLI's Google sign-in and plan limits. */
async function antigravityRpc<T>(method: string, input: object): Promise<T> {
  const response = await fetch(
    `/api/v1/plugins/provider-antigravity/rpc/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
  } | null;
  if (!response.ok || body?.ok !== true || body.result === undefined)
    throw new Error("Antigravity could not be reached.");
  return body.result;
}

/** The plan's limits on the machine the login is on: a five-hour and a weekly one per model group. */
async function antigravityLimits(hostId: string | undefined): Promise<AntigravityGroup[]> {
  const { resources } = await antigravityRpc<{
    resources: { id: string; scope: { kind: string; hostId?: string } }[];
  }>("provider-usage.v1.listResources", {});
  const resource =
    resources.find((entry) => entry.scope.hostId === hostId) ?? resources[0];
  if (!resource) return [];
  const { usage } = await antigravityRpc<{
    usage: {
      status: string;
      windows?: {
        kind?: string;
        model?: string | null;
        label: string;
        usedPercent: number;
        resetsAt: string | null;
      }[];
    };
  }>("provider-usage.v1.getResource", { resourceId: resource.id, refresh: false });
  if (usage.status !== "ok") return [];
  const groups: AntigravityGroup[] = [];
  for (const window of usage.windows ?? []) {
    const name = window.model ?? "";
    let group = groups.find((entry) => entry.name === name);
    if (!group) groups.push((group = { name, limits: [] }));
    group.limits.push({
      label:
        window.kind === "five-hour"
          ? "5h"
          : window.kind === "weekly"
            ? "7d"
            : window.kind === "daily"
              ? "1d"
              : window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt ? Date.parse(window.resetsAt) : null,
    });
  }
  return groups;
}

/**
 * Antigravity's Google account. Its CLI keeps one login, in the system
 * keyring, so there are no accounts to add or switch: this section shows that
 * login and its plan's limits, and signs in or out.
 */
function AntigravitySection() {
  const { providers } = useProviders();
  const navigate = useBbNavigate();
  // undefined while loading; null when the Antigravity plugin is off.
  const [login, setLogin] = useState<AntigravityLogin | null | undefined>(undefined);
  const [limits, setLimits] = useState<AntigravityGroup[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (input: { action: string; requestId?: string; code?: string }) => {
      setBusy(true);
      setError(null);
      try {
        const next = await antigravityRpc<AntigravityLogin>("antigravityAccount", input);
        setLogin(next);
        if (next.state === "error") setError(next.message);
        return next;
      } catch (cause) {
        setError(errorText(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    antigravityRpc<AntigravityLogin>("antigravityAccount", { action: "status" }).then(
      (next) => {
        if (!cancelled) setLogin(next);
      },
      () => {
        if (!cancelled) setLogin(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const connected = login?.state === "connected";
  const hostId = login?.host_id;
  useEffect(() => {
    if (!connected) return setLimits([]);
    let cancelled = false;
    antigravityLimits(hostId).then(
      (next) => {
        if (!cancelled) setLimits(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [connected, hostId]);

  if (login === null) return null;
  const waiting = login?.state === "waiting" && login.login_id ? login : null;
  const signIn = async () => {
    const next = await run({ action: "login", requestId: crypto.randomUUID() });
    if (next?.state === "waiting" && next.verification_url)
      navigate.openUrl(next.verification_url);
  };
  const now = Date.now();
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 pl-0.5">
        <ProviderIcon
          providerKind="agent"
          provider={
            providers.find((info) => info.id === "antigravity") ?? { id: "antigravity" }
          }
          fallback="Bot"
          className="size-4 shrink-0"
          aria-hidden
        />
        <h2 className="flex-1 text-sm font-semibold text-foreground">Antigravity</h2>
      </div>
      {login === undefined ? (
        <p className="py-2.5 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pl-3.5 pr-2 text-sm",
              // The login in use is marked like the other agents' rows.
              connected && "border-l-[3px] border-foreground bg-accent pl-[11px]",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]",
                connected ? "border-foreground" : "border-subtle-foreground/60",
              )}
            >
              {connected ? <span className="size-2 rounded-full bg-foreground" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <span className="truncate">This {COMPUTER_TITLE}</span>
                {connected ? (
                  <span className="shrink-0 rounded bg-foreground/10 px-1.5 text-xs font-semibold leading-4">
                    In use
                  </span>
                ) : null}
              </div>
              <div className="truncate text-xs text-subtle-foreground">
                {connected
                  ? "Google account"
                  : login.state === "unavailable"
                    ? (login.message ?? "Could not check Antigravity.")
                    : waiting
                      ? "Signing in…"
                      : "Signed out"}
              </div>
            </div>
            {/* One line per model group, so the row stays as tall as the others. Hover a bar for its reset. */}
            {limits.length > 0 ? (
              <div className="order-last flex basis-full flex-col gap-y-1 pl-7 sm:order-none sm:basis-auto sm:pl-0">
                {limits.map((group) => (
                  <div key={group.name} className="flex items-center gap-x-5 sm:justify-end">
                    <span className="text-xs text-subtle-foreground">{group.name}</span>
                    {group.limits.map((limit) => (
                      <span
                        key={limit.label}
                        title={
                          limit.resetsAt !== null && limit.resetsAt > now
                            ? `Resets in ${until(limit.resetsAt)}`
                            : undefined
                        }
                      >
                        <Meter label={limit.label} usedPercent={limit.usedPercent} />
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            {connected ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild disabled={busy}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground"
                    aria-label="Antigravity account actions"
                  >
                    <Icon name="MoreHorizontal" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void run({ action: "logout" })}>
                    <Icon name="LogOut" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : waiting ? null : login.state === "unavailable" ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run({ action: "status" })}
              >
                Check again
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void signIn()}>
                {busy ? "Opening sign-in…" : "Sign in with Google"}
              </Button>
            )}
          </div>
        </div>
      )}
      {waiting ? (
        <form
          className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3.5 py-2 text-sm text-muted-foreground"
          onSubmit={(event) => {
            event.preventDefault();
            const entered = code.trim();
            setCode("");
            if (entered)
              void run({ action: "complete", requestId: waiting.login_id!, code: entered });
          }}
        >
          <span className="min-w-0 flex-1">
            Paste the code Google shows
            {waiting.verification_url ? (
              <>
                {" · "}
                <button
                  type="button"
                  className="text-primary-text hover:underline"
                  onClick={() => {
                    void navigator.clipboard.writeText(waiting.verification_url!);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
              </>
            ) : null}
          </span>
          <input
            type="password"
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
            placeholder="Code from Google"
            aria-label="Google sign-in code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="h-7 w-44 rounded border border-border bg-transparent px-1.5 text-sm text-foreground outline-none focus:border-foreground/50"
          />
          <Button type="submit" size="sm" disabled={busy || !code.trim()}>
            Connect
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label="Cancel"
            onClick={() => void run({ action: "cancel", requestId: waiting.login_id! })}
          >
            <Icon name="X" />
          </Button>
        </form>
      ) : null}
      <p className="text-xs text-subtle-foreground">
        Antigravity signs in with one Google account. One login covers it, so there's nothing to add here.
      </p>
      {error ? <p className="text-xs text-destructive-text">{error}</p> : null}
    </section>
  );
}

const AGENTS: readonly { provider: Provider; name: string }[] = [
  { provider: "claude-code", name: "Claude Code" },
  { provider: "codex", name: "Codex" },
  { provider: "acp-cursor", name: "Cursor" },
];

/** Settings → Agents → Accounts: every agent's accounts on one page. All threads use the one picked. */
function AccountsPage() {
  // Draws the page again every minute, so the countdowns move and passed resets clear. It loads nothing.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((count) => count + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [privacy, setPrivacy] = usePrivacyMode();
  return (
    <div className="space-y-2">
      {/* Hides emails here and in the usage box, for recordings. */}
      <label className="ml-auto flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        Privacy mode
        <Switch checked={privacy} onCheckedChange={setPrivacy} />
      </label>
      <div className="space-y-6">
        {AGENTS.map((agent) => (
          <Fragment key={agent.provider}>
            <AccountsSection {...agent} />
            {/* Antigravity keeps one Google login, so it gets a section of its own after Codex. */}
            {agent.provider === "codex" ? <AntigravitySection /> : null}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  // Settings → Agents → Accounts, the one place for every agent's accounts.
  app.slots.settingsSection({
    id: "accounts",
    // Not shown on the page (the tab names it). Settings search finds the page by these.
    title: "Agent accounts",
    description: "Add and switch Claude Code, Codex, and Cursor subscriptions, and sign in to Antigravity.",
    component: AccountsPage,
  });
});
