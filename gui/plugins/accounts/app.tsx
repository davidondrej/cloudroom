import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import {
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
  USAGE_STALE_MS,
  type AccountView,
  type Provider,
  type accountsRpcContract,
} from "./src/contract.js";

type Rpc = ReturnType<typeof useRpc<typeof accountsRpcContract>>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A time span: "5m", "2h 10m", "1d 6h".
function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${minutes % 60}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
const until = (timestamp: number) => span(timestamp - Date.now());

function windowLabel(label: string): string {
  return label
    .replace("Five-hour limit", "5h")
    .replace("Five-hour · ", "5h ")
    .replace("Weekly limit", "7d")
    .replace("Weekly · ", "7d ")
    .replace("Weekly", "7d")
    .replace("Plan usage", "Plan")
    .replace("Plan · ", "Plan ")
    .replace("On-demand spend", "Spend");
}

// One line of an account's limits. `usedPercent` is null for a limit that was not read: it is unknown, not 0%.
type Limit = {
  label: string;
  usedPercent: number | null;
  resetsAt: number | null;
  checkedAt?: number | null;
};

// The line: the limit's name, bar, percent used, and the time until it resets. Greyed when no read confirmed it lately.
// An old bar is a floor until its reset. Past it, or at 0%, nothing is known: it shows "–", not a guessed 0%.
function Meter({ label, usedPercent, resetsAt, checkedAt }: Limit) {
  const used = usedPercent ?? 0;
  const hot = used >= 90;
  const old = checkedAt != null && Date.now() - checkedAt > USAGE_STALE_MS;
  const unknown = usedPercent === null || (old && used === 0 && resetsAt === null);
  return (
    <div
      className={cn("contents", old && "*:opacity-40")}
      title={old ? (checkedAt ? `Last checked ${span(Date.now() - checkedAt)} ago` : "Last known usage") : undefined}
    >
      <span>{windowLabel(label)}</span>
      <span className="h-[3px] overflow-hidden rounded-full bg-border">
        <span
          className={cn("block h-full", hot ? "bg-warning-text" : "bg-muted-foreground")}
          style={{ width: `${Math.min(100, used)}%` }}
        />
      </span>
      <span
        className={cn("text-right", hot && "text-warning-text")}
        title={usedPercent === null ? "Not read yet" : unknown ? "Not checked lately" : undefined}
      >
        {unknown ? "–" : `${Math.round(used)}%`}
      </span>
      <span
        className="whitespace-nowrap pl-1 text-subtle-foreground/75"
        title={
          resetsAt === null
            ? undefined
            : `Resets ${new Date(resetsAt).toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}`
        }
      >
        {resetsAt === null ? null : until(resetsAt)}
      </span>
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
  limits,
  index,
  picking,
  locked,
  onUse,
  onRename,
  onRemove,
  onSignInAgain,
  signingIn,
  onSignOut,
}: {
  account: AccountView;
  // The limits every row of this agent shows, in order, each as it looks when the account doesn't report it.
  limits: Limit[];
  index: number;
  // This row is being switched to.
  picking: boolean;
  // A switch is running: no row can be picked.
  locked: boolean;
  onUse: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onSignInAgain?: () => void;
  // A sign-in is already running in this list: Sign in again waits for it.
  signingIn: boolean;
  // Antigravity's one Google login on this computer.
  onSignOut?: (() => void) | undefined;
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
  // Every limit gets its own line, with the time until it resets. A limit this account doesn't report shows empty,
  // so every row has the same lines. An account with no usage read shows none.
  // "Resets in" alone shows only for a limit that lasts longer than every full bar.
  // A 0% Claude left out was confirmed by the row's latest read, so it greys with the rest.
  const newest = Math.max(...account.windows.map((window) => window.checkedAt ?? -1));
  const shown: Limit[] =
    account.windows.length === 0
      ? []
      : limits.map(
          (empty) =>
            account.windows.find((window) => window.label === empty.label) ??
            (empty.usedPercent === 0 && newest >= 0 ? { ...empty, checkedAt: newest } : empty),
        );
  // How long ago this row's bars were last read, once that's too long; 0 for bars saved before reads were timed.
  const checkedAgo = newest >= 0 && now - newest > USAGE_STALE_MS ? (newest ? now - newest : 0) : null;
  const full = shown.some(
    (window) =>
      Math.round(window.usedPercent ?? 0) >= 100 &&
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
            {checkedAgo !== null ? (
              <span
                className="flex shrink-0 items-center gap-1 rounded bg-foreground/10 px-1.5 text-xs font-medium leading-4 text-subtle-foreground"
                title={checkedAgo ? `Usage last checked ${span(checkedAgo)} ago` : "Last known usage"}
              >
                <Icon name="Clock" className="size-3" />
                {checkedAgo ? `${span(checkedAgo).split(" ")[0]} ago` : "Not recent"}
              </span>
            ) : null}
          </div>
        )}
        {detail ? (
          <div className="truncate text-xs text-subtle-foreground" title={detail}>
            {detail}
          </div>
        ) : null}
        {/* A dead login shows even at a limit: the limit only hides usage-read errors. One click opens the sign-in page. */}
        {account.signedOut && onSignInAgain ? (
          // Clicks here never pick the row: a greyed-out button lets clicks through to it.
          <div
            className="mt-1.5 flex w-fit items-center gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="text-xs text-warning-text" title={account.error ?? undefined}>
              Signed out
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-xs [&_[data-icon-root]]:size-3"
              disabled={signingIn}
              onClick={onSignInAgain}
            >
              <Icon name="RotateCcw" />
              Sign in again
            </Button>
          </div>
        ) : account.error && !account.limitedUntil ? (
          <div className="truncate text-xs text-warning-text" title={account.error}>
            {account.error}
          </div>
        ) : null}
        {account.limitedLogin && onSignInAgain ? (
          <button
            type="button"
            disabled={signingIn}
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
        {shown.length > 0 ? (
          <div className="grid grid-cols-[auto_6rem_2rem_3.25rem] items-center gap-x-2 text-xs leading-[18px] tabular-nums text-subtle-foreground">
            {shown.map((window) => (
              <Meter
                key={window.label}
                label={window.label}
                usedPercent={window.usedPercent}
                resetsAt={window.resetsAt}
                checkedAt={window.checkedAt}
              />
            ))}
          </div>
        ) : null}
        {account.inUse && account.needsSignIn ? (
          <Button variant="outline" size="sm" onClick={onUse}>
            Approve for Cloud
          </Button>
        ) : null}
      </div>
      {/* "This Mac" signed out has nothing to do: no login to name, and the computer's own login is never removed here. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild disabled={!renamable && !onSignOut}>
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
          {renamable ? (
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Icon name="Edit" /> Rename
            </DropdownMenuItem>
          ) : null}
          {onSignOut ? (
            <DropdownMenuItem onSelect={onSignOut}>
              <Icon name="LogOut" /> Sign out
            </DropdownMenuItem>
          ) : null}
          {onSignInAgain ? (
            <DropdownMenuItem disabled={signingIn} onSelect={onSignInAgain}>
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
  const [privacy] = usePrivacyMode();
  // Privacy mode hides any email in the message ("<email> is already added"), not the whole message.
  const shown = error?.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (email) =>
    hideEmail(email, privacy),
  );

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
      {/* Errors wrap so the next step is never cut off; status text stays on one line. */}
      <div
        className={cn(
          "min-w-0 flex-1 text-muted-foreground",
          error ? "break-words" : "truncate",
        )}
      >
        {error ? (
          <span className="text-destructive-text">
            {shown}
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

/** Antigravity accounts sign in with Google like Cloud does: the link opens, and Google shows a code to paste back. */
function CodeRow({ rpc, close }: { rpc: Rpc; close: () => void }) {
  const navigate = useBbNavigate();
  const [session, setSession] = useState<{ id: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each try is a new sign-in; leaving the row cancels the open one.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let started: string | null = null;
    rpc.call("antigravity.start", null).then(
      (next) => {
        started = next.sessionId;
        if (cancelled) {
          void rpc.call("antigravity.cancel", { sessionId: next.sessionId });
          return;
        }
        setSession({ id: next.sessionId, url: next.authorizeUrl });
        navigate.openUrl(next.authorizeUrl);
      },
      (cause: unknown) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
      if (started) void rpc.call("antigravity.cancel", { sessionId: started });
    };
  }, [rpc, attempt]);
  const retry = () => {
    setSession(null);
    setCode("");
    setError(null);
    setAttempt((count) => count + 1);
  };
  const add = () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    rpc.call("antigravity.complete", { sessionId: session.id, code }).then(close, (cause: unknown) => {
      const message = errorText(cause);
      // A mistyped code keeps the sign-in open; any other error ends it.
      if (!message.startsWith("Paste the code")) setSession(null);
      setError(message);
      setBusy(false);
    });
  };
  return (
    <div className="space-y-2 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          aria-label="Google sign-in code"
          placeholder={session ? "Paste the code Google shows" : error ? "Sign-in ended" : "Starting sign-in…"}
          value={code}
          disabled={busy || !session}
          onChange={(event) => setCode(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && code.trim()) add();
            if (event.key === "Escape" && !busy) close();
          }}
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm text-foreground outline-none focus:border-foreground/50"
        />
        {session || busy ? (
          <Button size="sm" disabled={busy || !code.trim()} onClick={add}>
            {busy ? "Signing in…" : "Add"}
          </Button>
        ) : error ? (
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label="Cancel"
          disabled={busy}
          onClick={close}
        >
          <Icon name="X" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {error ? (
          <span className="text-destructive-text">{error}</span>
        ) : session ? (
          <>
            Sign in with another Google account, then paste the code here.{" "}
            <strong className="font-semibold text-foreground">Local threads</strong> switch to it when an account
            hits its limit.{" "}
            <button
              type="button"
              onClick={() => navigate.openUrl(session.url)}
              className="text-primary-text hover:underline"
            >
              Open sign-in again
            </button>
          </>
        ) : (
          "Opening Google sign-in…"
        )}
      </p>
    </div>
  );
}

type GoogleLogin = {
  state: "missing" | "waiting" | "connected" | "unavailable" | "error" | "expired";
  message: string | null;
  login_id: string | null;
  verification_url: string | null;
};
type GoogleLoginInput = {
  action: "status" | "login" | "complete" | "cancel" | "logout";
  requestId?: string;
  code?: string;
};

/** The ACP plugin runs Antigravity's Google sign-in (`agy acp --login`) on this computer. */
async function antigravityAccount(input: GoogleLoginInput): Promise<GoogleLogin> {
  const response = await fetch("/api/v1/plugins/provider-acp/rpc/antigravityAccount", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: GoogleLogin;
  } | null;
  if (!response.ok || body?.ok !== true || !body.result)
    throw new Error("Antigravity could not be reached.");
  return body.result;
}

/** Antigravity's Google login on this computer: null while it's checked, or when the ACP plugin is off. */
function useGoogleLogin(enabled: boolean) {
  const [login, setLogin] = useState<GoogleLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    antigravityAccount({ action: "status" }).then(
      (next) => {
        if (!cancelled) setLogin(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  const run = useCallback(async (input: GoogleLoginInput) => {
    setBusy(true);
    setError(null);
    try {
      const next = await antigravityAccount(input);
      setLogin(next);
      if (next.message && next.state !== "unavailable") setError(next.message);
      return next;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { login, busy, error, run };
}
type Google = ReturnType<typeof useGoogleLogin>;

/** Signs Antigravity in with Google here: Google's page opens, then its code goes in the box. */
function GoogleSignIn({ google }: { google: Google }) {
  const navigate = useBbNavigate();
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const { login, busy, run } = google;
  if (!login) return null;
  const waiting = login.state === "waiting" && login.login_id ? login : null;
  if (!waiting)
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-border py-2 pl-3.5 pr-2 text-sm">
        <span className="min-w-0 flex-1 text-muted-foreground">
          {login.state === "connected"
            ? "Signed in. Reading your plan…"
            : "Signed out on this computer."}
        </span>
        {login.state === "connected" ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run({ action: "login", requestId: crypto.randomUUID() }).then((next) => {
                if (next?.state === "waiting" && next.verification_url)
                  navigate.openUrl(next.verification_url);
              })
            }
          >
            {busy ? "Opening Google…" : "Sign in with Google"}
          </Button>
        )}
      </div>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border py-2 pl-3.5 pr-2 text-sm text-muted-foreground"
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
        {busy ? "Connecting…" : "Connect"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="Cancel sign-in"
        disabled={busy}
        onClick={() => void run({ action: "cancel", requestId: waiting.login_id! })}
      >
        <Icon name="X" />
      </Button>
    </form>
  );
}

function AccountsSection({
  provider,
  name,
  hideWhenEmpty = false,
  note,
  onPresence,
}: {
  provider: Provider;
  name: string;
  hideWhenEmpty?: boolean;
  note?: string | undefined;
  onPresence?: ((present: boolean) => void) | undefined;
}) {
  const rpc = useRpc<typeof accountsRpcContract>();
  const { providers } = useProviders();
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const antigravity = provider === "acp-antigravity";
  const google = useGoogleLogin(antigravity);
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
      await rpc.call("accounts.use", { provider, id, where: "settings" });
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
  const listed = (accounts?.length ?? 0) > 0;
  // This computer's own agy login shows as the Local row; added accounts are separate logins.
  const signedInHere = accounts?.some((account) => account.id === LOCAL) ?? false;
  // agy's usage reader keeps its answer a minute, so after a sign-in or out the row catches up within one.
  const loginState = google.login?.state;
  useEffect(() => {
    if (!antigravity || (loginState !== "connected" && loginState !== "missing")) return;
    if ((loginState === "connected") === signedInHere) return;
    let tries = 0;
    const check = () =>
      void rpc.call("accounts.list", { provider, refresh: true }).then(setAccounts, () => undefined);
    check();
    const timer = window.setInterval(() => {
      tries += 1;
      if (tries > 6) window.clearInterval(timer);
      else check();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [antigravity, loginState, signedInHere, provider, rpc]);
  // Optional subscriptions (Antigravity) stay hidden unless connected, or installed and ready to sign in, here.
  const visible =
    !hideWhenEmpty ||
    listed ||
    (antigravity && loginState !== undefined && loginState !== "unavailable");
  useEffect(() => onPresence?.(visible), [visible, onPresence]);
  if (!visible) return null;
  // Every account shows the same limits, so the lines match from row to row.
  // Claude leaves out 5h and 7d while they have no use, so those show 0%. Any other limit an account leaves out
  // was not read (the reply check can't read a model's limit): it shows as unknown.
  const unused = provider === "claude-code" ? ["Five-hour limit", "Weekly limit"] : [];
  const limits: Limit[] = [
    ...new Set([
      ...unused,
      ...(accounts ?? []).flatMap((account) =>
        account.windows.map((window) => window.label),
      ),
    ]),
  ].map((label) => ({
    label,
    usedPercent: unused.includes(label) ? 0 : null,
    resetsAt: null,
  }));
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
                limits={limits}
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
                  provider === "claude-code" && account.id !== LOCAL
                    ? () => setAdding({ mac: false, id: account.id })
                    : undefined
                }
                signingIn={adding !== null}
                onSignOut={
                  antigravity && account.id === LOCAL && google.login !== null
                    ? () =>
                        void google.run({ action: "logout" }).then((next) => {
                          // The usage reader still remembers the login for up to a minute.
                          if (next?.state === "missing")
                            setAccounts((list) => list?.filter((row) => row.id !== LOCAL) ?? list);
                        })
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
          ) : provider === "acp-antigravity" ? (
            <CodeRow
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
      {antigravity && !signedInHere ? <GoogleSignIn google={google} /> : null}
      {note ? (
        <p className="text-xs text-subtle-foreground">{note}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive-text">{error}</p> : null}
      {google.error ? <p className="text-xs text-destructive-text">{google.error}</p> : null}
    </section>
  );
}

const AGENTS: readonly {
  provider: Provider;
  name: string;
  hideWhenEmpty?: boolean;
}[] = [
  { provider: "claude-code", name: "Claude Code" },
  { provider: "codex", name: "Codex" },
  { provider: "acp-cursor", name: "Cursor" },
  { provider: "acp-antigravity", name: "Antigravity", hideWhenEmpty: true },
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
  const [hasAntigravity, setHasAntigravity] = useState(false);
  return (
    <div className="space-y-2">
      {/* Hides emails here and in the usage box, for recordings. */}
      <label className="ml-auto flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        Privacy mode
        <Switch checked={privacy} onCheckedChange={setPrivacy} />
      </label>
      <div className="space-y-6">
        {AGENTS.map((agent) => (
          <AccountsSection
            key={agent.provider}
            {...agent}
            onPresence={
              agent.provider === "acp-antigravity"
                ? setHasAntigravity
                : undefined
            }
            note={
              agent.provider === "acp-antigravity"
                ? "Added Antigravity accounts run Local threads; Cloud keeps its own Antigravity login. Grok signs in with your X subscription, so there's nothing to add for it."
                : agent.provider === "acp-cursor" && !hasAntigravity
                  ? "Grok signs in with your X subscription. One login covers it, so there's nothing to add here."
                  : undefined
            }
          />
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
    description: "Add and switch Claude Code, Codex, Cursor, and Antigravity subscriptions.",
    component: AccountsPage,
  });
});
