import { useEffect, useMemo, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { APPROVAL_RENDERER_ID, approvalPayloadSchema } from "./contract.js";

// Rough cost, two significant digits: 698 → "~700", 20,522 → "~21,000".
const roughly = (value: number) => `~${Number(value.toPrecision(2)).toLocaleString("en-US")}`;
// Shorter, for phones: 20,522 → "~21K".
const compact = (value: number) => `~${new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 2 }).format(value)}`;
const LIME = "var(--primary)";
const PINS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const GRID = [1, 2, 3, 4, 5, 6, 7];
const TRACES = [40, 52, 64, 76, 88, 100, 112, 124];
const EDGE = [584, 602, 620, 638, 656];

// A GPU chip with circuit traces, drawn on the card's right side.
function ChipArt() {
  return (
    <svg viewBox="0 0 728 168" preserveAspectRatio="xMaxYMid slice" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden>
      <g stroke={LIME} strokeWidth={1.4} fill="none" opacity={0.45}>
        {TRACES.map((y, i) => {
          const bend = 548 - i * 9;
          const end = 84 + (y - 84) * 1.9;
          return <path key={`l${y}`} d={`M566 ${y} H${bend} L${bend - Math.abs(end - y)} ${end} H${300 + i * 22}`} />;
        })}
        {TRACES.map((y, i) => <path key={`r${y}`} d={`M674 ${y} H${700 + (i % 3) * 6} L728 ${y + (i - 3.5) * 6}`} />)}
        {EDGE.map((x, i) => <path key={`t${x}`} d={`M${x} 32 V${18 - (i % 2) * 6} L${x + (i - 2) * 10} 0`} />)}
        {EDGE.map((x, i) => <path key={`b${x}`} d={`M${x} 136 V${150 + (i % 2) * 6} L${x + (i - 2) * 10} 168`} />)}
      </g>
      <g fill={LIME}>
        {TRACES.map((y, i) => <circle key={y} cx={300 + i * 22} cy={84 + (y - 84) * 1.9} r={3} />)}
      </g>
      <rect x="566" y="32" width="108" height="104" rx="10" fill="#161616" stroke="rgba(255,255,255,0.18)" />
      {PINS.map((i) => <rect key={`pl${i}`} x={560} y={38 + i * 11} width={6} height={4} fill="#c9a24a" />)}
      {PINS.map((i) => <rect key={`pr${i}`} x={674} y={38 + i * 11} width={6} height={4} fill="#c9a24a" />)}
      <rect x="588" y="52" width="64" height="64" rx="4" fill="color-mix(in oklab, var(--primary) 18%, #0b0b0b)" stroke={LIME} strokeWidth={1.5} />
      <g stroke={LIME} strokeWidth={0.6} opacity={0.5}>
        {GRID.map((k) => <line key={`v${k}`} x1={588 + k * 8} y1={52} x2={588 + k * 8} y2={116} />)}
        {GRID.map((k) => <line key={`h${k}`} x1={588} y1={52 + k * 8} x2={652} y2={52 + k * 8} />)}
      </g>
    </svg>
  );
}

// Phones get two buttons instead of the card, which filled half their screen (David, 2026-11-13). Same breakpoint as
// the app's own phone layout (Tailwind's md).
const PHONE = "(max-width: 767px)";
function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(PHONE).matches));
  useEffect(() => {
    const query = window.matchMedia?.(PHONE);
    if (!query) return;
    const change = () => setPhone(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return phone;
}

// Every GPU session asks first and shows what it costs (ADR 0331). Never names the vendor (ADR 0332). The app shows it
// as a card at the end of the chat (isChatCardPluginInteraction): which GPU, what for, and roughly how many credits.
// Always dark, like hardware, in both themes. Inline styles: the app's Tailwind build doesn't scan plugins, so only
// its shared classes are safe here.
function ApprovalCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(() => approvalPayloadSchema.safeParse(interaction.payload), [interaction.payload]);
  const [busy, setBusy] = useState(false);
  const phone = usePhone();
  if (!parsed.success)
    return (
      <Button variant="outline" onClick={() => void cancel().catch(() => undefined)}>
        Dismiss invalid request
      </Button>
    );
  const p = parsed.data;
  const name = p.name ?? p.gpu;
  const gpu = (p.count ?? 1) > 1 ? `${p.count}× ${name}` : name;
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await submit({ approve });
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const escape = (event: { key: string }) => {
    if (event.key === "Escape") void decide(false);
  };
  if (phone)
    return (
      // inline-size containment: the app's slot is a fieldset, which would otherwise widen to fit the whole label.
      <div onKeyDown={escape} style={{ margin: "0 8px", display: "flex", gap: 8, contain: "inline-size" }}>
        <Button type="button" disabled={busy} onClick={() => void decide(true)} style={{ minWidth: 0, flexShrink: 1 }}>
          <Icon name="Cpu" aria-hidden style={{ width: 16, height: 16, flexShrink: 0 }} />
          {/* On narrow phones the GPU name shortens first; the cost always shows. */}
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Approve {gpu}</span>
          <span style={{ flexShrink: 0, marginLeft: -4 }}>· {compact(p.max_credits)} credits</span>
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void decide(false)} style={{ flexShrink: 0 }}>
          Deny
        </Button>
      </div>
    );
  return (
    <div
      onKeyDown={escape}
      style={{ position: "relative", overflow: "hidden", borderRadius: 16, border: "1px solid rgba(255,255,255,0.12)", background: "#0b0b0b", minHeight: 168 }}
    >
      <ChipArt />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, #0b0b0b 0%, #0b0b0b 38%, transparent 62%)" }} />
      <div style={{ position: "relative", padding: "22px 24px", maxWidth: "min(380px, 55%)", display: "flex", flexDirection: "column", gap: 6 }}>
        <p style={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.3, color: "#fafafa" }}>{gpu}</p>
        <p style={{ fontSize: 15, color: "rgba(250,250,250,0.6)" }}>{p.purpose}</p>
        <p style={{ fontSize: 17, fontWeight: 600, color: LIME, whiteSpace: "nowrap" }}>{roughly(p.max_credits)} credits</p>
        {p.note ? <p style={{ fontSize: 13, lineHeight: 1.5, color: "rgba(250,250,250,0.6)" }}>{p.note}</p> : null}
        <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
          <Button type="button" disabled={busy} onClick={() => void decide(true)}>
            Approve
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide(false)} style={{ color: "#fafafa" }}>
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER_ID, component: ApprovalCard });
});
