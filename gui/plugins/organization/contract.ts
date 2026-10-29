import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// The website's answers (web/lib/org.ts) and the RPC between this plugin's page and its server.
export const STATE_CHANNEL = "state";

export const stateSchema = z.object({
  account: z.string().optional(),
  org: z.object({
    name: z.string(), role: z.enum(["admin", "member"]), repos: z.array(z.string()), instructions: z.string(), repo_rules: z.record(z.string(), z.string()).default({}),
    member_view: z.enum(["none", "shared", "all"]).default("shared"), admins_see_locked: z.boolean().default(true),
  }).nullable(),
  invites: z.array(z.object({ orgId: z.string(), name: z.string() })),
  mine: z.array(z.object({ thread: z.string(), shared: z.boolean(), locked: z.boolean().default(false) })),
  taken: z.array(z.string()),
  recheck_ms: z.number().int().positive(),
});
export type OrgState = z.infer<typeof stateSchema>;

export const messageSchema = z.object({ role: z.enum(["user", "agent"]), text: z.string() });
export type OrgMessage = z.infer<typeof messageSchema>;
export const sharedThreadSchema = z.object({
  owner: z.string(), ownerName: z.string(), thread: z.string(), title: z.string(), repo: z.string(),
  harness: z.string().nullable(), model: z.string().nullable(), at: z.string(),
});
export type SharedThread = z.infer<typeof sharedThreadSchema>;
export const handoffSchema = z.object({
  repo: z.string(), branch: z.string(), title: z.string(), harness: z.string().nullable(), model: z.string().nullable(),
  ownerName: z.string(), messages: z.array(messageSchema),
});

const role = z.enum(["admin", "member"]);
export const settingsSchema = z.object({
  email: z.string(),
  org: z.object({
    name: z.string(), role, repos: z.array(z.string()), instructions: z.string(), repo_rules: z.record(z.string(), z.string()),
    rules_editors: z.enum(["admins", "everyone"]), member_view: z.enum(["none", "shared", "all"]), admin_view: z.boolean(),
    sharing: z.string(), canEditRules: z.boolean(), members: z.array(z.object({ email: z.string(), role, joined: z.boolean() })),
  }).nullable(),
});
export type OrgSettings = z.infer<typeof settingsSchema>;
export type OrgChange = { action: string } & Record<string, unknown>;

const view = z.object({ state: stateSchema.nullable(), error: z.string().nullable() });
const ref = z.object({ owner: z.string(), thread: z.string() }).strict();

export const orgRpcContract = defineRpcContract({
  state: { input: z.object({}).strict(), output: view },
  list: { input: z.object({}).strict(), output: z.object({ threads: z.array(sharedThreadSchema) }) },
  view: { input: ref, output: z.object({ title: z.string(), messages: z.array(messageSchema) }) },
  takeover: { input: ref, output: z.object({ threadId: z.string() }) },
  thread: { input: z.object({ threadId: z.string() }).strict(), output: z.object({ eligible: z.boolean(), shared: z.boolean(), adminsSee: z.boolean() }) },
  share: { input: z.object({ threadId: z.string(), shared: z.boolean() }).strict(), output: z.object({ shared: z.boolean() }) },
  invite: { input: z.object({ orgId: z.string(), accept: z.boolean() }).strict(), output: view },
  settings: { input: z.object({ change: z.looseObject({ action: z.string() }).optional() }).strict(), output: settingsSchema },
  githubRepos: { input: z.object({}).strict(), output: z.object({ login: z.string().nullable(), repos: z.array(z.string()) }) },
});
