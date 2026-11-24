import { expect, it } from "vitest";
import { windowsPreviewRepair } from "../../src/services/cloudroom/previews.js";

it("turns the Windows helper's Permission denied into an elevated icacls repair with literal arguments (#2459)", () => {
  const dir = "C:\\Users\\o'$env:x\\.gui-cloudroom\\cloudroom-preview";
  // The helper's real stderr: Python doubles the backslashes.
  const repair = windowsPreviewRepair(`[Errno 13] Permission denied: '${dir.replaceAll("\\", "\\\\")}\\\\config.json'`, dir, "PC\\o'me");
  expect(repair).toContain(`run icacls 'C:\\Users\\o''$env:x\\.gui-cloudroom\\cloudroom-preview' /grant 'PC\\o''me:(OI)(CI)F' /C /L and restart`);
  expect(windowsPreviewRepair("Preview helper did not start", dir, "PC\\o'me")).toBeNull();
});
