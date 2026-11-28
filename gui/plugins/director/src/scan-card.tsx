import { useMemo, useState } from "react";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Glyph, message, useDirector } from "./parts.js";
import { MAX_SCAN_CREDIT, type ScanItem } from "./scan.js";

const DEFAULT_TINT = "#a78bfa";

function groupItems(items: readonly ScanItem[]): { label: string; items: ScanItem[] }[] {
  const general = items.filter((item) => item.scope === "general");
  const byProject = new Map<string, ScanItem[]>();
  for (const item of items) {
    if (item.scope !== "project" || !item.target) continue;
    const list = byProject.get(item.target) ?? [];
    list.push(item);
    byProject.set(item.target, list);
  }
  const groups: { label: string; items: ScanItem[] }[] = [];
  if (general.length > 0) groups.push({ label: "Always", items: general });
  for (const label of [...byProject.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({ label, items: byProject.get(label)! });
  }
  return groups;
}

/**
 * Inline scan checklist card (Design 3B, David 2026-11-28): stacked left-lit purple rows
 * grouped by Always / project, with bold lesson on top and the Director's observation below.
 */
export function DirectorScanCard({ attributes }: PluginMessageDirectiveProps) {
  const { rpc, view, setView } = useDirector();
  const scanId = attributes.id?.trim() ?? "";
  const scan = view && scanId ? view.scans[scanId] ?? null : null;

  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => (scan ? groupItems(scan.items) : []), [scan]);

  if (view === null) {
    return (
      <div
        data-room-plugin="director"
        className="my-3 rounded-2xl border border-border/50 bg-composer/75 px-4 py-3 text-xs text-muted-foreground"
      >
        Loading scanned learnings…
      </div>
    );
  }

  if (scan === null) {
    return (
      <div
        data-room-plugin="director"
        className="my-3 rounded-2xl border border-border/50 bg-composer/75 px-4 py-3 text-xs text-muted-foreground"
      >
        This scan is no longer available. Run a new scan in Director settings.
      </div>
    );
  }

  const tint = view.config.color || DEFAULT_TINT;
  const ink = `color-mix(in oklab, ${tint} 72%, var(--foreground))`;
  const wash = (pct: number) => `color-mix(in oklab, ${tint} ${pct}%, transparent)`;

  const saved = scan.savedAt !== null;
  const keptSet = saved ? new Set(scan.keptIds) : null;
  const isKept = (id: string) => (keptSet ? keptSet.has(id) : !dropped.has(id));
  const keptIds = scan.items.filter((item) => isKept(item.id)).map((item) => item.id);
  const keptCount = keptIds.length;

  const toggle = (id: string) => {
    if (saved || saving) return;
    setError(null);
    setDropped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSave = () => {
    if (saved || saving || keptCount === 0) return;
    setSaving(true);
    setError(null);
    rpc
      .call("saveScan", { id: scan.id, keptIds })
      .then(setView, (cause: unknown) => setError(message(cause)))
      .finally(() => setSaving(false));
  };

  const learned = view.learned;
  const goal = scan.savedMeter?.goal ?? learned?.goal ?? 50;
  const currentReviewed = learned?.reviewed ?? 0;
  const scanCredit = Math.min(keptCount, Math.max(0, MAX_SCAN_CREDIT - currentReviewed));
  const projected = Math.min(goal, currentReviewed + scanCredit);

  return (
    <div
      data-room-plugin="director"
      className="my-3 space-y-3 rounded-2xl border border-border/50 bg-composer/75 p-4"
    >
      {groups.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
            {group.label}
          </div>
          <div className="space-y-1.5">
            {group.items.map((item) => {
              const on = isKept(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={saved || saving}
                  aria-pressed={on}
                  onClick={() => toggle(item.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-2 text-left transition-colors ${saved ? "cursor-default" : "cursor-pointer"}`}
                  style={
                    on
                      ? {
                          background: `linear-gradient(90deg, ${wash(15)} 0%, ${wash(6)} 60%, transparent 100%)`,
                          borderColor: wash(30),
                        }
                      : {
                          background: "transparent",
                          borderColor: "var(--border)",
                          opacity: 0.52,
                        }
                  }
                >
                  <span
                    className="flex size-4.5 shrink-0 items-center justify-center rounded-full transition-colors"
                    style={
                      on
                        ? { background: tint, color: "#141414" }
                        : { background: "var(--state-hover)", color: "var(--muted-foreground)" }
                    }
                  >
                    <Icon name={on ? "Check" : "X"} className="size-3 stroke-[2.75]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[13px] font-medium leading-tight ${
                        on ? "text-foreground" : "text-muted-foreground line-through"
                      }`}
                    >
                      {item.lesson}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                      {item.observation}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-3">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span style={{ color: ink }}>
            <Glyph icon={view.config.icon} size={14} />
          </span>
          {saved ? (
            <span>
              Saved <strong className="font-medium text-foreground">{keptCount}</strong> learning{keptCount === 1 ? "" : "s"}
              {scan.savedMeter ? (
                <>
                  {" "}· Director is at{" "}
                  <strong className="font-medium text-foreground tabular-nums">
                    {Math.min(scan.savedMeter.reviewed, scan.savedMeter.goal)} / {scan.savedMeter.goal}
                  </strong>
                </>
              ) : null}
            </span>
          ) : (
            <span>
              Click any row to toggle
              {learned !== null ? (
                <>
                  {" "}·{" "}
                  <strong className="font-medium text-foreground tabular-nums">
                    {projected} / {goal}
                  </strong>{" "}
                  on save
                </>
              ) : (
                " · Sign in to save learnings"
              )}
            </span>
          )}
        </span>

        {saved ? (
          <span
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium"
            style={{ background: wash(16), color: ink }}
          >
            <Icon name="Check" className="size-3.5 stroke-[2.5]" />
            Saved
          </span>
        ) : (
          <button
            type="button"
            disabled={saving || keptCount === 0}
            onClick={onSave}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-4 text-[12.5px] font-semibold transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-45"
            style={{ background: tint, color: "#141414" }}
          >
            {saving ? "Saving…" : `Save ${keptCount} learning${keptCount === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    </div>
  );
}
