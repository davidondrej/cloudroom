import { COMPUTER_TITLE } from "@cloudroom/domain";
import { useEffect } from "react";
import { useQueries } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { pluginSettingsViewQueryOptions } from "@/hooks/queries/plugin-settings-queries";
import { APP_COMMAND_GROUPS } from "@/lib/app-command-metadata";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { usePluginSlots } from "@/lib/plugin-slots";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import type { PluginSettingsEntry } from "./plugin-settings-entries";
import {
  getSettingsGroupLinks,
  SETTINGS_NAV_GROUPS,
  type SettingsNavSection,
  type SettingsSectionId,
} from "./settings-sections";

type SettingsPageId = SettingsSectionId | (string & {});

export interface SettingsSearchEntry {
  heading?: string;
  keywords?: string;
  label: string;
  page: SettingsPageId;
}

export interface SettingsSearchResult {
  key: string;
  label: string;
  path: string;
  target: string | null;
  to: string;
}

interface SettingsSearchState {
  activePluginId: string | null;
  activeSection: SettingsSectionId | null;
  pluginEntries: readonly PluginSettingsEntry[];
  sections: readonly SettingsNavSection[];
}

const entries = (
  page: SettingsPageId,
  heading: string | undefined,
  items: readonly (string | readonly [string, string])[],
): SettingsSearchEntry[] =>
  items.map((item) =>
    typeof item === "string"
      ? { page, heading, label: item }
      : { page, heading, label: item[0], keywords: item[1] },
  );

