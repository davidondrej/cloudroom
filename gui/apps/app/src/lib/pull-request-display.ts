import type {
  PullRequestState,
  ThreadPullRequest,
  ThreadPullRequestAttentionState,
  ThreadPullRequestChecksState,
  ThreadPullRequestMergeabilityState,
  ThreadPullRequestReviewState,
} from "@cloudroom/domain";
import type { IconName } from "@cloudroom/shared-ui/icon";

interface PullRequestDisplay {
  label: string;
  icon: IconName;
  className: string;
}

export type GithubCheckStatus = "success" | "failure" | "pending";

interface PullRequestStateDisplay extends PullRequestDisplay {
  dotClass: string;
}

export const PULL_REQUEST_STATE_DISPLAY: Record<
  PullRequestState,
  PullRequestStateDisplay
> = {
  open: {
    label: "Open",
    icon: "GitPullRequestArrow",
    className: "text-success",
    dotClass: "bg-success",
  },
  draft: {
    label: "Draft",
    icon: "GitPullRequestDraft",
    className: "text-muted-foreground",
    dotClass: "bg-muted-foreground",
  },
  merged: {
    label: "Merged",
    icon: "GitMerge",
    className: "text-pr-merged",
    dotClass: "bg-pr-merged",
  },
  closed: {
    label: "Closed",
    icon: "GitPullRequestClosed",
    className: "text-destructive",
    dotClass: "bg-destructive",
  },
};

const CHECKS_DISPLAY: Record<ThreadPullRequestChecksState, PullRequestDisplay> =
  {
    passing: {
      label: "Checks passing",
      icon: "CircleCheck",
      className: "text-success",
    },
    failing: {
      label: "Checks failing",
      icon: "CircleX",
      className: "text-destructive",
    },
    pending: {
      label: "Checks pending",
      icon: "Clock",
      className: "text-warning-text",
    },
    no_checks: {
      label: "No checks",
      icon: "Circle",
      className: "text-muted-foreground",
    },
    unknown: {
      label: "Checks unknown",
      icon: "AlertTriangle",
      className: "text-warning-text",
    },
  };

const REVIEW_DISPLAY: Record<ThreadPullRequestReviewState, PullRequestDisplay> =
  {
    approved: {
      label: "Approved",
      icon: "CircleCheck",
      className: "text-success",
    },
    changes_requested: {
      label: "Changes requested",
      icon: "CircleX",
      className: "text-destructive",
    },
    review_required: {
      label: "Review required",
      icon: "Clock",
      className: "text-destructive",
    },
    review_requested: {
      label: "Review requested",
      icon: "Clock",
      className: "text-destructive",
    },
    none: {
      label: "No review",
      icon: "Circle",
      className: "text-muted-foreground",
    },
  };

const MERGEABILITY_DISPLAY: Record<
  ThreadPullRequestMergeabilityState,
  PullRequestDisplay
> = {
  mergeable: {
    label: "Mergeable",
    icon: "CircleCheck",
    className: "text-success",
  },
  conflicts: {
    label: "Conflicts",
    icon: "AlertTriangle",
    className: "text-destructive",
  },
  blocked: {
    label: "Blocked",
    icon: "AlertTriangle",
    className: "text-destructive",
  },
  draft: {
    label: "Draft",
    icon: "Clock",
    className: "text-muted-foreground",
  },
  unknown: {
    label: "Mergeability unknown",
    icon: "AlertTriangle",
    className: "text-warning-text",
  },
};

const ATTENTION_DISPLAY: Record<
  ThreadPullRequestAttentionState,
  PullRequestDisplay
> = {
  checks_failed: {
    ...CHECKS_DISPLAY.failing,
    icon: "GitPullRequestArrow",
  },
  checks_pending: {
    ...CHECKS_DISPLAY.pending,
    icon: "GitPullRequestArrow",
  },
  changes_requested: {
    ...REVIEW_DISPLAY.changes_requested,
    icon: "GitPullRequestArrow",
  },
  review_requested: {
    ...REVIEW_DISPLAY.review_requested,
    icon: "GitPullRequestArrow",
  },
  conflicts: {
    ...MERGEABILITY_DISPLAY.conflicts,
    icon: "GitPullRequestArrow",
  },
  blocked: {
    ...MERGEABILITY_DISPLAY.blocked,
    icon: "GitPullRequestArrow",
  },
  draft: PULL_REQUEST_STATE_DISPLAY.draft,
  ready_to_merge: {
    label: "Ready to merge",
    icon: "GitPullRequestArrow",
    className: "text-success",
  },
  merged: PULL_REQUEST_STATE_DISPLAY.merged,
  closed: PULL_REQUEST_STATE_DISPLAY.closed,
  none: PULL_REQUEST_STATE_DISPLAY.open,
};

export function getPullRequestChecksDisplay(
  pullRequest: ThreadPullRequest,
): PullRequestDisplay {
  return CHECKS_DISPLAY[pullRequest.checks.state];
}

export function getPullRequestGithubCheckStatus(
  pullRequest: ThreadPullRequest,
): GithubCheckStatus | null {
  if (pullRequest.state !== "open" && pullRequest.state !== "draft") {
    return null;
  }
  switch (pullRequest.checks.state) {
    case "passing":
      return "success";
    case "failing":
      return "failure";
    case "pending":
      return "pending";
    case "no_checks":
    case "unknown":
      return null;
  }
}

export function getPullRequestReviewDisplay(
  pullRequest: ThreadPullRequest,
): PullRequestDisplay {
  return REVIEW_DISPLAY[pullRequest.review.state];
}

export function getPullRequestMergeabilityDisplay(
  pullRequest: ThreadPullRequest,
): PullRequestDisplay {
  return MERGEABILITY_DISPLAY[pullRequest.mergeability.state];
}

export function getPullRequestAttentionDisplay(
  pullRequest: ThreadPullRequest,
): PullRequestDisplay {
  return ATTENTION_DISPLAY[pullRequest.attention];
}

/**
 * The one-click fix for what blocks an open pull request: its button label and the prompt sent to the
 * thread's agent. The agent reads the logs or comments itself with `gh`, so the app fetches nothing.
 */
export function getPullRequestFix(
  pullRequest: ThreadPullRequest,
): { label: string; prompt: string } | null {
  if (pullRequest.state !== "open" && pullRequest.state !== "draft") {
    return null;
  }
  const name = `PR #${pullRequest.number} (${pullRequest.url})`;
  if (pullRequest.checks.state === "failing") {
    const { failedCount, totalCount } = pullRequest.checks;
    return {
      label: "Fix checks",
      prompt: `CI is failing on ${name}: ${failedCount} of ${totalCount} checks failed. Find the failed checks with \`gh pr checks ${pullRequest.number}\`, read their logs with \`gh run view <run-id> --log-failed\`, fix the cause, and push the fix to this PR's branch.`,
    };
  }
  if (pullRequest.review.state === "changes_requested") {
    return {
      label: "Address review",
      prompt: `A reviewer requested changes on ${name}. Read the reviews and every review comment with \`gh pr view ${pullRequest.number} --comments\` and \`gh api repos/{owner}/{repo}/pulls/${pullRequest.number}/comments\`, address each one, and push the changes to this PR's branch.`,
    };
  }
  return null;
}
