// The Account Check and the watchlist scan /org/<domain>, a URL that takes no filter parameters. Every
// hiring.cafe filter those screens offer therefore has to be re-applied locally, and until now only
// keywords, excludes, technologies, date and location were.
//
// Measured by asking evaluate() directly with a job that fails every stated filter: 13 of the 16
// controls on the Account Check had NO EFFECT. "Remote only, Senior Level, $500,000 minimum" returned
// an onsite junior cleaning role in Mumbai with no salary stated, and nothing on screen said so.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { orgFacetsAllowed } from "./orgFacets.ts";
import type { RawJob, SearchSpec } from "./types.ts";

const job = (raw: Record<string, unknown>): RawJob => ({
  id: "j", source: "hcorg", externalId: "x", title: "Role", company: "Acme", location: "London",
  state: null, remote: false, url: "https://acme.com/1", postedAt: null, domain: "acme.com",
  status: "open", raw,
} as unknown as RawJob);
const spec = (s: Partial<SearchSpec>): SearchSpec => ({ keywords: [], ...s });
const ok = (raw: Record<string, unknown>, s: Partial<SearchSpec>) => orgFacetsAllowed(job(raw), spec(s));

test("a stated facet that fails the filter rejects the job", () => {
  assert.equal(ok({ workplace_type: "Onsite" }, { workplaceTypes: ["Remote"] }), false);
  assert.equal(ok({ commitment: "Part Time" }, { commitmentTypes: ["Full Time"] }), false);
  assert.equal(ok({ seniority: "Entry Level" }, { seniorityLevels: ["Senior Level"] }), false);
  assert.equal(ok({ job_category: "Sales" }, { departments: ["Software Development"] }), false);
  assert.equal(ok({ org_type: "private" }, { organizationTypes: ["non-profit"] }), false);
  assert.equal(ok({ security_clearance: "None" }, { securityClearances: ["Top Secret"] }), false);
  assert.equal(ok({ funding_type: "seed" }, { fundingStages: ["series f"] }), false);
  assert.equal(ok({ industry: ["Retail"] }, { industries: ["Software"] }), false);
});

test("a stated facet that satisfies the filter keeps the job", () => {
  assert.equal(ok({ workplace_type: "Remote" }, { workplaceTypes: ["Remote"] }), true);
  assert.equal(ok({ seniority: "Senior Level" }, { seniorityLevels: ["Senior Level", "Mid Level"] }), true);
  assert.equal(ok({ industry: ["Software", "Fintech"] }, { industries: ["Fintech"] }), true);
  assert.equal(ok({ workplace_type: "REMOTE" }, { workplaceTypes: ["Remote"] }), true, "case must not matter");
});

test("a comma-joined facet matches on any one of its values", () => {
  // hiring.cafe joins multiple commitments: "Full Time,Part Time" is a role open to either. A whole
  // string comparison rejected it. Caught by asking hiring.cafe itself — a live search for
  // commitmentTypes ["Part Time"] returned exactly these rows, so the service was right and we were
  // wrong. 1,136 of 26,965 stored rows carry a comma-joined commitment.
  assert.equal(ok({ commitment: "Full Time,Part Time" }, { commitmentTypes: ["Part Time"] }), true);
  assert.equal(ok({ commitment: "Full Time,Part Time" }, { commitmentTypes: ["Full Time"] }), true);
  assert.equal(ok({ commitment: "Part Time,Contract" }, { commitmentTypes: ["Contract"] }), true);
  assert.equal(ok({ commitment: "Full Time,Temporary" }, { commitmentTypes: ["Internship"] }), false,
    "a value it does NOT list must still be rejected");
});

test("an option that legitimately contains a comma is not broken by the split", () => {
  // "Environment, Health, and Safety" is ONE department, offered as a single option, and appears with
  // its commas on 80 stored rows. Splitting blindly would stop it ever matching itself.
  assert.equal(ok({ job_category: "Environment, Health, and Safety" },
    { departments: ["Environment, Health, and Safety"] }), true);
  assert.equal(ok({ job_category: "Environment, Health, and Safety" },
    { departments: ["Software Development"] }), false);
});

