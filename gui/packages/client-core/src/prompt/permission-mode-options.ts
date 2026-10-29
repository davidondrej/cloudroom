import type { PermissionMode } from "@cloudroom/domain";

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  description: string;
  tone?: "warning";
}

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: "accept-edits",
    label: "Manual",
    description: "Asks before anything else",
  },
  {
    value: "auto",
    label: "Auto",
    description: "AI reviews, risky stuff asks",
  },
  {
    value: "full",
    label: "Full Access",
    tone: "warning",
    description: "No sandbox, no limits",
  },
];