const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  ...entries("general", "Threads & editing", [
    ["Navigate to threads on creation", "open jump new thread"],
    ["Markdown formatting in prompt box", "rich text composer editor"],
    ["Default thread followup behavior", "queue steer enter follow up message"],
  ]),
  ...entries("general", "Links", [
    ["Open links in the in-app browser", "web url"],
    ["Rewrite localhost links", "port preview url"],
  ]),
  ...entries("general", "Git", [
    ["New branch prefix", "branch name worktree"],
    ["Delete archived worktrees after", "worktree cleanup auto delete retention days never"],
  ]),
  ...entries("general", "Skills", [["Cloudroom CLI skills", "install agents"]]),
  ...entries("general", "Thread naming", [
    ["Thread naming", "title rename name"],
    ["Model", "thread naming llm harness provider fallback"],
    ["Rules", "thread naming title"],
    ["Rename vague titles", "thread naming"],
  ]),
  ...entries("general", "Thread purpose", [
    ["Thread purpose", "goal summary percent done progress hover"],
    ["Show in sidebar", "thread purpose hover preview card left"],
    ["Reasoning effort", "thread purpose thinking"],
  ]),
  ...entries("general", "Wrong-project hint", [
    ["Wrong-project hint", "project nudge suggest switch jev"],
    ["Confidence", "wrong project hint nudge sensitivity percent"],
  ]),
  ...entries("general", "Voice Input", [
    ["Voice Input", "dictation speech talk"],
    ["Microphone", "mic audio dictation voice"],
  ]),
  ...entries("general", "Privacy & diagnostics", [
    ["Streamer mode", "hide secrets screen share recording privacy"],
    ["Share usage data and setup errors", "telemetry analytics privacy"],
    ["Send agent feedback", "bug reports privacy"],
    ["Show diagnostic events", "debug logs errors"],
  ]),
  ...entries("push-notifications", undefined, [["Notifications", "alerts push"]]),
  ...entries("keep-awake", undefined, [["Keep Awake", "sleep caffeinate"]]),
  ...entries("provider-usage", undefined, [["Usage", "limits quota tokens"]]),
  ...entries("custom-instructions", undefined, [
    ["Custom instructions", "agents.md prompt rules"],
  ]),
  ...entries("connect", undefined, [["Cloudroom Connect", "phone mobile remote"]]),
  ...entries("browser", undefined, [
    ["Browsers", "import chrome safari arc bookmarks cookies"],
  ]),
  ...entries("files", "File Preferences", [
    ["Local editor integration", "vscode cursor ide open"],
    ["Directory default", "open folder editor finder"],
    ["File default", "open editor ide"],
  ]),
  ...entries("files", undefined, [["File openers", "extension open with app"]]),
  ...entries("appearance", "Appearance", [
    ["Sidebar", "thread list"],
    ["Navigation", "sidebar"],
    ["Collapse subagents", "sidebar child threads subthreads fold hide expand"],
    ["Harness icons", "sidebar claude code codex provider agent logo"],
    ["Source code", "syntax highlighting renderer"],
    ["Diffs", "changes renderer"],
    ["Theme", "dark mode light mode system color scheme"],
    ["Corners", "rounded sharp radius"],
    ["Palette", "colors custom theme"],
    ["Favicon color", "icon dock tab"],
    ["Fade inactive splits", "dim split panes"],
    ["Sidebar footer", "buttons reorder"],
    ["Question cards", "agent questions ask"],
    ["Always show one-click prompts", "starter prompts new thread security pills"],
  ]),
  ...entries("keyboard", undefined, [
    ["Keyboard shortcuts", "hotkeys keybindings keys"],
    ["Show keyboard hints when holding CMD / Control", "hotkeys command"],
  ]),
  ...APP_COMMAND_GROUPS.flatMap((group) =>
    group.commands.map((command) => ({
      page: "keyboard",
      heading: "Keyboard shortcuts",
      label: command.label,
      keywords: `${group.label} shortcut hotkey keybinding`,
    })),
  ),
  ...entries("providers", undefined, [
    ["Providers", "claude code codex pi acp cli install harness agents version update auto-update login log in connect cloud mac"],
    ["Not installed", "install add agent cli harness provider"],
    ["Collapse finished turns", "timeline"],
  ]),
  ...entries("defaults", "Defaults", [
    ["Starting machine", "cloud local last used new thread"],
    ["Remove AI co-authors", "git commit co-authored-by attribution claude cursor"],
  ]),
  ...entries("cloud-environment", "Cloud environment", [
    ["GitHub", "account token gh push pr"],
    ["API keys", "secrets environment variables env tokens"],
    ["Skills", "cloud skills"],
    ["MCP servers", "mcp tools model context protocol cloud"],
    ["GitHub repos", "clone repositories sandbox"],
    ["Setup script", "install sandbox startup cli clis tools"],
  ]),
  ...entries("auto-delete", "Auto-delete", [
    ["Delete unused cloud threads", "retention delete old cloud threads sessions history days year never"],
  ]),
  ...entries("projects", undefined, [
    ["Projects", "repos folders rename delete"],
    ["Hidden projects", "hide unhide restore sidebar removed"],
  ]),
  ...entries("import", undefined, [["Import chats", "history migrate"]]),
  ...entries("export", undefined, [["Export chats", "history backup download markdown json"]]),
  ...entries("archived", undefined, [["Archived threads", "restore unarchive"]]),
  ...entries("account", undefined, [
    ["Cloudroom account", "sign in login email account sign out"],
    ["Plan & billing", "billing plan subscription invoices upgrade pro ultra payment cloud credits buy packs"],
    ["Connected", "github claude code codex logins connected"],
    ["Invite friends", "invite friend referral share $400 credits"],
    ["Or connect your own Core", "self-hosted core url api token server"],
  ]),
  ...entries("machines", undefined, [
    [`${COMPUTER_TITLE} access`, "mac computer access cloud agents permission full read-only ask off"],
    ["Where your agents run", "machines mac computer devices rename vps server cloud"],
    ["Connection method", "ssh remote machine access"],
    ["Server address", "url host remote"],
    ["Machine environment", "environment variables path gh_token shell"],
  ]),
  ...entries("updates", undefined, [
    ["Cloudroom daemon", "version update restart"],
    ["Machine updates", "update version"],
  ]),
  ...entries("marketplaces", undefined, [
    ["Plugin marketplaces", "extensions add store"],
  ]),
  ...entries("plugins", undefined, [["Installed plugins", "extensions"]]),
  ...entries("command-guard", undefined, [
    ["Command Guard", "safety dangerous commands rm block protect"],
  ]),
  ...entries("system-prompt", undefined, [
    ["Cloudroom system prompt", "instructions agents"],
  ]),
  ...entries("experiments", "Experiments", [
    ["Changelog preview", "beta release notes"],
    ["Multi-machine picker", "beta"],
    ["Sidebar progressive disclosure", "beta"],
    ["Timeline windowing", "beta performance"],
  ]),
  ...entries("community", "Community", [
    ["Website", "blog"],
    ["GitHub", "source code issues"],
    ["Getting started", "docs help guide"],
    ["Changelog", "release notes what's new"],
  ]),
];

