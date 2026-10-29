import type { AppDeps } from "../../types.js";
import type { PluginService } from "../plugins/plugin-service.js";
import type { SandboxDirectory } from "./sandboxes.js";

const PLUGIN_ID = "organization";
const CHECK_MS = 60_000;

/** Organizations (ADR 0277): the built-in Organization plugin turns on by itself for organization members and off when
 *  they leave or sign out, so nobody visits Settings → Plugins. Checks every minute; orgMember() asks the website only
 *  after a sign-in, then every 15 minutes for members and every hour for others. Offline changes nothing. */
export function startOrgPlugin(deps: Pick<AppDeps, "logger"> & { sandboxes: Pick<SandboxDirectory, "orgMember">; plugins: Pick<PluginService, "list" | "setEnabled"> }) {
  const check = async () => {
    const member = await deps.sandboxes.orgMember();
    const plugin = deps.plugins.list().find((item) => item.id === PLUGIN_ID);
    if (member === null || !plugin || plugin.enabled === member) return;
    await deps.plugins.setEnabled(PLUGIN_ID, member);
    deps.logger.info({ member }, member ? "Organization plugin turned on: this account is in an organization" : "Organization plugin turned off: this account left its organization");
  };
  const run = () => void check().catch((error: unknown) => deps.logger.warn({ err: error }, "Organization plugin check failed"));
  run();
  const timer = setInterval(run, CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
