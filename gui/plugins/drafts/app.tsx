import { toast } from "sonner";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "drafts",
    scopes: ["thread", "new-thread"],
    plusMenu: [
      {
        id: "drafts",
        label: "Save draft…",
        icon: "EditFile",
        description:
          "Keep this message in the queue until you send it manually.",
        disabled: (composer) => composer.isEmpty || composer.isSubmitting,
        run: async ({ composer }) => {
          try {
            await composer.submit({
              experimental_data: { kind: "draft" },
            });
            toast.success("Draft saved");
          } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
          if (composer.isEmpty) {
            toast.error("Nothing to save", {
              description: "Type a message first, then save it as a draft.",
            });
          }
        },
      },
    ],
  });
});
