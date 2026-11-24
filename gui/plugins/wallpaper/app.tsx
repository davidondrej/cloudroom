import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { Slider } from "@cloudroom/shared-ui/slider";
import { Switch } from "@cloudroom/shared-ui/switch";
import { dither, prepare } from "./image.js";
import { CHANGED, MIMES, SLOTS, imageUrl, type Look, type WallpaperState } from "./model.js";
import type { rpcContract } from "./server.js";

/**
 * The saved wallpapers. The server pushes the new state to every window on
 * each change, so this only asks for it on load and after a reconnect.
 */
function useWallpaper() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<WallpaperState | null>(null);
  /** The newest look change still being saved, if any. */
  const saving = useRef<object | null>(null);
  const online = useRealtimeConnectionState() === "connected";
  const refresh = useCallback(() => void rpc.call("get", null).then(setState, () => {}), [rpc]);
  useEffect(refresh, [refresh, online]);
  // Server news waits for a look change in flight: an older state would pull a dragged slider back.
  useRealtime(CHANGED, (next) => {
    if (!saving.current) setState(next as WallpaperState);
  });
  /** Shows a look change right away, then saves it. Only the newest save's answer is applied. */
  function setLook(slot: number, change: Partial<Look>, fail: (cause: unknown) => void) {
    const mine = (saving.current = {});
    const settle = (apply: () => void) => {
      if (saving.current !== mine) return;
      saving.current = null;
      apply();
    };
    setState((now) => now && { ...now, slots: now.slots.map((wallpaper) => (wallpaper.slot === slot ? { ...wallpaper, look: { ...wallpaper.look, ...change } } : wallpaper)) });
    rpc.call("look", { slot, look: change }).then(
      (next) => settle(() => setState(next)),
      (cause: unknown) => {
        settle(refresh);
        fail(cause);
      },
    );
  }
  return { rpc, state, setState, setLook };
}

/**
 * The whole wallpaper is one stylesheet. The app marks where it goes:
 * `data-wallpaper` on the New thread and chat panels, `data-wallpaper-column`
 * on the reading column (kept solid so text stays readable; its 1px shadow
 * covers the scroll anchor between the messages and the composer), and
 * `data-wallpaper-clear` on solid bands that should let it through: the one
 * behind the chat composer, and the phone's sticky "Recent" heading (blurred,
 * so the list stays readable as it scrolls under).
 */
