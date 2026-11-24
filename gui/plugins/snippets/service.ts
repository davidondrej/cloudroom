import {
  applyCommand,
  findSnippet,
  parseCommand,
  readLibrary,
  visibleLibrary,
  type Library,
} from "./library.ts";
import type { ExpansionMode } from "./template.ts";

export interface View {
  owner: string;
  personal: Library;
  team: Library;
  organization: string | null;
  sync: boolean;
  mode: ExpansionMode;
  withinWords: boolean;
  clipboardHistory: boolean;
  problem: string;
}
export interface Device {
  pendingSync?: boolean;
  personal: Library;
  base: Library;
  sync: boolean;
  mode: ExpansionMode;
  withinWords: boolean;
  clipboardHistory: boolean;
}
export const emptyDevice = (): Device => ({
  personal: [],
  base: [],
  sync: false,
  mode: "immediate",
  withinWords: false,
  clipboardHistory: false,
});
const modes = ["immediate", "keep", "discard", "off"] as const;

export function snippetService(
  load: (owner: string) => Device,
  save: (owner: string, device: Device) => void,
  remoteCall: (
    body: { action: string } & Record<string, unknown>,
  ) => Promise<unknown>,
  changed: (team: boolean, origin?: string) => void,
) {
  const identity = async () =>
    String((await remoteCall({ action: "identity" })) ?? "device");
  let pending: Promise<unknown> = Promise.resolve();
  function serial<T>(job: () => Promise<T>) {
    const result = pending.then(job);
    pending = result.catch(() => {});
    return result;
  }
  async function exchange(owner: string, d: Device, enable = false) {
    const clean = JSON.stringify(d.base) === JSON.stringify(d.personal);
    let incoming: unknown;
    if (clean && !enable) {
      const reply = await remoteCall({
        action: "pull",
        withStatus: true,
        account: owner,
      });
      // Older servers cannot distinguish a missing object from an empty library.
      if (Array.isArray(reply)) {
        if (!reply.length && d.personal.length)
          throw new Error("Cloud library status unavailable.");
        incoming = reply;
      } else if (
        reply &&
        typeof reply === "object" &&
        "exists" in reply &&
        "items" in reply &&
        typeof reply.exists === "boolean"
      ) {
        if (reply.exists) incoming = reply.items;
      } else throw new Error("Invalid cloud library status.");
    }
    if (incoming === undefined)
      incoming = await remoteCall({
        action: "exchange",
        base: enable || clean ? [] : d.base,
        local: d.personal,
        account: owner,
      });
    const remote = readLibrary(incoming);
    if (
      JSON.stringify(remote) !== JSON.stringify(d.base) ||
      !clean ||
      d.pendingSync
    ) {
      delete d.pendingSync;
      d.base = remote;
      d.personal = remote;
      save(owner, d);
    }
  }
  async function view(refresh: boolean): Promise<View> {
    const owner = await identity(),
      device = load(owner);
    let team: Library = [],
      organization: string | null = null,
      problem = device.pendingSync ? "Saved locally · sync pending." : "";
    if (refresh && owner !== "device") {
      const [personal, org] = await Promise.allSettled([
        device.sync ? exchange(owner, device) : Promise.resolve(),
        remoteCall({ action: "team", account: owner }) as Promise<{
          org: string | null;
          items: Library;
        }>,
      ]);
      problem =
        personal.status === "rejected"
          ? device.pendingSync
            ? "Saved locally · sync pending."
            : "Personal sync is unavailable. Local edits are saved."
          : "";
      if (org.status === "fulfilled") {
        team = readLibrary(org.value.items);
        organization = org.value.org;
      } else problem ||= "Organization snippets are unavailable.";
    }
    const { personal, sync, mode, withinWords } = device;
    return {
      owner,
      personal,
      team,
      organization,
      sync,
      mode,
      withinWords,
      clipboardHistory: device.clipboardHistory ?? false,
      problem,
    };
  }
  async function run(
    argv: string[],
    expected?: { owner: string; organization: string | null; origin?: string },
  ) {
    const owner = await identity(),
      d = load(owner),
      cmd = parseCommand(argv);
    if (expected && expected.owner !== owner)
      throw new Error("The account changed. Reopen Snippets.");
    if (cmd.action === "settings") {
      const {
        mode,
        "within-words": withinWords,
        "remember-clipboard": clipboardHistory,
      } = cmd.options;
      if (mode !== undefined && !modes.includes(mode as ExpansionMode))
        throw new Error("Choose immediate, keep, discard, or off.");
      for (const [flag, value] of Object.entries({
        "within-words": withinWords,
        "remember-clipboard": clipboardHistory,
      })) {
        if (value !== undefined && value !== "true" && value !== "false")
          throw new Error("Use true or false for --" + flag + ".");
      }
      if (
        mode !== undefined ||
        withinWords !== undefined ||
        clipboardHistory !== undefined
      ) {
        if (mode !== undefined) d.mode = mode as ExpansionMode;
        if (withinWords !== undefined) d.withinWords = withinWords === "true";
        if (clipboardHistory !== undefined)
          d.clipboardHistory = clipboardHistory === "true";
        save(owner, d);
        changed(false, expected?.origin);
      }
      return {
        mode: d.mode,
        withinWords: d.withinWords,
        clipboardHistory: d.clipboardHistory ?? false,
      };
    }
    if (cmd.action === "sync") {
      if (cmd.target === "status")
        return { enabled: d.sync, pending: !!d.pendingSync };
      if (!["on", "off"].includes(cmd.target))
        throw new Error("Use sync on, off, or status.");
      if (cmd.target === "on") {
        if (owner === "device")
          throw new Error("Sign in to enable snippet sync.");
        await exchange(owner, d, !d.sync);
      }
      d.sync = cmd.target === "on";
      if (!d.sync) {
        d.base = [];
        delete d.pendingSync;
      }
      save(owner, d);
      changed(false, expected?.origin);
      return { enabled: d.sync };
    }
    // Resolve references against the same library shown in the picker, including device-only snippets.
    if (cmd.action === "render") {
      const data = await view(true);
      if (data.owner !== owner)
        throw new Error("The signed-in account changed.");
      const source = cmd.scope === "organization" ? data.team : data.personal;
      return (
        await applyCommand(
          source,
          cmd,
          visibleLibrary(data.personal, data.team),
        )
      ).result;
    }
    if (cmd.action === "share" || cmd.scope === "organization") {
      if (owner === "device")
        throw new Error("Sign in to use Organization snippets.");
      if (cmd.action === "share" && d.sync) await exchange(owner, d);
      const result = await remoteCall({
        action: "command",
        account: owner,
        argv,
        ...(expected && { organization: expected.organization }),
        ...(cmd.action === "share" && {
          snippet: findSnippet(d.personal, cmd.target),
        }),
      });
      if (!["list", "search", "get", "render", "export"].includes(cmd.action))
        changed(true, expected?.origin);
      return result;
    }
    // A CLI command can arrive while the app is closed and another device has edited the library.
    if (d.sync && !expected) await exchange(owner, d).catch(() => {});
    const { items, result } = await applyCommand(d.personal, cmd);
    if (items !== d.personal) {
      d.personal = items;
      if (d.sync) d.pendingSync = true;
      save(owner, d);
      if (d.sync) await exchange(owner, d).catch(() => {});
      changed(false, expected?.origin);
    }
    return result;
  }

  return {
    view: (source: "local" | "refresh") =>
      source === "local" ? view(false) : serial(() => view(true)),
    run: (
      argv: string[],
      expected?: {
        owner: string;
        organization: string | null;
        origin?: string;
      },
    ) => serial(() => run(argv, expected)),
  };
}
