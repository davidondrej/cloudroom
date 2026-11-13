import { useEffect, useState, type ReactNode } from "react";
import type { SkillSummary } from "@cloudroom/server-contract";
import { ResourceInfiniteScrollSentinel } from "@cloudroom/shared-ui/resource-pagination";
import { Skeleton } from "@cloudroom/shared-ui/skeleton";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@cloudroom/shared-ui/avatar";
import { Icon, type BuiltinIconName } from "@cloudroom/shared-ui/icon";
import {
  ResourceBrowseCard,
  ResourceBrowseGrid,
  ResourceCardStat,
  ResourceCollectionViewport,
  ResourceInstallControl,
  ResourceListState,
  ResourceOverflowMenu,
  ResourceSourceShelf,
  ResourceToolbar,
} from "@cloudroom/shared-ui/resource-list";
import {
  formatInstallCount,
  formatRegistrySource,
  REGISTRY_PAGE_SIZE,
} from "@/lib/skills-registry";
import type { RegistrySkill, RegistrySkillDetail } from "@/lib/skills-registry";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { SkillDetailView } from "@/components/tools/SkillDetailView";
import { TOOLS_PAGE_BAND_CLASSES } from "@/components/tools/tools-navigation";

function RegistrySkillActions({
  skillName,
  onFork,
  presentation = "label",
  featured = false,
}: {
  skillName: string;
  onFork: () => void;
  presentation?: "label" | "icon";
  featured?: boolean;
}) {
  return (
    <ResourceInstallControl
      accessibleLabel={`Fork ${skillName} into a new Cloudroom skill`}
      label="Fork"
      icon="Fork"
      presentation={presentation}
      tooltip={`Fork ${skillName}`}
      className={cn(
        presentation === "label" && "min-w-0",
        featured &&
          "border-ring bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
      )}
      onAction={onFork}
    />
  );
}

// David's own skills, pinned above the skills.sh list (David, 2026-11-11).
export const FEATURED_SKILLS_REPOSITORY = "davidondrej/skills";
export const FEATURED_SKILLS: readonly {
  id: string;
  icon: BuiltinIconName;
}[] = [
  { id: "davidondrej/skills/designs", icon: "Palette" },
  { id: "davidondrej/skills/deepapi", icon: "Globe" },
  { id: "davidondrej/skills/4x4", icon: "GridView" },
  { id: "davidondrej/skills/total-review", icon: "SecurityCheck" },
];

