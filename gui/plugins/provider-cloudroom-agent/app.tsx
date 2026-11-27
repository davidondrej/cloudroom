import { definePluginApp } from "@get-bb/plugin-sdk/app";

/** Outline cloud with two eyes, one color like the other harness logos. */
function CloudroomAgentIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="2.2 2.4 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M7 18.6H17A4 4 0 1 0 16.596 10.62A4.6 4.6 0 1 0 7.443 11.428A3.6 3.6 0 1 0 7 18.6Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <circle cx="10.2" cy="13.9" r="1.05" />
      <circle cx="14" cy="13.9" r="1.05" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "cloudroom-agent", icon: CloudroomAgentIcon });
});
