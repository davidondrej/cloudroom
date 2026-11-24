import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** RepoSync's repos live on the website with the Cloud environment, so every computer and sandbox sees the same ones,
 *  and Core in each sandbox does the syncing (docs/scopes/repo-sync.md). This plugin is only their Settings tab. */
const row = z.object({ repo: z.string(), branch: z.string(), every: z.number(), on: z.boolean() });

export const repoSyncRpcContract = defineRpcContract({
  get: {
    input: z.null(),
    output: z.object({ rows: z.array(row), available: z.array(z.string()), pushed: z.record(z.string(), z.number()) }),
  },
  change: {
    input: z.object({
      repo: z.string().min(1),
      on: z.boolean().optional(),
      branch: z.string().min(1).optional(),
      every: z.number().optional(),
      remove: z.boolean().optional(),
    }),
    output: z.array(row),
  },
  branches: { input: z.object({ repo: z.string().min(1) }), output: z.array(z.string()) },
});

export default function repoSyncPlugin(room: BbPluginApi): void {
  const environment = (change: Parameters<typeof room.sdk.cloudroom.updateEnvironment>[0]) =>
    room.sdk.cloudroom.updateEnvironment(change);
  room.rpc.register(repoSyncRpcContract, {
    // The account's GitHub repos come with their last push, which is what "Pushed 1 min ago" shows.
    async get() {
      const found = await environment({ action: "githubRepos" });
      return { rows: found.repoSync ?? [], available: found.available ?? [], pushed: found.pushed ?? {} };
    },
    async change(input) {
      return (await environment({ action: "repoSync", ...input })).repoSync ?? [];
    },
    async branches({ repo }) {
      return (await environment({ action: "githubBranches", repo })).branches ?? [];
    },
  });
}
