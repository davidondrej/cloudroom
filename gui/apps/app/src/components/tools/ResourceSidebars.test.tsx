// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ResourceSidebar } from "./ResourceSidebar";

afterEach(cleanup);

function renderSidebarAt(path: string, appRoutePath = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <ResourceSidebar
          appRoutePath={appRoutePath}
          isResizing={false}
          onResizeMouseDown={() => {}}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

const row = (name: string) => screen.getByRole("link", { name });

describe("Skills sidebar", () => {
  it("owns only the Skills pages and the app back target", () => {
    renderSidebarAt("/skills", "/projects/proj_one");

    expect(screen.getByText("Skills")).toBeTruthy();
    expect(row("Browse skills").getAttribute("href")).toBe("/skills");
    expect(row("My skills").getAttribute("href")).toBe("/skills?view=library");
    expect(row("Browse skills").querySelector("svg")).toBeNull();
    expect(row("My skills").querySelector("svg")).toBeNull();
    expect(screen.queryByText("Plugins")).toBeNull();
    expect(screen.queryByRole("link", { name: "Browse plugins" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Installed plugins" }),
    ).toBeNull();
    expect(row("Back to app").getAttribute("href")).toBe("/projects/proj_one");
  });

  it.each([
    ["/skills", "Browse skills"],
    ["/skills/registry", "Browse skills"],
    ["/skills?view=library", "My skills"],
    ["/skills/library/my-skill", "My skills"],
    ["/skills/registry/owner%2Frepo%2Fskill", "Browse skills"],
  ])("marks %s as %s", (path, expected) => {
    renderSidebarAt(path);

    expect(row(expected).getAttribute("aria-current")).toBe("page");
  });
});
