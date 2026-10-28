import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  Sidebar,
  SidebarContent,
  useCloseMobileSidebar,
} from "@/components/ui/sidebar.js";
import {
  SidebarResizeHandle,
  SidebarTopReserveRow,
} from "@/components/sidebar/SidebarChrome";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@/components/sidebar/ProjectList";
import { SIDEBAR_STANDARD_ROW_PADDING_CLASS } from "@/components/sidebar/sidebarRowClasses";
import { CHROME_SECTION_LABEL_CLASS } from "@cloudroom/shared-ui/chrome-style-tokens";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutPill } from "@/components/commands/AppCommandShortcutHint";

function SectionSidebarBackButton({ label, to }: { label: string; to: string }) {
  const closeOnMobile = useCloseMobileSidebar();
  const shortcut = useAppCommandShortcut("app.back");
  return (
    <Link
      to={to}
      onClick={closeOnMobile}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:pointer-coarse:h-11"
    >
      <Icon
        name="ArrowLeft"
        className={cn(COARSE_POINTER_ICON_SIZE_CLASS, "text-primary-text")}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <AppCommandShortcutPill
          shortcut={shortcut}
          className="border border-border-hairline bg-transparent opacity-100 max-md:pointer-coarse:hidden"
        />
      ) : null}
    </Link>
  );
}

export function SectionSidebarIcon({ name }: { name: IconName }) {
  return <Icon name={name} className={COARSE_POINTER_ICON_SIZE_CLASS} />;
}

export function SectionSidebarRow({
  active,
  children,
  className,
  label,
  to,
}: {
  active: boolean;
  children?: ReactNode;
  className?: string;
  label: string;
  to: string;
}) {
  const closeOnMobile = useCloseMobileSidebar();
  return (
    <Button
      asChild
      size="sm"
      variant="ghost"
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "w-full",
        className,
        active && "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      <Link
        to={to}
        onClick={closeOnMobile}
        aria-current={active ? "page" : undefined}
      >
        {children}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </Link>
    </Button>
  );
}

export function SectionSidebarActionRow({
  children,
  label,
  onClick,
  testId,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  const closeOnMobile = useCloseMobileSidebar();
  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid={testId}
      className={cn(PROJECT_LIST_ACTION_BUTTON_CLASS, "w-full")}
      onClick={() => {
        closeOnMobile();
        onClick();
      }}
    >
      {children}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </Button>
  );
}

export function SectionSidebarLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        CHROME_SECTION_LABEL_CLASS,
        SIDEBAR_STANDARD_ROW_PADDING_CLASS,
      )}
    >
      {children}
    </div>
  );
}

export function SectionSidebar({
  backLabel,
  backTo,
  children,
  footer,
  isResizing,
  mobileHosted = false,
  onResizeMouseDown,
  testIdPrefix,
}: {
  backLabel: string;
  backTo: string;
  children: ReactNode;
  footer?: ReactNode;
  isResizing: boolean;
  mobileHosted?: boolean;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  testIdPrefix: string;
}) {
  const body = (
    <>
      <SidebarTopReserveRow
        testId={`${testIdPrefix}-sidebar-top-reserve-row`}
      />
      <div className="shrink-0 px-2 pt-2 pb-1">
        <SectionSidebarBackButton label={backLabel} to={backTo} />
        <div className="mx-0.5 mt-2 h-px bg-sidebar-border" />
      </div>
      <SidebarContent>
        <div className="min-w-0 px-2">{children}</div>
      </SidebarContent>
      {footer ? <div className="shrink-0 px-2 pb-2">{footer}</div> : null}
      <SidebarResizeHandle
        testId={`${testIdPrefix}-sidebar-resize-handle`}
        isResizing={isResizing}
        onMouseDown={onResizeMouseDown}
      />
    </>
  );

  if (mobileHosted) {
    return (
      <div
        data-testid={`${testIdPrefix}-sidebar-body`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {body}
      </div>
    );
  }

  return <Sidebar>{body}</Sidebar>;
}
