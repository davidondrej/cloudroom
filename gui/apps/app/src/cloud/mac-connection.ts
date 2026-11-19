import { getRoomDesktopInfo } from "@/lib/room-desktop";
import { wsManager } from "@/lib/ws";

export const viewingOtherMac = () =>
  getRoomDesktopInfo() !== null && window.location.hostname.endsWith(".cloudroom.run");

export class OtherMacUnavailableError extends Error {
  constructor() { super("Connection to the other Mac was lost."); }
}

export const relayConnectionError = (response: Response) =>
  (response.status === 503 && response.headers.get("x-bb-tunnel-offline") === "1") ||
  (response.status >= 502 && response.status <= 504 && response.headers.get("x-cloudroom-tunnel-error") === "1");

let relayOffline = false;
let lostAt: number | null = null;
const listeners = new Set<() => void>();

export function observeMacResponse(response: Response): void {
  const offline = relayConnectionError(response);
  if (offline || response.ok) setMacUnreachable(offline);
}

export function setMacUnreachable(offline: boolean): void {
  if (offline === relayOffline) return;
  relayOffline = offline;
  for (const listener of listeners) listener();
}

export function otherMacLostAt(): number | null {
  if (!viewingOtherMac()) return null;
  if (!relayOffline && wsManager.getConnectionState() === "connected") lostAt = null;
  else lostAt ??= Date.now();
  return lostAt;
}

export function onMacConnectionChange(listener: () => void): () => void {
  if (!viewingOtherMac()) return () => {};
  listeners.add(listener);
  const unsubscribe = wsManager.onConnectionStateChange(() => {
    if (wsManager.getConnectionState() === "connected") relayOffline = false;
    listener();
  });
  return () => { listeners.delete(listener); unsubscribe(); };
}
