import { COMPUTER } from "@cloudroom/domain/computer-name";
import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Button } from "@cloudroom/shared-ui/button";
import { Checkbox } from "@cloudroom/shared-ui/checkbox";
import { Input } from "@cloudroom/shared-ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cloudroom/shared-ui/popover";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type {
  AutomationAgentSummary,
  AutomationsOverviewResponse,
} from "./src/rpc-types.js";
import type { TemplateUsage } from "./src/usage.js";
import type { CloudAutomation } from "./cloud-view.js";
import { formatAutomationTrigger } from "./lib/format-schedule.js";
import {
  LOOP_TEMPLATES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_PRIORITIES,
  type LoopTemplate,
  type TemplateCategory,
} from "./templates.js";

export interface TemplateProject {
  id: string;
  name: string;
  path: string | null;
  github: string | null;
}

export type LoopTarget = "cloud" | "local";

export interface LoopTemplatesState {
  projects: readonly TemplateProject[] | null;
  /** Creates one loop per project, Cloud or Local, at the template's priority. Resolves once every create has settled. */
  onAdd: (
    template: LoopTemplate,
    projectIds: string[],
    target: LoopTarget,
  ) => Promise<void>;
  /** True on the Free plan, null while the plan loads. */
  locked: boolean | null;
  onUpgrade: () => void;
  /** Each template's rough share of the weekly Claude or Codex limit, by template ID. Templates it can't price are missing. */
  usage?: TemplateUsage;
}

/** "~6%" or "<1%": a rough share of a weekly limit. */
export function shareLabel(percent: number | undefined): string | null {
  if (percent === undefined) return null;
  return percent < 1 ? "<1%" : `~${Math.round(percent)}%`;
}

type OverviewEntry = AutomationsOverviewResponse["automations"][number];

export const LOOP_PRIORITY_STYLE = {
  1: { ring: "border-[#ff7066] bg-[#ff7066]/15", text: "text-[#ff7066]" },
  2: { ring: "border-[#ff9a14] bg-[#ff9a14]/15", text: "text-[#ff9a14]" },
  3: { ring: "border-[#5297ff] bg-[#5297ff]/15", text: "text-[#5297ff]" },
  4: { ring: "border-muted-foreground", text: "text-muted-foreground" },
} as const;

