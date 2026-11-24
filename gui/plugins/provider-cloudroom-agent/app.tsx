import { definePluginApp } from "@get-bb/plugin-sdk/app";

/** Cloudroom's own logo, in color: provider logo files are drawn as one-color masks. */
function CloudroomAgentIcon({ className }: { className?: string }) {
  return <img src="/icon-192.png?v=room" alt="" aria-hidden="true" className={className} style={{ objectFit: "contain", borderRadius: "22%" }} />;
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "cloudroom-agent", icon: CloudroomAgentIcon });
});
