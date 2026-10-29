// @vitest-environment jsdom
import { COMPUTER } from "@cloudroom/domain/computer-name";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const app = await loadPluginApp(() => import("./app"));
const { readCheckoutInputs } = await import("./app");

afterEach(() => {
  cleanup();
});

function inputsSlot() {
  const registration = app.environmentProviderInputs.find(
    (candidate) =>
      candidate.environmentProviderId ===
      PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  );
  if (registration === undefined) {
    throw new Error("the checkout inputs control was not registered");
  }
  return registration;
}

describe("checkout inputs control", () => {
  it("selects a GitHub branch before the new machine exists", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        target: { kind: "new-host" },
        value: null,
        onChange,
      },
      {
        branchesState: {
          branches: ["local-only"],
          remoteBranches: ["origin/main", "origin/release"],
        },
      },
    );
    const trigger = slot.getByRole("combobox", { name: "Branch" });
    expect(trigger.textContent).toContain("Default branch");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    fireEvent.click(trigger);
    expect(await slot.findByText("On GitHub")).toBeTruthy();
    expect(slot.queryByText(`On this ${COMPUTER}`)).toBeNull();
    expect(slot.queryByRole("button", { name: "local-only" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "release" }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { branch: { kind: "existing", name: "release" } },
    });
  });

  it("submits the current checkout as soon as it mounts", async () => {
    const onChange = vi.fn();
    renderSlot(inputsSlot(), {
      projectId: "project-1",
      target: { kind: "existing-host", hostId: "host-a" },
      value: null,
      onChange,
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ status: "ready", value: {} });
    });
  });

  it("shows the current branch, or the picked one, on the chip", () => {
    const current = renderSlot(inputsSlot(), {
      projectId: "project-1",
      target: { kind: "existing-host", hostId: "host-a" },
      value: null,
      onChange: vi.fn(),
    });
    expect(
      current.getByRole("combobox", { name: "Branch" }).textContent,
    ).toBe("main");
    cleanup();
    const picked = renderSlot(inputsSlot(), {
      projectId: "project-1",
      target: { kind: "existing-host", hostId: "host-a" },
      value: { branch: { kind: "existing", name: "release" } },
      onChange: vi.fn(),
    });
    expect(
      picked.getByRole("combobox", { name: "Branch" }).textContent,
    ).toBe("release");
  });

  it("groups branches by where they live and checks out a GitHub-only one", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        target: { kind: "existing-host", hostId: "host-a" },
        value: null,
        onChange,
      },
      {
        branchesState: {
          branches: ["main", "release"],
          remoteBranches: ["origin/HEAD", "origin/main", "origin/feature"],
        },
      },
    );
    fireEvent.click(slot.getByRole("combobox", { name: "Branch" }));
    expect(await slot.findByText(`On this ${COMPUTER}`)).toBeTruthy();
    expect(slot.getByText("On GitHub")).toBeTruthy();
    expect(slot.getByRole("button", { name: /^main\s*current$/ })).toBeTruthy();
    expect(slot.getAllByRole("button", { name: /^main/ })).toHaveLength(1);
    expect(slot.queryByRole("button", { name: "HEAD" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "feature" }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { branch: { kind: "existing", name: "feature" } },
    });
  });

  it("keeps a seeded path while the branch changes", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        target: { kind: "existing-host", hostId: "host-a" },
        value: { path: "/srv/other-checkout" },
        onChange,
      },
      { branchesState: { branches: ["main", "release"] } },
    );
    fireEvent.click(slot.getByRole("combobox", { name: "Branch" }));
    fireEvent.click(await slot.findByRole("button", { name: "release" }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: {
        path: "/srv/other-checkout",
        branch: { kind: "existing", name: "release" },
      },
    });
    cleanup();
    const cleared = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        target: { kind: "existing-host", hostId: "host-a" },
        value: {
          path: "/srv/other-checkout",
          branch: { kind: "existing", name: "release" },
        },
        onChange,
      },
      { branchesState: { branches: ["main", "release"] } },
    );
    fireEvent.click(cleared.getByRole("combobox", { name: "Branch" }));
    fireEvent.click(await cleared.findByRole("button", { name: /^main\s*current$/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { path: "/srv/other-checkout" },
    });
  });

  it("selects a searched branch with Enter and closes", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        target: { kind: "existing-host", hostId: "host-a" },
        value: null,
        onChange,
      },
      { branchesState: { branches: ["main", "release"] } },
    );
    const trigger = slot.getByRole("combobox", { name: "Branch" });
    fireEvent.click(trigger);
    const search = await slot.findByRole("textbox", {
      name: "Search branches",
    });
    fireEvent.change(search, { target: { value: "release" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { branch: { kind: "existing", name: "release" } },
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reports the checkout blocker and only allows the current or picked branch", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      {
        projectId: "project-1",
        target: { kind: "existing-host", hostId: "host-a" },
        value: { branch: { kind: "existing", name: "release" } },
        onChange,
      },
      {
        branchesState: { branches: ["main", "release", "hotfix"] },
        checkoutState: { dirty: true },
      },
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        status: "blocked",
        reason: "Checkout blocked by uncommitted changes",
      });
    });
    fireEvent.click(slot.getByRole("combobox", { name: "Branch" }));
    expect(
      await slot.findByText("Checkout blocked by uncommitted changes"),
    ).toBeTruthy();
    expect(slot.getByRole("button", { name: "hotfix" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(slot.getByRole("button", { name: "release" })).toHaveProperty(
      "disabled",
      false,
    );
    const current = slot.getByRole("button", { name: /^main\s*current$/ });
    expect(current).toHaveProperty("disabled", false);
    fireEvent.click(current);
    expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: {} });
  });

  it("reads only a well-formed branch out of the current value", () => {
    expect(
      readCheckoutInputs({ branch: { kind: "existing", name: "main" } }),
    ).toEqual({ path: null, branch: { kind: "existing", name: "main" } });
    expect(
      readCheckoutInputs({ branch: { kind: "named", name: "main" } }),
    ).toEqual({ path: null, branch: null });
    expect(readCheckoutInputs("main")).toEqual({ path: null, branch: null });
  });
});
