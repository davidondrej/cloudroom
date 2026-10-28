import { COMPUTER_TITLE } from "@cloudroom/domain";
import { describe, expect, it } from "vitest";
import { teleportLocalSteps } from "./TeleportNotice";

describe("teleportLocalSteps", () => {
  it("switches to this PC on Windows and this Mac or computer elsewhere", () => {
    expect(teleportLocalSteps("this PC").at(-1)).toEqual(["switching", "Switch to PC"]);
    expect(teleportLocalSteps("this Mac").at(-1)).toEqual(["switching", `Switch to ${COMPUTER_TITLE}`]);
  });
});
