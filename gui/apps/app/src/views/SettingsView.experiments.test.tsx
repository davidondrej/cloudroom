// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentKey } from "@cloudroom/domain";
import { ExperimentsSettingsSection } from "./SettingsView";

afterEach(cleanup);

function renderSection(
  onExperimentChange: (key: ExperimentKey, enabled: boolean) => void,
) {
  return render(
    <ExperimentsSettingsSection
      disabled={false}
      experiments={{
        changelogPreview: false,
        mobileApp: false,
        multiMachinePicker: false,
        sidebarProgressiveDisclosure: false,
        timelineWindowing: false,
      }}
      onExperimentChange={onExperimentChange}
    />,
  );
}

describe("ExperimentsSettingsSection", () => {
  it("reports changelog preview changes", () => {
    const onChange = vi.fn();
    renderSection(onChange);
    fireEvent.click(screen.getByLabelText("Changelog preview"));
    expect(onChange).toHaveBeenCalledWith("changelogPreview", true);
  });

  it("does not offer native BB mobile pairing as a Cloudroom experiment", () => {
    const onChange = vi.fn();
    renderSection(onChange);
    expect(screen.queryByLabelText("Mobile app")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports multi-machine picker changes", () => {
    const onChange = vi.fn();
    renderSection(onChange);
    fireEvent.click(screen.getByLabelText("Multi-machine picker"));
    expect(onChange).toHaveBeenCalledWith("multiMachinePicker", true);
  });

  it("reports sidebar progressive disclosure changes", () => {
    const onChange = vi.fn();
    renderSection(onChange);
    fireEvent.click(screen.getByLabelText("Sidebar progressive disclosure"));
    expect(onChange).toHaveBeenCalledWith("sidebarProgressiveDisclosure", true);
  });

  it("reports timeline windowing changes", () => {
    const onChange = vi.fn();
    renderSection(onChange);
    fireEvent.click(screen.getByLabelText("Timeline windowing"));
    expect(onChange).toHaveBeenCalledWith("timelineWindowing", true);
  });
});