function RegistryOwnerAvatar({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const owner = formatRegistrySource(source).split("/")[0] ?? "";
  return (
    <Avatar
      className={cn(
        "size-8 rounded-md border border-border bg-muted",
        className,
      )}
    >
      <AvatarImage
        src={`https://github.com/${encodeURIComponent(owner)}.png?size=64`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
      <AvatarFallback
        aria-hidden
        className="rounded-[inherit] text-xs font-semibold text-subtle-foreground"
      >
        {owner.charAt(0).toLocaleUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

const SKILLS_SH_LINK_CLASS =
  "rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function RegistrySkillSocialProof({
  skill,
  installsKnown,
}: {
  skill: RegistrySkill;
  installsKnown: boolean;
}) {
  const installs = formatInstallCount(skill.installs);
  const stars = skill.stars !== null ? formatInstallCount(skill.stars) : null;
  return (
    <span className="inline-flex flex-nowrap items-center gap-1 text-[11px] leading-none">
      {installsKnown ? (
        <ResourceCardStat
          icon="Download"
          iconClassName="text-success"
          accessibleLabel={`${installs} installs`}
        >
          {installs}
        </ResourceCardStat>
      ) : null}
      {stars !== null ? (
        <ResourceCardStat
          icon="Star"
          iconClassName="fill-attention/20 text-attention"
          accessibleLabel={`${stars} stars`}
        >
          {stars}
        </ResourceCardStat>
      ) : null}
    </span>
  );
}

function RegistrySkillSourceItem({
  skill,
  installsKnown,
  featuredIcon,
  onFork,
  onSelect,
}: {
  skill: RegistrySkill;
  installsKnown: boolean;
  featuredIcon?: BuiltinIconName;
  onFork: (skill: RegistrySkill) => void;
  onSelect: (skill: RegistrySkill) => void;
}) {
  return (
    <ResourceBrowseCard
      className={
        featuredIcon ? "border-primary/45 bg-primary/[0.05]" : undefined
      }
      leading={
        featuredIcon ? (
          <span className="flex size-8 items-center justify-center rounded-md border border-primary/40 bg-primary/10 text-primary">
            <Icon name={featuredIcon} className="size-4" aria-hidden />
          </span>
        ) : (
          <RegistryOwnerAvatar source={skill.source} />
        )
      }
      leadingClassName="size-8"
      title={skill.name}
      byline={formatRegistrySource(skill.source)}
      description={skill.summary ?? undefined}
      openLabel={`View details for ${skill.name}`}
      onOpen={() => onSelect(skill)}
      headerAction={
        <RegistrySkillActions
          skillName={skill.name}
          onFork={() => onFork(skill)}
          presentation={featuredIcon ? "icon" : "label"}
          featured={featuredIcon !== undefined}
        />
      }
      footerMeta={
        <RegistrySkillSocialProof skill={skill} installsKnown={installsKnown} />
      }
    />
  );
}

function RegistrySkillSourceItemSkeleton({ skillName }: { skillName: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${skillName}`}
      className="grid min-h-28 w-full grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] gap-2 rounded-lg border border-border bg-card p-3"
    >
      <span className="sr-only">Loading {skillName}</span>
      <span className="flex min-w-0 items-center gap-3 self-center">
        <Skeleton className="size-8 shrink-0 rounded-md" />
        <Skeleton className="h-3.5 w-32 max-w-full" />
      </span>
      <Skeleton className="h-7 w-16 rounded-md" />
      <span className="col-span-2 row-start-2 space-y-1.5 self-center">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </span>
      <Skeleton className="h-3 w-28 max-w-full self-end" />
      <Skeleton className="h-3 w-20 self-end justify-self-end" />
    </div>
  );
}

const TRENDING_GRID_CLASS =
  "grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))]";
const FEATURED_GRID_CLASS =
  "grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))]";

export function RegistrySkillsBrowsePage({
  skills,
  featuredSkills = [],
  featuredStars = null,
  pendingSkillIds,
  unknownInstallSkillIds,
  isLoading,
  loadingMore,
  hasMore,
  hasError,
  query,
  leading,
  action,
  onRetry,
  onQueryChange,
  onLoadMore,
  onFork,
  onSelect,
}: {
  skills: readonly RegistrySkill[];
  featuredSkills?: readonly { skill: RegistrySkill; icon: BuiltinIconName }[];
  featuredStars?: number | null;
  pendingSkillIds: ReadonlySet<string>;
  unknownInstallSkillIds: ReadonlySet<string>;
  isLoading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  hasError: boolean;
  query: string;
  leading?: ReactNode;
  action?: ReactNode;
  onRetry?: () => void;
  onQueryChange: (query: string) => void;
  onLoadMore: () => void;
  onFork: (skill: RegistrySkill) => void;
  onSelect: (skill: RegistrySkill) => void;
}) {
  const isSearching = query.trim().length > 0;
  return (
    <ResourceCollectionViewport
      scrollId="skills-browse-results"
      bandClassName={TOOLS_PAGE_BAND_CLASSES}
      toolbar={
        <ResourceToolbar
          searchValue={query}
          searchPlaceholder="Search skills"
          onSearchChange={onQueryChange}
          leading={leading}
          action={action}
        />
      }
    >
      <div className={cn("space-y-6", TOOLS_PAGE_BAND_CLASSES)}>
        {!isSearching && featuredSkills.length > 0 ? (
          <ResourceSourceShelf
            label={
              <span className="inline-flex items-center gap-1.5">
                <span className="font-medium text-primary-text">Featured</span>
                <span aria-hidden className="text-subtle-foreground">
                  ·
                </span>
                <span className="text-foreground">David Ondrej</span>
                {featuredStars !== null ? (
                  <>
                    <span aria-hidden className="text-subtle-foreground">
                      ·
                    </span>
                    <Icon
                      name="Star"
                      className="size-3 fill-attention/20 text-attention"
                      aria-hidden
                    />
                    <span>{formatInstallCount(featuredStars)}</span>
                  </>
                ) : null}
              </span>
            }
            leading={
              <RegistryOwnerAvatar
                source={FEATURED_SKILLS_REPOSITORY}
                className="size-4 rounded-full"
              />
            }
            browseAction={
              <a
                href={`https://github.com/${FEATURED_SKILLS_REPOSITORY}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md px-[var(--resource-source-shelf-action-inline)] py-[var(--resource-source-shelf-action-block)] text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                See all
              </a>
            }
          >
            <ResourceBrowseGrid className={FEATURED_GRID_CLASS}>
              {featuredSkills.map(({ skill, icon }) => (
                <RegistrySkillSourceItem
                  key={skill.id}
                  skill={skill}
                  installsKnown
                  featuredIcon={icon}
                  onFork={onFork}
                  onSelect={onSelect}
                />
              ))}
            </ResourceBrowseGrid>
          </ResourceSourceShelf>
        ) : null}
        {hasError && skills.length === 0 ? (
          <ResourceListState
            state="error"
            message="Couldn't load skills.sh."
            onRetry={onRetry}
          />
        ) : isLoading ? (
          <ResourceListState
            state="loading"
            message="Loading skills.sh skills"
            loadingRows={REGISTRY_PAGE_SIZE}
          />
        ) : skills.length === 0 ? (
          <ResourceListState
            state="empty"
            message={
              isSearching
                ? `No skills.sh resources match "${query}"`
                : "No skills.sh resources available."
            }
          />
        ) : (
          <ResourceSourceShelf
            label={
              <>
                {isSearching ? "Results from " : "Trending on "}
                <a
                  href="https://skills.sh"
                  target="_blank"
                  rel="noreferrer"
                  className={SKILLS_SH_LINK_CLASS}
                >
                  skills.sh
                </a>
              </>
            }
          >
            <ResourceBrowseGrid className={TRENDING_GRID_CLASS}>
              {skills.map((skill) =>
                pendingSkillIds.has(skill.id) ? (
                  <RegistrySkillSourceItemSkeleton
                    key={skill.id}
                    skillName={skill.name}
                  />
                ) : (
                  <RegistrySkillSourceItem
                    key={skill.id}
                    skill={skill}
                    installsKnown={!unknownInstallSkillIds.has(skill.id)}
                    onFork={onFork}
                    onSelect={onSelect}
                  />
                ),
              )}
            </ResourceBrowseGrid>
            {hasError ? (
              <ResourceListState
                state="error"
                message="Couldn't load more from skills.sh."
                onRetry={onRetry}
              />
            ) : null}
          </ResourceSourceShelf>
        )}
        {hasError || isLoading ? null : (
          <ResourceInfiniteScrollSentinel
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={onLoadMore}
          />
        )}
      </div>
    </ResourceCollectionViewport>
  );
}

