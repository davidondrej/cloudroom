import { COMPUTER } from "@cloudroom/domain/computer-name";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  UrlLink as UrlLink,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { connectRpcContract } from "./src/rpc.js";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { Switch } from "@cloudroom/shared-ui/switch";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  CONNECT_REALTIME_CHANNEL,
  PHONE_SETUP_URL_QR,
  type ConnectStateName,
  type ConnectStatus,
} from "@/src/types";


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DANGER_QUIET_CLASS =
  "text-destructive-text hover:text-destructive-text hover:bg-surface-destructive";

const STATES: readonly ConnectStateName[] = [
  "disconnected",
  "connected",
  "reconnecting",
];

function isState(value: unknown): value is ConnectStateName {
  return STATES.includes(value as ConnectStateName);
}

function asStatus(payload: unknown): ConnectStatus | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (
    !isState(record.state) ||
    typeof record.paired !== "boolean" ||
    typeof record.since !== "number"
  ) {
    return null;
  }
  const shares: ConnectStatus["shares"] = [];
  if (Array.isArray(record.shares)) {
    for (const entry of record.shares as Record<string, unknown>[]) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.hostId === "string" &&
        typeof entry.hostName === "string" &&
        typeof entry.port === "number" &&
        typeof entry.createdAt === "number" &&
        typeof entry.url === "string"
      ) {
        shares.push({
          hostId: entry.hostId,
          hostName: entry.hostName,
          port: entry.port,
          createdAt: entry.createdAt,
          url: entry.url,
          ...(typeof entry.unavailableReason === "string"
            ? { unavailableReason: entry.unavailableReason }
            : {}),
        });
      }
    }
  }
  return {
    state: record.state,
    paired: record.paired,
    handle: typeof record.handle === "string" ? record.handle : null,
    url: typeof record.url === "string" ? record.url : null,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    nextRetryAt:
      typeof record.nextRetryAt === "number" ? record.nextRetryAt : null,
    since: record.since,
    remoteClients:
      typeof record.remoteClients === "number" ? record.remoteClients : 0,
    lastRemoteActivityAt:
      typeof record.lastRemoteActivityAt === "number"
        ? record.lastRemoteActivityAt
        : null,
    shares,
    signedIn: record.signedIn === true,
  };
}

function formatSince(sinceMs: number): string {
  const at = new Date(sinceMs);
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function retryHint(nextRetryAt: number | null): string {
  if (nextRetryAt === null) return "retrying automatically";
  const seconds = Math.max(0, Math.round((nextRetryAt - Date.now()) / 1000));
  return seconds > 0 ? `retrying in ${seconds}s` : "retrying…";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "muted" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "ok" &&
          "bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_18%,transparent)]",
        tone === "warn" &&
          "animate-pulse bg-warning shadow-[0_0_0_3px_color-mix(in_oklab,var(--warning)_22%,transparent)]",
        tone === "muted" && "bg-muted-foreground/50",
      )}
    />
  );
}

