import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  clientChannelSchema,
  pushNotificationsRpcContract,
  type ClientChannel,
  type ClientNotification,
} from "./contract.js";
import {
  describeInteraction,
  firstLine,
  resolveNotification,
  type Kind,
  type PendingEvents,
} from "./rules.js";

const DEFAULT_COALESCE_MS = 2_000;
const USAGE =
  "Usage: room-cli push-notifications <status [--json]|test <web|desktop>>";

interface PluginOptions {
  coalesceMs?: number;
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPushNotificationsPlugin(options: PluginOptions = {}) {
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const now = options.now ?? Date.now;

  return async function pushNotificationsPlugin(
    bb: BbPluginApi,
  ): Promise<void> {
    const settings = bb.settings.define({
      webEnabled: {
        type: "boolean",
        label: "Web notifications",
        description:
          "Show system notifications while Cloudroom is open in a browser. Each browser needs notification permission.",
        default: true,
      },
      desktopEnabled: {
        type: "boolean",
        label: "Desktop notifications",
        description:
          "Show system notifications while the Cloudroom desktop app is running.",
        default: true,
      },
    });
    const pending = new Map<
      string,
      PendingEvents & { timer: ReturnType<typeof setTimeout> }
    >();
    let running = false;

    async function enabledChannels(): Promise<ClientChannel[]> {
      const { webEnabled, desktopEnabled } = await settings.get();
      return clientChannelSchema.options.filter((channel) =>
        channel === "web" ? webEnabled : desktopEnabled,
      );
    }

    function publish(message: Omit<ClientNotification, "id">): void {
      bb.realtime.publish(CLIENT_NOTIFICATION_CHANNEL, {
        id: randomUUID(),
        ...message,
      } satisfies ClientNotification);
    }

    async function flush(threadId: string, events: PendingEvents) {
      const channels = await enabledChannels();
      if (channels.length === 0) return;
      const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
      if (thread === null) return;
      const openInteraction =
        events.bodies.question === undefined
          ? null
          : ((await bb.sdk.threads.interactions.list({ threadId })).find(
              (interaction) => interaction.status === "pending",
            ) ?? null);
      const notification = resolveNotification(thread, events, openInteraction);
      if (notification !== null && running) {
        publish({ ...notification, threadId, channels });
      }
    }

    function queue(threadId: string, kind: Kind, body: string): void {
      if (!running) return;
      const existing = pending.get(threadId);
      if (existing) {
        existing.bodies[kind] = body;
        existing.eventAt = Math.max(existing.eventAt, now());
        return;
      }
      const timer = setTimeout(() => {
        const events = pending.get(threadId);
        pending.delete(threadId);
        if (events === undefined || !running) return;
        flush(threadId, events).catch((error: unknown) => {
          bb.log.error(
            `Notification failed for thread ${threadId}: ${errorMessage(error)}`,
          );
        });
      }, coalesceMs);
      timer.unref?.();
      pending.set(threadId, {
        bodies: { [kind]: body },
        eventAt: now(),
        timer,
      });
    }

    async function sendTest(channel: ClientChannel) {
      if (!(await enabledChannels()).includes(channel)) {
        throw new Error(`${channel} notifications are disabled`);
      }
      publish({
        title: "Cloudroom notifications are working",
        body: "You’ll be notified when a thread needs your attention.",
        threadId: null,
        channels: [channel],
      });
      return { ok: true as const };
    }

    bb.rpc.register(pushNotificationsRpcContract, {
      "notifications.test": ({ channel }) => sendTest(channel),
    });

    bb.cli.register({
      name: "push-notifications",
      summary: "Web and desktop notifications",
      commands: [
        {
          name: "status",
          summary: "Show which notification channels are on",
          usage: "room-cli push-notifications status [--json]",
        },
        {
          name: "test",
          summary:
            "Send a test to connected web or desktop clients with permission",
          usage: "room-cli push-notifications test <web|desktop>",
        },
      ],
      async run([command, ...args]) {
        if (command === "test" && args.length === 1) {
          const channel = clientChannelSchema.safeParse(args[0]);
          if (!channel.success) {
            return { exitCode: 1, stderr: "Use web or desktop" };
          }
          try {
            await sendTest(channel.data);
          } catch (error) {
            return { exitCode: 1, stderr: errorMessage(error) };
          }
          return {
            exitCode: 0,
            stdout: `Test sent to connected ${channel.data} clients with notification permission`,
          };
        }
        const json = args.length === 1 && args[0] === "--json";
        if (command === "status" && (args.length === 0 || json)) {
          const { webEnabled, desktopEnabled } = await settings.get();
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({ webEnabled, desktopEnabled })
              : `Web: ${webEnabled}\nDesktop: ${desktopEnabled}`,
          };
        }
        return { exitCode: 1, stderr: USAGE };
      },
    });

    bb.events.on("interaction.pending", ({ thread, interaction }) => {
      queue(thread.id, "question", describeInteraction(interaction));
    });
    bb.events.on("thread.failed", ({ thread, error }) => {
      queue(thread.id, "error", firstLine(error) || "The thread hit an error");
    });
    bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
      if (thread.parentThreadId !== null || thread.visibility !== "visible") {
        return;
      }
      queue(
        thread.id,
        "finished",
        firstLine(lastAssistantText) || "Finished and waiting for you",
      );
    });

    bb.background.service("notifier", {
      async start(signal) {
        running = true;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        running = false;
        for (const { timer } of pending.values()) clearTimeout(timer);
        pending.clear();
      },
    });
  };
}

export default createPushNotificationsPlugin();
