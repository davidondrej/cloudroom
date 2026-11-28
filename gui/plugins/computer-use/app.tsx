import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginPendingInteractionProps,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import {
  APPROVAL_RENDERER_ID,
  BROWSER_SETUP_RENDERER_ID,
  approvalPayloadSchema,
  browserSetupPayloadSchema,
  type BrowserControlStatus,
  type rpcContract,
} from "./contract.js";

type Settings = StandardSchemaV1InferOutput<(typeof rpcContract)["getSettings"]["output"]>;
type Permissions = NonNullable<Settings["status"]>["permissions"];

const DOT_OK = "#22c55e";
const DOT_WARN = "#f59e0b";
const DOT_MUTED = "var(--muted-foreground)";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function StatusDot({ state }: { state: "ok" | "warn" | "unknown" }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: 9999,
        backgroundColor:
          state === "ok" ? DOT_OK : state === "warn" ? DOT_WARN : DOT_MUTED,
        flexShrink: 0,
      }}
    />
  );
}

function BrowserBadgeIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, color: "var(--muted-foreground)" }}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
      <ellipse cx="8" cy="8" rx="2.9" ry="6.25" stroke="currentColor" strokeWidth="1.15" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  );
}

function PermissionRows({
  permissions,
  onChange,
}: {
  permissions: Permissions;
  onChange?: (settings: Settings) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = [
    { kind: "accessibility" as const, label: "Accessibility", need: "Required to see and control apps.", granted: permissions.accessibility },
    { kind: "screenRecording" as const, label: "Screen Recording", need: "Needed for screenshots.", granted: permissions.screenRecording },
  ];
  const grant = async (kind: "accessibility" | "screenRecording") => {
    setBusy(true);
    setError(null);
    try {
      onChange?.(await rpc.call("requestPermission", { kind }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.kind} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0">
            <span className="font-medium">{row.label}</span>{" "}
            <span className="text-xs text-muted-foreground">{row.granted ? "Granted" : row.need}</span>
          </span>
          {row.granted === false ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void grant(row.kind)}>
              Grant
            </Button>
          ) : null}
        </div>
      ))}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// Shared 2-row Browser Control checklist used in both Settings and the inline chat setup card.
