import type { IconName } from "@cloudroom/shared-ui/icon";
import { CREATE_PLUGIN_PROMPT } from "@cloudroom/client-core";

interface PluginExample {
  title: string;
  hook: string;
  icon: IconName;
  brief: string;
}

export const PLUGIN_EXAMPLES: readonly PluginExample[] = [
  {
    title: "Kanban board",
    hook: "Ship a board your agents move cards across while they work.",
    icon: "Columns2",
    brief:
      "adds a kanban board panel where each card is a thread, and agents move cards between columns as work progresses",
  },
  {
    title: "Live dashboard",
    hook: "Put the numbers your team actually checks on the Cloudroom homepage.",
    icon: "ChartColumn",
    brief:
      "adds a homepage dashboard with deploy frequency, open PR count, and CI pass rate, refreshed on an interval",
  },
  {
    title: "Chief of staff",
    hook: "Delegate your backlog and get briefed on only what needs you.",
    icon: "UserRound",
    brief:
      "adds a chief-of-staff panel that takes in my backlog, opens an agent thread for each item, keeps them moving by answering routine questions itself, and briefs me on progress and the few decisions only I can make",
  },
  {
    title: "Video editor",
    hook: "Drop in raw clips and let agents assemble a polished first cut.",
    icon: "Play",
    brief:
      "adds a video editor where I drop raw clips onto a timeline, agents assemble a first cut with trims, captions, and music, and I review the result and request changes in plain words",
  },
  {
    title: "Prototyping lab",
    hook: "Describe a product flow and compare working prototypes side by side.",
    icon: "Beaker",
    brief:
      "adds a prototyping lab where I describe a product flow in plain words, agents build several working prototypes in parallel, and I compare them side by side before choosing one to refine",
  },
  {
    title: "Support inbox",
    hook: "Triage user reports into fixes without leaving Cloudroom.",
    icon: "Mail",
    brief:
      "adds a support inbox that pulls in bug reports, clusters duplicates, drafts replies for my review, and opens a fix thread for each confirmed bug",
  },
];

export function briefPrompt({ brief }: { brief: string }): string {
  return `${CREATE_PLUGIN_PROMPT}${brief}.`;
}

interface UtilityExample {
  id: string;
  label: string;
  icon: IconName;
  brief: string;
}

export const UTILITY_EXAMPLES: readonly UtilityExample[] = [
  {
    id: "panel",
    label: "Panel",
    icon: "PanelLeft",
    brief:
      "adds a nav panel that lists my saved prompts and inserts one into the composer on click",
  },
  {
    id: "homepage-section",
    label: "Homepage section",
    icon: "SectionAdd",
    brief:
      "adds a homepage section showing yesterday's merged PRs and my review queue",
  },
  {
    id: "file-opener",
    label: "File opener",
    icon: "FileText",
    brief:
      "adds a file opener that renders CSV files as sortable, filterable tables",
  },
  {
    id: "cli-command",
    label: "CLI command",
    icon: "Terminal",
    brief:
      "adds a Cloudroom CLI command that deploys the current branch to staging and reports status",
  },
  {
    id: "background-service",
    label: "Background service",
    icon: "Zap",
    brief:
      "adds a background service that posts thread failures to a Slack webhook",
  },
  {
    id: "prompt-mentions",
    label: "Prompt mentions",
    icon: "MessageCirclePlus",
    brief: "connects Linear issues to the prompt box as searchable @-mentions",
  },
];
