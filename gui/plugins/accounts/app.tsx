import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
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
    .replace("Weekly", "7d");
}

const tileClass = "flex min-h-32 flex-col rounded-lg border p-3.5 text-sm";

/** The Mac's own login, before Cloudroom has its own sign-in for it. */
function TerminalTile({
  account,
  onSignIn,
}: {
  account: AccountView;
  onSignIn: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSignIn}
      className={cn(
        tileClass,
        "items-center justify-center gap-2.5 border-dashed border-border text-center text-muted-foreground hover:border-foreground/50 hover:text-foreground",
      )}
    >
      <Icon name="Terminal" className="size-4" />
      <span className="font-medium text-foreground">Add Terminal login</span>
      <span className="max-w-full truncate text-xs">{account.email}</span>
    </button>
  );
}

function AccountTile({
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
  const fallback =
    account.email ?? (local ? `This ${COMPUTER_TITLE}` : `Account ${index + 1}`);
  const name = account.name ?? fallback;
  const detail = [
    account.inUse ? "In use" : "Not in use",
    local && account.email ? `This ${COMPUTER_TITLE}` : null,
    account.name ? account.email : null,
    account.plan,
  ]
    .filter(Boolean)
    .join(" · ");
  const status = account.limitedUntil
    ? `Limit hit · resets in ${until(account.limitedUntil)}`
    : account.error;
  return (
    <div
      className={cn(
        tileClass,
        account.inUse ? "border-foreground/50" : "border-border",
      )}
    >
      <div className="flex min-h-7 items-center justify-between gap-2">
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
        {local ? null : (
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
      <div className="truncate text-xs text-subtle-foreground" title={detail}>
        {detail}
      </div>
      {status ? (
        <div className="truncate text-xs text-warning-text" title={status}>
          {status}
        </div>
      ) : null}
      {account.limitedLogin && onSignInAgain ? (
        <button
          type="button"
          onClick={onSignInAgain}
          className="truncate text-left text-xs text-primary-text hover:underline"
        >
          Sign in again for claude.ai connectors
        </button>
      ) : null}
      <div className="mt-auto space-y-1.5 pt-4">
        {account.windows.slice(0, 2).map((window) => (
          <div
            key={window.label}
            className="flex items-center gap-2 text-xs tabular-nums text-subtle-foreground"
          >
            <span className="w-5">{windowLabel(window.label)}</span>
            <span className="h-[3px] flex-1 bg-border">
              <span
                className="block h-full bg-muted-foreground"
                style={{ width: `${Math.min(100, window.usedPercent)}%` }}
              />
            </span>
            <span className="w-8 text-right">
              {Math.round(window.usedPercent)}%
            </span>
          </div>
        ))}
        {account.inUse ? null : (
          <Button
            variant="outline"
            size="sm"
            className="mt-1.5"
            onClick={onUse}
          >
            Use
          </Button>
        )}
      </div>
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
              step.second ? (
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

function AccountsSection({ provider }: { provider: Provider }) {
  const rpc = useRpc<typeof accountsRpcContract>();
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

  const count = accounts?.filter((account) => account.id !== LOCAL).length ?? 0;
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-foreground">Accounts</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={adding !== null || count >= MAX_ACCOUNTS}
          onClick={() => setAdding({ mac: false, id: null })}
        >
          <Icon name="Plus" /> Add
        </Button>
      </div>
      {accounts === null ? (
        <p className="py-2.5 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
          {[...accounts]
            .sort((a, b) => Number(a.needsSignIn) - Number(b.needsSignIn))
            .map((account, index) =>
              account.needsSignIn ? (
                <TerminalTile
                  key={account.id}
                  account={account}
                  onSignIn={() => setAdding({ mac: true, id: null })}
                />
              ) : (
                <AccountTile
                  key={account.id}
                  account={account}
                  index={index}
                  onUse={() =>
                    void run(() =>
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
              ),
            )}
        </div>
      )}
      {adding ? (
        <div className="rounded-lg border border-dashed border-border px-3.5">
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
        </div>
      ) : null}
      <p className="text-xs text-subtle-foreground">
        All Local and Cloud threads use the account in use.
      </p>
      {error ? <p className="text-xs text-destructive-text">{error}</p> : null}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "claude-code",
    component: () => <AccountsSection provider="claude-code" />,
  });
  app.slots.settingsSection({
    id: "codex",
    component: () => <AccountsSection provider="codex" />,
  });
});
