import { describe, expect, it } from "vitest";
import * as semver from "@cloudroom/domain/semver";
import { ROOM_APP_COMPAT_VERSION, PLUGIN_SDK_VERSION } from "@cloudroom/domain";
import {
  roomCompatAppVersion,
  isPluginSdkRangeSatisfied,
} from "../../../src/services/plugins/sdk-compat.js";

const major = semver.major(PLUGIN_SDK_VERSION);

describe("isPluginSdkRangeSatisfied", () => {
  it("accepts a caret range the running SDK has grown past", () => {
    expect(isPluginSdkRangeSatisfied(`^${major}.0.1`)).toBe(true);
    expect(isPluginSdkRangeSatisfied(`${major}.0.1`)).toBe(true);
  });

  it("rejects a floor above the running SDK", () => {
    const sdk = semver.parse(PLUGIN_SDK_VERSION);
    if (sdk === null) throw new Error("cannot parse SDK version");
    const ahead = `${sdk.major}.${sdk.minor + 1}.0`;
    expect(isPluginSdkRangeSatisfied(`>=${ahead}`)).toBe(false);
    expect(isPluginSdkRangeSatisfied(`^${ahead}`)).toBe(false);
  });

  it("rejects a range pinned to a different major", () => {
    expect(isPluginSdkRangeSatisfied(`^${major + 1}.0.0`)).toBe(false);
  });

  it("returns false for a malformed range instead of throwing", () => {
    expect(() => isPluginSdkRangeSatisfied("not-a-range")).not.toThrow();
    expect(isPluginSdkRangeSatisfied("not-a-range")).toBe(false);
  });

  it("accepts the ranges the scaffold and the running SDK produce", () => {
    expect(isPluginSdkRangeSatisfied(`>=${PLUGIN_SDK_VERSION}`)).toBe(true);
    expect(isPluginSdkRangeSatisfied(PLUGIN_SDK_VERSION)).toBe(true);
    expect(isPluginSdkRangeSatisfied("*")).toBe(true);
  });
});

describe("bbCompatAppVersion", () => {
  it("reports the BB release that matches the SDK, not the bb-app package version", () => {
    expect(roomCompatAppVersion("126.0.0")).toBe(ROOM_APP_COMPAT_VERSION);
  });

  it("keeps dev builds in dev mode", () => {
    expect(roomCompatAppVersion("0.0.0-dev")).toBe("0.0.0-dev");
  });
});
