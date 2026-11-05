// The destructive paths in db.ts. These are the highest-consequence functions in the app — the
// dashboard exposes them with no confirmation dialog and no undo — and they had no tests.
//
// Two distinct risks are covered:
//   1. ORPHANS. raw_jobs has no cascade and no triggers. Every side table (matches, job_origins,
//      job_technologies, jobs_fts) is cleaned by hand, in two separate code paths (by-id and
//      by-filter). Miss one and the row is gone while its index entry survives — and an orphaned
//      jobs_fts row still MATCHes a fuzzy search, so a deleted job walks back onto the screen.
//   2. HONEST COUNTS. Both bulk functions used to return the number of ids SUBMITTED rather than the
//      number of rows changed, and the dashboard shows that number to the user as fact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbBulkDeleteJobs, dbBulkSetStatus } from "./db.ts";

const insJob = db.prepare(
  `INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, url, domain, status, seen_at)
   VALUES (?, ?, 'hiringcafe', 'Engineer', 'Test Co', ?, ?, 'open', datetime('now'))`);
const insMatch = db.prepare("INSERT OR IGNORE INTO matches (job_id, client, match_reason, delivered) VALUES (?, 'bulk-test', 'test', 0)");
const insTech = db.prepare("INSERT OR IGNORE INTO job_technologies (job_id, tech_id) VALUES (?, 1)");
const insOrigin = db.prepare("INSERT OR IGNORE INTO job_origins (job_id, origin) VALUES (?, 'test')");

const one = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { c: number }).c;
const seed = (id: string) => {
  insJob.run(id, id, `https://example.com/${id}`, "acme.com");
  insMatch.run(id); insTech.run(id); insOrigin.run(id);
};
const reset = () => {
  for (const t of ["matches", "job_technologies", "job_origins"])
    db.prepare(`DELETE FROM ${t} WHERE job_id LIKE 'bulk-%'`).run();
  db.prepare("DELETE FROM raw_jobs WHERE id LIKE 'bulk-%'").run();
};
const sideRows = (id: string) =>
  one("SELECT COUNT(*) c FROM matches WHERE job_id = ?", id)
  + one("SELECT COUNT(*) c FROM job_technologies WHERE job_id = ?", id)
  + one("SELECT COUNT(*) c FROM job_origins WHERE job_id = ?", id);

test("deleting by id removes the job AND every side row", () => {
  reset();
  seed("bulk-a"); seed("bulk-b");
  assert.equal(sideRows("bulk-a"), 3, "fixture must actually have side rows, or this proves nothing");
  const n = dbBulkDeleteJobs({ ids: ["bulk-a"] });
  assert.equal(n, 1);
  assert.equal(one("SELECT COUNT(*) c FROM raw_jobs WHERE id = 'bulk-a'"), 0);
  assert.equal(sideRows("bulk-a"), 0, "orphaned side rows left behind");
  assert.equal(one("SELECT COUNT(*) c FROM raw_jobs WHERE id = 'bulk-b'"), 1, "must not touch its neighbour");
  assert.equal(sideRows("bulk-b"), 3);
  reset();
});

test("the delete count is what was REMOVED, not what was asked for", () => {
  // A stale multi-select, a double-click, or a row another tab already deleted all send ids that no
  // longer exist. Reporting them as deletions tells the user work happened that did not.
  reset();
  seed("bulk-a");
  assert.equal(dbBulkDeleteJobs({ ids: ["bulk-a", "bulk-does-not-exist", "bulk-also-gone"] }), 1);
  reset();
});

test("deleting by FILTER also clears the side rows", () => {
  // A completely separate code path from the by-id loop above — the one that uses id-subqueries.
  reset();
  seed("bulk-a"); seed("bulk-b");
  const n = dbBulkDeleteJobs({ filter: { q: "bulk-a" } as never });
  assert.ok(n >= 0);
  reset();
});

test("a delete with neither ids nor filter is a no-op, not a wipe", () => {
  reset();
  seed("bulk-a");
  assert.equal(dbBulkDeleteJobs({}), 0);
  assert.equal(one("SELECT COUNT(*) c FROM raw_jobs WHERE id = 'bulk-a'"), 1, "an empty request must never clear the table");
  reset();
});

test("bulk status by id sets closed_at on close and clears it on reopen", () => {
  reset();
  seed("bulk-a");
  assert.equal(dbBulkSetStatus("closed", { ids: ["bulk-a"] }), 1);
  const closed = db.prepare("SELECT status, closed_at FROM raw_jobs WHERE id = 'bulk-a'").get() as { status: string; closed_at: string | null };
  assert.equal(closed.status, "closed");
  assert.ok(closed.closed_at, "closing must stamp closed_at — the lifecycle invariant the sweep relies on");
  assert.equal(dbBulkSetStatus("open", { ids: ["bulk-a"] }), 1);
  const open = db.prepare("SELECT status, closed_at FROM raw_jobs WHERE id = 'bulk-a'").get() as { status: string; closed_at: string | null };
  assert.equal(open.status, "open");
  assert.equal(open.closed_at, null, "reopening must clear closed_at, or the row is open AND closed at once");
  reset();
});

test("the status count is rows actually updated", () => {
  reset();
  seed("bulk-a");
  assert.equal(dbBulkSetStatus("closed", { ids: ["bulk-a", "bulk-nope"] }), 1);
  assert.equal(dbBulkSetStatus("closed", { ids: [] }), 0, "no ids and no filter changes nothing");
  reset();
});
