import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { jwtClaims } from "./tokens.js";

export const codexListSchema = z.object({
  signedIn: z.boolean(),
  accounts: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      plan: z.string().nullable(),
      inUse: z.boolean(),
      error: z.string().nullable(),
      credits: z
        .object({ detail: z.string().nullable() })
        .nullable()
        .default(null),
      windows: z.array(
        z.object({
          label: z.string(),
          usedPercent: z.number(),
          resetsAt: z.number().nullable(),
        }),
      ),
    }),
  ),
});
export const codexStartSchema = z.object({
  sessionId: z.string(),
  verificationUri: z.string(),
  userCode: z.string(),
  expiresAt: z.number(),
});
export const codexPollSchema = z.object({
  status: z.enum(["pending", "complete", "error"]),
  message: z.string().nullable(),
});

export async function localCodexEmail(): Promise<string | null> {
  try {
    const home =
      process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const auth = JSON.parse(
      await fs.readFile(path.join(home, "auth.json"), "utf8"),
    ) as { tokens?: { id_token?: string } };
    const claims = jwtClaims(auth.tokens?.id_token);
    const profile = claims["https://api.openai.com/profile"] as
      | { email?: unknown }
      | undefined;
    const email = claims.email ?? profile?.email;
    return typeof email === "string" && email ? email : null;
  } catch {
    return null;
  }
}
