// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useDraftPreservingOptionChange } from "./NewThreadComposer";

it("records an effort click that matches the shown default, without a draft snapshot (#656)", () => {
  const [setValue, snapshot] = [vi.fn(), vi.fn()];
  const { result } = renderHook(() =>
    useDraftPreservingOptionChange<string>("high", setValue, snapshot, true),
  );
  result.current("high");
  expect(setValue).toHaveBeenCalledExactlyOnceWith("high");
  expect(snapshot).not.toHaveBeenCalled();
});
