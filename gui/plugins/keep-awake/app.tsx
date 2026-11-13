import { COMPUTER } from "@cloudroom/domain/computer-name";
import { useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc, type StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk/app";
import { Checkbox } from "@cloudroom/shared-ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@cloudroom/shared-ui/radio-group";
import { Switch } from "@cloudroom/shared-ui/switch";
import type { keepAwakeRpcContract } from "./server.js";

type View = StandardSchemaV1InferOutput<(typeof keepAwakeRpcContract)["getConfiguration"]["output"]>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function ModeOption(props: { value: "all" | "selected"; label: string; hint: string; disabled?: boolean }) {
  const id = `keep-awake-${props.value}-hosts`;
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-3 rounded-md px-2 py-2 ${
        props.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-accent/50"
      }`}
    >
      <RadioGroupItem id={id} value={props.value} aria-label={props.label} disabled={props.disabled} className="mt-0.5" />
      <span>
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="block text-xs text-muted-foreground">{props.hint}</span>
      </span>
    </label>
  );
}

function KeepAwakeSettings() {
  const rpc = useRpc<typeof keepAwakeRpcContract>();
  const [view, setView] = useState<View | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the server last confirmed; a failed save goes back to it. */
  const confirmed = useRef<View | null>(null);
  /** Saves run one at a time, and only the newest one may update the page. */
  const saves = useRef<Promise<void>>(Promise.resolve());
  const newest = useRef(0);

  useEffect(() => {
    let live = true;
    rpc.call("getConfiguration").then(
      (loaded) => {
        if (!live) return;
        confirmed.current = loaded;
        setView(loaded);
      },
      (loadError: unknown) => live && setError(errorMessage(loadError)),
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  if (view === null) {
    return (
      <p
        className={`text-sm ${error === null ? "text-muted-foreground" : "text-destructive"}`}
        role={error === null ? "status" : "alert"}
      >
        {error ?? "Loading hosts…"}
      </p>
    );
  }

  function save(next: View): void {
    const mine = ++newest.current;
    setView(next);
    setError(null);
    setSaving(true);
    saves.current = saves.current
      .then(() => rpc.call("setConfiguration", { enabled: next.enabled, selection: next.selection }))
      .then(
        (saved) => {
          confirmed.current = saved;
          if (mine !== newest.current) return;
          setView(saved);
          setSaving(false);
        },
        (saveError: unknown) => {
          if (mine !== newest.current) return;
          setView(confirmed.current);
          setError(errorMessage(saveError));
          setSaving(false);
        },
      );
  }

  const selectedIds = view.selection.mode === "selected" ? view.selection.hostIds : [];
  const hasHosts = view.hosts.length > 0;
  /** The last selected host cannot be unchecked: "selected" needs at least one. */
  const selectHosts = (hostIds: string[]): void => {
    if (hostIds.length > 0) save({ ...view, selection: { mode: "selected", hostIds } });
  };

  return (
    <div className="w-full space-y-5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Prevent sleep</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Keep selected {COMPUTER}s and their screens awake while Cloudroom is running.
            Closing the lid or choosing Sleep still sleeps the {COMPUTER}.
          </p>
        </div>
        <Switch checked={view.enabled} size="default" aria-label="Keep Awake" onCheckedChange={(enabled) => save({ ...view, enabled })} />
      </div>

      {view.enabled ? (
        <>
          <div className="border-t border-border/60 pt-4">
            <h3 className="text-sm font-medium text-foreground">Hosts</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Choose which {COMPUTER}s to keep awake.
            </p>
            <RadioGroup
              className="mt-2 gap-1"
              value={view.selection.mode}
              onValueChange={(mode) => {
                if (mode === "all") save({ ...view, selection: { mode: "all" } });
                if (mode === "selected" && view.selection.mode !== "selected") {
                  selectHosts(view.hosts.map((host) => host.id).slice(0, 256));
                }
              }}
            >
              <ModeOption
                value="all"
                label="All hosts"
                hint="Include hosts added in the future. Only macOS, Linux and Windows hosts are supported."
              />
              <ModeOption value="selected" label="Specific hosts" hint={`Choose individual ${COMPUTER}s below.`} disabled={!hasHosts} />
            </RadioGroup>
          </div>

          {view.selection.mode === "selected" ? (
            <div className="overflow-hidden rounded-md border border-border/60">
              {hasHosts ? (
                <div className="divide-y divide-border/60">
                  {view.hosts.map((host) => {
                    const selected = selectedIds.includes(host.id);
                    return (
                      <div key={host.id} className="flex min-h-10 items-center gap-3 px-3 py-2">
                        <Checkbox
                          checked={selected}
                          disabled={selected && selectedIds.length === 1}
                          aria-label={host.name}
                          onCheckedChange={(checked) =>
                            selectHosts(
                              checked === true
                                ? [...new Set([...selectedIds, host.id])]
                                : selectedIds.filter((id) => id !== host.id),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">{host.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {host.status === "connected" ? "Connected" : "Offline"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="px-3 py-4 text-sm text-muted-foreground">No hosts available.</p>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="flex min-h-5 justify-end" aria-live="polite">
        <span className={`text-xs ${error === null ? "text-muted-foreground" : "text-destructive"}`} role={error === null ? "status" : "alert"}>
          {error ?? (saving ? "Saving…" : "Saved")}
        </span>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "configuration", component: KeepAwakeSettings });
});
