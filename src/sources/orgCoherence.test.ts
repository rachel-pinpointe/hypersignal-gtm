// A junk domain filed 200 openings belonging to companies that had never heard of it.
//
// hiring.cafe's /org/<domain> route groups openings under a company domain, and the scan trusted that
// grouping completely. For a generic domain the grouping is meaningless. Measured live: /org/us.com
// returns 25 openings on page 0 belonging to TEN unrelated employers, and the scan filed every one of
// them against us.com — Jasper Group, ITAC, Kuraray, TMMG, Porters American Retail Services and the
// rest all became "us.com is hiring".
//
// The name distributions below are the real ones read off hiring.cafe, not invented shapes.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { orgPageIsOneEmployer } from "./hiringcafe.ts";

const rep = (n: number, name: string) => Array.from({ length: n }, () => name);

test("a page of ten unrelated employers is refused", () => {
  // /org/us.com page 0, verbatim.
  const us = [...rep(5, "Jasper Group"), ...rep(4, "Porters American Retail Services"),
    ...rep(4, "Global Technical Systems"), ...rep(2, "Innovative Hearth Products"), ...rep(2, "ITAC"),
    ...rep(2, "Business Operational Concepts"), ...rep(2, "TMMG"), ...rep(2, "Magnet Partners"),
    "Aviture", "Kuraray"];
  const r = orgPageIsOneEmployer(us);
  assert.equal(r.ok, false);
  assert.ok(r.coherence < 0.3, `us.com measured 20% coherent, got ${Math.round(r.coherence * 100)}%`);
});

test("a real employer passes even when its name has nothing to do with its domain", () => {
  // THE CHECK THAT LOOKS OBVIOUS — "the company name must match the domain" — WOULD DELETE THESE.
  // aa.com is American Airlines, pg.com is Procter & Gamble, abc.xyz is Alphabet. Refusing short
  // domains outright would delete hp.com, ey.com and ibm.com too. All measured at 100% coherent.
  for (const name of ["American Airlines", "Procter & Gamble", "Alphabet", "HP", "EY", "IBM"])
    assert.equal(orgPageIsOneEmployer(rep(25, name)).ok, true, name);
});

test("related brands are one employer, not a mixed page", () => {
  // /org/fedex.com page 0: 20 FedEx, 3 FedEx Supply Chain, 2 FedEx Freight — measured 100%.
  const fedex = [...rep(20, "FedEx"), ...rep(3, "FedEx Supply Chain"), ...rep(2, "FedEx Freight")];
  const r = orgPageIsOneEmployer(fedex);
  assert.equal(r.ok, true);
  assert.equal(r.coherence, 1);
});

test("a single stray on an otherwise coherent page does not condemn it", () => {
  // /org/3m.com measured 92%. A name we do not recognise is more likely a subsidiary than a misfiling,
  // and throwing away real openings to tidy an 8% minority is the worse error.
  assert.equal(orgPageIsOneEmployer([...rep(23, "3M"), ...rep(2, "Aearo Technologies")]).ok, true);
});

test("legal suffixes and accents do not split one company into several", () => {
  assert.equal(orgPageIsOneEmployer([...rep(10, "Nestlé"), ...rep(10, "Nestle S.A."), ...rep(5, "Nestlé, Inc.")]).ok, true);
});

test("a page that states no company names is not treated as a failure", () => {
  // Nothing stated is not a failed test — the same rule the facet filters follow. Refusing here would
  // silently drop a real company because its openings happened to omit the field.
  assert.equal(orgPageIsOneEmployer([]).ok, true);
  assert.equal(orgPageIsOneEmployer(["", "   ", ""]).ok, true);
});

test("the threshold sits clear of every measured value", () => {
  // Nothing legitimate measured below 92%; the junk case measured 20%. If a future edit moves the line
  // into that gap, this fails rather than quietly starting to discard real employers.
  const half = [...rep(13, "Acme"), ...rep(12, "Beta Industries")];
  assert.equal(orgPageIsOneEmployer(half).ok, false, "a 52/48 split is not one employer");
  const mostly = [...rep(16, "Acme"), ...rep(9, "Beta Industries")];
  assert.equal(orgPageIsOneEmployer(mostly).ok, true, "64% is above the line");
});
