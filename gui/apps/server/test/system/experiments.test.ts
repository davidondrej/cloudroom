import { describe, expect, it } from "vitest";
import { getExperiments } from "@cloudroom/db";
import { defaultExperiments, experimentsSchema } from "@cloudroom/domain";
import { systemConfigResponseSchema } from "@cloudroom/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const allOn = {
  changelogPreview: true,
  mobileApp: true,
  multiMachinePicker: true,
  sidebarProgressiveDisclosure: true,
  timelineWindowing: true,
};

function putExperiments(harness: TestAppHarness, body: unknown) {
  return harness.app.request("/api/v1/settings/experiments", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("experiments settings", () => {
  it("serves the shipped experiment defaults in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const body = systemConfigResponseSchema.parse(await readJson(response));
      expect(body.experiments).toEqual(defaultExperiments);
    });
  });

  it("persists a PUT and reflects it in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/experiments", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(allOn),
      });
      expect(put.status).toBe(200);
      expect(experimentsSchema.parse(await readJson(put))).toEqual({ ...defaultExperiments, ...allOn });
      expect(getExperiments(harness.db)).toEqual({ ...defaultExperiments, ...allOn });

      const config = await harness.app.request("/api/v1/system/config");
      expect(
        systemConfigResponseSchema.parse(await readJson(config)).experiments,
      ).toEqual({ ...defaultExperiments, ...allOn });
    });
  });

  it("does not expose legacy direct bb connect routes", async () => {
    await withTestHarness(async (harness) => {
      const disabled = await harness.app.request("/api/v1/connect/status");
      expect(disabled.status).toBe(404);

      const put = await harness.app.request("/api/v1/settings/experiments", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changelogPreview: false,
          mobileApp: false,
          multiMachinePicker: false,
          sidebarProgressiveDisclosure: false,
          timelineWindowing: false,
        }),
      });
      expect(put.status).toBe(200);

      const enabled = await harness.app.request("/api/v1/connect/status");
      expect(enabled.status).toBe(404);
    });
  });

  it("keeps settings a payload leaves out and ignores unknown ones", async () => {
    await withTestHarness(async (harness) => {
      expect((await putExperiments(harness, { hideLaptopHints: true })).status).toBe(200);
      expect((await putExperiments(harness, { changelogPreview: true, futureExperiment: true })).status).toBe(200);
      expect(getExperiments(harness.db)).toEqual({ ...defaultExperiments, hideLaptopHints: true, changelogPreview: true });
      expect((await putExperiments(harness, { changelogPreview: "yes" })).status).toBe(400);
    });
  });
});
