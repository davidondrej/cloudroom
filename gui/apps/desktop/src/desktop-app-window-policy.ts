const EXTERNALLY_OPENABLE_SCHEME = /^(https?|mailto):/iu;

export function isHttpOrigin(origin: string | null | undefined): boolean {
  return (
    origin !== null &&
    origin !== undefined &&
    (origin.startsWith("http://") || origin.startsWith("https://"))
  );
}

export interface AppNavigationDecision {
  allow: boolean;
  openExternally: boolean;
}

export interface DecideAppWindowNavigationArgs {
  kind: "navigate" | "redirect";
  isMainFrame: boolean;
  targetUrl: string;
  committedUrl: string;
}

// The app window's main frame may only be navigated by the main process (loadURL, which does not
// fire will-frame-navigate) or reloaded. Any other renderer-initiated navigation is blocked, so an
// untrusted page can never become the top document and inherit the preload, IPC, or permissions.
// A redirect is always part of a load the main process started or of a reload we allowed (the
// renderer navigation that would have reached an untrusted origin is already blocked before any
// redirect fires), so redirects are allowed — this keeps an http->https upgrade on a custom or
// dev server working.
export function decideAppWindowNavigation(
  args: DecideAppWindowNavigationArgs,
): AppNavigationDecision {
  if (!args.isMainFrame) {
    return { allow: true, openExternally: false };
  }
  if (args.kind === "redirect" || args.targetUrl === args.committedUrl) {
    return { allow: true, openExternally: false };
  }
  return {
    allow: false,
    openExternally: EXTERNALLY_OPENABLE_SCHEME.test(args.targetUrl),
  };
}

export interface AppSenderIdentity {
  isAppWindow: boolean;
  isMainFrame: boolean;
  senderOrigin: string | null;
}

export function isAppWindowMainFrame(
  identity: Pick<AppSenderIdentity, "isAppWindow" | "isMainFrame">,
): boolean {
  return identity.isAppWindow && identity.isMainFrame;
}

// Trust the app window's own main frame on a real http(s) origin. The navigation guard guarantees
// that frame only ever holds a document the main process loaded, so its committed origin is the
// authorized app/server origin (including after an http->https redirect). An opaque "null" origin
// (a data: view or a CSP-sandboxed preview) and any sub-frame are rejected.
export function isSensitiveAppSender(identity: AppSenderIdentity): boolean {
  return (
    identity.isAppWindow &&
    identity.isMainFrame &&
    isHttpOrigin(identity.senderOrigin)
  );
}

// notifications: desktop push notifications and usage alerts use the web Notification API.
// fullscreen: the video file preview's fullscreen button.
const ALLOWED_APP_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "notifications",
  "fullscreen",
  "screen-wake-lock",
  "local-network",
  "local-network-access",
  "loopback-network",
]);

export interface AllowedAppPermissionArgs {
  permission: string;
  isAppWindowMainFrame: boolean;
  originIsHttp: boolean;
  mediaAudioOnly: boolean;
}

export function isAllowedAppPermission(args: AllowedAppPermissionArgs): boolean {
  if (!args.isAppWindowMainFrame || !args.originIsHttp) {
    return false;
  }
  if (args.permission === "media") {
    return args.mediaAudioOnly;
  }
  return ALLOWED_APP_PERMISSIONS.has(args.permission);
}
