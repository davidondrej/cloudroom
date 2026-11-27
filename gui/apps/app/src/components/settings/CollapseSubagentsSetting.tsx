import { Switch } from "@cloudroom/shared-ui/switch";
import { useAtom } from "jotai";
import {
  collapseChildThreadsAtom,
  showSubagentBarAtom,
} from "@/components/sidebar/sidebarCollapsedAtoms";
import { SettingsWithControl } from "@/components/ui/settings-section";

export const COLLAPSE_SUBAGENTS_SETTING_LABEL = "Collapse subagents";
const SUBAGENT_BAR_SETTING_LABEL = "Subagent bar";

export function CollapseSubagentsSetting() {
  const [collapsed, setCollapsed] = useAtom(collapseChildThreadsAtom);

  return (
    <SettingsWithControl
      label={COLLAPSE_SUBAGENTS_SETTING_LABEL}
      description="Threads an agent starts stay folded under their main thread in the sidebar."
    >
      <Switch
        checked={collapsed}
        onCheckedChange={setCollapsed}
        aria-label={COLLAPSE_SUBAGENTS_SETTING_LABEL}
      />
    </SettingsWithControl>
  );
}

export function SubagentBarSetting() {
  const [show, setShow] = useAtom(showSubagentBarAtom);

  return (
    <SettingsWithControl
      label={SUBAGENT_BAR_SETTING_LABEL}
      description="Shows the subagents a thread started in a bar under its title."
    >
      <Switch
        checked={show}
        onCheckedChange={setShow}
        aria-label={SUBAGENT_BAR_SETTING_LABEL}
      />
    </SettingsWithControl>
  );
}
