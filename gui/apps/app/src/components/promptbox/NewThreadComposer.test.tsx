// @vitest-environment jsdom

import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeProviderInfo } from "@cloudroom/test-helpers/domain-fixtures";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import { usePromptBoxPermissionModePreference } from "@/hooks/thread-creation-options/persisted-selection-fields";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { providerListCacheKey, writeCachedProviderList } from "@/lib/provider-list-cache";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  resolveNewThreadSubmitDisabledReason,
  resolveUnofferedProjectPermissionMode,
  useDraftPreservingOptionChange,
  useNewThreadPermissionControl,
} from "./NewThreadComposer";

vi.mock("@/lib/sdk", () => ({
  sdk: { system: { executionOptions: vi.fn(), providerStates: vi.fn() } },
}));

it("records an effort click that matches the shown default, without a draft snapshot (#656)", () => {
  const [setValue, snapshot] = [vi.fn(), vi.fn()];
  const { result } = renderHook(() =>
    useDraftPreservingOptionChange<string>("high", setValue, snapshot, true),
  );
  result.current("high");
  expect(setValue).toHaveBeenCalledExactlyOnceWith("high");
  expect(snapshot).not.toHaveBeenCalled();
});

it("asks for access when the project's saved mode is one its agent no longer offers (#2166)", () => {
  const projectDefaults = {
    providerId: "acp-opencode",
    model: "m",
    reasoningLevel: "high",
    permissionMode: "accept-edits",
    serviceTier: "default",
  } as const;
  const args = {
    offeredModes: ["full"] as const,
    projectDefaults,
    providerId: "acp-opencode",
    sendsPermissionMode: false,
  };
  expect(resolveUnofferedProjectPermissionMode(args)).toBe("accept-edits");
  // A start that sends its own mode, another agent, or an offered mode keeps main's behavior.
  expect(resolveUnofferedProjectPermissionMode({ ...args, sendsPermissionMode: true })).toBeNull();
  expect(resolveUnofferedProjectPermissionMode({ ...args, providerId: "codex" })).toBeNull();
  expect(resolveUnofferedProjectPermissionMode({ ...args, offeredModes: ["accept-edits", "full"] })).toBeNull();
});

const opencode = makeProviderInfo({ id: "acp-opencode", displayName: "OpenCode" });
const fullOnlyOpencode = { ...opencode, capabilities: { ...opencode.capabilities, permissionModes: ["full" as const] } };
const staleManualDefaults = { providerId: "acp-opencode", model: "m", reasoningLevel: "high", permissionMode: "accept-edits", serviceTier: "default" } as const;

function Composer({ scope = "new-thread" }: { scope?: "new-thread" | "component-local" }) {
  const options = useThreadCreationOptions({ scope, preferenceProjectId: "proj", initialProviderId: "acp-opencode", initialModel: "m", initialPermissionMode: "accept-edits" });
  const { permission, permissionChoiceRequired } = useNewThreadPermissionControl({ executionTarget: "local", options, projectDefaults: staleManualDefaults, seedPermissionMode: undefined, snapshot: () => {} });
  const remembered = usePromptBoxPermissionModePreference().value;
  const sendBlocked = resolveNewThreadSubmitDisabledReason({ environmentProviderInputsBlocker: null, environmentSetupRequiredReason: null, isCopyingAttachments: false, isLoadingModels: false, isSubmitting: false, isUploading: false, modelLoadError: null, projectDefaultsStatus: "resolved", projectDefaultsUnavailable: false, permissionChoiceRequired, promptInputEmpty: false, providerDisplayName: "OpenCode", selectedProviderId: options.selectedProviderId, selectedThreadModel: "m", submissionEnvironmentUnavailable: false });
  return (
    <>
      <PermissionModePicker {...permission} defaultOpen modal={false} />
      <button type="button" onClick={() => options.setReasoningLevel("low")}>change effort</button>
      <output>{`${sendBlocked}|${options.permissionMode}|${options.executionInputSources.permissionMode}|${remembered}`}</output>
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(sdk.system.providerStates).mockResolvedValue({ providers: [] });
});
afterEach(cleanup);

it("a Full pick on a stale Manual default unblocks Send, goes out explicit and is remembered (#2166)", async () => {
  vi.mocked(sdk.system.executionOptions).mockResolvedValue({
    providers: [fullOnlyOpencode],
    models: [{ id: "m", model: "m", displayName: "M", description: "", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], defaultReasoningEffort: "high", isDefault: true }],
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
  });
  render(<Composer />, { wrapper: createQueryClientTestHarness().wrapper });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Choose access first.|full|undefined|"));
  fireEvent.click(screen.getByRole("menuitem", { name: /Full Access/ }));
  // Send waits no more, the request carries Full as the user's explicit choice, and the browser keeps it.
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("null|full|explicit|full"));
});

it("a cached Full-only provider list never asks for access before live options arrive (#2166)", async () => {
  writeCachedProviderList(providerListCacheKey({ environmentId: null, hostId: null }), [fullOnlyOpencode]);
  vi.mocked(sdk.system.executionOptions).mockImplementation(() => new Promise(() => undefined));
  render(<Composer />, { wrapper: createQueryClientTestHarness().wrapper });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("null|full|undefined|"));
  expect(screen.queryByRole("button", { name: "Permission mode" })).toBeNull();
});

it("a plugin composer still asks for access after another field changes (#2166)", async () => {
  vi.mocked(sdk.system.executionOptions).mockResolvedValue({
    providers: [fullOnlyOpencode],
    models: [{ id: "m", model: "m", displayName: "M", description: "", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }, { reasoningEffort: "low", description: "" }], defaultReasoningEffort: "high", isDefault: true }],
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
  });
  render(<Composer scope="component-local" />, { wrapper: createQueryClientTestHarness().wrapper });
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Choose access first\.\|full\|undefined/));
  fireEvent.click(screen.getByRole("button", { name: "change effort" }));
  // Another field forces the access source explicit, but Send still waits for a real pick.
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Choose access first\.\|full\|explicit/));
  fireEvent.click(screen.getByRole("menuitem", { name: /Full Access/ }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^null\|full\|explicit/));
});
