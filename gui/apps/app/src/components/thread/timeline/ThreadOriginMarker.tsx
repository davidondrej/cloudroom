import { NavLink } from "react-router-dom";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";

export type ThreadOriginRelationship = "parent" | "fork" | "side-chat";

export interface ThreadOrigin {
  relationship: ThreadOriginRelationship;
  title: string;
  href: string;
}

const ORIGIN_COPY: Record<
  ThreadOriginRelationship,
  { label: string; icon: IconName }
> = {
  parent: { label: "Child of", icon: "UserRound" },
  fork: { label: "Forked from", icon: "Fork" },
  "side-chat": { label: "Side chat of", icon: "SideChat" },
};

/** A divider at the top of the timeline that links to the thread this one came from. */
export function ThreadOriginMarker({ origin }: { origin: ThreadOrigin }) {
  const copy = ORIGIN_COPY[origin.relationship];
  return (
    <div
      role="separator"
      aria-label={`${copy.label} ${origin.title}`}
      className="mb-3 flex items-center gap-3 px-2 py-1 text-xs text-muted-foreground"
    >
      <span className="h-px min-w-4 flex-1 bg-border" aria-hidden />
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon name={copy.icon} className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">{copy.label}</span>
        <NavLink
          to={origin.href}
          className="min-w-0 truncate text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
        >
          {origin.title}
        </NavLink>
      </span>
      <span className="h-px min-w-4 flex-1 bg-border" aria-hidden />
    </div>
  );
}
