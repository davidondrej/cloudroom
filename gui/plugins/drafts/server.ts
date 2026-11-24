import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function draftsPlugin(room: BbPluginApi): void {
  room.experimental_hooks.on("message.dispatch", (context) => {
    const isNewDraft =
      context.experimental_submission?.pluginId === room.pluginId &&
      context.experimental_submission.data !== null &&
      typeof context.experimental_submission.data === "object" &&
      !Array.isArray(context.experimental_submission.data) &&
      context.experimental_submission.data.kind === "draft";
    const isQueuedDraft =
      context.queuedMessage?.waitingOn?.kind === "plugin" &&
      context.queuedMessage.waitingOn.pluginId === room.pluginId;
    return isNewDraft || isQueuedDraft
      ? { action: "wait", reason: "Draft" }
      : { action: "proceed" };
  });
}
