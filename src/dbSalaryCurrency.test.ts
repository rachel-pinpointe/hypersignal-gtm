// A salary without its currency is not a quantity — and until now the database stored the number in
// its own indexed column and left the currency inside the raw JSON blob, where nothing that COMPARED
// salaries could afford to read it.
//
// What that produced on the live data, measured before this change:
//   • "Salary ▼" on the postings and jobs tables sorts the raw number. 97 of the top 100 rows are not
//     USD — 83 INR, 7 JPY, 6 HUF, 1 NGN — because ₹11,000,000 (about $132k) is a bigger NUMBER than
//     $400,000. The highest-paying-jobs view is a ranking of which currency inflates best.
//   • A saved rule "salary min >= 100000" returns 1,786 rows, 393 of them priced in one of 16 other
//     currencies. ₹100,000 is roughly $1,200 a year.
//   • The builder labelled those fields "($/yr)" — the last place in the app still asserting a unit
//     the data does not have — and offered no currency field, so the claim could not even be narrowed.
//
// The app has no exchange rates and is not going to invent any: every display path here already
// follows "state what the data supports and nothing else" (delivery.ts, the CSV export, fmtSalary).
// This file pins the pieces that make the COMPARISON honest instead — the currency travels with the
// number, in a column, so a rule can say "and the currency is USD".
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, upsertJob, dbAdminJobs, compileQueryTree } from "./db.ts";
import type { RawJob } from "./types.ts";

const job = (id: string, raw: Record<string, unknown>, desc?: string): RawJob => ({
  id, source: "hiringcafe", externalId: id, title: `Engineer ${id}`, company: "Acme",
  location: "Austin, TX", state: "TX", remote: false,
  url: `https://boards.greenhouse.io/acme/jobs/${id}`, postedAt: null, domain: "acme.test",
  raw: { ...raw, ...(desc ? { description: desc } : {}) },
} as unknown as RawJob);

const stored = (id: string) =>
  db.prepare("SELECT comp_max, currency, json_extract(raw,'$.currency') rawCur FROM raw_jobs WHERE id = ?").get(id) as
    { comp_max: number | null; currency: string | null; rawCur: string | null };

test("an inserted posting stores the currency in a column, beside the number it belongs to", async () => {
  upsertJob(job("sc-usd", { comp_min: 180000, comp_max: 240000, currency: "USD" }));
  const r = stored("sc-usd");
  assert.equal(r.comp_max, 240000);
  assert.equal(r.currency, "USD", "the column must be written at insert, not left for a later read of the blob");
  assert.equal(r.rawCur, "USD", "and it must still agree with the blob it came from");
});

test("a posting with no stated currency stores NULL, never an assumed dollar", async () => {
  // The rule the webhook and the CSV already follow. A currency we invent here would be laundered
  // into a fact by every surface downstream, none of which can tell it was a guess.
  upsertJob(job("sc-bare", { comp_max: 95000 }));
  const r = stored("sc-bare");
  assert.equal(r.comp_max, 95000);
  assert.equal(r.currency, null);
});

test("a re-sighting that upgrades the description refreshes BOTH from the new payload", async () => {
  // The subtle one. In an UPDATE, the right-hand side of SET reads the OLD row, so writing this as
  // json_extract(raw, …) would recompute from the blob being replaced and silently keep the stale
  // figure forever. The first sighting of a job often has no salary at all — it arrives with the
  // scraped description later — so this is the path most salaries actually come in through.
  upsertJob(job("sc-upgrade", { comp_max: 1, currency: "CAD" }));            // thin first sighting
  const first = stored("sc-upgrade");
  assert.equal(first.comp_max, 1);
  assert.equal(first.currency, "CAD");

  upsertJob(job("sc-upgrade", { comp_max: 210000, currency: "USD" }, "Full job description here."));
  const r = stored("sc-upgrade");
  assert.equal(r.comp_max, 210000, "the number came from the richer payload");
  assert.equal(r.currency, "USD", "and so did the currency — not left at the old CAD");
});

test("the query builder can express which currency a salary rule means", async () => {
  // Without this field the salary condition is unusable for its actual purpose: it cannot be narrowed
  // to one currency, so every threshold silently spans all 17.
  const compiled = compileQueryTree({
    combinator: "AND",
    children: [
      { field: "salaryMax", op: "gte", value: 100000 },
      { field: "currency", op: "is", value: "USD" },
    ],
  });
  assert.ok(compiled, "the tree must compile");
  assert.match(compiled!.sql, /j\.currency/, "the condition must reach the lifted column");
  assert.ok(!/json_extract\(j\.raw,'\$\.currency'\)/.test(compiled!.sql),
    "and must NOT re-parse the raw blob — that is what made this too expensive to do before");
});

test("a currency-narrowed rule actually excludes the other currencies", async () => {
  // The compile test above proves the SQL is shaped right; this proves it selects the right rows.
  upsertJob(job("sc-inr", { comp_max: 11000000, currency: "INR" }));   // about USD 132k
  upsertJob(job("sc-big", { comp_max: 400000, currency: "USD" }));

  const all = dbAdminJobs({ query: { combinator: "AND", children: [{ field: "salaryMax", op: "gte", value: 100000 }] }, limit: 200 });
  const usd = dbAdminJobs({
    query: { combinator: "AND", children: [
      { field: "salaryMax", op: "gte", value: 100000 },
      { field: "currency", op: "is", value: "USD" },
    ] }, limit: 200,
  });
  const ids = (rows: Array<Record<string, unknown>>) => new Set(rows.map((r) => r.id as string));
  assert.ok(ids(all).has("sc-inr"), "the unnarrowed rule lets the rupee figure through — that is the defect");
  assert.ok(!ids(usd).has("sc-inr"), "narrowed by currency, it does not");
  assert.ok(ids(usd).has("sc-big"), "and the dollar figure still matches");
});

test("the Salary sort reads the indexed column, and the rupee row really does outrank the dollar one", async () => {
  // Pinned rather than fixed, deliberately. Ranking ₹11,000,000 above $400,000 is wrong to a reader
  // and there is no honest way to correct it without exchange rates the app does not have — so the
  // column header now says so and the currency filter exists to work around it. If someone later adds
  // conversion, this test is the one that should fail and be rewritten, rather than the behaviour
  // changing quietly under a UI that still explains the old rule.
  const rows = dbAdminJobs({ sort: "salary", dir: "desc", limit: 200 });
  const at = (id: string) => rows.findIndex((r) => r.id === id);
  assert.ok(at("sc-inr") >= 0 && at("sc-big") >= 0, "both fixtures must be on the page");
  assert.ok(at("sc-inr") < at("sc-big"), "11,000,000 sorts above 400,000 because nothing converts them");

  // NULLs last: a posting with no salary must not win the "highest salary" sort by being empty.
  upsertJob(job("sc-none", {}));
  const withNull = dbAdminJobs({ sort: "salary", dir: "desc", limit: 200 });
  const nullIdx = withNull.findIndex((r) => r.id === "sc-none");
  const paidIdx = withNull.findIndex((r) => r.id === "sc-inr");
  assert.ok(nullIdx > paidIdx, "a posting with no stated salary sorts after every posting that has one");
});
