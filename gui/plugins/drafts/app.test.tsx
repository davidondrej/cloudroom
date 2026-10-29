// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type {
  ComposerSubmitOptions,
  PluginComposerApi,
  PluginComposerScope,
} from "@get-bb/plugin-sdk/app";

const app = await loadPluginApp(() => import("./app"));
const customization = app.composerCustomizations[0]!;
const plusMenuItem = customization.plusMenu![0]!;

function composer(
  text = "ship the release notes",
  submit: (options: ComposerSubmitOptions) => Promise<void> = async () => {},
  scope: PluginComposerScope = { kind: "thread", threadId: "thr_scope" },
): PluginComposerApi {
  return {
    scope,
    isEmpty: text.trim() === "",
    isSubmitting: false,
    submit,
  } as Partial<PluginComposerApi> as PluginComposerApi;
}

describe("registration", () => {
  it("adds a draft action to thread and new-thread composers", () => {
    expect(app.composerCustomizations).toMatchObject([
      {
        id: "drafts",
        scopes: ["thread", "new-thread"],
        plusMenu: [{ label: "Save draft…", icon: "EditFile" }],
      },
    ]);
  });

  it("disables saving when the draft is empty", () => {
    const disabled = plusMenuItem.disabled as (
      composer: PluginComposerApi,
    ) => boolean;
    expect(disabled(composer(""))).toBe(true);
    expect(disabled(composer())).toBe(false);
  });
});

describe("saving", () => {
  it("submits the active composer with draft metadata", async () => {
    const submits: unknown[] = [];
    await plusMenuItem.run({
      composer: composer(undefined, async (options) => {
        submits.push(options);
      }),
    });
    expect(submits).toEqual([{ experimental_data: { kind: "draft" } }]);
  });
});
