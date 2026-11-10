import { StrictMode, useEffect } from "react";
import { COMPUTER } from "@cloudroom/domain";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import {
  isPhoneRelay,
  keepOfflineCopy,
  macIsOff,
  macOffline,
  reloadWhenMacGoesOffline,
} from "./cloud/cloud-mode";
import { installCloudServer } from "./cloud/cloud-server";
import { keepOtherMacOnScreen, viewingOtherMac } from "./cloud/other-mac";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { AppToaster } from "./components/AppToaster";
import { isFirefoxAndroid } from "./components/layout/useMobileVisualViewportHeight";
import { appToast } from "./components/ui/app-toast";
import { registerProviderCliInstallQueryClient } from "./components/provider-cli/provider-cli-install-store";
import { initializeCorners } from "./hooks/useCorners";
import { initializePreferredTheme } from "./hooks/useTheme";
import { initializeFavicon } from "./lib/favicon-color-preference";
import { installForeignDomMutationGuard } from "./lib/foreign-dom-mutation-guard";
import { installAppQueryClientBrowserEvents } from "./lib/query-client";
import { appQueryClient } from "./lib/app-query-client";
import { getBbDesktopInfo } from "./lib/bb-desktop";
import { applyCachedAppThemeCss } from "./lib/themes";
import { installPerfMonitor } from "./lib/perf";
import { installNewThreadKeyboardPrimer } from "./lib/new-thread-keyboard-primer";
import { installTimeInApp } from "./lib/time-in-app";
import "./app.css";

installForeignDomMutationGuard();
installPerfMonitor();
installNewThreadKeyboardPrimer();
installTimeInApp();

Error.stackTraceLimit = 50;

// A page left open across an app update asks for old chunk names that no
// longer exist. Reload to pick up the new build, at most once per minute so a
// truly missing file can't cause a reload loop.
window.addEventListener("vite:preloadError", () => {
  if (macIsOff()) return;
  const lastReload = Number(sessionStorage.getItem("cloudroom:preload-reload"));
  if (Date.now() - lastReload < 60_000) return;
  sessionStorage.setItem("cloudroom:preload-reload", String(Date.now()));
  window.location.reload();
});

document.documentElement.toggleAttribute(
  "data-firefox-android",
  isFirefoxAndroid(navigator),
);

// Pause looping animations only when Electron and the page both say the
// window is unfocused. Either signal alone can be wrong: the page loses focus
// to the in-app browser view, and Electron's state can disagree with the page.
const desktopApi = getBbDesktopInfo();
let nativeFocused: boolean | undefined;
const updateWindowBlurred = () => {
  document.documentElement.toggleAttribute(
    "data-window-blurred",
    nativeFocused === false && !document.hasFocus(),
  );
};
const setNativeFocused = ({ isFocused }: { isFocused?: boolean }) => {
  nativeFocused = isFocused;
  updateWindowBlurred();
};
desktopApi?.onWindowStateChange?.(setNativeFocused);
void desktopApi?.getWindowState?.().then(setNativeFocused);
for (const type of ["focus", "blur", "pageshow"]) {
  window.addEventListener(type, updateWindowBlurred);
}
document.addEventListener("visibilitychange", updateWindowBlurred);

installAppQueryClientBrowserEvents(appQueryClient);
registerProviderCliInstallQueryClient(appQueryClient);

initializePreferredTheme();
initializeCorners();
applyCachedAppThemeCss();
initializeFavicon();

const root = createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, errorInfo) => {
    console.error(
      "[Cloudroom] uncaught render error — the app root was torn down",
      error,
      errorInfo.componentStack,
    );
  },
});

let toldCloudMode = false;

function CloudModeNotice() {
  useEffect(() => {
    if (toldCloudMode) return;
    toldCloudMode = true;
    appToast.message(
      `Your ${COMPUTER} is offline. Showing your Cloud threads.`,
    );
  }, []);
  return null;
}

function render() {
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <QueryClientProvider client={appQueryClient}>
          <BrowserRouter>
            <App />
            <AppToaster />
            {macIsOff() && <CloudModeNotice />}
          </BrowserRouter>
        </QueryClientProvider>
      </AppErrorBoundary>
    </StrictMode>,
  );
}

if (viewingOtherMac()) {
  // The desktop app showing another Mac stays on it through a drop. It never reloads into Cloud threads like a phone.
  keepOfflineCopy();
  keepOtherMacOnScreen();
  render();
} else if (isPhoneRelay()) {
  keepOfflineCopy();
  void macOffline().then((offline) => {
    if (offline) installCloudServer();
    else reloadWhenMacGoesOffline();
    render();
  });
} else {
  render();
}
