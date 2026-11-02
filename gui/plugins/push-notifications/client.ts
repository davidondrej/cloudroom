import {
  clientNotificationSchema,
  type ClientChannel,
  type ClientNotification,
} from "./contract.js";

const SEEN_LIMIT = 100;

export function clientChannel(): ClientChannel {
  return "bbDesktop" in window ? "desktop" : "web";
}

export function notificationPermission():
  | NotificationPermission
  | "unsupported" {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}

function isMacDesktop(): boolean {
  const desktop: unknown = (window as { bbDesktop?: unknown }).bbDesktop;
  return (
    typeof desktop === "object" &&
    desktop !== null &&
    "platform" in desktop &&
    desktop.platform === "macos"
  );
}

function readSeenIds(key: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function markSeen(key: string, ids: readonly string[], id: string): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify([...ids.slice(-(SEEN_LIMIT - 1)), id]),
    );
  } catch {
    return;
  }
}

export function createClientDelivery(navigate: (threadId: string) => void) {
  const active = new Set<Notification>();
  let disposed = false;

  function display(message: ClientNotification): void {
    const notification = new Notification(message.title, {
      body: message.body,
      ...(isMacDesktop()
        ? {}
        : {
            icon: new URL("/icon-192.png?v=room", window.location.origin).href,
          }),
      tag: `bb-${message.threadId ?? message.id}`,
    });
    active.add(notification);
    notification.onclose = () => active.delete(notification);
    notification.onclick = () => {
      if (disposed) return;
      window.focus();
      if (message.threadId !== null) navigate(message.threadId);
      notification.close();
      active.delete(notification);
    };
  }

  async function deliver(payload: unknown, enabled: boolean): Promise<void> {
    const parsed = clientNotificationSchema.safeParse(payload);
    const channel = clientChannel();
    if (
      !enabled ||
      disposed ||
      !parsed.success ||
      !parsed.data.channels.includes(channel) ||
      notificationPermission() !== "granted"
    ) {
      return;
    }
    const message = parsed.data;
    const showOnce = () => {
      if (disposed || notificationPermission() !== "granted") return;
      const key = `bb.push-notifications.seen.${channel}`;
      const seen = readSeenIds(key);
      if (seen.includes(message.id)) return;
      display(message);
      markSeen(key, seen, message.id);
    };
    if (navigator.locks) {
      await navigator.locks.request(`bb-notifications-${channel}`, showOnce);
    } else {
      showOnce();
    }
  }

  return {
    deliver,
    dispose() {
      disposed = true;
      for (const notification of active) notification.close();
      active.clear();
    },
  };
}
