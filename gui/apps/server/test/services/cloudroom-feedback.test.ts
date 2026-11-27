import { expect, it, vi } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";

it("rejects feedback over 4,000 characters with a 400 that names the limit (#2669)", async () => {
  await withTestHarness(async (harness) => {
    const delivered = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      const send = (message: string) => harness.app.request("/api/v1/cloudroom/bug-reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
      const ok = await send("x".repeat(4000));
      expect([ok.status, await ok.json()]).toEqual([200, { sent: true }]);
      const tooLong = await send("x".repeat(4001));
      expect(tooLong.status).toBe(400);
      expect((await tooLong.json()).message).toContain("4,000 characters");
      expect(delivered).toHaveBeenCalledTimes(1);
    } finally {
      delivered.mockRestore();
    }
  });
});
