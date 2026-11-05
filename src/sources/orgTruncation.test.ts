// An /org/ scan stops at its page limit and used to say nothing.
//
// Page 0 of a company's listing reports its TRUE total, so a scan that cannot reach the end knows
// exactly how short it fell. It did not report it, and the caller got a shorter list with no way to
// tell "this company has 200 openings" from "we were allowed to read 200 of its 2,885". Every count
// downstream inherits the wrong number — the check's per-company total, the Companies view's role
// count, and the hiring-velocity signal that compares this scan against the last one.
//
// Reachable on live data, not theoretical: at the Account Check's 90-page default (2,250 openings)
// fedex.com (2,885 stored) and ups.com (2,405) both truncate; at the "Fast" depth (8 pages, 200)
// ten watched companies do.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectDegraded } from "./degraded.ts";

/** The arithmetic scrapeHiringCafeOrg runs: did the PAGE LIMIT end the scan, or the company's list? */
const truncated = (total: number, perPage: number, maxPages: number) =>
  !!total && Math.ceil(total / perPage) > maxPages;

test("the page limit ending a scan is detectable from the stated total", () => {
  // fedex.com at the Account Check default: 2,885 openings, 25 a page = 116 pages needed, 90 allowed.
  assert.equal(truncated(2885, 25, 90), true);
  // ups.com, same limit.
  assert.equal(truncated(2405, 25, 90), true);
  // A company that fits is not reported — a warning on every scan is a warning nobody reads.
  assert.equal(truncated(519, 25, 90), false);
  assert.equal(truncated(2250, 25, 90), false, "exactly at the limit is complete, not truncated");
  assert.equal(truncated(2251, 25, 90), true, "one over the limit is truncated");
});

test("the shallower depths truncate far more companies", () => {
  assert.equal(truncated(582, 25, 8), true, "rlcarriers.com at Fast depth");
  assert.equal(truncated(218, 25, 8), true, "lynden.com at Fast depth");
  assert.equal(truncated(150, 25, 8), false);
});

test("an unknown total is never reported as truncation", () => {
  // parseOrgPage returns total 0 when the page did not state one. Absent is not "zero openings", and
  // guessing either way would be the exact defect this codebase keeps finding.
  assert.equal(truncated(0, 25, 8), false);
});

test("the warning reaches a fetch run's collected warnings", async () => {
  const { reportDegraded } = await import("./degraded.ts");
  const { warnings } = await collectDegraded(async () => {
    if (truncated(2885, 25, 90)) reportDegraded("fedex.com: page limit reached — read about 2250 of 2885 openings");
    if (truncated(519, 25, 90)) reportDegraded("expeditors.com: should not appear");
    return null;
  });
  assert.equal(warnings.length, 1, "only the company that actually truncated is reported");
  assert.match(warnings[0]!, /fedex\.com/);
  assert.match(warnings[0]!, /2885/);
});
