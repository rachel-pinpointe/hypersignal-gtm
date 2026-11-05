// backfillMatchesSteps is the reconcile that keeps stored matches equal to what every active
// client's CURRENT config says should match. It runs on boot and after every config save, in both
// directions (ADD what now matches, PRUNE what no longer does), and it had no test.
//
// Its failure modes are all silent and all about the DASHBOARD being wrong rather than the app
// breaking: a broadened filter that adds nothing, a tightened filter that leaves stale rows on
// screen, or — the worst — a chunk boundary that skips jobs, so which postings a client sees depends
// on how many rows happen to be in the table.
//
// The chunking is what makes this worth pinning. It walks raw_jobs by keyset pagination on a TEXT
// primary key, commits per chunk, and bounds the prune pass with a high-water mark taken before any
// insert. Each of those is a place an off-by-one silently loses or double-processes rows, and none
// of it is visible from the outside — the run just reports a smaller number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { backfillMatches, backfillMatchesSteps } from "./ingest.ts";
import type { ClientConfig } from "./types.ts";

const insJob = db.prepare(
  `INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, location, url, domain, status, seen_at, posted_at)
   VALUES (?, ?, 'hiringcafe', ?, ?, 'Austin, TX', ?, ?, 'open', datetime('now'), datetime('now'))`);
const seedJob = (id: string, title: string, domain: string) =>
  insJob.run(id, id, title, "Test Co", `https://example.com/${id}`, domain);

const reset = () => {
  db.exec("DELETE FROM matches");
  db.exec("DELETE FROM raw_jobs WHERE id LIKE 'bm-%'");
};
const matchesFor = (client: string) =>
  (db.prepare("SELECT job_id FROM matches WHERE client = ? ORDER BY job_id").all(client) as Array<{ job_id: string }>)
    .map((r) => r.job_id);

const client = (name: string, keywords: string[], extra: Record<string, unknown> = {}): ClientConfig =>
  ({ name, active: true, kind: "search", search: { keywords, ...extra } } as ClientConfig);

test("a job matching the config is recorded, one that does not is left alone", () => {
  reset();
  seedJob("bm-1", "Senior Python Engineer", "acme.com");
  seedJob("bm-2", "Warehouse Associate", "acme.com");
  backfillMatches([client("c1", ["python"])]);
  assert.deepEqual(matchesFor("c1"), ["bm-1"]);
});

test("a new EXCLUDE prunes the matches it now covers", () => {
  reset();
  seedJob("bm-1", "Senior Python Engineer", "acme.com");
  seedJob("bm-2", "Senior Java Engineer", "acme.com");
  backfillMatches([client("c1", ["engineer"])]);
  assert.deepEqual(matchesFor("c1"), ["bm-1", "bm-2"], "both match the broad filter");
  // Excludes are applied in full on the prune pass, for every source.
  backfillMatches([client("c1", ["engineer"], { exclude: ["java"] })]);
  assert.deepEqual(matchesFor("c1"), ["bm-1"], "the excluded role must be gone, not merely hidden");
});

test("removing a KEYWORD prunes a locally-refined row but NOT a hiring.cafe search row", () => {
  // This is the one asymmetry in the prune, and it is deliberate — but it is not what the docblock
  // used to claim, and it is the first thing this test suite caught. The prune evaluates with
  // serverFiltered:true, so matcher.ts trusts hiring.cafe's own server-side filtering for a keyword
  // SEARCH row instead of re-running our best-effort local phrase matcher, which would wrongly drop
  // legitimate semantic matches. Every other source is refined locally and does re-check.
  reset();
  seedJob("bm-hc", "Senior Java Engineer", "acme.com");                       // source 'hiringcafe'
  seedJob("bm-org", "Senior Java Engineer", "acme.com");
  db.prepare("UPDATE raw_jobs SET source = 'hcorg' WHERE id = 'bm-org'").run();

  // includeOrgJobs is required for a SEARCH client to match org-sourced rows at all — without it the
  // hcorg row never enters the comparison and the test would prove nothing about pruning.
  const withOrg = (kw: string[]) => client("c1", kw, { includeOrgJobs: true });

  backfillMatches([withOrg(["java"])]);
  assert.deepEqual(matchesFor("c1"), ["bm-hc", "bm-org"], "both match while the keyword is present");

  backfillMatches([withOrg(["python"])]);
  assert.deepEqual(matchesFor("c1"), ["bm-hc"],
    "the locally-refined hcorg row is pruned; the hiring.cafe search row is deliberately kept");
});

