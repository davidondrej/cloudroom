import { useMemo, useState } from "react";
import { definePluginApp, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { APPROVAL_RENDERER_ID, approvalPayloadSchema } from "./contract.js";

const n = (value: number) => Math.round(value).toLocaleString("en-US");
const article = (word: string) => (/^[AEFHILMNORSX]/i.test(word) ? "an" : "a");

// Every GPU session asks first and shows what it costs (ADR 0331). Never names the vendor (ADR 0332). The app shows it
// as a centered pop-up over a blurred background (isModalPluginInteraction). Inline styles: the app's Tailwind build
// doesn't scan plugins, so only its shared classes are safe here.
function ApprovalCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(() => approvalPayloadSchema.safeParse(interaction.payload), [interaction.payload]);
  const [busy, setBusy] = useState(false);
  if (!parsed.success)
    return (
      <Button variant="outline" onClick={() => void cancel().catch(() => undefined)}>
        Dismiss invalid request
      </Button>
    );
  const p = parsed.data;
  const name = p.name ?? p.gpu;
  const title = (p.count ?? 1) > 1 ? `Use ${p.count} ${name} GPUs?` : `Use ${article(name)} ${name} GPU?`;
  const share = p.credits_left && p.credits_left > 0 ? Math.min(1, p.max_credits / p.credits_left) : 1;
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await submit({ approve });
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void decide(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") void decide(false);
      }}
    >
      <p className="text-foreground" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3 }}>{title}</p>
      <p className="text-muted-foreground" style={{ fontSize: 15, lineHeight: 1.5, marginTop: 6 }}>{p.purpose}</p>
      <div style={{ marginTop: 24, height: 6, borderRadius: 999, overflow: "hidden", background: "color-mix(in oklab, var(--foreground) 10%, transparent)" }}>
        <div className="bg-primary" style={{ width: `${Math.max(share * 100, 2)}%`, height: "100%" }} />
      </div>
      <div className="text-muted-foreground" style={{ display: "flex", justifyContent: "space-between", gap: 16, marginTop: 10, fontSize: 14 }}>
        <span>
          Up to <b className="text-foreground">{n(p.max_credits)} credits</b> · {n(p.credits_per_hour)} an hour
        </span>
        {p.credits_left === null ? null : <span>{n(p.credits_left)} left</span>}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 28 }}>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </Button>
        <Button type="submit" disabled={busy} autoFocus>
          Approve
        </Button>
      </div>
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER_ID, component: ApprovalCard });
});