test("UNKNOWN never fails a test — an absent fact is not a failing one", () => {
  // The defect this codebase keeps finding is a missing measurement rendered as a fact. A posting that
  // never stated its salary is not "under $100k".
  assert.equal(ok({}, { workplaceTypes: ["Remote"] }), true);
  assert.equal(ok({}, { seniorityLevels: ["Senior Level"] }), true);
  assert.equal(ok({ seniority: null }, { seniorityLevels: ["Senior Level"] }), true);
  assert.equal(ok({}, { salaryMin: 500000, salaryCurrency: "USD", salaryFrequency: "Yearly" }), true);
  assert.equal(ok({}, { yoeMin: 10 }), true);
  assert.equal(ok({}, { companySizeRanges: [[1, 10]] }), true);
  assert.equal(ok({}, { minYearFounded: 2020 }), true);
  // ATS rows carry none of these fields at all, so they must pass every facet untouched.
  assert.equal(ok({}, { workplaceTypes: ["Remote"], seniorityLevels: ["Senior Level"], salaryMin: 1 }), true);
});

test("the two explicit opt-ins DO exclude unknowns, because that is what they mean", () => {
  assert.equal(ok({}, { onlyTransparentSalary: true }), false);
  assert.equal(ok({ comp_min: 90000 }, { onlyTransparentSalary: true }), true);
  assert.equal(ok({}, { yoeMin: 3, excludeIfNoYoe: true }), false);
  assert.equal(ok({ yoe: 5 }, { yoeMin: 3, excludeIfNoYoe: true }), true);
});

test("company size ranges are OR-ed, and an open-ended range has no ceiling", () => {
  assert.equal(ok({ employees: 300 }, { companySizeRanges: [[1, 10], [201, 500]] }), true);
  assert.equal(ok({ employees: 300 }, { companySizeRanges: [[1, 10], [11, 50]] }), false);
  assert.equal(ok({ employees: 90000 }, { companySizeRanges: [[10001, null]] }), true);
});

test("year founded is bounded on both sides", () => {
  assert.equal(ok({ founded: 2015 }, { minYearFounded: 2020 }), false);
  assert.equal(ok({ founded: 2022 }, { minYearFounded: 2020 }), true);
  assert.equal(ok({ founded: 2022 }, { maxYearFounded: 2019 }), false);
});

test("years of experience is bounded on both sides", () => {
  assert.equal(ok({ yoe: 2 }, { yoeMin: 10 }), false);
  assert.equal(ok({ yoe: 12 }, { yoeMin: 10 }), true);
  assert.equal(ok({ yoe: 12 }, { yoeMax: 5 }), false);
});

test("salary bounds run in the directions hiring.cafe defines", () => {
  // min bounds the job's FLOOR from below; max bounds the job's CEILING from above.
  const j = { comp_min: 100000, comp_max: 150000, currency: "USD" };
  assert.equal(ok(j, { salaryMin: 120000, salaryCurrency: "USD", salaryFrequency: "Yearly" }), false);
  assert.equal(ok(j, { salaryMin: 90000, salaryCurrency: "USD", salaryFrequency: "Yearly" }), true);
  assert.equal(ok(j, { salaryMax: 120000, salaryCurrency: "USD", salaryFrequency: "Yearly" }), false);
  assert.equal(ok(j, { salaryMax: 200000, salaryCurrency: "USD", salaryFrequency: "Yearly" }), true);
});

test("an hourly bound is converted before it is compared", () => {
  // The stored figures are always YEARLY. Comparing "50" against 104000 would pass every job alive.
  const j = { comp_min: 104000, comp_max: 104000, currency: "USD" };          // = $50/h at 2080h
  assert.equal(ok(j, { salaryMin: 40, salaryCurrency: "USD", salaryFrequency: "Hourly" }), true);
  assert.equal(ok(j, { salaryMin: 60, salaryCurrency: "USD", salaryFrequency: "Hourly" }), false);
});

test("a salary in a different currency is not compared, rather than compared wrongly", () => {
  // The SAME number means different money in different currencies: 9,000,000 JPY is about $60k. So the
  // comparison is skipped when the currencies disagree, and runs when they agree — proven by holding
  // the number fixed and changing only the currency, which must flip the verdict.
  const j = { comp_min: 9000000, comp_max: 9000000 };
  const want = { salaryMin: 10000000, salaryCurrency: "USD", salaryFrequency: "Yearly" };
  assert.equal(ok({ ...j, currency: "JPY" }, want), true,
    "mismatched currencies must not produce a confident wrong answer");
  assert.equal(ok({ ...j, currency: "USD" }, want), false,
    "matching currencies must actually be compared");
});

test("no filters set means everything passes", () => {
  assert.equal(ok({ workplace_type: "Onsite", seniority: "Entry Level" }, {}), true);
  assert.equal(orgFacetsAllowed(job({ workplace_type: "Onsite" }), undefined), true);
});
