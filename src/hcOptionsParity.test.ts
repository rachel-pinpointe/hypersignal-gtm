// The filter vocabularies exist TWICE — HC_OPTIONS in src/hiringcafeFilters.ts (what the engine sends
// to hiring.cafe and what orgFacets compares against) and a hand-maintained copy in web/app.js (what
// the menus offer). Nothing made them agree.
//
// That is not a hypothetical drift. Adding 14 measured-and-verified department values to the engine
// list changed nothing a user could see, because the menu reads its own copy — the new categories
// would have been sendable only by hand-editing a YAML. The failure is silent in both directions: an
// option the UI offers but the engine does not know is sent and ignored; a value the engine knows but
// the UI omits is unreachable.
//
// Read from source rather than imported, because web/app.js is a browser script with no module
// exports — the same approach channelParity.test.ts uses for server.ts's column lists.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HC_OPTIONS } from "./hiringcafeFilters.ts";
import { PER_YEAR } from "./orgFacets.ts";

const APP = readFileSync(join(import.meta.dirname, "..", "web", "app.js"), "utf8");

/** The array literal assigned to `<key>:` inside web/app.js's options object. */
function uiList(key: string): string[] {
  const m = new RegExp(`^  ${key}: (\\[[^\\]]*\\]),$`, "m").exec(APP);
  assert.ok(m, `could not find "${key}" in web/app.js — this test would otherwise measure nothing`);
  return JSON.parse(m![1]!) as string[];
}

const CASES: Array<[string, string[]]> = [
  ["workplaceTypes", [...HC_OPTIONS.workplaceTypes]],
  ["commitmentTypes", [...HC_OPTIONS.commitmentTypes]],
  ["seniorityLevels", [...HC_OPTIONS.seniorityLevels]],
  ["roleTypes", [...HC_OPTIONS.roleTypes]],
  ["securityClearances", [...HC_OPTIONS.securityClearances]],
  ["organizationTypes", [...HC_OPTIONS.organizationTypes]],
  ["fundingStages", [...HC_OPTIONS.fundingStages]],
  ["salaryFrequency", [...HC_OPTIONS.salaryFrequency]],
  ["departments", Object.values(HC_OPTIONS.departments).flat()],
];

for (const [key, engine] of CASES) {
  test(`the ${key} menu offers exactly what the engine knows`, () => {
    const ui = uiList(key);
    const missing = engine.filter((v) => !ui.includes(v));
    const extra = ui.filter((v) => !engine.includes(v));
    assert.deepEqual(missing, [], `web/app.js is missing ${missing.length} value(s) the engine knows — unreachable from the UI`);
    assert.deepEqual(extra, [], `web/app.js offers ${extra.length} value(s) the engine does not know — sent and ignored`);
  });
}

test("the department list still contains the 14 values measured against hiring.cafe", () => {
  // Each was put to hiring.cafe as searchState.departments and returned results that were 100% in
  // the requested category. They were absent from the offered list while appearing on stored jobs.
  const all = Object.values(HC_OPTIONS.departments).flat();
  for (const v of ["Creative and Art Services", "Transportation and Logistics", "Media and Communications",
    "Retail and Wholesale", "Finance", "Consulting Services", "Operations", "Research and Development",
    "Software Engineering", "Healthcare", "Quality", "Manufacturing", "Accounting", "Technology"])
    assert.ok(all.includes(v), `"${v}" was verified against hiring.cafe and must stay offered`);
  // "Transportation" returned ZERO jobs, so accepted-but-empty and rejected are indistinguishable.
  // It is deliberately NOT offered — adding it later needs evidence, not a guess.
  assert.equal(all.includes("Transportation"), false);
});

// The two lists whose KEY NAME differs between the files, so the loop above cannot reach them by
// name. Same duplication, same silent drift, checked the same way.
test("the company-size ranges match, despite being named differently in each file", () => {
  const m = /^  companySizes: (\[[\s\S]*?\]),$/m.exec(APP);
  assert.ok(m, "could not find companySizes in web/app.js");
  const ui = JSON.parse(m![1]!) as Array<[number, number | null]>;
  assert.deepEqual(ui, HC_OPTIONS.companySizeRanges.map((r) => [...r]),
    "the size buckets differ — the menu would offer a range the engine never sends, or omit one it does");
});

test("the sort options match, values and labels", () => {
  const m = /^  sortBy: (\[[\s\S]*?\]),$/m.exec(APP);
  assert.ok(m, "could not find sortBy in web/app.js");
  const ui = JSON.parse(m![1]!) as Array<[string, string]>;
  assert.deepEqual(ui, HC_OPTIONS.sortBy.map((r) => [...r]),
    "a sort value only one side knows is either unreachable or sent and ignored");
});

test("every pay period the UI offers has a conversion multiplier", () => {
  // orgFacets compares a salary bound against figures hiring.cafe stores as YEARLY, so the bound is
  // converted first. An unrecognised period falls through to x1 — "25 Quarterly" would then filter as
  // 25 a YEAR, which is not a filter at all, and nothing would say so. Adding an option to
  // HC_OPTIONS.salaryFrequency without a multiplier must fail here rather than in production.
  for (const f of HC_OPTIONS.salaryFrequency)
    assert.ok(PER_YEAR[f.toLowerCase()] !== undefined,
      `salaryFrequency offers "${f}" but orgFacets.PER_YEAR has no multiplier for it`);
});

test("no multiplier exists for a period nobody can pick", () => {
  // The other direction: a stale entry here is dead weight that reads as supported.
  const offered = new Set(HC_OPTIONS.salaryFrequency.map((f) => f.toLowerCase()));
  for (const k of Object.keys(PER_YEAR))
    assert.ok(offered.has(k), `PER_YEAR carries "${k}", which salaryFrequency does not offer`);
});