// Inline styles keep custom spacing/colors reliable because the app's Tailwind build doesn't scan plugin files.
function BrowserControlSection({
  browserControl,
  platform,
  showCliHint = false,
  onSettings,
  onOpenedFdaSettings,
}: {
  browserControl: BrowserControlStatus;
  platform: string;
  showCliHint?: boolean;
  onSettings?: (next: Settings) => void;
  onOpenedFdaSettings?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState<"recheck" | "fda" | "inspect" | null>(null);
  const [copied, setCopied] = useState(false);
  const [openedFda, setOpenedFda] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runRpc = async (
    action: "recheck" | "fda" | "inspect",
    work: () => Promise<Settings>,
  ) => {
    setBusy(action);
    setError(null);
    try {
      onSettings?.(await work());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard?.writeText(browserControl.inspectUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError(`Copy manually: ${browserControl.inspectUrl}`);
    }
  };

  const showFdaRow = platform === "darwin" && browserControl.fullDiskAccess !== null;
  const fdaOk = browserControl.fullDiskAccess === true;
  const debugOk = browserControl.remoteDebugging === true;
  const debugUnknown = browserControl.remoteDebugging === null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <BrowserBadgeIcon />
          <span className="truncate text-sm font-medium text-foreground">
            Browser control · {browserControl.browserName}
          </span>
          {browserControl.isDefault ? (
            <span
              style={{
                fontSize: 11,
                lineHeight: "16px",
                padding: "1px 6px",
                borderRadius: 5,
                border: "1px solid var(--border)",
                color: "var(--muted-foreground)",
                flexShrink: 0,
              }}
            >
              default
            </span>
          ) : null}
          {browserControl.ready ? (
            <span
              style={{
                fontSize: 11,
                lineHeight: "16px",
                padding: "1px 6px",
                borderRadius: 5,
                color: DOT_OK,
                border: "1px solid rgba(34, 197, 94, 0.35)",
                flexShrink: 0,
              }}
            >
              Ready
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void runRpc("recheck", () => rpc.call("getSettings", null))}
        >
          {busy === "recheck" ? "Checking…" : "Recheck"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {!browserControl.supported
          ? browserControl.reason ??
            `${browserControl.browserName} doesn't support background browser control.`
          : browserControl.ready
            ? `Agents can click and read your logged-in ${browserControl.shortName} tabs in the background without stealing focus.`
            : `Lets agents click and read your logged-in ${browserControl.shortName} tabs in the background without stealing focus.`}
      </p>

      {browserControl.supported ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {showFdaRow ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot state={fdaOk ? "ok" : "warn"} />
                <span className="min-w-0">
                  <span className="font-medium text-foreground">Full Disk Access</span>{" "}
                  <span
                    className="text-xs"
                    style={{ color: fdaOk ? "var(--muted-foreground)" : DOT_WARN }}
                  >
                    {fdaOk
                      ? "Granted"
                      : openedFda
                        ? "Turn Cloudroom on, then quit and reopen Cloudroom so macOS applies it"
                        : `Off · macOS blocks ${browserControl.shortName}'s debug port without it (requires reopening Cloudroom)`}
                  </span>
                </span>
              </div>
              {!fdaOk ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => {
                    setOpenedFda(true);
                    onOpenedFdaSettings?.();
                    void runRpc("fda", () =>
                      rpc.call("requestPermission", { kind: "fullDiskAccess" }),
                    );
                  }}
                >
                  Open System Settings
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot state={debugOk ? "ok" : debugUnknown ? "unknown" : "warn"} />
              <span className="min-w-0">
                <span className="font-medium text-foreground">
                  {browserControl.shortName} remote debugging
                </span>{" "}
                <span
                  className="text-xs"
                  style={{
                    color: debugOk || debugUnknown ? "var(--muted-foreground)" : DOT_WARN,
                  }}
                >
                  {debugOk
                    ? "On · ready for background tabs"
                    : debugUnknown
                      ? `Unknown until Full Disk Access is on · tick Allow at ${browserControl.inspectUrl}`
                      : `Off · tick Allow at ${browserControl.inspectUrl}`}
                </span>
              </span>
            </div>
            {!debugOk ? (
              <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void copyUrl()}
                >
                  {copied ? "Copied" : "Copy URL"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    void runRpc("inspect", () => rpc.call("openBrowserInspect", null))
                  }
                >
                  Open in {browserControl.shortName}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showCliHint ? (
        <p
          className="text-xs text-muted-foreground"
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 }}
        >
          CLI: room-cli computer-use status · room-cli computer-use setup --browser
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function ApprovalCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(() => approvalPayloadSchema.safeParse(interaction.payload), [interaction.payload]);
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  if (!parsed.success)
    return (
      <Button variant="outline" onClick={() => void cancel().catch(() => undefined)}>
        Dismiss invalid request
      </Button>
    );
  const payload = parsed.data;
  const current = permissions ?? payload.permissions;
  const decide = async (decision: "thread" | "deny") => {
    setBusy(true);
    try {
      await submit({ decision });
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="space-y-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") void decide("deny");
      }}
    >
      <div className="space-y-1">
        <p className="text-sm text-foreground">
          The agent wants to use Computer Use in this thread, starting with{" "}
          <span className="font-semibold">{payload.app.name}</span>.
        </p>
        {payload.purpose ? <p className="text-xs text-muted-foreground">{payload.purpose}</p> : null}
        <p className="text-xs text-muted-foreground">
          Allows this thread to see and control desktop apps, including bringing windows to the front when needed. Screen content may be sent to the model.
        </p>
      </div>
      {payload.platform === "darwin" && current.accessibility === false ? (
        <div className="rounded-md border border-border/70 p-3">
          <p className="mb-2 text-xs text-muted-foreground">Cloudroom needs macOS permission first.</p>
          <PermissionRows permissions={current} onChange={(next) => next.status && setPermissions(next.status.permissions)} />
        </div>
      ) : null}
      <div className="flex flex-col-reverse gap-2 border-t border-border/70 pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void decide("deny")}>
          Deny
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => void decide("thread")}>
          Allow for this thread
        </Button>
      </div>
    </div>
  );
}

// Inline chat card shown by `room-cli computer-use setup --browser`. Sits at the end of the timeline
// without replacing the composer (isChatCardPluginInteraction).
function BrowserSetupCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const parsed = useMemo(
    () => browserSetupPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const [live, setLive] = useState<BrowserControlStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [openedFdaSettings, setOpenedFdaSettings] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<BrowserControlStatus | null> => {
    try {
      const next = await rpc.call("getSettings", null);
      const bc = next.status?.browserControl ?? null;
      if (bc) setLive(bc);
      return bc;
    } catch {
      return null;
    }
  }, [rpc]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (!parsed.success) {
    return (
      <Button variant="outline" onClick={() => void cancel().catch(() => undefined)}>
        Dismiss invalid request
      </Button>
    );
  }

  const browserControl = live ?? parsed.data.browserControl;

  const dismiss = async () => {
    setBusy(true);
    try {
      await submit({ action: "dismiss" });
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const checkAndRetry = async () => {
    setBusy(true);
    setNote(null);
    try {
      const latest = (await refresh()) ?? browserControl;
      if (latest.ready || !latest.supported) {
        await submit({ action: "retry" });
      } else if (parsed.data.platform === "darwin" && latest.fullDiskAccess === false) {
        setNote(
          openedFdaSettings
            ? "macOS applies Full Disk Access only after restarting. Quit and reopen Cloudroom, then retry."
            : "Turn on Full Disk Access in System Settings, then quit and reopen Cloudroom so macOS applies it.",
        );
      } else {
        setNote("Finish the highlighted step above, then click Check & retry.");
      }
    } catch {
      await submit({ action: "retry" }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") void dismiss();
      }}
      style={{
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--card)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <BrowserControlSection
        browserControl={browserControl}
        platform={parsed.data.platform}
        onOpenedFdaSettings={() => setOpenedFdaSettings(true)}
        onSettings={(next) => {
          if (next.status?.browserControl) {
            setLive(next.status.browserControl);
            if (next.status.browserControl.ready) setNote(null);
          }
        }}
      />

      {note ? (
        <p className="text-xs" style={{ color: DOT_WARN }}>
          {note}
        </p>
      ) : null}

      <div
        className="flex items-center justify-between gap-2"
        style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
      >
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void dismiss()}>
          Not now
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => void checkAndRetry()}>
          {browserControl.ready ? "Continue" : "Check & retry"}
        </Button>
      </div>
    </div>
  );
}

function ComputerUseSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (work: Promise<Settings>) =>
    work.then(setSettings, (caught: unknown) => setError(errorMessage(caught)));
  useEffect(() => {
    void load(rpc.call("getSettings", null));
  }, [rpc]);
  if (!settings) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  const status = settings.status;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Agents in Local threads (and Cloud threads with Mac access) can see and control desktop apps. Cloudroom asks you once per thread.
      </p>
      {status ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {status.supported
              ? `Cua Driver ${status.version} · ${status.installed ? "installed" : "downloads on first use"} · ${status.running ? "running" : "idle"}`
              : status.reason}
          </p>
          {status.hint ? <p className="text-xs text-muted-foreground">{status.hint}</p> : null}
          {status.platform === "darwin" ? <PermissionRows permissions={status.permissions} onChange={setSettings} /> : null}
          {status.supported ? (
            <Button size="sm" variant="ghost" onClick={() => void load(rpc.call("restart", null))}>
              Restart driver
            </Button>
          ) : null}
          {status.browserControl ? (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginTop: 8 }}>
              <BrowserControlSection
                browserControl={status.browserControl}
                platform={status.platform}
                showCliHint
                onSettings={setSettings}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-destructive">{settings.error}</p>
      )}
      <div className="space-y-2">
        <p className="text-sm font-medium">Allowed threads</p>
        {settings.grantedThreads.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          settings.grantedThreads.map((thread) => (
            <div key={thread.threadId} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{thread.title}</span>
              <Button size="sm" variant="ghost" onClick={() => void load(rpc.call("revokeThread", { threadId: thread.threadId }))}>
                Revoke
              </Button>
            </div>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">Powered by Cua Driver (MIT).</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER_ID, component: ApprovalCard });
  app.slots.pendingInteraction({ id: BROWSER_SETUP_RENDERER_ID, component: BrowserSetupCard });
  app.slots.settingsSection({ id: "configuration", component: ComputerUseSettings });
});
