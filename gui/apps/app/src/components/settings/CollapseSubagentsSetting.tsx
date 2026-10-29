import { Switch } from "@cloudroom/shared-ui/switch";
import { useAtom } from "jotai";
import { collapseChildThreadsAtom } from "@/components/sidebar/sidebarCollapsedAtoms";
import { SettingsWithControl } from "@/components/ui/settings-section";

export const COLLAPSE_SUBAGENTS_SETTING_LABEL = "Collapse subagents";

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