function qrCodeSvgUrl(rows: readonly string[]): string {
  const size = rows.length + 2;
  const modules = rows.flatMap((row, y) =>
    [...row].map((cell, x) =>
      cell === "#" ? `M${x + 1} ${y + 1}h1v1h-1z` : "",
    ),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${modules.join("")}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const PHONE_SETUP_QR_SRC = qrCodeSvgUrl(PHONE_SETUP_URL_QR);

function UrlHero({ url, showOpen }: { url: string; showOpen: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const urlRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const selectUrl = useCallback(() => {
    const element = urlRef.current;
    if (element === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopyState("copied");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopyState("idle"), 1500);
      },
      () => {
        selectUrl();
        setCopyState("manual");
      },
    );
  }, [url, selectUrl]);

  return (
    <div className="flex max-w-xl items-center gap-1 rounded-lg border border-border bg-surface-recessed py-1 pl-3.5 pr-1">
      <UrlLink
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground no-underline hover:underline"
      >
        <span ref={urlRef}>{url}</span>
      </UrlLink>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={copy}
        aria-label="Copy URL"
      >
        <Icon
          name={copyState === "copied" ? "Check" : "Copy"}
          className="size-4"
        />
        {copyState === "copied"
          ? "Copied"
          : copyState === "manual"
            ? "Press ⌘C"
            : "Copy"}
      </Button>
      {showOpen ? (
        <Button type="button" variant="outline" size="sm" asChild>
          <UrlLink href={url} target="_blank" rel="noreferrer">
            Open
          </UrlLink>
        </Button>
      ) : null}
    </div>
  );
}

function QuietCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [text]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      onClick={copy}
      aria-label={label}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

interface ShareHostGroup {
  hostId: string;
  hostName: string;
  shares: ConnectStatus["shares"];
}

function groupSharesByHost(shares: ConnectStatus["shares"]): ShareHostGroup[] {
  const groups: ShareHostGroup[] = [];
  const byHostId = new Map<string, ShareHostGroup>();
  for (const share of shares) {
    let group = byHostId.get(share.hostId);
    if (group === undefined) {
      group = { hostId: share.hostId, hostName: share.hostName, shares: [] };
      byHostId.set(share.hostId, group);
      groups.push(group);
    }
    group.shares.push(share);
  }
  return groups;
}

function SharedPortsSection({
  shares,
  dimmed,
}: {
  shares: ConnectStatus["shares"];
  dimmed: boolean;
}) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [portInput, setPortInput] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [exposing, setExposing] = useState(false);
  const [revokingShare, setRevokingShare] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expose = useCallback(() => {
    const trimmed = portInput.trim();
    if (trimmed.length === 0 || exposing) return;
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("Port must be an integer between 1 and 65535");
      return;
    }
    setExposing(true);
    setError(null);
    rpc.call("expose", { port }).then(
      () => {
        setExposing(false);
        setPortInput("");
        setFormOpen(false);
      },
      (rpcError: unknown) => {
        setExposing(false);
        setError(errorText(rpcError));
      },
    );
  }, [portInput, exposing, rpc]);

  const unexpose = useCallback(
    (hostId: string, port: number) => {
      if (revokingShare !== null) return;
      const key = `${hostId}:${port}`;
      setRevokingShare(key);
      setError(null);
      rpc.call("unexpose", { hostId, port }).then(
        () => {
          setRevokingShare(null);
        },
        (rpcError: unknown) => {
          setRevokingShare(null);
          setError(errorText(rpcError));
        },
      );
    },
    [revokingShare, rpc],
  );

  return (
    <div
      className={cn(
        "space-y-3",
        dimmed && "pointer-events-none opacity-60 saturate-[0.85]",
      )}
    >
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Agents can share their dev servers too. Only your signed-in phones can open them.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setFormOpen((open) => !open)}
        >
          <Icon name="Plus" className="size-3.5" />
          Expose a port
        </Button>
      </div>

      {shares.length > 0 ? (
        <div className="space-y-2.5 rounded-lg border border-border p-3">
          {groupSharesByHost(shares).map((group) => {
            const hostDown = group.shares.every((share) => share.url === "");
            return (
              <div key={group.hostId} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <StatusDot tone={hostDown ? "muted" : "ok"} />
                  <span
                    className={cn(
                      "min-w-0 truncate text-xs font-medium",
                      hostDown ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {group.hostName}
                  </span>
                </div>
                <ul className="space-y-1 pl-3.5">
                  {group.shares.map((share) => (
                    <li
                      key={`${share.hostId}:${share.port}`}
                      className="flex items-center gap-2"
                    >
                      <span
                        className={cn(
                          "shrink-0 font-mono text-xs tabular-nums",
                          share.url
                            ? "text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        :{share.port}
                      </span>
                      {share.url ? (
                        <>
                          <UrlLink
                            href={share.url}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
                          >
                            {hostOf(share.url)}
                          </UrlLink>
                          <QuietCopyButton
                            text={share.url}
                            label={`Copy share URL for port ${share.port}`}
                          />
                        </>
                      ) : (
                        <span
                          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                          title={share.unavailableReason}
                        >
                          Unavailable —{" "}
                          {share.unavailableReason ?? "unknown reason"}
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={DANGER_QUIET_CLASS}
                        disabled={
                          revokingShare === `${share.hostId}:${share.port}`
                        }
                        onClick={() => unexpose(share.hostId, share.port)}
                      >
                        {revokingShare === `${share.hostId}:${share.port}` ? (
                          <Icon
                            name="Spinner"
                            className="size-4 animate-spin"
                          />
                        ) : null}
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : formOpen ? null : (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          No shared servers yet.
        </p>
      )}

      {formOpen ? (
        <form
          className="flex max-w-[16rem] items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            expose();
          }}
        >
          <Input
            type="number"
            min={1}
            max={65535}
            step={1}
            value={portInput}
            onChange={(event) => setPortInput(event.target.value)}
            placeholder="Port"
            inputMode="numeric"
            className="max-w-[7rem] font-mono"
            aria-label="Port to share"
          />
          <Button
            type="submit"
            size="sm"
            disabled={exposing || portInput.trim().length === 0}
          >
            {exposing ? (
              <Icon name="Spinner" className="size-4 animate-spin" />
            ) : null}
            Expose
          </Button>
        </form>
      ) : null}

      {error !== null ? (
        <p className="text-xs text-destructive-text">{error}</p>
      ) : null}
    </div>
  );
}

function PhoneSetupCard() {
  return (
    <div className="flex items-center gap-8 rounded-lg border border-border p-6">
      <img
        src={PHONE_SETUP_QR_SRC}
        alt="QR code to set up Cloudroom on your phone"
        className="size-48 shrink-0 rounded-md border border-border bg-white p-2"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-base font-semibold text-foreground">Scan with your phone</h3>
        <p className="text-sm text-muted-foreground">
          Or open{" "}
          <span className="font-medium text-foreground">cloudroom.dev/m</span>
          {" "}on your phone. Sign in with your Cloudroom account and tap Open Cloudroom.
        </p>
      </div>
    </div>
  );
}

function PhoneTab({ status }: { status: ConnectStatus }) {
  if (!status.signedIn) {
    return (
      <p className="text-sm text-muted-foreground">
        {status.lastError ?? "Sign in to Cloudroom to use it on your phone."}
      </p>
    );
  }
  if (!status.paired) {
    return (
      <p className="text-sm text-muted-foreground">
        Your phone can reach this {COMPUTER} once Cloudroom Connect is ready.
      </p>
    );
  }
  const connected = status.state === "connected";
  return (
    <div className="space-y-3">
      <PhoneSetupCard />
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        Tip: add it to your Home Screen. On iPhone, tap Share, then Add to Home
        Screen. On Android, open the browser menu and tap Install app.
        {connected ? "" : ` Your phone reaches this ${COMPUTER} while Cloudroom is open and the ${COMPUTER} is awake.`}
      </p>
      {status.url !== null ? (
        <div className="flex items-center gap-4 rounded-lg border border-border px-4 py-3">
          <span className="shrink-0 text-sm font-medium text-foreground">Private address</span>
          <div className="min-w-0 flex-1">
            <UrlHero url={status.url} showOpen={connected} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {children}
    </div>
  );
}

function RemoteInstructionsRow() {
  const rpc = useRpc<typeof connectRpcContract>();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("remoteInstructions", {}).then(
      (result) => setEnabled(result.enabled),
      (rpcError: unknown) => setError(errorText(rpcError)),
    );
  }, [rpc]);
  const change = useCallback(
    (next: boolean) => {
      setPending(true);
      setError(null);
      setEnabled(next);
      rpc.call("remoteInstructions", { enabled: next }).then(
        (result) => {
          setPending(false);
          setEnabled(result.enabled);
        },
        (rpcError: unknown) => {
          setPending(false);
          setEnabled(!next);
          setError(errorText(rpcError));
        },
      );
    },
    [rpc],
  );
  return (
    <SettingRow
      title="Tell agents about remote access"
      detail={
        error ??
        "When you use Cloudroom remotely, agents share dev servers through Cloudroom Connect. Applies to new agent sessions."
      }
    >
      <Switch
        checked={enabled ?? false}
        disabled={enabled === null || pending}
        onCheckedChange={change}
        aria-label="Tell agents about remote access"
      />
    </SettingRow>
  );
}

function SignOutPhones() {
  const rpc = useRpc<typeof connectRpcContract>();
  const [state, setState] = useState<"idle" | "confirm" | "pending">("idle");
  const [result, setResult] = useState<string | null>(null);
  const signOut = useCallback(() => {
    setState("pending");
    rpc.call("signOutPhones").then(
      ({ revoked }) => {
        setState("idle");
        setResult(revoked === 1 ? "Signed out 1 session." : `Signed out ${revoked} sessions.`);
      },
      (error: unknown) => {
        setState("idle");
        setResult(errorText(error));
      },
    );
  }, [rpc]);
  return (
    <SettingRow
      title="Signed-in phones"
      detail={result ?? "Phones stay signed in until you sign them out here."}
    >
      {state === "confirm" ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setState("idle")}>
          Cancel
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={DANGER_QUIET_CLASS}
        disabled={state === "pending"}
        onClick={() => (state === "confirm" ? signOut() : setState("confirm"))}
      >
        {state === "confirm" ? "Sign out all phones?" : "Sign out all phones"}
      </Button>
    </SettingRow>
  );
}

function SettingsTab({ status }: { status: ConnectStatus }) {
  return (
    <div className="divide-y divide-border-seam rounded-lg border border-border">
      <RemoteInstructionsRow />
      {status.paired ? <SignOutPhones /> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: ConnectStatus }) {
  const [tone, label, detail]: ["ok" | "warn" | "muted", string, string | null] =
    !status.signedIn
      ? ["muted", "Signed out", status.lastError]
      : !status.paired
        ? ["warn", "Setting up…", status.lastError]
        : status.state !== "connected"
          ? [
              "warn",
              "Reconnecting…",
              [status.lastError, retryHint(status.nextRetryAt)]
                .filter((part): part is string => Boolean(part))
                .join(" · "),
            ]
          : [
              "ok",
              "Ready",
              `since ${formatSince(status.since)}${
                status.remoteClients > 0 ? ` · ${status.remoteClients} viewing remotely` : ""
              }`,
            ];
  return (
    <div className="flex min-w-0 items-center gap-2">
      {detail ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>
      ) : null}
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
          tone === "ok" && "border-success/60 bg-success/10 text-foreground",
          tone === "warn" && "border-warning/20 bg-warning/15 text-warning-text",
          tone === "muted" && "border-border text-muted-foreground",
        )}
      >
        <StatusDot tone={tone} />
        {label}
      </span>
    </div>
  );
}

type ConnectTab = "phone" | "servers" | "settings";

function TabButton({
  active,
  icon,
  label,
  count,
  onSelect,
}: {
  active: boolean;
  icon: string;
  label: string;
  count?: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-xs"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon name={icon} className="size-3.5" />
      {label}
      {count !== undefined && count > 0 ? (
        <span className="rounded-full bg-surface-recessed px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function ConnectSettingsSection() {
  const rpc = useRpc<typeof connectRpcContract>();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<ConnectTab>("phone");

  useEffect(() => {
    rpc.call("status").then(
      (result) => {
        const next = asStatus(result);
        if (next !== null) setStatus(next);
        else setLoadError("Unexpected status payload.");
      },
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc]);

  useRealtime(CONNECT_REALTIME_CHANNEL, (payload) => {
    const next = asStatus(payload);
    if (next !== null) {
      setStatus(next);
      setLoadError(null);
    }
  });

  if (loadError !== null) {
    return (
      <p className="text-sm text-destructive-text">
        Failed to load remote-access status: {loadError}
      </p>
    );
  }
  if (status === null) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div
          role="tablist"
          aria-label="Cloudroom Connect"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-recessed p-1"
        >
          <TabButton active={tab === "phone"} icon="Smartphone" label="Phone" onSelect={() => setTab("phone")} />
          <TabButton
            active={tab === "servers"}
            icon="Globe"
            label="Shared servers"
            count={status.shares.length}
            onSelect={() => setTab("servers")}
          />
          <TabButton active={tab === "settings"} icon="Settings" label="Settings" onSelect={() => setTab("settings")} />
        </div>
        <span className="flex-1" />
        <StatusBadge status={status} />
      </div>
      {tab === "phone" ? <PhoneTab status={status} /> : null}
      {tab === "servers" ? (
        status.paired ? (
          <SharedPortsSection
            shares={status.shares}
            dimmed={status.state !== "connected"}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Shared servers work once Cloudroom Connect is ready.
          </p>
        )
      ) : null}
      {tab === "settings" ? <SettingsTab status={status} /> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "remote-access",
    component: ConnectSettingsSection,
  });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "remote-access",
    label: "Cloudroom Connect",
    icon: "Smartphone",
    onActivate({ openPluginDetails }) {
      openPluginDetails();
    },
  });
});
