import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarActionRow,
  SectionSidebarRow,
} from "@/components/sidebar/SectionSidebar";
import { InviteSidebarRow } from "@/components/InviteOffer";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import { canOpenNativeScreen, shellOpenNative } from "@/lib/native-shell";
import { SettingsAccountMenu } from "./SettingsAccountMenu";
import { useSettingsNavState } from "./settings-nav";
import type { SettingsNavState } from "./settings-nav";
import {
  findSettingsNavGroup,
  getSettingsGroupLinks,
  SETTINGS_NAV_GROUPS,
} from "./settings-sections";
import {
  searchSettings,
  usePluginSettingsSearchEntries,
  useReportSettingsSearchMiss,
} from "./settings-search";

const RESULTS_ID = "settings-search-results";
const optionId = (index: number) => `settings-search-option-${index}`;

interface SettingsSidebarProps {
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  appRoutePath: string;
  mobileHosted?: boolean;
}

type SettingsSidebarNavigation = Pick<
  SettingsNavState,
  "activePluginId" | "activeSection" | "pluginEntries" | "sections"
>;

interface SettingsSidebarContentProps extends SettingsSidebarProps {
  account?: ReactNode;
  invite?: ReactNode;
  navigation: SettingsSidebarNavigation;
  testIdPrefix?: string;
}

export function SettingsSidebarContent({
  account,
  invite,
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  mobileHosted,
  navigation,
  testIdPrefix = "settings",
}: SettingsSidebarContentProps) {
  const navigate = useNavigate();
  const closeOnMobile = useCloseMobileSidebar();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeGroup = findSettingsNavGroup(
    navigation.activeSection,
    navigation.activePluginId,
  );
  const searching = query.trim() !== "";
  const pluginSearchEntries = usePluginSettingsSearchEntries(
    navigation.pluginEntries.map((entry) => entry.id),
    searching,
  );
  const results = searching
    ? searchSettings(query, navigation, pluginSearchEntries)
    : [];
  const selectedIndex = Math.min(selected, results.length - 1);
  useReportSettingsSearchMiss(searching && results.length === 0 ? query : null);
  useEffect(() => {
    if (selectedIndex < 0) return;
    document
      .getElementById(optionId(selectedIndex))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.matches("input, textarea, select"))
      )
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  const rows = SETTINGS_NAV_GROUPS.flatMap((group) => {
    const links = getSettingsGroupLinks(group, navigation);
    return links.length > 0 ? [{ group, to: links[0]!.to }] : [];
  });

  const footer = (
    <div className="space-y-2">
      {canOpenNativeScreen() ? (
        <SectionSidebarActionRow
          label="This device"
          testId="settings-nav-native-device"
          onClick={() => shellOpenNative("device-settings")}
        >
          <SectionSidebarIcon name="Smartphone" />
        </SectionSidebarActionRow>
      ) : null}
      {account}
    </div>
  );

  return (
    <SectionSidebar
      backLabel="Back to app"
      backTo={appRoutePath}
      footer={footer}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      onResizeMouseDown={onResizeMouseDown}
      testIdPrefix={testIdPrefix}
    >
      <div className="relative mt-2 mb-3">
        <Icon
          name="Search"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-sidebar-foreground"
        />
        <Input
          ref={searchRef}
          aria-label="Search settings"
          aria-activedescendant={
            selectedIndex >= 0 ? optionId(selectedIndex) : undefined
          }
          aria-autocomplete="list"
          aria-controls={RESULTS_ID}
          aria-expanded={searching}
          className="h-9 border-sidebar-border bg-sidebar-accent pr-9 pl-9 text-sm"
          role="combobox"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setSelected(
                (selectedIndex + step + results.length) %
                  Math.max(results.length, 1),
              );
              return;
            }
            const result = results[selectedIndex];
            if (event.key !== "Enter" || !result) return;
            navigate(result.to, { state: { settingsTarget: result.target } });
            setQuery("");
            closeOnMobile();
          }}
          placeholder="Search settings…"
          value={query}
        />
        {searching ? null : (
          <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm border border-border-hairline px-1.5 py-0.5 font-sans text-xs leading-none text-subtle-foreground max-md:pointer-coarse:hidden">
            /
          </kbd>
        )}
      </div>
      {searching ? (
        <>
          <div
            aria-label="Settings results"
            className="space-y-0.5"
            id={RESULTS_ID}
            role="listbox"
          >
            {results.map((result, index) => (
              <Link
                key={result.key}
                aria-selected={index === selectedIndex}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                to={result.to}
                state={{ settingsTarget: result.target }}
                onClick={closeOnMobile}
                onMouseEnter={() => setSelected(index)}
                className={cn(
                  "block rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent",
                  index === selectedIndex && "bg-sidebar-accent",
                )}
              >
                <span className="block truncate">{result.label}</span>
                {result.path ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {result.path}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
          {results.length === 0 ? (
            <p
              className="px-2 py-1.5 text-sm text-muted-foreground"
              role="status"
            >
              No settings match.
            </p>
          ) : null}
        </>
      ) : (
        <div className="space-y-0.5">
          {rows.map(({ group, to }) => (
            <SectionSidebarRow
              key={group.id}
              active={activeGroup.id === group.id}
              label={group.label}
              to={to}
            >
              <SectionSidebarIcon name={group.icon} />
            </SectionSidebarRow>
          ))}
          {invite}
        </div>
      )}
    </SectionSidebar>
  );
}

export function SettingsSidebar({
  onResizeMouseDown,
  isResizing,
  appRoutePath,
  mobileHosted,
}: SettingsSidebarProps) {
  const navigation = useSettingsNavState();

  return (
    <SettingsSidebarContent
      account={
        <SettingsAccountMenu
          usagePage={navigation.pluginEntries.some(
            ({ id }) => id === "provider-usage",
          )}
        />
      }
      invite={<InviteSidebarRow />}
      appRoutePath={appRoutePath}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      navigation={navigation}
      onResizeMouseDown={onResizeMouseDown}
    />
  );
}
