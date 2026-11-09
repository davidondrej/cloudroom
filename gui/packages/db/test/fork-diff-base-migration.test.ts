import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createEnvironment, createProject, noopNotifier, upsertHost } from "../src/index.js";
import { createMigratedConnection } from "./helpers/migrated-connection.js";

it("0135 clears only frozen fork snapshot branches as the diff base", () => {
  const db = createMigratedConnection();
  try {
    const host = upsertHost(db, noopNotifier, { name: "test-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "test-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
    });
    const base = (mergeBaseBranch: string | null) =>
      createEnvironment(db, noopNotifier, { providerOwnsPath: false, projectId: project.id, hostId: host.id, mergeBaseBranch }).id;
    const ids = [base("cloudroom/fork-e41fd7ef2a73"), base("main"), base("feature/x"), base(null)];
    db.$client.exec(readFileSync(new URL("../drizzle/0135_fork_diff_base.sql", import.meta.url), "utf8"));
    const read = db.$client.prepare("SELECT merge_base_branch FROM environments WHERE id = ?");
    expect(ids.map((id) => (read.get(id) as { merge_base_branch: string | null }).merge_base_branch))
      .toEqual([null, "main", "feature/x", null]);
  } finally {
    db.$client.close();
  }
});
