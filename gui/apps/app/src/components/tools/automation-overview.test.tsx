// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { AutomationOverviewView } from "bb-plugin-automations/overview-view";
import { focusWithKeyboard } from "@/test/keyboard-focus";
import type {
  AutomationResponse,
  AutomationsOverviewResponse,
} from "bb-plugin-automations/rpc-types";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_ProviderIcon: ({ provider }: { provider: { id: string } }) => (
    <span data-provider-icon={provider.id} />
  ),
  experimental_useProviders: () => ({
    status: "ready",
    providers: [
      {
        id: "claude",
        displayName: "Claude Code",
        reasoningLevels: [{ id: "medium", label: "Medium" }],
      },
      {
        id: "codex",
        displayName: "Codex",
        reasoningLevels: [{ id: "max", label: "Max" }],
      },
    ],
  }),
}));

function iconNames(element: HTMLElement): string[] {
  return [...element.querySelectorAll("[data-icon]")].map(
    (icon) => icon.getAttribute("data-icon") ?? "",
  );
}

const INSTALLED_AUTOMATIONS: AutomationsOverviewResponse["automations"] = [
  {
    automation: {
      id: "auto_1",
      projectId: "proj_1",
      name: "Nightly digest",
      enabled: true,
      priority: 3,
      trigger: {
        triggerType: "schedule",
        cron: "0 9 * * *",
        timezone: "UTC",
      },
      execution: {
        mode: "agent",
        prompt: "Summarize yesterday's commits.",
        providerId: "claude",
        model: "claude-opus-5",
        reasoningLevel: "medium",
        permissionMode: "auto",
        environment: { type: "host", workspace: { type: "personal" } },
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: 1_800_000_000_000,
      lastRunAt: null,
      runCount: 0,
      lastRunStatus: null,
      lastRunThreadId: null,
      lastError: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    project: { id: "proj_1", name: "bb" },
  },
];

afterEach(cleanup);

describe("AutomationOverviewView", () => {
  it("keeps lifecycle groups stable around the selected sort", () => {
    const baseEntry = INSTALLED_AUTOMATIONS[0]!;
    if ("problem" in baseEntry.automation) {
      throw new Error("Expected a canonical automation fixture");
    }
    const baseAutomation = baseEntry.automation;
    const entry = (
      name: string,
      overrides: Partial<AutomationResponse> = {},
    ) => ({
      ...baseEntry,
      automation: {
        ...baseAutomation,
        id: `auto_${name.toLowerCase().replaceAll(" ", "_")}`,
        name,
        ...overrides,
      },
    });
    const entries = [
      entry("Aardvark completed", {
        enabled: false,
        trigger: { triggerType: "once", runAt: Date.now() - 1_000 },
        nextRunAt: null,
        runCount: 1,
        lastRunStatus: "succeeded",
      }),
      entry("Zulu inactive", { enabled: false, nextRunAt: null }),
      entry("Aardvark pending", {
        trigger: { triggerType: "once", runAt: Date.now() + 60_000 },
        nextRunAt: Date.now() + 60_000,
      }),
      entry("Zulu active"),
      entry("Alpha inactive", { enabled: false, nextRunAt: null }),
      entry("Alpha active"),
    ];
    const { container } = render(
      <AutomationOverviewView
        entries={entries}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );

    const rowTitles = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-loop-card]"),
        (row) =>
          row.querySelector("button:not([data-row-action])")?.textContent,
      );
    const show = (scope: RegExp) =>
      fireEvent.click(screen.getByRole("button", { name: scope }));
    expect(rowTitles()).toEqual([
      "Aardvark pending",
      "Alpha active",
      "Zulu active",
    ]);
    show(/^Off/);
    expect(rowTitles()).toEqual([
      "Alpha inactive",
      "Zulu inactive",
      "Aardvark completed",
    ]);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort: Next run, ascending" }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Loop name" }));
    expect(rowTitles()).toEqual([
      "Alpha inactive",
      "Zulu inactive",
      "Aardvark completed",
    ]);
    fireEvent.keyDown(document, { key: "Escape" });
    show(/^All/);
    expect(rowTitles()).toEqual([
      "Alpha active",
      "Zulu active",
      "Aardvark pending",
    ]);
  });

  it("renders the production collection shell for an empty library", () => {
    render(
      <AutomationOverviewView
        entries={[]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );

    expect(screen.getByRole("tab", { name: "Overview0" })).toBeTruthy();
    expect(screen.getByText("No loops yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New loop" })).toBeTruthy();
  });

  it("opens a missing-prompt row in the standard editor", () => {
    const onOpenDetail = vi.fn();
    const healthyAutomation = INSTALLED_AUTOMATIONS[0]!.automation;
    if (
      "problem" in healthyAutomation ||
      healthyAutomation.execution.mode !== "agent"
    ) {
      throw new Error("Expected an agent automation fixture");
    }
    const entries: AutomationsOverviewResponse["automations"] = [
      {
        automation: {
          ...healthyAutomation,
          id: "auto_repair",
          name: "Needs a prompt",
          execution: { ...healthyAutomation.execution, prompt: "" },
          problem: "missing-agent-prompt",
        },
        project: { id: "proj_1", name: "bb" },
      },
      {
        automation: {
          id: "auto_invalid",
          projectId: "proj_1",
          name: "Unreadable automation",
          problem: "invalid-stored-data",
        },
        project: { id: "proj_1", name: "bb" },
      },
      ...INSTALLED_AUTOMATIONS,
    ];
    render(
      <AutomationOverviewView
        entries={entries}
        error={null}
        onRetry={() => {}}
        onOpenDetail={onOpenDetail}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );

    expect(screen.getByText("Needs a prompt")).toBeTruthy();
    expect(screen.getByText("Unreadable automation")).toBeTruthy();
    expect(screen.getByText("Nightly digest")).toBeTruthy();
    expect(screen.getAllByText("9AM")).toHaveLength(2);

    const search = screen.getByPlaceholderText("Search loops");
    fireEvent.change(search, { target: { value: "Prompt required" } });
    expect(screen.getByText("Needs a prompt")).toBeTruthy();
    expect(screen.queryByText("Unreadable automation")).toBeNull();
    expect(screen.queryByText("Nightly digest")).toBeNull();

    fireEvent.change(search, { target: { value: "Invalid data" } });
    expect(screen.queryByText("Needs a prompt")).toBeNull();
    expect(screen.getByText("Unreadable automation")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onOpenDetail).toHaveBeenCalledWith(
      { projectId: "proj_1", automationId: "auto_repair" },
      { editing: true },
    );
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  });

  it("groups running loops by repo in the side menu and keeps paused ones under Off", () => {
    const base = INSTALLED_AUTOMATIONS[0]!;
    if ("problem" in base.automation) throw new Error("Expected a loop");
    const loop = (
      id: string,
      projectId: string,
      name: string,
      enabled = true,
    ) => ({
      automation: { ...base.automation, id, projectId, name, enabled },
      project: { id: projectId, name: projectId === "proj_1" ? "bb" : "notes" },
    });
    render(
      <AutomationOverviewView
        entries={[
          loop("auto_1", "proj_1", "Nightly digest"),
          loop("auto_2", "proj_1", "Weekly report"),
          loop("auto_3", "proj_2", "Notes sync"),
          loop("auto_4", "proj_2", "Old cleanup", false),
        ]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
        templates={{
          projects: [
            { id: "proj_1", name: "bb", path: null, github: "acme/bb-app" },
            { id: "proj_2", name: "notes", path: null, github: null },
          ],
          onAdd: async () => {},
          locked: false,
          onUpgrade: () => {},
        }}
      />,
    );
    const menu = screen.getByRole("navigation", { name: "Repos" });
    const item = (name: RegExp) => within(menu).getByRole("button", { name });
    expect(item(/^All3$/)).toBeTruthy();
    expect(
      item(/^bb-app2$/).querySelector('[data-icon="GithubLogo"]'),
    ).toBeTruthy();
    expect(item(/^notes1$/).querySelector('[data-icon="Laptop"]')).toBeTruthy();
    expect(item(/^Off1$/)).toBeTruthy();
    expect(screen.queryByText("Old cleanup")).toBeNull();

    fireEvent.click(item(/^notes/));
    expect(item(/^notes/).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Notes sync")).toBeTruthy();
    expect(screen.queryByText("Nightly digest")).toBeNull();
    expect(screen.getByText("1 loop running")).toBeTruthy();

    fireEvent.click(item(/^Off/));
    expect(screen.getByText("Old cleanup")).toBeTruthy();
    expect(screen.queryByText("Notes sync")).toBeNull();
  });

  it("uses compact, icon-free sort options and preserves disabled state", () => {
    render(
      <AutomationOverviewView
        entries={INSTALLED_AUTOMATIONS}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );

    const sortTrigger = screen.getByRole("button", {
      name: "Sort: Next run, ascending",
    });
    expect(sortTrigger.querySelector('[data-icon="ArrowUpDown"]')).toBeTruthy();
    fireEvent.pointerDown(sortTrigger);
    const projectOption = screen.getByRole("menuitemradio", {
      name: "Project",
    });
    const nextOption = screen.getByRole("menuitemradio", {
      name: "Next run",
    });
    const nameOption = screen.getByRole("menuitemradio", {
      name: "Loop name",
    });
    expect(projectOption.getAttribute("aria-disabled")).toBe("true");
    expect(projectOption.getAttribute("aria-checked")).toBe("false");
    expect(nameOption.getAttribute("aria-checked")).toBe("false");
    expect(nextOption.getAttribute("aria-checked")).toBe("true");
    expect(iconNames(projectOption)).toEqual(["ArrowUp"]);
    expect(iconNames(nextOption)).toEqual(["ArrowUp"]);
    fireEvent.click(nextOption);
    expect(sortTrigger.querySelector('[data-icon="ArrowUpDown"]')).toBeTruthy();
    expect(iconNames(nextOption)).toEqual(["ArrowDown"]);
    expect(sortTrigger.getAttribute("aria-label")).toBe(
      "Sort: Next run, descending",
    );
  });

  it("preserves sort selection semantics in the compact viewport drawer", async () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <AutomationOverviewView
          entries={INSTALLED_AUTOMATIONS}
          error={null}
          onRetry={() => {}}
          onOpenDetail={() => {}}
          onEnabledChange={async () => {}}
          onPriorityChange={async () => {}}
          onCreateViaChat={() => {}}
          activeMode="installed"
          onModeChange={() => {}}
        />
      </CompactViewportOverrideProvider>,
    );

    const sortTrigger = screen.getByRole("button", {
      name: "Sort: Next run, ascending",
    });
    fireEvent.click(sortTrigger);

    const projectOption = await screen.findByRole("menuitemradio", {
      name: "Project",
    });
    const nameOption = screen.getByRole("menuitemradio", {
      name: "Loop name",
    });
    expect(projectOption.getAttribute("aria-checked")).toBe("false");
    expect(projectOption.getAttribute("aria-disabled")).toBe("true");
    expect((projectOption as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByRole("menuitemradio", { name: "Next run" }).ariaChecked,
    ).toBe("true");
    expect(
      screen
        .getAllByRole("menuitemradio")
        .filter((option) => option.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);

    fireEvent.click(projectOption);
    expect(sortTrigger.getAttribute("aria-label")).toBe(
      "Sort: Next run, ascending",
    );
    fireEvent.click(nameOption);
    expect(sortTrigger.getAttribute("aria-label")).toBe(
      "Sort: Loop name, ascending",
    );
    expect(nameOption.getAttribute("aria-checked")).toBe("true");
  });

  it("shows each automation's agents, schedule, and next run", () => {
    const base = INSTALLED_AUTOMATIONS[0]!;
    if ("problem" in base.automation) throw new Error("Expected a fixture");
    const script = {
      ...base.automation,
      id: "auto_sweep",
      name: "Security sweep",
      execution: { mode: "script" as const, script: "echo", timeoutMs: 1000 },
    };
    render(
      <AutomationOverviewView
        entries={[
          base,
          {
            ...base,
            automation: script,
            scriptAgents: [
              {
                providerId: "codex",
                model: "gpt-6.1-sol",
                reasoningLevel: "max",
              },
              {
                providerId: "claude",
                model: "claude-opus-5-5[1m]",
                reasoningLevel: "max",
              },
            ],
          },
          {
            ...base,
            automation: { ...script, id: "auto_plain", name: "Plain script" },
          },
        ]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );

    const row = (name: string) =>
      screen.getByText(name).closest<HTMLElement>("[data-loop-card]")!;
    const digest = row("Nightly digest");
    expect(digest.textContent).toContain("Opus 5·Medium");
    expect(digest.textContent).toContain("9AM");
    expect(digest.textContent).toMatch(/in \d+d/);
    expect(digest.querySelector('[aria-label^="Priority 3 "]')).toBeTruthy();
    expect(row("Security sweep").textContent).toContain(
      "GPT-6.1 Sol ⇄ Opus 5.5 (1M)·Max",
    );
    expect(row("Plain script").textContent).toContain("Script");
    expect(screen.getAllByText("bb")).toHaveLength(1);
    expect(screen.getByText("3 loops running")).toBeTruthy();
  });

  it("shows Personal as project membership and keeps it searchable", async () => {
    render(
      <AutomationOverviewView
        entries={[
          {
            ...INSTALLED_AUTOMATIONS[0]!,
            project: { id: "proj_personal", name: "Personal" },
          },
          {
            ...INSTALLED_AUTOMATIONS[0]!,
            automation: {
              ...INSTALLED_AUTOMATIONS[0]!.automation,
              id: "auto_other",
              name: "Other digest",
            },
          },
        ]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );
    const icon = screen.getByRole("img", { name: "Project: Personal" });
    expect(icon.querySelector('[data-icon="Laptop"]')).not.toBeNull();
    expect(icon.parentElement?.textContent).toBe("Personal");
    fireEvent.change(screen.getByPlaceholderText("Search loops"), {
      target: { value: "Personal" },
    });
    expect(screen.getByText("Nightly digest")).toBeTruthy();
    expect(screen.queryByText("Other digest")).toBeNull();
    focusWithKeyboard(icon);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Project: Personal",
    );
  });

  it("does not treat a project named Local as the personal project", () => {
    const namedLocalEntry = {
      ...INSTALLED_AUTOMATIONS[0]!,
      project: { id: "proj_named_local", name: "Local" },
    };
    const { container } = render(
      <AutomationOverviewView
        entries={[
          namedLocalEntry,
          {
            ...INSTALLED_AUTOMATIONS[0]!,
            automation: {
              ...INSTALLED_AUTOMATIONS[0]!.automation,
              id: "auto_other",
            },
          },
        ]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );

    expect(
      container.querySelector(
        '[aria-label="Local project"] [data-icon="Laptop"]',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Project: Local" })).toBeNull();
  });
  it("shows each loop's saved priority, saves a new one, and drops a failed pick", async () => {
    const base = INSTALLED_AUTOMATIONS[0]!;
    if ("problem" in base.automation) throw new Error("Expected a loop");
    const first = { ...base, automation: { ...base.automation, priority: 1 } };
    const second = {
      ...base,
      automation: { ...base.automation, id: "auto_2", name: "Weekly report" },
    };
    const onPriorityChange = vi
      .fn<(route: { projectId: string; automationId: string }, priority: number) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"));
    render(
      <AutomationOverviewView
        entries={[first, second]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={onPriorityChange}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );
    const pick = async (name: string, level: number) => {
      fireEvent.pointerDown(
        screen.getByRole("button", { name: new RegExp(`^Priority \\d for ${name}`) }),
        { button: 0, ctrlKey: false },
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: new RegExp(`Priority ${level}`) }),
      );
    };
    expect(
      screen.getByRole("button", { name: /^Priority 1 for Nightly digest/ }),
    ).toBeTruthy();
    await pick("Weekly report", 2);
    expect(onPriorityChange).toHaveBeenCalledWith(
      { projectId: "proj_1", automationId: "auto_2" },
      2,
    );
    expect(
      screen.getByRole("button", { name: /^Priority 2 for Weekly report/ }),
    ).toBeTruthy();
    await pick("Nightly digest", 4);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Priority 1 for Nightly digest/ }),
      ).toBeTruthy(),
    );
  });

  it("adds a template at the template's priority", async () => {
    const onAdd = vi.fn(async () => {});
    render(
      <AutomationOverviewView
        entries={[]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="templates"
        onModeChange={() => {}}
        templates={{
          projects: [
            { id: "proj_1", name: "Repo one", path: "/repo-one", github: null },
          ],
          onAdd,
          locked: false,
          onUpgrade: () => {},
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add Security sweep to repos" }),
    );
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Add to 1 repo" }));
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Security sweep", priority: 1 }),
        ["proj_1"],
        "cloud",
      ),
    );
  });

  it("tags loops whose last run failed", () => {
    const base = INSTALLED_AUTOMATIONS[0]!;
    const failed = {
      ...base,
      automation: {
        ...base.automation,
        id: "auto_2",
        name: "Broken sync",
        lastRunStatus: "failed" as const,
        lastError: "Agent exited with code 1",
      },
    };
    render(
      <AutomationOverviewView
        entries={[base, failed]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onPriorityChange={async () => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );
    const row = (name: string) =>
      screen.getByText(name).closest<HTMLElement>("[data-loop-card]")!;
    expect(row("Broken sync").textContent).toContain("Failed");
    expect(
      row("Broken sync").querySelector('[title="Agent exited with code 1"]'),
    ).toBeTruthy();
    expect(row("Nightly digest").textContent).not.toContain("Failed");
  });
});
