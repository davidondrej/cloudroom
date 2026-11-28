import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  stripGitUrlCredentials,
  stripTextGitUrlCredentials,
} from "@cloudroom/domain";
import {
  createPluginArtifact,
  deletePluginArtifact,
  deleteInstalledPlugin,
  getInstalledPluginRegistration,
  getInstalledPlugin,
  getPluginMarketplace,
  listPluginArtifacts,
  listPluginArtifactsAtOrUnderPath,
  listPluginArtifactsUnderPath,
  listPluginKvKeys,
  markInstalledPluginChanged,
  markInstalledPluginRemoved,
  setInstalledPluginEnabled,
  setInstalledPluginLastFailure,
  setInstalledPluginUpdateState,
  setPluginKvValue,
  upsertInstalledPlugin,
  upsertPluginMarketplace,
  type DbConnection,
} from "../../src/index.js";
import {
  stripPluginGitUrlCredentials,
  type UpsertInstalledPluginInput,
} from "../../src/data/plugins.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

describe("normalized plugin persistence", () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createMigratedConnection();
  });

  afterEach(() => db.$client.close());

  it("persists typed plugin intent and an active artifact reference", () => {
    const linearPlugin: UpsertInstalledPluginInput = {
      id: "linear",
      source: "npm:bb-plugin-linear@1.2.3",
      provenance: {
        kind: "catalog",
        marketplace: "bb-community",
        entryId: "linear",
      },
      sourceIntent: {
        kind: "npm",
        packageName: "bb-plugin-linear",
        registry: "https://registry.npmjs.org",
        requestedSpec: "^1.2.0",
        specKind: "range",
      },
      exactResolution: {
        kind: "npm",
        version: "1.2.3",
        integrity: "sha512-example",
      },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: "2.0.0",
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/plugins/linear",
      version: "1.2.3",
      enabled: true,
    };
    upsertInstalledPlugin(db, linearPlugin);
    createPluginArtifact(db, {
      id: "artifact-1",
      pluginId: "linear",
      sourceKind: "npm",
      npmResolvedVersion: "1.2.3",
      gitResolvedCommit: null,
      gitCheckoutRoot: null,
      path: "/cache/artifact-1.tgz",
      integrity: "sha512-example",
      contentHash: "sha256-example",
      validationResult: "valid",
      validatedAt: 100,
    });
    upsertInstalledPlugin(db, { ...linearPlugin, activeArtifactId: "artifact-1" });
    expect(getInstalledPlugin(db, "linear")?.rootDir).toBe(
      "/cache/artifact-1.tgz",
    );

    expect(getInstalledPluginRegistration(db, "linear")).toMatchObject({
      provenance: "catalog",
      catalogEntryId: "linear",
      catalogMarketplaceName: "bb-community",
      sourceKind: "npm",
      sourceNpmRequestedSpec: "^1.2.0",
      sourceNpmSpecKind: "range",
      npmResolvedVersion: "1.2.3",
      activeArtifactId: "artifact-1",
    });
    expect(listPluginArtifacts(db, "linear")).toHaveLength(1);
    expect(deletePluginArtifact(db, "artifact-1")).toBe(true);
    expect(getInstalledPluginRegistration(db, "linear")?.activeArtifactId).toBe(
      null,
    );
  });

  it("rejects an npm artifact without registry integrity at runtime", () => {
    const invalidArtifact = {
      id: "artifact-invalid",
      pluginId: "missing",
      sourceKind: "npm",
      npmResolvedVersion: "1.2.3",
      gitResolvedCommit: null,
      path: "/cache/artifact-invalid.tgz",
      integrity: null,
      contentHash: null,
      validationResult: "pending",
      validatedAt: null,
    };
    expect(() =>
      Reflect.apply(createPluginArtifact, undefined, [db, invalidArtifact]),
    ).toThrow(/resolution fields/);
  });

  it("stores a git ref and a git tag range in mutually exclusive columns", () => {
    const common = {
      provenance: { kind: "direct" } as const,
      exactResolution: { kind: "git" as const, commit: "abcdef1234567" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/cache/repo/abcdef1234567",
      version: "1.4.2",
      enabled: true,
    };
    upsertInstalledPlugin(db, {
      ...common,
      id: "ranged",
      source: "git:/repo@semver:notes/:^1.0.0",
      sourceIntent: {
        kind: "git",
        url: "/repo",
        subdirectory: "plugins/notes",
        selector: {
          kind: "range",
          range: "^1.0.0",
          tagPrefix: "notes/",
          resolvedTag: "notes/v1.4.2",
        },
      },
    });
    expect(getInstalledPlugin(db, "ranged")).toMatchObject({
      sourceGitRange: "^1.0.0",
      sourceGitTagPrefix: "notes/",
      sourceGitResolvedTag: "notes/v1.4.2",
      sourceGitRequestedRef: null,
      sourceGitRefKind: null,
    });

    upsertInstalledPlugin(db, {
      ...common,
      id: "ranged",
      source: "git:/repo@main",
      sourceIntent: {
        kind: "git",
        url: "/repo",
        subdirectory: "plugins/notes",
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
    });
    expect(getInstalledPlugin(db, "ranged")).toMatchObject({
      sourceGitRange: null,
      sourceGitTagPrefix: null,
      sourceGitResolvedTag: null,
      sourceGitRequestedRef: "main",
      sourceGitRefKind: "branch",
    });
  });

  it.each([
    ["https://user:TOKEN@host/r.git", "https://host/r.git"],
    ["https://TOKEN@github.com/o/r", "https://github.com/o/r"],
    ["http:///alice:TOKEN@host/repo.git", "http:///host/repo.git"],
    ["http:/alice@host:repo.git", "http:/alice@host:repo.git"],
    ["HTTPS://u:p@ss@host:8443/r", "HTTPS://host:8443/r"],
    ["https://do\\main\\u:TOKEN@host/r", "https://host/r"],
    ["ftps://u:TOKEN@host/r", "ftps://host/r"],
    ["git:https://u:TOKEN@host/r@main", "git:https://host/r@main"],
    ["ssh://git:pw@host:2222/r", "ssh://git@host:2222/r"],
    ["ssh://git@host/r", "ssh://git@host/r"],
    ["git@github.com:o/r.git", "git@github.com:o/r.git"],
    ["git:team@repo.git", "git:team@repo.git"],
    ["/srv/repo@main", "/srv/repo@main"],
    ["file:///srv@storage/team/repo.git", "file:///srv@storage/team/repo.git"],
  ])("strips Git URL credentials: %s", (value, expected) => {
    expect(stripGitUrlCredentials(value)).toBe(expected);
  });

  it("strips Git URL credentials in text (#2190)", () => {
    expect(
      stripTextGitUrlCredentials(
        "fatal: could not read Password for 'https://TOKEN@host': no; see ssh://git@h/r",
      ),
    ).toBe(
      "fatal: could not read Password for 'https://host': no; see ssh://git@h/r",
    );
    expect(
      stripTextGitUrlCredentials("unable to access 'http:///alice:TOKEN@h/r/'"),
    ).toBe("unable to access 'http:///h/r/'");
    expect(
      stripTextGitUrlCredentials("git clone https://alice:FAKE,TOKEN@host/repo failed"),
    ).toBe("git clone https://host/repo failed");
    expect(
      stripPluginGitUrlCredentials("git:alice:TOKEN@github.com/org/repo@main"),
    ).toBe("git:github.com/org/repo@main");
  });

  it("strips credentials from Git URLs saved before #1935", () => {
    const url = 'https://user:pa"s s@github.com/acme/repo';
    upsertInstalledPlugin(db, {
      id: "legacy",
      source: `git:${url}@main`,
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "git",
        url,
        subdirectory: null,
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
      exactResolution: { kind: "git", commit: "abcdef1234567" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: "git ls-remote 'https://user:pa\"ss@github.com/acme/repo' failed",
      },
      activeArtifactId: null,
      rootDir: "/cache/repo",
      version: "1.0.0",
      enabled: true,
    });
    setInstalledPluginLastFailure(db, "legacy", {
      version: "1.1.0",
      detail: "git clone 'https://x:ghp_FAKE123@github.com/acme/repo' failed",
      at: 1,
    });
    for (const row of [
      getInstalledPlugin(db, "legacy"),
      getInstalledPluginRegistration(db, "legacy"),
    ]) {
      expect(row).toMatchObject({
        source: "git:https://github.com/acme/repo@main",
        sourceGitUrl: "https://github.com/acme/repo",
        updateStatusDetail:
          "git ls-remote 'https://github.com/acme/repo' failed",
        lastFailureDetail: "git clone 'https://github.com/acme/repo' failed",
      });
    }
    upsertPluginMarketplace(db, {
      name: "legacy",
      sourceKind: "git",
      manifestUrl: url,
      sourceGitRef: "main",
      sourceGitCommit: null,
      manifestJson: "{}",
      statsJson: null,
      etag: null,
      lastModified: null,
      lastSuccessfulRefreshAt: null,
      lastAttemptedRefreshAt: null,
      lastError: null,
    });
    expect(getPluginMarketplace(db, "legacy")?.manifestUrl).toBe(
      "https://github.com/acme/repo",
    );
  });

  it("moves changedAt only for the user's own changes", () => {
    const plugin: UpsertInstalledPluginInput = {
      id: "github",
      source: "builtin:github",
      provenance: { kind: "builtin" },
      sourceIntent: { kind: "builtin", name: "github" },
      exactResolution: { kind: "builtin" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/plugins/github",
      version: "1.0.0",
      enabled: true,
    };
    const dates = () => {
      const row = getInstalledPlugin(db, "github");
      return { installedAt: row?.installedAt, changedAt: row?.changedAt };
    };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      upsertInstalledPlugin(db, plugin);
      expect(dates()).toEqual({ installedAt: 1_000, changedAt: 1_000 });

      // A Cloudroom release re-registers built-ins, and update checks run on their own.
      vi.setSystemTime(2_000);
      upsertInstalledPlugin(db, { ...plugin, version: "1.1.0" });
      setInstalledPluginUpdateState(db, "github", {
        lastCheckAt: 2_000,
        availableCompatibleVersion: "1.2.0",
        newestIncompatibleVersion: null,
        statusDetail: null,
      });
      expect(dates()).toEqual({ installedAt: 1_000, changedAt: 1_000 });

      vi.setSystemTime(3_000);
      setInstalledPluginEnabled(db, "github", false);
      expect(dates().changedAt).toBe(3_000);

      vi.setSystemTime(4_000);
      markInstalledPluginChanged(db, "github");
      expect(dates().changedAt).toBe(4_000);

      // Installed again after removal: a new install date.
      markInstalledPluginRemoved(db, "github");
      vi.setSystemTime(5_000);
      upsertInstalledPlugin(db, plugin);
      expect(dates().installedAt).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains artifact records when a plugin registration is removed", () => {
    const retainedPlugin: UpsertInstalledPluginInput = {
      id: "retained",
      source: "git:/repo@main",
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "git",
        url: "/repo",
        subdirectory: null,
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
      exactResolution: { kind: "git", commit: "abcdef1234567" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/cache/repo/abcdef1234567",
      version: "1.0.0",
      enabled: true,
    };
    upsertInstalledPlugin(db, retainedPlugin);
    createPluginArtifact(db, {
      id: "retained-artifact",
      pluginId: "retained",
      sourceKind: "git",
      npmResolvedVersion: null,
      gitResolvedCommit: "abcdef1234567",
      gitCheckoutRoot: "/cache/repo/abcdef1234567",
      path: "/cache/repo/abcdef1234567",
      integrity: null,
      contentHash: "sha256:retained",
      validationResult: "valid",
      validatedAt: Date.now(),
    });
    upsertInstalledPlugin(db, { ...retainedPlugin, activeArtifactId: "retained-artifact" });

    expect(deleteInstalledPlugin(db, "retained")).toBe(true);
    expect(listPluginArtifacts(db, "retained")).toHaveLength(1);
  });

  it("matches LIKE metacharacters in key and path prefixes literally", () => {
    for (const key of ["a_b/1", "axb/2", "50%/3", "50x/4", "c\\d/5", "cxd/6"]) {
      setPluginKvValue(db, "kv-plugin", key, "value");
    }
    expect(listPluginKvKeys(db, "kv-plugin", "a_b")).toEqual(["a_b/1"]);
    expect(listPluginKvKeys(db, "kv-plugin", "50%")).toEqual(["50%/3"]);
    expect(listPluginKvKeys(db, "kv-plugin", "c\\")).toEqual(["c\\d/5"]);

    for (const [id, path] of [
      ["root", "/cache/a_b"],
      ["child", "/cache/a_b/child"],
      ["sibling", "/cache/axb/child"],
    ] as const) {
      createPluginArtifact(db, {
        id,
        pluginId: "path-plugin",
        sourceKind: "npm",
        npmResolvedVersion: "1.0.0",
        gitResolvedCommit: null,
        gitCheckoutRoot: null,
        path,
        integrity: "sha512-example",
        contentHash: null,
        validationResult: "valid",
        validatedAt: 100,
      });
    }
    expect(
      listPluginArtifactsUnderPath(db, "/cache/a_b", "/").map(({ id }) => id),
    ).toEqual(["child"]);
    expect(
      listPluginArtifactsAtOrUnderPath(db, "/cache/a_b", "/").map(
        ({ id }) => id,
      ),
    ).toEqual(["root", "child"]);
  });
});