function css(url: string, look: Look, pixelated: boolean): string {
  return `
[data-wallpaper]{position:relative;isolation:isolate}
[data-wallpaper]::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none;background:url("${url}") center/${look.fit} no-repeat;opacity:${look.opacity};${pixelated ? "image-rendering:pixelated;" : ""}}
${look.half ? `[data-wallpaper="new-thread"]::before{-webkit-mask-image:linear-gradient(#000 25%,transparent 55%);mask-image:linear-gradient(#000 25%,transparent 55%)}` : ""}
[data-wallpaper="thread"] [data-wallpaper-column]{background-color:var(--background);box-shadow:0 1px var(--background)}
[data-wallpaper] [data-wallpaper-clear]{background-color:transparent}
[data-wallpaper] [data-wallpaper-clear]>[data-overflow-fade]{display:none}
[data-wallpaper="new-thread"] [data-wallpaper-clear]{-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}`;
}

/** Mounted once per window. Draws the active wallpaper. */
function Painter() {
  const { state } = useWallpaper();
  const active = state?.slots.find((wallpaper) => wallpaper.slot === state.active);
  const url = active ? imageUrl(active.version) : null;
  const wantsDither = Boolean(active?.look.dither && !active.animated);
  const [dithered, setDithered] = useState<string | null>(null);
  useEffect(() => {
    if (!url || !wantsDither) return;
    let live = true;
    let made: string | null = null;
    dither(url).then((result) => {
      made = result;
      if (live) setDithered(result);
      else URL.revokeObjectURL(result);
    }, () => {});
    return () => {
      live = false;
      setDithered(null);
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, wantsDither]);
  if (!active || !url) return null;
  return <style>{css(dithered ?? url, active.look, dithered !== null)}</style>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

const TILE = "size-16 shrink-0 cursor-pointer overflow-hidden rounded-md border text-xs text-muted-foreground";

function Settings() {
  const wallpaper = useWallpaper();
  const { rpc, state, setState } = wallpaper;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const target = useRef(1);
  if (!state) return null;

  const active = state.slots.find((wallpaper) => wallpaper.slot === state.active);
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  function save(change: Promise<WallpaperState>) {
    setError(null);
    setBusy(true);
    change.then(setState, fail).finally(() => setBusy(false));
  }
  function pick(slot: number) {
    target.current = slot;
    picker.current?.click();
  }
  /** Runs on every slider step, so it never locks the controls. */
  function setLook(change: Partial<Look>) {
    if (active) wallpaper.setLook(active.slot, change, fail);
  }

  return (
    <div className="space-y-4">
      <input
        ref={picker}
        type="file"
        accept={MIMES.join(",")}
        aria-label="Wallpaper image"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) save(prepare(file).then((image) => rpc.call("upload", { slot: target.current, ...image })));
        }}
      />
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Wallpaper">
        <button
          type="button"
          role="radio"
          aria-checked={!active}
          disabled={busy}
          className={`${TILE} ${active ? "border-border" : "border-primary ring-1 ring-primary"}`}
          onClick={() => save(rpc.call("use", { slot: null }))}
        >
          None
        </button>
        {SLOTS.map((slot) => {
          const saved = state.slots.find((wallpaper) => wallpaper.slot === slot);
          const selected = saved !== undefined && saved === active;
          return (
            <button
              key={slot}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={saved ? `Wallpaper ${slot}` : `Add wallpaper ${slot}`}
              disabled={busy}
              className={`${TILE} ${selected ? "border-primary ring-1 ring-primary" : "border-border"} ${saved ? "" : "border-dashed text-lg"}`}
              onClick={() => (saved ? save(rpc.call("use", { slot })) : pick(slot))}
            >
              {saved ? <img src={imageUrl(saved.version)} alt="" className="size-full object-cover" /> : "+"}
            </button>
          );
        })}
      </div>
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      {active ? (
        <>
          <div data-wallpaper="new-thread" aria-hidden className="h-36 rounded-md border border-border bg-background" />
          <Row label="Visibility">
            <Slider
              className="w-40"
              aria-label="Visibility"
              value={[active.look.opacity]}
              min={0.05}
              max={1}
              step={0.05}
              onValueChange={([opacity]) => setLook({ opacity })}
            />
          </Row>
          <Row label="Fill the whole panel" hint="Off shows the whole image, with empty space around it.">
            <Switch checked={active.look.fit === "cover"} aria-label="Fill the whole panel" onCheckedChange={(fill) => setLook({ fit: fill ? "cover" : "contain" })} />
          </Row>
          <Row label="Half wallpaper on New thread" hint="The wallpaper fades out halfway down. Chats always show it beside the messages.">
            <Switch checked={active.look.half} aria-label="Half wallpaper on New thread" onCheckedChange={(half) => setLook({ half })} />
          </Row>
          <Row label="Pixel effect" hint={active.animated ? "Not available for GIFs." : "Redraws the image as chunky pixels."}>
            <Switch checked={active.look.dither && !active.animated} disabled={active.animated} aria-label="Pixel effect" onCheckedChange={(dither) => setLook({ dither })} />
          </Row>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => pick(active.slot)}>Replace image</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => save(rpc.call("clear", { slot: active.slot }))}>Remove</Button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Pick a slot to add a JPG, PNG, WebP, or GIF. It stays on this computer.</p>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "painter", component: Painter });
  app.slots.settingsSection({ id: "wallpaper", title: "Wallpaper", component: Settings });
});
