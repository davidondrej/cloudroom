import { Button } from "@cloudroom/shared-ui/button";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { CHANGELOG_LINKS } from "./changelog-preview";

const WEBSITE_URL = "https://www.cloudroom.dev";
const GITHUB_REPO_URL = "https://github.com/davidondrej/cloudroom-gui";
const BB_CREDIT_URL = "https://github.com/get-bb/bb";

interface CommunityLinkRowProps {
  description: string;
  href: string;
  icon: IconName;
  label: string;
  openLabel: string;
}

function CommunityLinkRow({
  description,
  href,
  icon,
  label,
  openLabel,
}: CommunityLinkRowProps) {
  return (
    <SettingsWithControl label={label} description={description}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs"
        aria-label={openLabel}
        onClick={() => {
          openUrlInExternalBrowser(href);
        }}
      >
        <Icon name={icon} className="size-3.5 shrink-0" />
        {openLabel}
        <Icon
          name="ExternalLink"
          className="size-3 shrink-0 text-muted-foreground"
        />
      </Button>
    </SettingsWithControl>
  );
}

export function CommunitySettingsSection() {
  return (
    <SettingsSection
      title="Community"
      description="Follow Cloudroom development and learn how to get started."
    >
      <div className="space-y-5">
        <CommunityLinkRow
          label="Website"
          description="Product updates, blog posts, and security details."
          href={WEBSITE_URL}
          icon="Globe"
          openLabel="Visit cloudroom.dev"
        />
        <CommunityLinkRow
          label="GitHub"
          description="Source code, issues, and contributions for the Cloudroom GUI."
          href={GITHUB_REPO_URL}
          icon="GithubLogo"
          openLabel="View on GitHub"
        />
        <CommunityLinkRow
          label="Getting started"
          description="Build the GUI and connect to Cloudroom."
          href={`${GITHUB_REPO_URL}#readme`}
          icon="Explore"
          openLabel="Read the guide"
        />
        {CHANGELOG_LINKS.page !== null ? (
          <CommunityLinkRow
            label="Changelog"
            description="Cloudroom release notes and manual update information."
            href={CHANGELOG_LINKS.page}
            icon="ExternalLink"
            openLabel="Read the changelog"
          />
        ) : null}
        <p className="text-xs text-muted-foreground">
          <a
            href={BB_CREDIT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault();
              openUrlInExternalBrowser(BB_CREDIT_URL);
            }}
          >
            Built on BB
          </a>
        </p>
      </div>
    </SettingsSection>
  );
}
