// SimplyHired's date parser — the one piece of that adapter that runs without a browser, and the one
// most likely to be wrong without anyone noticing.
//
// SimplyHired does not give a posting date. It gives a chip of loose text somewhere on the card
// ("14d", "3 hours ago", "Today", "30+ days"), and this function has to find it among every other
// line of that card and turn it into an instant. Everything downstream runs on the result: the
// client's date filter, the "new this week" view, and the hiring-velocity signal, which is a count of
// postings per month. A parser that reads "8 hour shift" as a timestamp does not fail — it dates the
// job to eight hours ago and it looks entirely plausible on screen.
//
// The rest of simplyHiredAdapter drives Playwright and is exercised against the live site rather than
// here; `looksBlocked`, its other decision point, is covered in browser.test.ts.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePosted } from "./simplyhired.ts";

const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
/** How long ago the parsed value is, in ms. Tolerant of the clock moving during the test. */
function agoMs(iso: string | null): number {
  assert.ok(iso, "expected a parsed date, got null");
  return Date.now() - Date.parse(iso!);
}
function assertAgo(iso: string | null, expected: number, what: string): void {
  const got = agoMs(iso);
  assert.ok(Math.abs(got - expected) < 5000, `${what}: expected ~${expected}ms ago, got ${got}ms`);
}

test("a real datetime attribute wins over anything on the card", async () => {
  // When SimplyHired renders a <time datetime>, it is the only exact value available. Reading the
  // fuzzy chip instead would round a known instant to the nearest day for no reason.
  assert.equal(parsePosted("2026-07-14T09:00:00Z", ["30+ days"]), "2026-07-14T09:00:00.000Z");
  assert.equal(parsePosted("2026-07-14", []), "2026-07-14T00:00:00.000Z");
});

test("a junk datetime attribute falls through to the card text instead of poisoning the date", async () => {
  // An empty or unparseable attribute is common on these cards. It must not be treated as a date, and
  // it must not stop the chip from being read.
  assertAgo(parsePosted("", ["Senior Cook", "3 days ago"]), 3 * DAY, "empty attribute");
  assertAgo(parsePosted("not a date", ["Senior Cook", "3 days ago"]), 3 * DAY, "unparseable attribute");
});

test("the units SimplyHired actually prints all convert", async () => {
  // Each abbreviation is a separate entry in the lookup, so each can be dropped on its own — and a
  // dropped unit returns null, which reads downstream as "we don't know when", not as an error.
  assertAgo(parsePosted("", ["45 minutes ago"]), 45 * MIN, "minutes");
  assertAgo(parsePosted("", ["45 min ago"]), 45 * MIN, "min");
  assertAgo(parsePosted("", ["6 hours ago"]), 6 * HOUR, "hours");
  assertAgo(parsePosted("", ["6h"]), 6 * HOUR, "h");
  assertAgo(parsePosted("", ["14d"]), 14 * DAY, "d");
  assertAgo(parsePosted("", ["14 days ago"]), 14 * DAY, "days");
  assertAgo(parsePosted("", ["3 weeks ago"]), 3 * 6048e5, "weeks");
  assertAgo(parsePosted("", ["2 months ago"]), 2 * 2592e6, "months");
  assertAgo(parsePosted("", ["1 year ago"]), 31536e6, "year");
});

test("'30+ days' is thirty days, not unparseable", async () => {
  // SimplyHired's oldest bucket. Dropping the plus makes every stale posting undated, which is exactly
  // the set a hiring-velocity count most needs to exclude.
  assertAgo(parsePosted("", ["30+ days"]), 30 * DAY, "30+ days");
  assertAgo(parsePosted("", ["30+ days ago"]), 30 * DAY, "30+ days ago");
});

test("'today' and its variants mean now", async () => {
  for (const chip of ["Today", "Just posted", "just now", "New", "moments ago", "Posted today"]) {
    assertAgo(parsePosted("", [chip]), 0, chip);
  }
});

test("card text that merely contains a number and a time word is NOT a date", async () => {
  // The reason the chip pattern is anchored to the whole line rather than searched within it. These
  // are all real SimplyHired card lines, and each one would date the posting wrongly — silently, and
  // in a way that looks reasonable on screen.
  for (const line of [
    "8 hour shift",            // the shift pattern, on nearly every hourly job
    "Monday to Friday + 1 day",
    "$22 - $26 an hour",
    "Up to 40 hours per week",
    "3 years experience required",
    "1.4",                     // the star rating that bleeds off the company line
  ]) {
    assert.equal(parsePosted("", [line]), null, `"${line}" must not be read as a posting date`);
  }
});

test("the date chip is found wherever it sits on the card, and the first one wins", async () => {
  // The lines come from innerText, so the chip's position moves with the card layout — searching only
  // a fixed index would stop finding it the next time SimplyHired reorders anything.
  const card = ["Line Cook", "Bistro Nine —Oakland, CA", "$20 - $24 an hour", "Full-time", "8 hour shift", "5 days ago"];
  assertAgo(parsePosted("", card), 5 * DAY, "chip at the end of the card");
  assertAgo(parsePosted("", ["2 days ago", ...card]), 2 * DAY, "and the first match is the one used");
});

test("a card with no date at all returns null rather than dating it to now", async () => {
  // Silence is not freshness. Defaulting an unknown date to the present is how a two-year-old posting
  // becomes this week's hiring signal.
  assert.equal(parsePosted("", []), null);
  assert.equal(parsePosted("", ["Line Cook", "Bistro Nine —Oakland, CA", "Full-time"]), null);
});
