import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const providerSchema = z.enum(["claude-code", "codex"]);
export type Provider = z.infer<typeof providerSchema>;
export const MAX_ACCOUNTS = 10;
export const LOCAL = "local";
export const ACCOUNTS_CHANGED = "accounts-changed";

export const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const accountViewSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  inUse: z.boolean(),
  limitedUntil: z.number().nullable(),
  error: z.string().nullable(),
  credits: z.object({ detail: z.string().nullable() }).nullable(),
  windows: z.array(usageWindowSchema),
  // The Mac's own Claude login, shown but not selectable until it is signed in again.
  needsSignIn: z.boolean(),
  // A Claude account added before full logins: it runs on its one-year token, without claude.ai connectors.
  limitedLogin: z.boolean(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

const target = z.object({ provider: providerSchema, id: z.string().min(1) });
const ok = z.null();
const poll = z.object({ sessionId: z.string() });
const polled = z.object({
  status: z.enum(["pending", "complete", "error"]),
  message: z.string().nullable(),
  // Claude's second sign-in, for the one-year token Cloud uses.
  authorizeUrl: z.string().nullish(),
});

export const accountsRpcContract = defineRpcContract({
  "accounts.list": {
    input: z.object({ provider: providerSchema }),
    output: z.array(accountViewSchema),
  },
  "accounts.use": { input: target, output: ok },
  "accounts.move": {
    input: target.extend({ direction: z.enum(["up", "down"]) }),
    output: ok,
  },
  "accounts.remove": { input: target, output: ok },
  "accounts.rename": {
    input: target.extend({ name: z.string().max(60) }),
    output: ok,
  },
  "claude.start": {
    input: z
      .object({ mac: z.boolean().optional(), id: z.string().optional() })
      .nullable(),
    output: z.object({ sessionId: z.string(), authorizeUrl: z.string() }),
  },
  "codex.start": {
    input: z.null(),
    output: z.object({
      sessionId: z.string(),
      verificationUri: z.string(),
      userCode: z.string(),
      expiresAt: z.number(),
    }),
  },
  "claude.poll": { input: poll, output: polled },
  "codex.poll": { input: poll, output: polled },
});
