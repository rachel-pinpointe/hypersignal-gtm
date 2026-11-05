// Suggestions for the industry filter.
//
// Industry is the one hiring.cafe filter whose vocabulary is NOT a closed list — 841 distinct values
// across 28,252 stored rows, long tail (the top 12 cover half the rows; 264 are needed for 95%). A
// dropdown would be the wrong control AND a false claim, since what we can offer is only what we
// happen to have fetched. So the field takes free text and these are hints.
//
// Two things have to hold for the hints to be honest and affordable:
//   • `matched` counts what matched BEFORE the slice. Returning the capped length would report "20
//     industries match" whenever more than 20 do — the page-limit defect this codebase keeps finding
//     in other shapes, a truncated read presented as the whole answer.
//   • the aggregation is CACHED. The value lives inside each row's raw JSON and node:sqlite is
//     synchronous, so a per-keystroke rebuild is a frozen dashboard, not a slow response. Measured on
//     the live database: 232ms to build.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbIndustries, dbIndustriesInvalidate } from "./db.ts";

const seed = () => {
  db.prepare("DELETE FROM raw_jobs WHERE id LIKE 'ind-test-%'").run();
  const ins = db.prepare(`INSERT INTO raw_jobs (id, source, external_id, title, url, status, raw, domain)
                          VALUES (?, 'hcorg', ?, 'Role', ?, 'open', ?, 'acme.test')`);
  const add = (n: number, industry: unknown) =>
    ins.run(`ind-test-${n}`, `x${n}`, `https://acme.test/${n}`, JSON.stringify({ industry }));
  // arrays (the normal shape), a bare string, and rows with nothing to say
  add(1, ["Logistics", "Transportation"]);
  add(2, ["Logistics"]);
  add(3, ["Logistics"]);
  add(4, "Fintech");                  // hiring.cafe sometimes stores a plain string
  add(5, ["Cybersecurity"]);
  add(6, null);
  add(7, []);
};
/** The vocabulary is cached, so a test that changes the data must invalidate it first — the same
 *  call a finished fetch run makes. */
const fresh = (q = "", limit = 20) => { dbIndustriesInvalidate(); return dbIndustries(q, limit); };

test("industries come back commonest first, with their job counts", () => {
  seed();
  const r = fresh();
  assert.ok(r.items.length > 0, "seeded industries must be discoverable");
  const names = r.items.map((i) => i.name);
  assert.ok(names.includes("Logistics"));
  // Logistics (3 rows) must outrank Cybersecurity (1 row).
  assert.ok(names.indexOf("Logistics") < names.indexOf("Cybersecurity"));
  const log = r.items.find((i) => i.name === "Logistics")!;
  assert.equal(log.jobs, 3);
});

test("a bare string industry is read as well as an array", () => {
  // json_type distinguishes the two shapes; a row storing "Fintech" rather than ["Fintech"] must not
  // be silently skipped.
  const r = fresh("fintech");
  assert.ok(r.items.some((i) => i.name === "Fintech"), "a string-valued industry must still be found");
});

test("matched counts what matched, not what fitted in the response", () => {
  const all = fresh("", 50);
  const capped = fresh("", 1);
  assert.equal(capped.items.length, 1, "the slice is honoured");
  assert.equal(capped.matched, all.matched, "…but the count reports everything that matched");
  assert.ok(capped.matched > 1, "this test is only meaningful with more matches than the cap");
});

test("filtering is a substring match, case-insensitively", () => {
  assert.ok(fresh("LOGIST").items.some((i) => i.name === "Logistics"));
  assert.ok(fresh("port").items.some((i) => i.name === "Transportation"), "matches inside the word too");
  assert.equal(fresh("zzzznotanindustry").items.length, 0);
  assert.equal(fresh("zzzznotanindustry").matched, 0);
});

test("rows that state no industry contribute nothing, rather than an empty entry", () => {
  const r = fresh("", 50);
  assert.ok(!r.items.some((i) => !i.name.trim()), "a blank industry must never be offered as an option");
});

test("known reports the size of the whole vocabulary, not the filtered slice", () => {
  const filtered = fresh("logist", 5);
  const all = fresh("", 50);
  assert.equal(filtered.known, all.known);
  assert.ok(filtered.known >= filtered.matched);
  db.prepare("DELETE FROM raw_jobs WHERE id LIKE 'ind-test-%'").run();
});
