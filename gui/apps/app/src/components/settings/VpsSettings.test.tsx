// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectVpsDialog } from "./VpsSettings";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    cloudroom: {
      status: vi.fn(async () => ({ account: null })),
      vpsAction: vi.fn(async () => ({ code: "ABCD-EFGH", expiresAt: Date.now() + 900_000, command: "curl -fsSL https://www.cloudroom.dev/vps | sudo sh -s ABCD-EFGH" })),
    },
  },
}));

describe("ConnectVpsDialog", () => {
  afterEach(cleanup);

  // The "Add a machine" menu takes focus back as it closes, right after this dialog opens (#1116).
  it("stays open when focus moves outside it", async () => {
    const onOpenChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <button type="button">Add a machine</button>
        <ConnectVpsDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );
    await screen.findByText(/sudo sh -s ABCD-EFGH/);
    screen.getByRole("button", { name: "Add a machine" }).focus();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Connect your VPS")).toBeDefined();
  });
});
