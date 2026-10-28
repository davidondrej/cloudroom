import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type {
  EnvironmentStatus,
  GitBranchRefClassification,
  ThreadPullRequest,
} from "@cloudroom/domain";
import type { PullRequestMergeMethod } from "@cloudroom/server-contract";
import {
  BranchPicker,
  getMergeBaseBranchCandidateGroups,
} from "@/components/pickers/BranchPicker";
import {
  PromptStackCard,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";
import { WorkspaceChangesList } from "@/components/thread/WorkspaceChangesList";
import {
  formatChangeSummary,
  formatWorkspaceChangedFilesLabel,
  renderChangeSummary,
  renderChangeTally,
  toChangeTally,
  type WorkspaceChangedFileSelection,
  type WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import {
  getPullRequestAttentionDisplay,
  getPullRequestGithubCheckStatus,
  PULL_REQUEST_STATE_DISPLAY,
} from "@/lib/pull-request-display";
import { PullRequestStatusPill } from "@/components/pull-request/PullRequestStatusPill";
import { AnimatedBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  BannerActionSlot,
  PROMPT_BANNER_ACTION_FILL_CLASS,
  PROMPT_BANNER_ACTION_SEGMENT_CLASS,
  PromptBannerActionButton,
} from "@/components/promptbox/banner/prompt-banner-actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";

export interface ContextBannerMergeBaseConfig {
  branch: string;
  branchRef?: GitBranchRefClassification | null;
  options?: readonly string[];
  remoteOptions?: readonly string[];
  optionsLoading?: boolean;
  onChange: (branch: string) => void;
  onPickerOpenChange?: (open: boolean) => void;
  onSearchQueryChange?: (query: string) => void;
}

export interface ThreadPromptGitSection {
  changedFiles: WorkspaceChangedFilesSection;
  mergeBase: ContextBannerMergeBaseConfig | null;
  onPromptBannerFileClick: (selection: WorkspaceChangedFileSelection) => void;
}

export interface ThreadPromptParentThreadSection {
  parentThreadTitle: string;
  href: string;
  relationship: "parent" | "fork" | "side-chat";
  onDismiss?: () => void;
}

export interface ThreadPromptPullRequestSection {
  pullRequest: ThreadPullRequest;
  actions?: {
    isPending?: boolean;
    onMarkReady?: () => void;
    onMerge?: (method: PullRequestMergeMethod) => void;
    onConvertToDraft?: () => void;
    selectedMergeMethod?: PullRequestMergeMethod;
  };
}

export interface ThreadPromptArchivedSection {
  archivedAt: number;
  onUnarchive?: () => void;
  unarchivePending?: boolean;
}

export interface ThreadPromptEnvironmentGoneSection {
  status: Extract<EnvironmentStatus, "destroyed">;
}

export type ThreadPromptContextBannerExpandedSection =
  | "git"
  | "parentThread";

interface ThreadPromptContextBannerProps {
  gitSection: ThreadPromptGitSection | null;
  gitSectionPending: boolean;
  archivedSection: ThreadPromptArchivedSection | null;
  environmentGoneSection: ThreadPromptEnvironmentGoneSection | null;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  pullRequestSection: ThreadPromptPullRequestSection | null;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
  /** Row content shown left of the minimal diff toggle, or above the banner otherwise. */
  leading?: ReactNode;
}

const KIND_PREFIX: Record<WorkspaceChangedFilesSection["kind"], string> = {
  uncommitted: "Uncommitted",
  untracked: "Untracked",
  committed: "Committed",
};

const ARCHIVED_THREAD_STATUS_LABEL = "Thread is archived";
const ENVIRONMENT_GONE_STATUS_COPY: Record<
  ThreadPromptEnvironmentGoneSection["status"],
  { ariaLabel: string; label: string }
> = {
  destroyed: {
    ariaLabel: "This environment has been archived.",
    label: "Environment archived",
  },
};

const SECTION_IDS = {
  parentThread: {
    toggle: "thread-prompt-banner-parent-thread-toggle",
    body: "thread-prompt-banner-parent-thread-body",
  },
  git: {
    toggle: "thread-prompt-banner-git-toggle",
    body: "thread-prompt-banner-git-body",
  },
} as const;

const SEGMENT_SHRINK_CLASS = "min-w-0 overflow-hidden";
const CONTEXT_BANNER_CARD_CLASS = cn(
  "relative z-10 ml-auto mr-3 w-fit overflow-hidden sm:mr-4",
  "[[data-app-composer]_&:last-child]:-mb-5 [[data-app-composer]_&:last-child]:rounded-b-none [[data-app-composer]_&:last-child]:border-b-0 [[data-app-composer]_&:last-child]:pb-3",
);
const CONTEXT_BANNER_ROW_CLASS =
  "flex items-center gap-0.5 p-0.5 text-xs text-muted-foreground";
const MINIMAL_GIT_BANNER_CLASS = cn(
  "relative z-10 mr-3 min-w-0 sm:mr-4",
  "[[data-app-composer]_&:last-child]:-mb-5 [[data-app-composer]_&:last-child]:pb-3",
);

interface SectionToggleButtonProps {
  id: string;
  controlsId: string;
  ariaLabel?: string;
  icon: ReactNode;
  label: ReactNode;
  compactLabel?: ReactNode;
  hideLabelInCompact?: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

function SectionToggleButton({
  id,
  controlsId,
  ariaLabel,
  icon,
  label,
  compactLabel,
  hideLabelInCompact = true,
  isExpanded,
  onToggle,
}: SectionToggleButtonProps) {
  return (
    <button
      type="button"
      id={id}
      aria-expanded={isExpanded}
      aria-controls={controlsId}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        "flex cursor-pointer items-center text-xs transition-colors",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
        "hover:bg-state-hover",
        SEGMENT_SHRINK_CLASS,
        label !== null && label !== undefined ? "gap-1.5" : "gap-0",
        isExpanded ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
      {label !== null && label !== undefined ? (
        <span
          className="min-w-0 truncate"
          data-promptbox-hide-compact={hideLabelInCompact ? "" : undefined}
        >
          {label}
        </span>
      ) : null}
      {hideLabelInCompact &&
      compactLabel !== null &&
      compactLabel !== undefined ? (
        <span className="min-w-0 truncate" data-promptbox-compact-label="">
          {compactLabel}
        </span>
      ) : null}
      <Icon
        name="ChevronDown"
        className={cn(
          "size-3.5 shrink-0 text-subtle-foreground transition-transform duration-200",
          isExpanded && "rotate-180",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

const PARENT_SECTION_COPY: Record<
  ThreadPromptParentThreadSection["relationship"],
  { verb: string; bodyLead: string; ariaPrefix: string }
> = {
  parent: {
    verb: "Parent",
    bodyLead: "This thread is a child of ",
    ariaPrefix: "Parent thread",
  },
  fork: {
    verb: "Forked from",
    bodyLead: "This thread was forked from ",
    ariaPrefix: "Forked from",
  },
  "side-chat": {
    verb: "Side chat of",
    bodyLead: "This thread is a side chat of ",
    ariaPrefix: "Side chat of",
  },
};

const PARENT_SECTION_ICON: Record<
  ThreadPromptParentThreadSection["relationship"],
  IconName
> = {
  parent: "UserRound",
  fork: "Fork",
  "side-chat": "SideChat",
};

function parentSectionAriaLabel(
  section: ThreadPromptParentThreadSection,
): string {
  return `${PARENT_SECTION_COPY[section.relationship].ariaPrefix} ${section.parentThreadTitle}`;
}

function shouldShowPullRequestAttentionLabel(
  pullRequest: ThreadPullRequest,
): boolean {
  return (
    pullRequest.attention === "checks_failed" ||
    pullRequest.attention === "changes_requested" ||
    pullRequest.attention === "review_requested" ||
    pullRequest.attention === "conflicts" ||
    pullRequest.attention === "blocked"
  );
}

function ParentThreadSectionToggle({
  section,
  isExpanded,
  onToggle,
}: {
  section: ThreadPromptParentThreadSection;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <SectionToggleButton
      id={SECTION_IDS.parentThread.toggle}
      controlsId={SECTION_IDS.parentThread.body}
      ariaLabel={parentSectionAriaLabel(section)}
      icon={
        <Icon
          name={PARENT_SECTION_ICON[section.relationship]}
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
      }
      label={null}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );
}

function ParentThreadSectionBody({
  section,
  isExpanded,
}: {
  section: ThreadPromptParentThreadSection;
  isExpanded: boolean;
}) {
  return (
    <AnimatedBody
      collapsedBorder="reserve"
      id={SECTION_IDS.parentThread.body}
      labelledBy={SECTION_IDS.parentThread.toggle}
      isExpanded={isExpanded}
    >
      <div className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
        {PARENT_SECTION_COPY[section.relationship].bodyLead}
        <NavLink
          to={section.href}
          className="text-foreground/90 underline underline-offset-2"
        >
          {section.parentThreadTitle}
        </NavLink>
        .
      </div>
    </AnimatedBody>
  );
}

const PromptBannerActionGroup = ({ children }: { children: ReactNode }) => (
  <div
    className={cn(
      "inline-flex overflow-hidden rounded border border-border",
      PROMPT_BANNER_ACTION_FILL_CLASS,
    )}
  >
    {children}
  </div>
);

const PromptBannerActionSegmentButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function PromptBannerActionSegmentButton(
  { className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "px-1.5 py-0.5",
        PROMPT_BANNER_ACTION_SEGMENT_CLASS,
        className,
      )}
      {...props}
    />
  );
});

function PendingBannerActionButton({
  pending,
  label,
  pendingLabel,
  onClick,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  onClick: () => void;
}) {
  return (
    <PromptBannerActionButton onClick={onClick} disabled={pending}>
      {pending ? pendingLabel : label}
    </PromptBannerActionButton>
  );
}

const PULL_REQUEST_MERGE_ACTIONS: readonly {
  method: PullRequestMergeMethod;
  label: string;
}[] = [
  { method: "merge", label: "Merge" },
  { method: "squash", label: "Squash merge" },
  { method: "rebase", label: "Rebase and merge" },
];

function PullRequestMergeSplitButton({
  disabled,
  onConvertToDraft,
  onMerge,
  selectedMethod,
}: {
  disabled?: boolean;
  onConvertToDraft?: () => void;
  onMerge: (method: PullRequestMergeMethod) => void;
  selectedMethod: PullRequestMergeMethod;
}) {
  const selectedAction =
    PULL_REQUEST_MERGE_ACTIONS.find(
      (action) => action.method === selectedMethod,
    ) ?? PULL_REQUEST_MERGE_ACTIONS[0];
  return (
    <PromptBannerActionGroup>
      <PromptBannerActionSegmentButton
        disabled={Boolean(disabled)}
        onClick={() => onMerge(selectedAction.method)}
      >
        {selectedAction.label}
      </PromptBannerActionSegmentButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <PromptBannerActionSegmentButton
            disabled={Boolean(disabled)}
            className={cn(
              "inline-flex items-center border-l border-border px-1 data-[state=open]:bg-state-active data-[state=open]:text-foreground",
            )}
            aria-label="Choose pull request merge method"
          >
            <Icon name="ChevronDown" className="size-3" aria-hidden="true" />
          </PromptBannerActionSegmentButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={2}
          mobileTitle="Merge pull request"
        >
          {PULL_REQUEST_MERGE_ACTIONS.map((action) => (
            <DropdownMenuItem
              key={action.method}
              onSelect={() => onMerge(action.method)}
              textValue={action.label}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
          {onConvertToDraft ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onConvertToDraft}
                textValue="Convert to draft"
              >
                Convert to draft
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </PromptBannerActionGroup>
  );
}

function PullRequestBannerLink({
  pullRequest,
  hideLabelInCompact,
  showLabel,
  showStateLabel,
}: {
  pullRequest: ThreadPullRequest;
  hideLabelInCompact: boolean;
  showLabel: boolean;
  showStateLabel: boolean;
}) {
  const attentionDisplay = getPullRequestAttentionDisplay(pullRequest);
  const stateDisplay = PULL_REQUEST_STATE_DISPLAY[pullRequest.state];
  const handlePullRequestClick = useUrlAnchorClickHandler(pullRequest.url);
  const showAttentionLabel =
    showLabel && shouldShowPullRequestAttentionLabel(pullRequest);
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handlePullRequestClick}
      aria-label={`Pull request ${pullRequest.number}: ${attentionDisplay.label}`}
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground no-underline transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
        getPullRequestGithubCheckStatus(pullRequest) !== null
          ? "min-w-13"
          : "min-w-8",
        "overflow-hidden",
      )}
    >
      <PullRequestStatusPill pullRequest={pullRequest} className="h-4" />
      {showLabel ? (
        <span
          className="min-w-0 truncate"
          data-promptbox-hide-compact={hideLabelInCompact ? "" : undefined}
        >
          PR #{pullRequest.number}
          {showStateLabel && pullRequest.state !== "open"
            ? ` · ${stateDisplay.label}`
            : ""}
        </span>
      ) : null}
      {showAttentionLabel ? (
        <span className={cn("min-w-0 truncate", attentionDisplay.className)}>
          · {attentionDisplay.label}
        </span>
      ) : null}
    </a>
  );
}

function MinimalGitBanner({
  gitSection,
  isExpanded,
  onToggle,
  leading,
}: {
  gitSection: ThreadPromptGitSection;
  isExpanded: boolean;
  onToggle: () => void;
  leading?: ReactNode;
}) {
  const { changedFiles, mergeBase } = gitSection;
  const tally = toChangeTally(changedFiles.stats);
  const prefix = KIND_PREFIX[changedFiles.kind];
  const mergeBaseCandidates = mergeBase
    ? getMergeBaseBranchCandidateGroups({
        mergeBaseBranch: mergeBase.branch,
        mergeBaseBranchRef: mergeBase.branchRef,
        mergeBaseBranchOptions: mergeBase.options,
        remoteMergeBaseBranchOptions: mergeBase.remoteOptions,
      })
    : null;
  return (
    <section
      aria-label="Thread context before sending"
      className={cn(MINIMAL_GIT_BANNER_CLASS, !leading && "ml-auto w-fit")}
    >
      <div className="flex items-start">
        {leading ? <div className="min-w-0 flex-1">{leading}</div> : null}
        <button
          type="button"
          id={SECTION_IDS.git.toggle}
          aria-expanded={isExpanded}
          aria-controls={SECTION_IDS.git.body}
          aria-label={`Changed files: ${prefix}, ${formatChangeSummary(tally)}`}
          title={`${prefix} · ${formatChangeSummary(tally)}`}
          onClick={onToggle}
          className={cn(
            "ml-auto flex min-h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-2xs transition-[color,opacity]",
            isExpanded
              ? "text-foreground"
              : "text-muted-foreground opacity-75 hover:opacity-100",
          )}
        >
          {renderChangeTally(tally)}
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 shrink-0 text-subtle-foreground transition-transform duration-200",
              isExpanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      <AnimatedBody
        collapsedBorder="none"
        seamless
        id={SECTION_IDS.git.body}
        labelledBy={SECTION_IDS.git.toggle}
        isExpanded={isExpanded}
      >
        <div className="flex items-center gap-1.5 px-1 pb-1 text-2xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {prefix} ·{" "}
            {formatWorkspaceChangedFilesLabel(changedFiles.files.length)}
          </span>
          {mergeBase && mergeBaseCandidates ? (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Icon
                name="GitMerge"
                className="size-3 shrink-0"
                aria-hidden="true"
              />
              <BranchPicker
                value={mergeBase.branch}
                options={mergeBaseCandidates.options}
                remoteOptions={mergeBaseCandidates.remoteOptions}
                variant="minimal"
                emphasizeTriggerValue={false}
                loading={mergeBase.optionsLoading}
                onChange={mergeBase.onChange}
                onOpenChange={mergeBase.onPickerOpenChange}
                onSearchQueryChange={mergeBase.onSearchQueryChange}
                className="max-w-[10rem]"
                muted
                popoverAlign="end"
              />
            </span>
          ) : null}
        </div>
        <WorkspaceChangesList
          files={changedFiles.files}
          className="max-h-32 px-1 pb-1"
          onFileClick={(file) =>
            gitSection.onPromptBannerFileClick({ file, section: changedFiles })
          }
        />
      </AnimatedBody>
    </section>
  );
}

interface ReadOnlyContextBannerProps {
  iconName: IconName;
  statusAriaLabel: string;
  statusLabel: string;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  statusAction: ReactNode;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
}

function ReadOnlyContextBanner({
  iconName,
  statusAriaLabel,
  statusLabel,
  parentThreadSection,
  statusAction,
  expandedSection,
  onToggleSection,
}: ReadOnlyContextBannerProps) {
  const isParentThreadExpanded =
    expandedSection === "parentThread" && parentThreadSection !== null;
  const hasMultipleSegments = parentThreadSection !== null;
  const showStatusAction = statusAction !== null && !hasMultipleSegments;
  return (
    <PromptStackCard
      ariaLabel="Thread context before sending"
      className={CONTEXT_BANNER_CARD_CLASS}
    >
      <div className={CONTEXT_BANNER_ROW_CLASS}>
        {parentThreadSection ? (
          <ParentThreadSectionToggle
            section={parentThreadSection}
            isExpanded={isParentThreadExpanded}
            onToggle={() => onToggleSection("parentThread")}
          />
        ) : null}
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs",
            PROMPT_STACK_INLAY_SEGMENT_CLASS,
          )}
          role="status"
          aria-label={statusAriaLabel}
        >
          <Icon
            name={iconName}
            className="size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate" aria-hidden="true">
            {statusLabel}
          </span>
        </div>
        {showStatusAction ? (
          <BannerActionSlot>{statusAction}</BannerActionSlot>
        ) : null}
      </div>
      {parentThreadSection ? (
        <ParentThreadSectionBody
          section={parentThreadSection}
          isExpanded={isParentThreadExpanded}
        />
      ) : null}
    </PromptStackCard>
  );
}

export function ThreadPromptContextBanner({
  gitSection,
  gitSectionPending,
  archivedSection,
  environmentGoneSection,
  parentThreadSection,
  pullRequestSection,
  expandedSection,
  onToggleSection,
  leading,
}: ThreadPromptContextBannerProps) {
  if (archivedSection || environmentGoneSection) {
    const environmentGone = environmentGoneSection !== null;
    const environmentGoneCopy = environmentGoneSection
      ? ENVIRONMENT_GONE_STATUS_COPY[environmentGoneSection.status]
      : null;
    return (
      <>
        {leading}
        <ReadOnlyContextBanner
          iconName={environmentGone ? "CircleX" : "Archive"}
          statusAriaLabel={
            environmentGoneCopy?.ariaLabel ?? ARCHIVED_THREAD_STATUS_LABEL
          }
          statusLabel={
            environmentGoneCopy?.label ?? ARCHIVED_THREAD_STATUS_LABEL
          }
          statusAction={
            archivedSection?.onUnarchive && !environmentGone ? (
              <PendingBannerActionButton
                pending={Boolean(archivedSection.unarchivePending)}
                label="Unarchive"
                pendingLabel="Unarchiving..."
                onClick={archivedSection.onUnarchive}
              />
            ) : null
          }
          parentThreadSection={parentThreadSection}
          expandedSection={expandedSection}
          onToggleSection={onToggleSection}
        />
      </>
    );
  }
  if (gitSectionPending) {
    return leading ?? null;
  }
  const showGit = gitSection !== null;
  const showParentThread = parentThreadSection !== null;
  const showPullRequest = pullRequestSection !== null;
  if (!showGit && !showParentThread && !showPullRequest) {
    return leading ?? null;
  }
  const visibleSegmentCount =
    Number(showParentThread) + Number(showPullRequest) + Number(showGit);
  const hasSingleVisibleSegment = visibleSegmentCount === 1;
  const isPullRequestAndGitOnly =
    showPullRequest && showGit && visibleSegmentCount === 2;
  const isGitExpanded = expandedSection === "git" && showGit;
  const isParentThreadExpanded =
    expandedSection === "parentThread" && showParentThread;
  const gitTally = showGit
    ? toChangeTally(gitSection.changedFiles.stats)
    : null;
  const gitSummaryText = gitTally ? formatChangeSummary(gitTally) : "";
  const gitSummaryPrefix = showGit
    ? KIND_PREFIX[gitSection.changedFiles.kind]
    : "";
  const gitSummary: ReactNode =
    showGit && gitTally ? (
      <>
        {gitSummaryPrefix} · {renderChangeSummary(gitTally)}
      </>
    ) : null;

  const isParentThreadOnly = showParentThread && !showGit && !showPullRequest;

  const pullRequest = pullRequestSection?.pullRequest ?? null;
  const showPullRequestLabel =
    hasSingleVisibleSegment || isPullRequestAndGitOnly;
  const pullRequestActions = pullRequestSection?.actions;
  const pullRequestAction =
    pullRequest && pullRequestActions ? (
      pullRequest.state === "draft" && pullRequestActions.onMarkReady ? (
        <BannerActionSlot>
          <PendingBannerActionButton
            pending={Boolean(pullRequestActions.isPending)}
            label="Mark ready"
            pendingLabel="Marking..."
            onClick={pullRequestActions.onMarkReady}
          />
        </BannerActionSlot>
      ) : pullRequest.state === "open" &&
        pullRequest.mergeability.state === "mergeable" &&
        pullRequestActions.onMerge ? (
        <BannerActionSlot>
          <PullRequestMergeSplitButton
            disabled={pullRequestActions.isPending}
            onConvertToDraft={pullRequestActions.onConvertToDraft}
            onMerge={pullRequestActions.onMerge}
            selectedMethod={pullRequestActions.selectedMergeMethod ?? "merge"}
          />
        </BannerActionSlot>
      ) : null
    ) : null;

  const compactContextBanner =
    hasSingleVisibleSegment && showGit ? (
      <MinimalGitBanner
        gitSection={gitSection}
        isExpanded={isGitExpanded}
        onToggle={() => onToggleSection("git")}
        leading={leading}
      />
    ) : visibleSegmentCount > 0 ? (
      <PromptStackCard
        ariaLabel="Thread context before sending"
        className={CONTEXT_BANNER_CARD_CLASS}
      >
        <div className={CONTEXT_BANNER_ROW_CLASS}>
          {showParentThread && parentThreadSection && isParentThreadOnly ? (
            <div
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-xs",
                PROMPT_STACK_INLAY_SEGMENT_CLASS,
              )}
              title={parentSectionAriaLabel(parentThreadSection)}
            >
              <Icon
                name={PARENT_SECTION_ICON[parentThreadSection.relationship]}
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">
                {PARENT_SECTION_COPY[parentThreadSection.relationship].verb}{" "}
                <NavLink
                  to={parentThreadSection.href}
                  className="text-foreground/90 underline underline-offset-2"
                >
                  {parentThreadSection.parentThreadTitle}
                </NavLink>
              </span>
              {parentThreadSection.onDismiss ? (
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="ml-1 shrink-0 cursor-pointer text-muted-foreground/70 transition-colors hover:text-foreground"
                  onClick={parentThreadSection.onDismiss}
                >
                  <Icon name="CircleX" className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
          ) : null}
          {showParentThread && parentThreadSection && !isParentThreadOnly ? (
            <ParentThreadSectionToggle
              section={parentThreadSection}
              isExpanded={isParentThreadExpanded}
              onToggle={() => onToggleSection("parentThread")}
            />
          ) : null}
          {showPullRequest && pullRequest ? (
            <PullRequestBannerLink
              pullRequest={pullRequest}
              hideLabelInCompact={!hasSingleVisibleSegment}
              showLabel={showPullRequestLabel}
              showStateLabel={hasSingleVisibleSegment}
            />
          ) : null}
          {showGit && gitSummary ? (
            <SectionToggleButton
              id={SECTION_IDS.git.toggle}
              controlsId={SECTION_IDS.git.body}
              icon={
                <Icon
                  name="FileDiff"
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
              }
              label={gitSummary}
              compactLabel={gitTally ? renderChangeSummary(gitTally) : null}
              hideLabelInCompact={visibleSegmentCount > 2}
              ariaLabel={`Changed files: ${gitSummaryPrefix}, ${gitSummaryText}`}
              isExpanded={isGitExpanded}
              onToggle={() => onToggleSection("git")}
            />
          ) : null}
          {pullRequestAction}
        </div>
        {showParentThread && parentThreadSection && !isParentThreadOnly ? (
          <ParentThreadSectionBody
            section={parentThreadSection}
            isExpanded={isParentThreadExpanded}
          />
        ) : null}
        {showGit ? (
          <AnimatedBody
            collapsedBorder="reserve"
            id={SECTION_IDS.git.body}
            labelledBy={SECTION_IDS.git.toggle}
            isExpanded={isGitExpanded}
          >
            <WorkspaceChangesList
              files={gitSection.changedFiles.files}
              className="max-h-32 px-3 pb-2 pt-1"
              onFileClick={(file) =>
                gitSection.onPromptBannerFileClick({
                  file,
                  section: gitSection.changedFiles,
                })
              }
            />
          </AnimatedBody>
        ) : null}
      </PromptStackCard>
    ) : null;

  const leadingNode = hasSingleVisibleSegment && showGit ? null : leading;
  if (leadingNode && compactContextBanner) {
    return (
      <div className="contents">
        {leadingNode}
        {compactContextBanner}
      </div>
    );
  }

  return leadingNode ?? compactContextBanner;
}
