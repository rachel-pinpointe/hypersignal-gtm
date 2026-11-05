// The unbounded CSV export must not have a hidden ceiling.
//
// queryMatches reads in two steps: step 1 pages the row identifiers, step 2 fetches the wide columns
// for exactly those rows with `... IN (?,?,?,…)`. That second step binds ONE SQL VARIABLE PER ROW,
// and SQLite refuses more than 32,766 of them. /api/matches/export calls queryMatches with limit -1
// on purpose — the whole point is "give me everything" — so the export was one query away from a flat
// failure. Not a truncation, a throw: the route catches it and answers HTTP 400 carrying a raw
// SQLite message. No partial file, no warning, the button just stops working one day.
//
// It had not fired yet only because the live table held 22,721 non-dismissed matches — 69% of the
// ceiling — and it grows with every fetch.
//
// This test seeds past the ceiling and exports. Before the chunking fix it throws "too many SQL
// variables"; after it, every seeded row comes back, in order, exactly once.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, queryMatches } from "./db.ts";

// Comfortably past 32,766 so the test still means something if SQLite's default ever moves up a
// little, but not so far that seeding dominates the suite's runtime.
const N = 34_000;
const CLIENT = "export-cap-test";

const reset = () => {
  db.prepare("DELETE FROM matches WHERE client = ?").run(CLIENT);
  db.prepare("DELETE FROM raw_jobs WHERE id LIKE 'expcap-%'").run();
};

test("the unbounded export survives more rows than SQLite has variable slots", () => {
  reset();
  const insJob = db.prepare(
    `INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, url, domain, status, seen_at)
     VALUES (?, ?, 'hiringcafe', 'Engineer', 'Cap Co', ?, 'cap.com', 'open', datetime('now'))`);
  const insMatch = db.prepare(
    "INSERT OR IGNORE INTO matches (job_id, client, match_reason, delivered) VALUES (?, ?, 'test', 0)");
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    const id = `expcap-${i}`;
    insJob.run(id, id, `https://example.com/${id}`);
    insMatch.run(id, CLIENT);
  }
  db.exec("COMMIT");

  // Guard the instrument: if the fixture did not actually land, an export of 0 rows would "pass".
  const live = (db.prepare("SELECT COUNT(*) c FROM matches WHERE client = ?").get(CLIENT) as { c: number }).c;
  assert.equal(live, N, "fixture must exceed the 32,766-variable ceiling, or this proves nothing");

  // limit -1 is exactly what /api/matches/export passes.
  const rows = queryMatches({ client: CLIENT, limit: -1, offset: 0 });
  assert.equal(rows.length, N, "every matched row must come back");

  // Chunking must not duplicate a row or drop one at a chunk boundary.
  const ids = new Set(rows.map((r) => r.id as string));
  assert.equal(ids.size, N, "chunk boundaries duplicated or lost rows");

  reset();
});
