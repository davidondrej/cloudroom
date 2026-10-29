// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptStackCard } from "./PromptStackCard";

afterEach(cleanup);

describe("PromptStackCard", () => {
  it("shows a top-right close button that calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<PromptStackCard ariaLabel="Cloud thread status" onDismiss={onDismiss}>request_id must be valid</PromptStackCard>);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("has no close button without onDismiss", () => {
    render(<PromptStackCard ariaLabel="Cloud thread status">Working</PromptStackCard>);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});