test("an INACTIVE client's matches are not pruned by this pass", () => {
  reset();
  seedJob("bm-1", "Senior Python Engineer", "acme.com");
  backfillMatches([client("c1", ["python"])]);
  assert.deepEqual(matchesFor("c1"), ["bm-1"]);
  // Deactivating is not deleting. Prune only ever touches an ACTIVE client's rows — the deleted-client
  // case belongs to dbPurgeOrphans — so a client toggled off and on again keeps its history.
  const off = { ...client("c1", ["python"]), active: false } as ClientConfig;
  backfillMatches([off, client("c2", ["nothingmatchesthis"])]);
  assert.deepEqual(matchesFor("c1"), ["bm-1"], "an inactive client's history survives");
});

test("the run is idempotent — a second pass over an unchanged config adds nothing", () => {
  reset();
  for (let i = 0; i < 12; i++) seedJob(`bm-${String(i).padStart(3, "0")}`, "Python Engineer", "acme.com");
  const cfg = [client("c1", ["python"])];
  const first = backfillMatches(cfg);
  const second = backfillMatches(cfg);
  assert.equal(first, 12, "first pass records every matching job");
  assert.equal(second, 0, "a re-run must add nothing — the reconcile runs on every boot and config save");
  assert.equal(matchesFor("c1").length, 12);
});

test("chunk boundaries do not lose jobs — every row is visited whatever the chunk size", () => {
  // The keyset cursor walks a TEXT primary key with `WHERE id > ? ORDER BY id`. An off-by-one here
  // does not throw; it silently skips or repeats rows, and the only symptom is a client seeing fewer
  // postings than it should. Sizes chosen to land on, one before, and one after an exact boundary.
  const N = 25;
  for (const chunk of [1, 2, 7, 24, 25, 26, 1000]) {
    reset();
    for (let i = 0; i < N; i++) seedJob(`bm-${String(i).padStart(3, "0")}`, "Python Engineer", "acme.com");
    // Drive the generator directly: that is the chunked path the dashboard actually uses.
    const run = backfillMatchesSteps([client("c1", ["python"])], chunk);
    let step = run.next();
    while (!step.done) step = run.next();
    assert.equal(step.value, N, `chunk size ${chunk} recorded ${step.value} of ${N} matches`);
    assert.equal(matchesFor("c1").length, N, `chunk size ${chunk} left ${matchesFor("c1").length} rows`);
  }
});

test("a match added by THIS run is never re-examined by the prune pass", () => {
  // The prune is bounded by a high-water mark taken before any insert. Without it the pass would
  // walk rows it had just written — harmless when the config agrees, but it is the difference
  // between a bounded pass and one whose cost grows with what it just did.
  reset();
  for (let i = 0; i < 8; i++) seedJob(`bm-${String(i).padStart(3, "0")}`, "Python Engineer", "acme.com");
  const added = backfillMatches([client("c1", ["python"])]);
  assert.equal(added, 8);
  assert.equal(matchesFor("c1").length, 8, "nothing the ADD pass wrote was pruned in the same run");
});

test("no active clients means no work, not a wipe", () => {
  reset();
  seedJob("bm-1", "Python Engineer", "acme.com");
  backfillMatches([client("c1", ["python"])]);
  // An empty active set must return early. If it fell through to the prune with an empty client map,
  // every stored match would look orphaned.
  assert.equal(backfillMatches([]), 0);
  assert.deepEqual(matchesFor("c1"), ["bm-1"], "an empty config list must not delete existing matches");
});
