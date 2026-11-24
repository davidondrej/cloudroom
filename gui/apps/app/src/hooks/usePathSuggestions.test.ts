// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import type { WorkspacePathEntry } from "@cloudroom/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPathSuggestions, usePathSuggestions } from "./usePathSuggestions";

const mocks = vi.hoisted(() => ({
  useEnvironmentPathSuggestions: vi.fn(),
  useProjectPathSuggestions: vi.fn(),
  useThreadStoragePaths: vi.fn(),
}));

vi.mock("./queries/environment-queries", () => ({
  useEnvironmentPathSuggestions: mocks.useEnvironmentPathSuggestions,
}));
vi.mock("./queries/project-queries", () => ({
  useProjectPathSuggestions: mocks.useProjectPathSuggestions,
}));
vi.mock("./queries/thread-queries", () => ({
  useThreadStoragePaths: mocks.useThreadStoragePaths,
}));

afterEach(cleanup);

interface PathEntryFixture {
  kind?: WorkspacePathEntry["kind"];
  path: string;
  score: number;
}

function makePathEntry(fixture: PathEntryFixture): WorkspacePathEntry {
  const name = fixture.path.split("/").at(-1) ?? fixture.path;
  return {
    kind: fixture.kind ?? "file",
    path: fixture.path,
    name,
    score: fixture.score,
    positions: [],
  };
}

describe("buildPathSuggestions", () => {
  it("preserves backend order instead of alphabetizing equal-score paths", () => {
    const suggestions = buildPathSuggestions({
      workspacePaths: [
        makePathEntry({ path: "README.md", score: 100 }),
        makePathEntry({ path: "APPS/DESKTOP/README.md", score: 100 }),
        makePathEntry({ path: "PACKAGES/DB/README.md", score: 100 }),
      ],
      threadStoragePaths: [],
      limit: 8,
    });

    expect(suggestions.map((suggestion) => suggestion.path)).toEqual([
      "README.md",
      "APPS/DESKTOP/README.md",
      "PACKAGES/DB/README.md",
    ]);
  });

  it("keeps workspace paths before thread-storage paths when scores tie", () => {
    const suggestions = buildPathSuggestions({
      workspacePaths: [
        makePathEntry({ path: "packages/db/README.md", score: 100 }),
      ],
      threadStoragePaths: [makePathEntry({ path: "README.md", score: 100 })],
      limit: 8,
    });

    expect(
      suggestions.map((suggestion) => ({
        source: suggestion.source,
        path: suggestion.path,
      })),
    ).toEqual([
      { source: "workspace", path: "packages/db/README.md" },
      { source: "thread-storage", path: "README.md" },
    ]);
  });
});

describe("usePathSuggestions", () => {
  it("searches the project folder for Cloud threads, which have no environment", () => {
    const idle = { data: undefined, isPending: false, isFetching: false, isError: false };
    mocks.useEnvironmentPathSuggestions.mockReturnValue(idle);
    mocks.useThreadStoragePaths.mockReturnValue(idle);
    mocks.useProjectPathSuggestions.mockReturnValue({
      ...idle,
      data: { paths: [makePathEntry({ kind: "directory", path: "src", score: 5 })] },
    });

    const { result } = renderHook(() =>
      usePathSuggestions({
        projectId: "proj_1",
        query: "src",
        environmentId: null,
        includeDirectories: true,
      }),
    );

    expect(mocks.useProjectPathSuggestions).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: "proj_1", includeDirectories: true }),
    );
    expect(mocks.useEnvironmentPathSuggestions).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentId: undefined }),
    );
    expect(result.current.suggestions).toEqual([
      expect.objectContaining({ source: "workspace", entryKind: "directory", path: "src" }),
    ]);
  });
});
