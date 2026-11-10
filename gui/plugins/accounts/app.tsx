import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { cn } from "@cloudroom/shared-ui/lib/utils";
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

function Meter({ label, usedPercent }: { label: string; usedPercent: number }) {
  const hot = usedPercent >= 90;
  return (
    <div className="flex w-32 items-center gap-2 text-xs tabular-nums text-subtle-foreground">
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
  );
}

function AccountRow({
  account,
  index,
  onUse,
  onRename,
  onRemove,
  onSignInAgain,
}: {
  account: AccountView;
  index: number;
  onUse: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onSignInAgain?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const local = account.id === LOCAL;
  const fallback = local
    ? `This ${COMPUTER_TITLE}`
    : (account.email ?? `Account ${index + 1}`);
  const name = account.name ?? fallback;
  const detail = [name === account.email ? null : account.email, account.plan]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pl-3.5 pr-2 text-sm",
        account.inUse && "bg-surface-recessed",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={account.inUse}
        aria-label={`Use ${name}`}
        onClick={account.inUse ? undefined : onUse}
        className={cn(
          "group -m-1.5 grid size-7 shrink-0 place-items-center rounded-full",
          account.inUse && "cursor-default",
        )}
      >
        <span
          className={cn(
            "grid size-4 place-items-center rounded-full border-[1.5px]",
            account.inUse
              ? "border-primary"
              : "border-subtle-foreground/60 group-hover:border-foreground",
          )}
        >
          {account.inUse ? <span className="size-2 rounded-full bg-primary" /> : null}
        </span>
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
          <div className="truncate font-medium text-foreground" title={name}>
            {name}
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
        {account.limitedUntil ? (
          <span className="whitespace-nowrap text-xs text-warning-text">
            Resets in {until(account.limitedUntil)}
          </span>
        ) : null}
        {account.windows.slice(0, 2).map((window) => (
          <Meter
            key={window.label}
            label={window.label}
            usedPercent={window.usedPercent}
          />
        ))}
        {account.inUse && account.needsSignIn ? (
          <Button variant="outline" size="sm" onClick={onUse}>
            Approve for Cloud
          </Button>
        ) : null}
      </div>
      {local ? (
        <span className="size-7 shrink-0" />
      ) : (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
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
            <DropdownMenuItem
              onSelect={onRemove}
              className="text-destructive-text focus:text-destructive-text"
            >
              <Icon name="Trash2" /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
  const load = useCallback(() => {
    rpc
      .call("accounts.list", { provider })
      .then(setAccounts, (cause: unknown) => setError(errorText(cause)));
  }, [provider, rpc]);
  useEffect(load, [load]);
  useRealtime(ACCOUNTS_CHANGED, load);

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
          className="divide-y divide-border overflow-hidden rounded-lg border border-border"
        >
          {accounts.map((account, index) => (
            <AccountRow
              key={account.id}
              account={account}
              index={index}
              onUse={() =>
                // The Mac's own Claude login needs one approval before Cloud can follow it.
                account.needsSignIn
                  ? setAdding({ mac: true, id: null })
                  : void run(() =>
                      rpc.call("accounts.use", { provider, id: account.id }),
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
                provider === "claude-code" && adding === null
                  ? () => setAdding({ mac: false, id: account.id })
                  : undefined
              }
            />
          ))}
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

const AGENTS: readonly { provider: Provider; name: string }[] = [
  { provider: "claude-code", name: "Claude Code" },
  { provider: "codex", name: "Codex" },
  { provider: "acp-cursor", name: "Cursor" },
];

/** Settings → Agents → Accounts: every agent's accounts on one page. All threads use the one picked. */
function AccountsPage() {
  return (
    <div className="space-y-6">
      {AGENTS.map((agent) => (
        <AccountsSection key={agent.provider} {...agent} />
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  // Settings → Agents → Accounts, the one place for every agent's accounts.
  app.slots.settingsSection({
    id: "accounts",
    // Not shown on the page (the tab names it). Settings search finds the page by these.
    title: "Agent accounts",
    description: "Add and switch Claude Code, Codex, and Cursor subscriptions.",
    component: AccountsPage,
  });
});
