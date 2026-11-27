import { expect, it } from "vitest";
import { antigravityCloudState } from "./antigravity-cloud";

const managed = { data: { selfHosted: false }, isError: false };
const cloudLoading = { isError: false };
const idle = { isError: false, isFetching: false };

it("offers Antigravity sign-in only after the status check says signed out (#2637)", () => {
  expect(antigravityCloudState(managed, { ...idle, isFetching: true })).toBe("checking");
  expect(antigravityCloudState(managed, { ...idle, isError: true })).toBe("unavailable");
  expect(antigravityCloudState(managed, { ...idle, isError: true, isFetching: true })).toBe("checking");
  expect(antigravityCloudState(managed, { ...idle, data: { connected: true } })).toBe("ready");
  expect(antigravityCloudState(managed, { ...idle, data: { connected: false } })).toBe("signed_out");
  expect(antigravityCloudState(cloudLoading, { ...idle, data: { connected: false } })).toBe("checking");
  expect(antigravityCloudState({ isError: true }, { ...idle, data: { connected: false } })).toBe("unavailable");
  // A recheck or a failed recheck beats a cached sign-out; an answer without `connected` is not a sign-out.
  expect(antigravityCloudState(managed, { ...idle, isFetching: true, data: { connected: false } })).toBe("checking");
  expect(antigravityCloudState(managed, { ...idle, isError: true, data: { connected: false } })).toBe("unavailable");
  expect(antigravityCloudState(managed, { ...idle, data: {} })).toBe("unavailable");
  expect(antigravityCloudState({ data: { selfHosted: true }, isError: false }, { ...idle, isError: true })).toBe("ready");
});
