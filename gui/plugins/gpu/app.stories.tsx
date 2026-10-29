import { useEffect } from "react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { collectPluginAppRegistrations } from "@/lib/plugin-app-definition";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { removePluginSlotRegistrations, setPluginSlotRegistrations } from "@/lib/plugin-slots";
import { PluginPendingInteractionComposer } from "@/components/plugin/PluginPendingInteractionComposer";

installTestPluginRuntime();
const { default: gpuApp } = await import("./app");

export default { title: "plugins/GPU approval" };

export function Approval() {
  useEffect(() => {
    setPluginSlotRegistrations("gpu", makePluginRegistrationSet({ pendingInteractions: collectPluginAppRegistrations(gpuApp).pendingInteractions }));
    return () => removePluginSlotRegistrations("gpu");
  }, []);
  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-3xl flex-col justify-end p-4">
      <PluginPendingInteractionComposer
        interaction={{ id: "gpu-demo", threadId: "thread-demo", createdAt: 1 }}
        dismissal="cancel"
        request={{
          pluginId: "gpu",
          rendererId: "gpu-approval",
          title: "Use a GPU?",
          data: {
            gpu: "1x H100 80 GB", name: "H100", count: 1, cpu: 8, memory: 48, disk: 100, hours: 2,
            purpose: "Fine-tune the support-ticket classifier on data/tickets.csv. About 40 minutes.",
            credits_per_hour: 10_261, max_credits: 20_522, credits_left: 131_400,
          },
        }}
      />
    </div>
  );
}