export function LoopGroupDivider({
  label,
  title,
  count,
  hint,
  className,
}: {
  label: string;
  title?: string;
  count: number;
  hint?: string;
  className?: string;
}) {
  return (
    <div className="mb-2 mt-6 flex items-center gap-2.5 text-xs font-semibold">
      <span className={className}>{label}</span>
      {title ? <span className="text-foreground">{title}</span> : null}
      <span className="font-medium text-subtle-foreground">{count}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
      {hint ? (
        <span className="font-normal text-subtle-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

// Where a repo lives: on GitHub, or only on this computer.
function RepoIcon({ github }: { github: string | null }) {
  return (
    <Icon
      name={github ? "GithubLogo" : "Laptop"}
      className="size-3.5 shrink-0 text-subtle-foreground"
      aria-hidden
    />
  );
}

// The GitHub owner, or the folder for a repo that's only on this computer.
function repoHome(project: TemplateProject): string {
  return (
    project.github?.split("/")[0] ??
    project.path?.replace(/^\/(?:Users|home)\/[^/]+/u, "~") ??
    ""
  );
}

function TemplateRepoPicker({
  template,
  projects,
  activeIds,
  onAdd,
}: {
  template: LoopTemplate;
  projects: readonly TemplateProject[] | null;
  activeIds: ReadonlySet<string>;
  onAdd: LoopTemplatesState["onAdd"];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<LoopTarget>(
    template.localOnly ? "local" : "cloud",
  );
  const [pending, setPending] = useState(false);
  const on = activeIds.size > 0;
  const choosable = (projects ?? []).filter((p) => !activeIds.has(p.id));
  const needle = query.trim().toLowerCase();
  const visible = (projects ?? []).filter(
    (p) => needle === "" || p.name.toLowerCase().includes(needle),
  );
  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const submit = () => {
    setPending(true);
    void onAdd(template, [...selected], target).finally(() => {
      setPending(false);
      setSelected(new Set());
      setOpen(false);
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Add ${template.name} to repos`}
          className={cn(
            "h-7 gap-1 px-2 text-xs",
            on && "border-primary/40 text-primary hover:text-primary",
          )}
        >
          <Icon name={on ? "Check" : "Plus"} className="size-3.5" aria-hidden />
          {on ? "On" : "Add"}
          <Icon name="ChevronDown" className="size-3" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 border-foreground/10 p-0">
        <div className="relative border-b border-foreground/10">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${projects?.length ?? 0} repos`}
            aria-label="Search repos"
            className="h-9 rounded-none border-0 bg-transparent pl-8 text-sm focus-visible:ring-0"
          />
        </div>
        <div className="flex items-center px-2.5 pb-1 pt-2 text-2xs font-medium text-subtle-foreground">
          {projects === null ? "Loading repos…" : `${projects.length} repos`}
          {choosable.length > 0 ? (
            <button
              type="button"
              className="ml-auto cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={() => setSelected(new Set(choosable.map((p) => p.id)))}
            >
              Select all
            </button>
          ) : null}
        </div>
        <div className="max-h-[min(28rem,calc(var(--radix-popover-content-available-height)-6rem))] overflow-y-auto px-1 pb-1.5">
          {visible.map((project) => {
            const active = activeIds.has(project.id);
            const checked = active || selected.has(project.id);
            return (
              <label
                key={project.id}
                className={cn(
                  "flex h-7 cursor-pointer items-center gap-2 rounded-md px-2",
                  active ? "cursor-default" : "hover:bg-state-hover",
                  checked && !active && "bg-foreground/6",
                )}
              >
                <Checkbox
                  className="size-3.5 rounded-[4px] border-foreground/25 data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background [&_[data-icon-root]]:size-2.75"
                  checked={checked}
                  disabled={active || pending}
                  onCheckedChange={(value) =>
                    toggle(project.id, value === true)
                  }
                />
                <RepoIcon github={project.github} />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {project.name}
                </span>
                {active ? (
                  <span className="shrink-0 pl-2 text-2xs text-success">
                    running
                  </span>
                ) : (
                  <span className="max-w-[45%] shrink-0 truncate pl-2 text-left font-mono text-2xs text-subtle-foreground [direction:rtl]">
                    <bdi>{repoHome(project)}</bdi>
                  </span>
                )}
              </label>
            );
          })}
          {projects !== null && visible.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No repos match.
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 border-t border-foreground/10 p-2">
          <div
            role="group"
            aria-label="Runs on"
            className="flex rounded-md bg-foreground/5 p-0.5"
          >
            {(["cloud", "local"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={target === option}
                disabled={pending || (option === "cloud" && template.localOnly)}
                title={
                  option === "cloud"
                    ? template.localOnly
                      ? `Runs only on this ${COMPUTER}: Cloud threads can't see the project's threads`
                      : `Runs on Cloudroom's servers, even while this ${COMPUTER} is off`
                    : `Runs on this ${COMPUTER}, only while it is awake`
                }
                onClick={() => setTarget(option)}
                className={cn(
                  "flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
                  target === option && "bg-foreground/10 text-foreground",
                )}
              >
                <Icon
                  name={option === "cloud" ? "Cloud" : "Laptop"}
                  className="size-3.5"
                  aria-hidden
                />
                {option === "cloud" ? "Cloud" : "Local"}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto h-7 border-foreground/15 px-3 text-xs"
            disabled={selected.size === 0 || pending}
            onClick={submit}
          >
            {pending
              ? target === "cloud"
                ? "Starting…"
                : "Adding…"
              : `Add to ${selected.size} repo${selected.size === 1 ? "" : "s"}`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TemplateCard({
  template,
  repos,
  activeIds,
  projects,
  usage,
  renderAgent,
  onAdd,
}: {
  template: LoopTemplate;
  repos: readonly { name: string; github: string | null }[];
  activeIds: ReadonlySet<string>;
  projects: readonly TemplateProject[] | null;
  usage: TemplateUsage[string] | undefined;
  renderAgent: (agent: AutomationAgentSummary) => ReactNode;
  onAdd: LoopTemplatesState["onAdd"];
}) {
  const on = repos.length > 0;
  return (
    <div className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] content-start items-center gap-x-2.5 rounded-lg border border-border bg-surface-raised p-3.5">
      <Icon
        name={template.icon}
        className={cn(
          "size-4",
          on ? "text-primary" : "text-muted-foreground/70",
        )}
        aria-hidden
      />
      <span className="truncate text-base font-semibold text-foreground">
        {template.name}
      </span>
      <TemplateRepoPicker
        template={template}
        projects={projects}
        activeIds={activeIds}
        onAdd={onAdd}
      />
      <p className="col-span-2 col-start-2 mt-1 text-sm leading-snug text-muted-foreground">
        {template.description}
      </p>
      <span className="col-span-2 col-start-2 mt-3 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/80">
        {renderAgent({
          providerId: template.providerId,
          model: template.model,
          reasoningLevel: template.reasoningLevel,
        })}
      </span>
      {/* The schedule and what it costs share a line: the schedule drives the usage. */}
      <span className="col-span-2 col-start-2 mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/80">
        <span className="shrink-0">
          {formatAutomationTrigger({
            triggerType: "schedule",
            cron: template.cron,
            timezone: "UTC",
          }).replace(/^On the hour, every/u, "Every")}
        </span>
        {usage ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span
              className="min-w-0 truncate"
              title={`A rough share of your weekly ${usage.limit} limit, from what this loop's runs usually use`}
            >
              <span className="text-foreground">
                {shareLabel(usage.percent)}
              </span>{" "}
              of weekly limit
            </span>
          </>
        ) : null}
      </span>
      {on ? (
        <span className="col-span-2 col-start-2 mt-2 flex flex-wrap gap-1">
          {repos.slice(0, 3).map((repo) => (
            <span
              key={repo.name}
              className="inline-flex h-5 items-center gap-1 rounded-[5px] bg-foreground/7 px-1.5 text-[11.5px] text-foreground"
            >
              <RepoIcon github={repo.github} />
              {repo.name}
            </span>
          ))}
          {repos.length > 3 ? (
            <span className="inline-flex h-5 items-center rounded-[5px] bg-foreground/7 px-1.5 text-[11.5px] text-subtle-foreground">
              +{repos.length - 3} more
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

const SKELETON_TITLE_WIDTHS = ["w-1/2", "w-2/5", "w-3/5"] as const;

function SkeletonCard({ index }: { index: number }) {
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg border border-border bg-surface-raised p-3.5">
      <span className="size-4 rounded-[5px] bg-foreground/15" />
      <span
        className={cn(
          "h-3 rounded bg-foreground/20",
          SKELETON_TITLE_WIDTHS[index % 3],
        )}
      />
      <span className="h-7 w-16 rounded-md border border-border" />
      <span className="col-span-2 col-start-2 mt-3 flex flex-col gap-2">
        <span className="h-2 w-11/12 rounded bg-foreground/12" />
        <span
          className={cn(
            "h-2 rounded bg-foreground/12",
            index % 2 ? "w-1/2" : "w-3/4",
          )}
        />
      </span>
      <span className="col-span-2 col-start-2 mt-4 flex gap-2">
        <span className="h-1.5 w-16 rounded bg-foreground/10" />
        <span className="h-1.5 w-10 rounded bg-foreground/10" />
        <span className="h-1.5 w-20 rounded bg-foreground/10" />
      </span>
    </div>
  );
}

function LockedTemplates({
  checking,
  onUpgrade,
}: {
  checking: boolean;
  onUpgrade: () => void;
}) {
  return (
    <div className="relative h-[44rem] overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none select-none opacity-85 blur-[6px] [mask-image:linear-gradient(to_bottom,#000,rgb(0_0_0/0.55)_30%,transparent_62%)]"
      >
        {[0, 1, 2].map((group) => (
          <div key={group}>
            <div
              className={cn(
                "mb-2 flex items-center gap-2.5",
                group > 0 && "mt-6",
              )}
            >
              <span className="h-2 w-4 rounded bg-foreground/20" />
              <span className="h-2 w-20 rounded bg-foreground/15" />
              <span className="h-px flex-1 bg-border" />
              <span className="h-1.5 w-28 rounded bg-foreground/10" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((card) => (
                <SkeletonCard key={card} index={group + card} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {checking ? null : (
        <div className="absolute inset-x-0 top-60 flex flex-col items-center gap-3.5 px-6 text-center">
          <Icon name="Zap" className="size-6 text-primary" aria-hidden />
          <h2 className="text-2xl font-semibold text-foreground">
            Unlock {LOOP_TEMPLATES.length} loop templates
          </h2>
          <p className="text-sm text-muted-foreground">
            Ready-made loops that keep your repos secure, clean, and reviewed.
          </p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {TEMPLATE_CATEGORIES.map((category) => (
              <span
                key={category.id}
                className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
              >
                {category.label}
                <span className="text-subtle-foreground">
                  {
                    LOOP_TEMPLATES.filter((t) => t.category === category.id)
                      .length
                  }
                </span>
              </span>
            ))}
          </div>
          <Button
            type="button"
            className="mt-1 h-9 gap-1.5 px-4"
            onClick={onUpgrade}
          >
            Upgrade to Pro
            <span className="font-normal opacity-70">$50/mo</span>
            <Icon name="ArrowRight" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

export interface LoopMenuItem<T extends string> {
  id: T;
  label: string;
  icon: string;
  count: number;
  title?: string;
  separated?: boolean;
}

export function LoopSideMenu<T extends string>({
  label,
  heading,
  items,
  value,
  onChange,
}: {
  label: string;
  heading: string;
  items: readonly LoopMenuItem<T>[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <nav aria-label={label} className="sticky top-0 flex flex-col gap-0.5">
      <div className="px-2.5 pb-1.5 text-2xs font-medium text-subtle-foreground">
        {heading}
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          title={item.title}
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
          className={cn(
            "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
            value === item.id && "bg-state-hover text-foreground",
            item.separated && "mt-3",
          )}
        >
          <Icon
            name={item.icon}
            className={cn(
              "size-3.5 shrink-0",
              value === item.id && "text-primary",
            )}
            aria-hidden
          />
          <span className="min-w-0 truncate">{item.label}</span>
          <span className="ml-auto text-2xs text-subtle-foreground">
            {item.count}
          </span>
        </button>
      ))}
    </nav>
  );
}

export function LoopTemplatesView({
  entries,
  cloudRows,
  templates,
  renderAgent,
}: {
  entries: readonly OverviewEntry[] | null;
  cloudRows: readonly CloudAutomation[];
  templates: LoopTemplatesState;
  renderAgent: (agent: AutomationAgentSummary) => ReactNode;
}) {
  const [category, setCategory] = useState<TemplateCategory | "all">("all");
  // Where each template runs: Local and Cloud loops that kept its name, per project.
  const running = useMemo(() => {
    const byName = new Map<string, Map<string, string>>();
    const add = (name: string, projectId: string, projectName: string) => {
      const projects = byName.get(name) ?? new Map<string, string>();
      projects.set(projectId, projectName);
      byName.set(name, projects);
    };
    for (const { automation, project } of entries ?? [])
      add(automation.name, project.id, project.name);
    for (const automation of cloudRows) {
      const project = templates.projects?.find(
        (p) => p.id === automation.project_id,
      );
      if (project) add(automation.name, project.id, project.name);
    }
    return byName;
  }, [entries, cloudRows, templates.projects]);
  const shown = LOOP_TEMPLATES.filter(
    (t) => category === "all" || t.category === category,
  );
  if (templates.locked !== false)
    return (
      <LockedTemplates
        checking={templates.locked === null}
        onUpgrade={templates.onUpgrade}
      />
    );

  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-start gap-7">
      <LoopSideMenu
        label="Template categories"
        heading="Categories"
        value={category}
        onChange={setCategory}
        items={[
          {
            id: "all" as const,
            label: "All",
            icon: "GridView",
            count: LOOP_TEMPLATES.length,
          },
          ...TEMPLATE_CATEGORIES.map((item) => ({
            ...item,
            count: LOOP_TEMPLATES.filter((t) => t.category === item.id).length,
          })),
        ]}
      />
      <div className="-mt-6 min-w-0">
        {TEMPLATE_PRIORITIES.map((priority) => {
          const group = shown.filter((t) => t.priority === priority.level);
          if (group.length === 0) return null;
          return (
            <section key={priority.level} aria-label={priority.label}>
              <LoopGroupDivider
                label={`P${priority.level}`}
                title={priority.label}
                count={group.length}
                hint={priority.hint}
                className={LOOP_PRIORITY_STYLE[priority.level].text}
              />
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                {group.map((template) => {
                  const active =
                    running.get(template.name) ?? new Map<string, string>();
                  return (
                    <TemplateCard
                      key={template.id}
                      template={template}
                      repos={[...active].map(([id, name]) => ({
                        name,
                        github:
                          templates.projects?.find((p) => p.id === id)
                            ?.github ?? null,
                      }))}
                      activeIds={new Set(active.keys())}
                      projects={templates.projects}
                      usage={templates.usage?.[template.id]}
                      renderAgent={renderAgent}
                      onAdd={templates.onAdd}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
