import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** `awake` lets the screen sleep; `display` keeps the screen on too. */
export const hostStateSchema = z.enum(["off", "awake", "display"]);
export type HostState = z.infer<typeof hostStateSchema>;

export const keepAwakeHostContract = defineRpcContract({
  setState: {
    input: z.object({ state: hostStateSchema }).strict(),
    output: z.object({ state: hostStateSchema, supported: z.boolean() }).strict(),
  },
});