export function RegistrySkillDetailView({
  skill,
  detail,
  localSkill,
  localPath,
  onRetry,
  onFork,
  onEditLocalSkill,
}: {
  skill: RegistrySkill;
  detail: RegistrySkillDetail;
  localSkill: SkillSummary | null;
  localPath: string | null;
  onRetry: () => void;
  onFork: (skill: RegistrySkill) => void;
  onEditLocalSkill: (skill: SkillSummary) => void;
}) {
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  useEffect(() => setSelectedPath("SKILL.md"), [skill.id]);
  const { canOpenPreferredFileTarget, openPathInPreferredFileTarget } =
    useLocalOpenTargets({ enabled: localPath !== null });
  const files = detail?.files ?? [];
  const selectedFile =
    files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const path = localPath ?? `skills.sh/${skill.source}/${skill.skillId}`;
  return (
    <SkillDetailView
      title={skill.name}
      path={path}
      pathHref={localPath === null ? skill.url : undefined}
      headerActions={
        <RegistrySkillActions
          skillName={skill.name}
          onFork={() => onFork(skill)}
        />
      }
      overflowMenu={
        localSkill !== null && localPath !== null ? (
          <ResourceOverflowMenu
            label={`${skill.name} actions`}
            items={[
              {
                label: "Edit",
                icon: "Edit",
                onSelect: () => onEditLocalSkill(localSkill),
              },
              {
                label: "Open source",
                icon: "ExternalLink",
                disabled: !canOpenPreferredFileTarget,
                disabledReason: canOpenPreferredFileTarget
                  ? undefined
                  : "No editor configured",
                onSelect: () => {
                  void openPathInPreferredFileTarget({
                    path: localPath,
                    lineNumber: null,
                  });
                },
              },
            ]}
          />
        ) : undefined
      }
      files={files.map((file) => file.path)}
      selectedPath={selectedFile?.path ?? selectedPath}
      onSelectFile={setSelectedPath}
      contentState={
        selectedFile
          ? { kind: "ready", content: selectedFile.contents }
          : {
              kind: "error",
              message: "The source does not include SKILL.md content.",
              onRetry,
            }
      }
    />
  );
}