const STOP_WORDS = new Set([
  "a", "an", "and", "can", "change", "disable", "do", "enable", "find",
  "for", "how", "i", "in", "is", "my", "of", "off", "on", "set", "setting",
  "settings", "the", "to", "turn", "where",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (a[i] === b[i]) i++;
  return (
    a.slice(i + 1) === b.slice(i + 1) ||
    a.slice(i) === b.slice(i + 1) ||
    a.slice(i + 1) === b.slice(i) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
  );
}

function tokenQuality(token: string, word: string): number {
  if (word === token) return 1;
  if (word.startsWith(token)) return 0.9;
  if (token.length >= 3 && word.includes(token)) return 0.6;
  if (token.length < 4) return 0;
  if (word.length >= 4 && withinOneEdit(token, word)) return 0.5;
  if (token.length < 5) return 0;
  for (let length = token.length - 1; length <= token.length + 1; length++) {
    if (word.length > length && withinOneEdit(token, word.slice(0, length))) {
      return 0.3;
    }
  }
  return 0;
}

function bestQuality(token: string, fieldWords: readonly string[]): number {
  let best = 0;
  for (const word of fieldWords) {
    best = Math.max(best, tokenQuality(token, word));
    if (best === 1) break;
  }
  return best;
}

interface SearchDocument extends SettingsSearchResult {
  fields: readonly (readonly [readonly string[], number])[];
}

function scoreDocument(
  doc: SearchDocument,
  tokens: readonly string[],
  phrase: string,
): { matched: number; score: number; typos: number } {
  let matched = 0;
  let score = 0;
  let typos = 0;
  for (const token of tokens) {
    let best = 0;
    let quality = 0;
    for (const [fieldWords, weight] of doc.fields) {
      const fieldQuality = bestQuality(token, fieldWords);
      best = Math.max(best, fieldQuality * weight);
      quality = Math.max(quality, fieldQuality);
    }
    if (quality > 0) matched++;
    if (quality > 0 && quality < 0.6) typos++;
    score += best;
  }
  const label = doc.label.toLowerCase();
  if (label === phrase) score += 5;
  else if (label.startsWith(phrase)) score += 3;
  return { matched, score, typos };
}

function buildDocuments(
  state: SettingsSearchState,
  pluginEntries: readonly SettingsSearchEntry[],
): SearchDocument[] {
  const docs: SearchDocument[] = [];
  const pages = new Map<string, { group: string; label: string; to: string }>();
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const link of getSettingsGroupLinks(group, state)) {
      pages.set(link.key, { group: group.label, label: link.label, to: link.to });
      const path = link.label === group.label ? "" : group.label;
      docs.push({
        key: `page:${link.key}`,
        label: link.label,
        path,
        target: null,
        to: link.to,
        fields: [
          [words(link.label), 3],
          [words(group.label), 2],
        ],
      });
    }
  }
  for (const entry of state.pluginEntries) {
    if (pages.has(entry.id)) continue;
    const to = getPluginConfigurationRoutePath({ pluginId: entry.id });
    pages.set(entry.id, { group: "Plugins", label: entry.label, to });
    docs.push({
      key: `page:${entry.id}`,
      label: entry.label,
      path: "Plugins",
      target: null,
      to,
      fields: [
        [words(entry.label), 3],
        [["plugins", "plugin"], 1.5],
      ],
    });
  }
  for (const entry of [...SETTINGS_SEARCH_ENTRIES, ...pluginEntries]) {
    const page = pages.get(entry.page);
    if (!page) continue;
    const path = [page.group, page.label, entry.heading]
      .filter((part, index, all): part is string =>
        part !== undefined && part !== entry.label && all.indexOf(part) === index,
      )
      .join(" › ");
    docs.push({
      key: `setting:${entry.page}:${entry.heading ?? ""}:${entry.label}`,
      label: entry.label,
      path,
      target: entry.label,
      to: page.to,
      fields: [
        [words(entry.label), 3],
        [words(`${page.group} ${page.label} ${entry.heading ?? ""}`), 2],
        [words(entry.keywords ?? ""), 1.5],
      ],
    });
  }
  return docs;
}

