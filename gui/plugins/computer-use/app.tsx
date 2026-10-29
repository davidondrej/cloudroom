import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginPendingInteractionProps,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { approvalPayloadSchema, type rpcContract } from "./contract.js";

type Settings = StandardSchemaV1InferOutput<(typeof rpcContract)["getSettings"]["output"]>;
type Permissions = NonNullable<Settings["status"]>["permissions"];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void grant(row.kind)}>
              Grant
            </Button>
          ) : null}
        </div>
      ))}
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
  const decide = async (decision: "thread" | "always" | "deny") => {
    setBusy(true);
    try {
      await submit({ decision });
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void decide("always");
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") void decide("deny");
      }}
    >
      <div className="space-y-1">
        <p className="text-sm text-foreground">
          The agent wants to see and control <span className="font-semibold">{payload.app.name}</span>.
        </p>
        {payload.purpose ? <p className="text-xs text-muted-foreground">{payload.purpose}</p> : null}
        <p className="text-xs text-muted-foreground">
          It works in the background with its own cursor. Screen content may be sent to the model.
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
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void decide("thread")}>
          Only this thread
        </Button>
        <Button type="submit" size="sm" disabled={busy} autoFocus>
          Always allow
        </Button>
      </div>
    </form>
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
        Agents in Local threads can see and control desktop apps. Cloudroom asks you before each new app.
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
        </div>
      ) : (
        <p className="text-sm text-destructive">{settings.error}</p>
      )}
      <div className="space-y-2">
        <p className="text-sm font-medium">Always allowed apps</p>
        {settings.alwaysAllowed.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          settings.alwaysAllowed.map((app) => (
            <div key={app.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {app.name} <span className="text-xs text-muted-foreground">{app.key}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void load(rpc.call("removeAlwaysAllowed", { key: app.key }))}>
                Remove
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
  app.slots.pendingInteraction({ id: "computer-use-approval", component: ApprovalCard });
  app.slots.settingsSection({ id: "configuration", component: ComputerUseSettings });
});
