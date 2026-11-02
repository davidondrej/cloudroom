import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  type pushNotificationsRpcContract,
} from "./contract.js";
import {
  clientChannel,
  createClientDelivery,
  notificationPermission,
} from "./client.js";

const BUTTON_CLASS =
  "rounded-md border border-border px-3 py-2 disabled:opacity-50";

const PERMISSION_STATUS = {
  unsupported:
    "System notifications are unavailable here. Use a supported browser over HTTPS or localhost.",
  denied:
    "Notifications are blocked. Allow them in your browser or system notification settings, then return here.",
  granted:
    "Notifications allowed. Your system notification settings also apply.",
  default: "Allow notifications on this device to receive thread updates.",
} as const;

function useChannelEnabled(): boolean {
  const { values } = useSettings();
  return values?.[`${clientChannel()}Enabled`] === true;
}

function NotificationDelivery() {
  const navigate = useBbNavigate();
  const enabled = useChannelEnabled();
  const delivery = useRef<ReturnType<typeof createClientDelivery> | null>(null);
  useEffect(() => {
    const next = createClientDelivery((id) => navigate.toThread(id));
    delivery.current = next;
    return () => {
      delivery.current = null;
      next.dispose();
    };
  }, [navigate]);
  useRealtime(CLIENT_NOTIFICATION_CHANNEL, (payload) => {
    void delivery.current?.deliver(payload, enabled).catch(() => undefined);
  });
  return null;
}

function NotificationSettings() {
  const rpc = useRpc<typeof pushNotificationsRpcContract>();
  const enabled = useChannelEnabled();
  const channel = clientChannel();
  const [permission, setPermission] = useState(notificationPermission);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setPermission(notificationPermission());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const allow = () =>
    run(async () => {
      setPermission(await Notification.requestPermission());
      return null;
    });
  const sendTest = () =>
    run(async () => {
      await rpc.call("notifications.test", { channel });
      return `Test sent to connected ${channel} clients with notification permission.`;
    });

  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">
        {channel === "desktop" ? "This desktop app" : "This browser"}
      </h3>
      <p className="text-muted-foreground" role="status">
        {PERMISSION_STATUS[permission]}
      </p>
      {permission === "default" ? (
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={busy || !enabled}
          onClick={() => void allow()}
        >
          Allow notifications
        </button>
      ) : null}
      {permission === "granted" ? (
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={busy || !enabled}
          onClick={() => void sendTest()}
        >
          Send test notification
        </button>
      ) : null}
      {!enabled ? (
        <p className="text-muted-foreground">
          Enable {channel} notifications above to receive updates.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Channel settings apply to this Cloudroom server. Each browser needs
        permission. Click a notification to open its thread.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "delivery",
    component: NotificationDelivery,
  });
  app.slots.settingsSection({ id: "device", component: NotificationSettings });
});