export function searchSettings(
  query: string,
  state: SettingsSearchState,
  pluginEntries: readonly SettingsSearchEntry[] = [],
): SettingsSearchResult[] {
  const allTokens = words(query);
  const meaningful = allTokens.filter((token) => !STOP_WORDS.has(token));
  const tokens = meaningful.length > 0 ? meaningful : allTokens;
  if (tokens.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const best = buildDocuments(state, pluginEntries).flatMap((doc, index) => {
    const result = scoreDocument(doc, tokens, phrase);
    return result.matched === tokens.length ? [{ doc, index, ...result }] : [];
  });
  const fewestTypos = Math.min(...best.map(({ typos }) => typos));
  const seen = new Set<string>();
  return best
    .filter(({ typos }) => typos === fewestTypos)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .flatMap(({ doc }) => {
      const id = `${doc.label}|${doc.to}`;
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ key: doc.key, label: doc.label, path: doc.path, target: doc.target, to: doc.to }];
    })
    .slice(0, 50);
}

export function usePluginSettingsSearchEntries(
  pluginIds: readonly string[],
  enabled: boolean,
): SettingsSearchEntry[] {
  const { settingsSections } = usePluginSlots();
  const views = useQueries({
    queries: pluginIds.map((pluginId) =>
      pluginSettingsViewQueryOptions(pluginId, { enabled }),
    ),
  });
  const sectionEntries = settingsSections.flatMap((section) =>
    section.title
      ? [{ page: section.pluginId, label: section.title, keywords: section.description }]
      : [],
  );
  const fieldEntries = views.flatMap((view, index) =>
    Object.values(view.data?.schema ?? {}).map((field) => ({
      page: pluginIds[index]!,
      label: field.label,
      keywords: field.description,
    })),
  );
  return [...sectionEntries, ...fieldEntries];
}

const reportedMisses = new Set<string>();

export function useReportSettingsSearchMiss(query: string | null): void {
  useEffect(() => {
    const missed = query?.trim().toLowerCase().replace(/\s+/g, " ");
    if (!missed || missed.length > 200 || reportedMisses.has(missed)) return;
    const timer = setTimeout(() => {
      reportedMisses.add(missed);
      void fetchWithAppSurface("/api/v1/cloudroom/settings-search-miss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: missed }),
      }).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [query]);
}

const HIGHLIGHT_CLASSES = ["rounded-md", "bg-accent", "ring-2", "ring-primary/50"];
const TARGET_SELECTOR = "h2, h3, p, span, summary, label";
const ROW_SELECTOR = "[data-control-placement], .divide-y > *, section";

function findSettingsTarget(root: HTMLElement, label: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(TARGET_SELECTOR)) {
    if (element.textContent?.trim() !== label) continue;
    const row = element.closest<HTMLElement>(ROW_SELECTOR);
    return row && row.offsetHeight < window.innerHeight / 2 ? row : element;
  }
  return null;
}

export function useRevealSettingsTarget(rootId: string): string | undefined {
  const location = useLocation();
  const state: unknown = location.state;
  const target =
    typeof state === "object" && state !== null && "settingsTarget" in state
      ? state.settingsTarget
      : null;
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (typeof target !== "string" || !root) return;
    let revealed: HTMLElement | null = null;
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      const element = findSettingsTarget(root, target);
      if (!element) return false;
      for (
        let details = element.closest("details");
        details;
        details = details.parentElement?.closest("details") ?? null
      ) {
        details.open = true;
      }
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.classList.add(...HIGHLIGHT_CLASSES);
      revealed = element;
      clearTimer = setTimeout(
        () => element.classList.remove(...HIGHLIGHT_CLASSES),
        2000,
      );
      return true;
    };
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    if (!reveal()) observer.observe(root, { childList: true, subtree: true });
    const stopTimer = setTimeout(() => observer.disconnect(), 5000);
    return () => {
      observer.disconnect();
      clearTimeout(stopTimer);
      clearTimeout(clearTimer);
      revealed?.classList.remove(...HIGHLIGHT_CLASSES);
    };
  }, [location.key, rootId, target]);
  return typeof target === "string" ? location.key : undefined;
}
