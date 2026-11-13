import { expect, it } from "vitest";
import { applyPopupEvent, canAskStar, nextStarAsk, type PopupState } from "../../src/services/cloudroom/popups.js";

const DAY = 86_400_000;
const fresh: PopupState = { closed: [], shownAt: null, credits: false, checklistHides: 0, starAsks: [], cards: [] };

it("asks once a day at most: a skipped card leads to the pop-up, then cards every 3 days, 3 at most", () => {
  let state = applyPopupEvent(fresh, "star_card", "shown", undefined, 0);
  expect(canAskStar(state, "popup", DAY - 1)).toBe(false);
  state = applyPopupEvent(state, "star_card", "closed", undefined, 1);
  expect(state.starAsks).toEqual([{ surface: "card", at: 0, answer: "dismissed" }]);
  expect(state.closed).toEqual([]);
  expect(canAskStar(state, "popup", DAY)).toBe(true);
  state = applyPopupEvent(state, "star", "shown", undefined, DAY);
  expect(canAskStar(state, "popup", 30 * DAY)).toBe(false);
  expect(canAskStar(state, "card", 2 * DAY)).toBe(false);
  expect(canAskStar(state, "card", 3 * DAY)).toBe(true);
  state = applyPopupEvent(applyPopupEvent(state, "star_card", "shown", undefined, 3 * DAY), "star_card", "shown", undefined, 6 * DAY);
  expect(canAskStar(state, "card", 30 * DAY)).toBe(false);
});

it("stops for good after a star from the card, and closes the pop-up for older apps", () => {
  const state = applyPopupEvent(applyPopupEvent(fresh, "star_card", "shown", undefined, 0), "star_card", "closed", "opened", 1);
  expect(state.closed).toEqual(["star"]);
  expect(canAskStar(state, "card", 30 * DAY)).toBe(false);
});

it("treats a pop-up closed before star asks existed as a skip: the card comes, the pop-up doesn't", () => {
  const state: PopupState = { ...fresh, closed: ["star"] };
  expect(canAskStar(state, "popup", 0)).toBe(false);
  expect(canAskStar(state, "card", 0)).toBe(true);
});

it("offers the unseen pop-up before repeating a skipped card", () => {
  const skipped = applyPopupEvent(applyPopupEvent(fresh, "star_card", "shown", undefined, 0), "star_card", "closed", undefined, 1);
  expect(nextStarAsk(skipped, { card: true, popup: true }, 4 * DAY)).toBe("popup");
  expect(nextStarAsk(skipped, { card: true, popup: false }, 4 * DAY)).toBe("card");
  expect(nextStarAsk(fresh, { card: true, popup: false }, 0)).toBe("card");
});

it("treats an older app's close without a reason as final", () => {
  const state = applyPopupEvent(applyPopupEvent(fresh, "star", "shown", undefined, 0), "star", "closed", "migrated", 1);
  expect(state.starAsks).toEqual([{ surface: "popup", at: 0, answer: "closed" }]);
  expect(nextStarAsk(state, { card: true, popup: true }, 30 * DAY)).toBe(null);
});
