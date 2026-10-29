import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

export const CLOUD_LOCKED_REASON = "Sign in to use Cloud.";

export function useCloudLocked(): boolean {
  const status = useCloudroomAccount();
  return status.isSuccess && !status.data.account && !status.data.selfHosted;
}

export function showCloudSignIn(): void {
  appToast.message("Sign in to use Cloud", {
    description: "Cloud agents need a Cloudroom account. Sign in or create one for free.",
    action: { label: "Sign in", onClick: () => { void sdk.cloudroom.signIn().then(({ url }) => openUrlInExternalBrowser(url), (error: Error) => appToast.error(error.message)); } },
  });
}
