import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { commands, parseCommand } from "./library.ts";
import {
  emptyDevice,
  snippetService,
  type Device,
  type View,
} from "./service.ts";
export const rpcContract = defineRpcContract({
  view: { input: z.enum(["local", "refresh"]), output: z.custom<View>() },
  run: {
    input: z.object({
      argv: z.array(z.string()),
      owner: z.string(),
      organization: z.string().nullable(),
      origin: z.string().uuid().optional(),
    }),
    output: z.unknown(),
  },
});

export default function snippets(room: BbPluginApi) {
  const db = room.storage.database();
  room.storage.migrate(db, [
    "CREATE TABLE library (owner TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ]);
  const get = db.prepare("SELECT value FROM library WHERE owner=?");
  const put = db.prepare(
    "INSERT INTO library(owner,value) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value",
  );
  // Keep snippets created before the first sign-in on this device. Sync still requires opt-in.
  const claimGuest = db.prepare(
    "UPDATE library SET owner=? WHERE owner='device' AND NOT EXISTS (SELECT 1 FROM library WHERE owner=?)",
  );
  const load = (owner: string): Device => {
    if (owner !== "device" && !get.get(owner)) claimGuest.run(owner, owner);
    const row = get.get(owner) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : emptyDevice();
  };
  const save = (owner: string, device: Device) =>
    put.run(owner, JSON.stringify(device));
  const service = snippetService(
    load,
    save,
    (body) => room.sdk.cloudroom.snippets(body),
    (team, origin) => room.realtime.publish("changed", { team, origin }),
  );
  room.rpc.register(rpcContract, {
    view: (source) => service.view(source),
    run: (input) => service.run(input.argv, input),
  });
  room.cli.register({
    name: "snippets",
    summary: "Manage personal and Organization snippets",
    commands: Object.entries(commands).map(([name, args]) => ({
      name,
      summary: name + " snippets",
      usage: ("room-cli snippets " + name + " " + args).trim(),
    })),
    async run(argv) {
      try {
        const result = await service.run([...argv]);
        return {
          exitCode: 0,
          stdout:
            typeof result === "string" && !parseCommand([...argv]).options.json
              ? result
              : JSON.stringify(result),
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
