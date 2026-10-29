import { describe, expect, it } from "vitest";
import {
  decideAppWindowNavigation,
  isAllowedAppPermission,
  isAppWindowMainFrame,
  isHttpOrigin,
  isSensitiveAppSender,
} from "../src/desktop-app-window-policy.js";

const APP_ORIGIN = "http://127.0.0.1:4317";
const APP_URL = `${APP_ORIGIN}/threads/thr_abc`;

describe("isHttpOrigin", () => {
  it("accepts http and https origins", () => {
    expect(isHttpOrigin(APP_ORIGIN)).toBe(true);
    expect(isHttpOrigin("https://x.cloudroom.run")).toBe(true);
  });

  it("rejects opaque, missing, and non-web origins", () => {
    expect(isHttpOrigin("null")).toBe(false);
    expect(isHttpOrigin(null)).toBe(false);
    expect(isHttpOrigin(undefined)).toBe(false);
    expect(isHttpOrigin("file://")).toBe(false);
  });
});

describe("decideAppWindowNavigation", () => {
  const base = { committedUrl: APP_URL };

  it("blocks a top-frame navigation to an outside site and opens it externally", () => {
    const decision = decideAppWindowNavigation({
      ...base,
      kind: "navigate",
      isMainFrame: true,
      targetUrl: "https://attacker.example/x",
    });
    expect(decision.allow).toBe(false);
    expect(decision.openExternally).toBe(true);
  });

  it("blocks a top-frame navigation to a same-origin file-preview endpoint", () => {
    const decision = decideAppWindowNavigation({
      ...base,
      kind: "navigate",
      isMainFrame: true,
      targetUrl: `${APP_ORIGIN}/api/v1/threads/thr_abc/worktree/files/evil.html`,
    });
    expect(decision.allow).toBe(false);
  });

  it("allows a reload (target equals the committed URL)", () => {
    const decision = decideAppWindowNavigation({
      ...base,
      kind: "navigate",
      isMainFrame: true,
      targetUrl: APP_URL,
    });
    expect(decision.allow).toBe(true);
    expect(decision.openExternally).toBe(false);
  });

  it("allows a sub-frame navigation (sandboxed previews)", () => {
    const decision = decideAppWindowNavigation({
      ...base,
      kind: "navigate",
      isMainFrame: false,
      targetUrl: "https://attacker.example/x",
    });
    expect(decision.allow).toBe(true);
  });

  it("allows an authorized load redirect, including a cross-origin http->https upgrade", () => {
    expect(
      decideAppWindowNavigation({
        ...base,
        kind: "redirect",
        isMainFrame: true,
        targetUrl: "https://my-server.example/",
      }).allow,
    ).toBe(true);
  });

  it("does not open non-web schemes externally when blocked", () => {
    const decision = decideAppWindowNavigation({
      ...base,
      kind: "navigate",
      isMainFrame: true,
      targetUrl: "file:///etc/passwd",
    });
    expect(decision.allow).toBe(false);
    expect(decision.openExternally).toBe(false);
  });
});

describe("isSensitiveAppSender", () => {
  const trusted = {
    isAppWindow: true,
    isMainFrame: true,
    senderOrigin: APP_ORIGIN,
  };

  it("allows the app window main frame on a real http(s) origin", () => {
    expect(isSensitiveAppSender(trusted)).toBe(true);
    expect(
      isSensitiveAppSender({ ...trusted, senderOrigin: "https://x.cloudroom.run" }),
    ).toBe(true);
  });

  it("rejects sub-frames (embedded preview iframes)", () => {
    expect(isSensitiveAppSender({ ...trusted, isMainFrame: false })).toBe(false);
  });

  it("rejects an opaque origin and a non-app window", () => {
    expect(isSensitiveAppSender({ ...trusted, senderOrigin: "null" })).toBe(false);
    expect(isSensitiveAppSender({ ...trusted, senderOrigin: null })).toBe(false);
    expect(isSensitiveAppSender({ ...trusted, isAppWindow: false })).toBe(false);
  });
});

describe("isAppWindowMainFrame", () => {
  it("allows the app window main frame regardless of origin (startup views)", () => {
    expect(isAppWindowMainFrame({ isAppWindow: true, isMainFrame: true })).toBe(true);
  });

  it("rejects sub-frames and non-app windows", () => {
    expect(isAppWindowMainFrame({ isAppWindow: true, isMainFrame: false })).toBe(false);
    expect(isAppWindowMainFrame({ isAppWindow: false, isMainFrame: true })).toBe(false);
  });
});

describe("isAllowedAppPermission", () => {
  const trusted = { isAppWindowMainFrame: true, originIsHttp: true };

  it("allows microphone (audio-only media)", () => {
    expect(
      isAllowedAppPermission({ ...trusted, permission: "media", mediaAudioOnly: true }),
    ).toBe(true);
  });

  it("denies camera / video media", () => {
    expect(
      isAllowedAppPermission({ ...trusted, permission: "media", mediaAudioOnly: false }),
    ).toBe(false);
  });

  it("allows clipboard write, notifications, fullscreen, screen wake lock, and local-network", () => {
    for (const permission of [
      "clipboard-sanitized-write",
      "notifications",
      "fullscreen",
      "screen-wake-lock",
      "local-network",
      "local-network-access",
      "loopback-network",
    ]) {
      expect(
        isAllowedAppPermission({ ...trusted, permission, mediaAudioOnly: false }),
      ).toBe(true);
    }
  });

  it("denies clipboard-read and other sensitive permissions", () => {
    for (const permission of [
      "clipboard-read",
      "geolocation",
      "midi",
      "openExternal",
      "display-capture",
    ]) {
      expect(
        isAllowedAppPermission({ ...trusted, permission, mediaAudioOnly: true }),
      ).toBe(false);
    }
  });

  it("denies a sub-frame or an opaque origin even for an allowed permission", () => {
    expect(
      isAllowedAppPermission({
        permission: "media",
        isAppWindowMainFrame: false,
        originIsHttp: true,
        mediaAudioOnly: true,
      }),
    ).toBe(false);
    expect(
      isAllowedAppPermission({
        permission: "clipboard-sanitized-write",
        isAppWindowMainFrame: true,
        originIsHttp: false,
        mediaAudioOnly: false,
      }),
    ).toBe(false);
  });
});
