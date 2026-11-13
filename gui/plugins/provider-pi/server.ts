import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

export default function plugin(room: BbPluginApi): void {
  const registered = room.providers.register(piProviderDeclaration());
  // The provider skill is only useful in this provider's own threads.
  room.agents.configure(({ provider }) => ({ tools: [], skills: provider.id === "pi" ? ["pi-provider"] : [] }));
  room.onDispose(() => {
    registered.dispose();
  });
}
