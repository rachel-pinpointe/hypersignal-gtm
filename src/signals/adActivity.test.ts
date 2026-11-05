// Regression tests for the Meta ad-activity reading.
//
// The producer's whole output rests on one number scraped from the Ad Library page, and that number
// was being read out of a Playwright callback where nothing could test it. The consequence, measured
// on the live database: 43 domains held `active = 50000` — the Ad Library's display CEILING, not a
// count — and each was flagged on the Companies view as running fifty thousand adverts.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdReading, normalizeAdRegion, AD_REGIONS, CEILING_NOTE } from "./adActivity.ts";

test("the 50,000 result ceiling is unmeasurable, not a count", () => {
  // Meta renders "~50,000 results" for anything at or above the cap. It means the keyword search
  // matched a large slice of the whole library, so it is evidence about nothing.
  assert.equal(parseAdReading("~50,000 results").count, null);
  assert.equal(parseAdReading("~50,000 results").note, CEILING_NOTE);
  assert.equal(parseAdReading("50,000 results").count, null);
  assert.equal(parseAdReading("≈ 62,000 results").count, null, "anything past the cap is equally meaningless");
});

test("a real count below the ceiling is still a real count", () => {
  // The guard must not swallow genuine heavy advertisers — 29,000 is a plausible reading.
  assert.equal(parseAdReading("~29,000 results").count, 29000);
  assert.equal(parseAdReading("1,234 results").count, 1234);
  assert.equal(parseAdReading("1 result").count, 1);
  assert.equal(parseAdReading("~49,999 results").count, 49999, "one short of the cap is a measurement");
});

test("null and zero are different answers", () => {
  // null = we could not measure; 0 = we measured and there are none. The producer branches on this:
  // a null must never write state or flip an ads-started/ads-stopped transition.
  assert.equal(parseAdReading("No ads match your search").count, 0);
  assert.equal(parseAdReading("No results found").count, 0);
  assert.equal(parseAdReading("Log in to continue\nCreate new account").count, null);
  assert.equal(parseAdReading("Log in to continue\nCreate new account").note, "login wall");
  assert.equal(parseAdReading("something entirely unexpected").count, null);
});

test("the card-count fallback is a lower bound, and says so", () => {
  const r = parseAdReading("Library ID: 123456789\nLibrary ID 987654321\nLibrary ID: 5");
  assert.equal(r.count, 3);
  assert.match(r.note, /lower bound/);
});

test("an unrecognised ad region is dropped, never passed through", () => {
  // A bad code would silently narrow the Ad Library search to nothing and read as "no ads".
  assert.equal(normalizeAdRegion("us"), "US");
  assert.equal(normalizeAdRegion("ALL"), "ALL");
  assert.equal(normalizeAdRegion("ZZ"), null);
  assert.equal(normalizeAdRegion(""), null);
  assert.equal(normalizeAdRegion(undefined), null);
  assert.equal(normalizeAdRegion("US; DROP TABLE"), null);
  assert.ok(AD_REGIONS.every((r) => normalizeAdRegion(r.code) === r.code),
    "every region the UI offers must survive its own validator");
});
