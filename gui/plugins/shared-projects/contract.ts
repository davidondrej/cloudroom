import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// The website's answers (web/lib/project-shares.ts) and the RPC between this plugin's page and its server.
export const STATE_CHANNEL = "state";

export const stateSchema = z.object({
  account: z.string().optional(),
  // `project` is this account's own app project for the repo, as the website knows it.
  shares: z.array(z.object({ id: z.string(), repo: z.string(), owner: z.boolean(), joined: z.boolean(), project: z.string().nullable() })),
  invites: z.array(z.object({ id: z.string(), repo: z.string(), from: z.string() })),
  hidden: z.array(z.string()),
  taken: z.array(z.string()),
  recheck_ms: z.number().int().positive(),
  // How often coming back to the app may check for invites before the next poll.
  focus_ms: z.number().int().positive().default(10 * 60_000),
});
export type SharesState = z.infer<typeof stateSchema>;
export type Invite = SharesState["invites"][number];

export const messageSchema = z.object({ role: z.enum(["user", "agent"]), text: z.string() });
export type SharedMessage = z.infer<typeof messageSchema>;
export const sharedThreadSchema = z.object({
  owner: z.string(), ownerName: z.string(), thread: z.string(), title: z.string(),
  harness: z.string().nullable(), model: z.string().nullable(), at: z.string(),
});
export type SharedThread = z.infer<typeof sharedThreadSchema>;
export const personSchema = z.object({
  // The share to remove or leave; null for people this account can't remove.
  id: z.string().nullable(), name: z.string(), email: z.string().nullable(), role: z.enum(["owner", "member"]), joined: z.boolean(), you: z.boolean(),
});
export type Person = z.infer<typeof personSchema>;
// A teammate in the account's organization, as a one-click choice: not shared with yet, invited, or sharing already.
export const teammateSchema = z.object({ name: z.string(), email: z.string(), state: z.enum(["none", "invited", "joined"]) });
export type Teammate = z.infer<typeof teammateSchema>;
export const pageSchema = z.object({
  repo: z.string(),
  // Shares this account owns, of what its plan includes. `max` 0 is a plan without sharing; null is no limit.
  limit: z.object({ used: z.number(), max: z.number().nullable() }),
  paused: z.boolean().default(false),
  // Empty outside an organization.
  team: z.array(teammateSchema).default([]),
  people: z.array(personSchema),
  threads: z.array(sharedThreadSchema),
});
export type SharePage = z.infer<typeof pageSchema>;
export const handoffSchema = z.object({
  repo: z.string(), branch: z.string(), title: z.string(), harness: z.string().nullable(), model: z.string().nullable(), reasoning: z.string().nullable().optional(),
  ownerName: z.string(), messages: z.array(messageSchema),
});

// `repo` is null for a project that is not on GitHub: it can't be shared.
const page = z.object({ name: z.string(), repo: z.string().nullable(), page: pageSchema.nullable() });
const project = z.object({ projectId: z.string() });
const ref = project.extend({ owner: z.string(), thread: z.string() }).strict();

export const sharesRpcContract = defineRpcContract({
  invites: { input: z.object({}).strict(), output: z.object({ invites: stateSchema.shape.invites }) },
  // The app came back to the front: check for invites now, at most as often as the website allows.
  refresh: { input: z.object({}).strict(), output: z.object({}) },
  answer: { input: z.object({ id: z.string(), accept: z.boolean() }).strict(), output: z.object({ projectId: z.string().nullable() }) },
  page: { input: project.strict(), output: page },
  // One person by `email`, or with `team`, every teammate the project isn't shared with yet.
  share: { input: project.extend({ email: z.string().optional(), team: z.boolean().optional() }).strict(), output: page },
  remove: { input: project.extend({ id: z.string() }).strict(), output: page },
  view: { input: ref, output: z.object({ title: z.string(), messages: z.array(messageSchema) }) },
  takeover: { input: ref, output: z.object({ threadId: z.string() }) },
  thread: { input: z.object({ threadId: z.string() }).strict(), output: z.object({ eligible: z.boolean(), hidden: z.boolean() }) },
  hide: { input: z.object({ threadId: z.string(), hidden: z.boolean() }).strict(), output: z.object({ hidden: z.boolean() }) },
});
