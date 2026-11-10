import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

export default function plugin(bb: BbPluginApi): void {
  const registered = bb.providers.register(piProviderDeclaration());
  // The provider skill is only useful in this provider's own threads.
  bb.agents.configure(({ provider }) => ({ tools: [], skills: provider.id === "pi" ? ["pi-provider"] : [] }));
  bb.onDispose(() => {
    registered.dispose();
  });
}
