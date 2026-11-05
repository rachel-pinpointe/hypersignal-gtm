// The retention and lifecycle paths: dbPurgeOldJobs (hard delete by age), dbSweepClosed (mark
// disappeared jobs closed), dbPurgeOrphans (drop matches for deleted clients).
//
// dbPurgeOldJobs is the only scheduled HARD DELETE in the app — it runs unattended at 3am from
// startMaintenance, driven by a retention setting, against rows nobody is looking at. There is no
// confirmation and no undo, so the two things that matter are that it deletes exactly the rows past
// the cutoff (an off-by-one on the date is unnoticeable and unrecoverable) and that it leaves no
// orphans in the four side tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbPurgeOldJobs, dbSweepClosed, dbPurgeOrphans, dbUnverifiedStale } from "./db.ts";

const insAged = db.prepare(
  `INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, url, domain, status, seen_at, posted_at, last_seen_at, expires_at)
   VALUES (?, ?, 'hiringcafe', 'Engineer', 'Test Co', ?, 'acme.com', ?, datetime('now', ?), datetime('now', ?), datetime('now', ?), ?)`);
const insMatch = db.prepare("INSERT OR IGNORE INTO matches (job_id, client, match_reason, delivered) VALUES (?, ?, 'test', 0)");
const insTech = db.prepare("INSERT OR IGNORE INTO job_technologies (job_id, tech_id) VALUES (?, 1)");

const n = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { c: number }).c;
const reset = () => {
  for (const t of ["matches", "job_technologies", "job_origins"])
    db.prepare(`DELETE FROM ${t} WHERE job_id LIKE 'ret-%'`).run();
  db.prepare("DELETE FROM raw_jobs WHERE id LIKE 'ret-%'").run();
  db.prepare("DELETE FROM matches WHERE client LIKE 'ret-%'").run();
};

/** Seed a job whose age (in days) is exactly `ageDays`, with a match and a tech row attached. */
const seedAged = (id: string, ageDays: number, status = "open", originKey: string | null = "hiringcafe@ret-client") => {
  const off = `-${ageDays} days`;
  insAged.run(id, id, `https://example.com/${id}`, status, off, off, off, null);
  db.prepare("UPDATE raw_jobs SET origin_key = ? WHERE id = ?").run(originKey, id);
  insMatch.run(id, "ret-client"); insTech.run(id);
};

/** Record that a source completed a clean fetch `agoDays` ago — the evidence the sweep requires. */
const sawAt = (key: string, agoDays: number) =>
  db.prepare(`INSERT INTO source_fetches (key, last_ok_at) VALUES (?, datetime('now', ?))
              ON CONFLICT(key) DO UPDATE SET last_ok_at = excluded.last_ok_at`).run(key, `-${agoDays} days`);
const forgetFetches = () => db.prepare("DELETE FROM source_fetches WHERE key LIKE '%ret-client'").run();

test("purge deletes only jobs PAST the cutoff, and leaves the boundary alone", () => {
  reset();
  seedAged("ret-old", 100);   // well past
  seedAged("ret-new", 1);     // well inside
  const deleted = dbPurgeOldJobs(30);
  assert.equal(deleted, 1, "exactly the one old job");
  assert.equal(n("SELECT COUNT(*) c FROM raw_jobs WHERE id = 'ret-old'"), 0);
  assert.equal(n("SELECT COUNT(*) c FROM raw_jobs WHERE id = 'ret-new'"), 1, "a recent job must survive");
  reset();
});

test("purge leaves no orphans behind", () => {
  // Four side tables, cleaned by hand. An orphaned jobs_fts row still MATCHes a fuzzy search, so a
  // purged job would reappear through the search box.
  reset();
  seedAged("ret-old", 100);
  assert.equal(n("SELECT COUNT(*) c FROM matches WHERE job_id = 'ret-old'"), 1, "fixture must have a match");
  assert.equal(n("SELECT COUNT(*) c FROM job_technologies WHERE job_id = 'ret-old'"), 1, "fixture must have a tech row");
  dbPurgeOldJobs(30);
  assert.equal(n("SELECT COUNT(*) c FROM matches WHERE job_id = 'ret-old'"), 0, "orphaned match");
  assert.equal(n("SELECT COUNT(*) c FROM job_technologies WHERE job_id = 'ret-old'"), 0, "orphaned tech row");
  assert.equal(n("SELECT COUNT(*) c FROM jobs_fts WHERE job_id = 'ret-old'"), 0, "orphaned search-index row");
  reset();
});

test("purge with nothing old enough deletes nothing and returns 0", () => {
  reset();
  seedAged("ret-new", 1);
  assert.equal(dbPurgeOldJobs(30), 0);
  assert.equal(n("SELECT COUNT(*) c FROM raw_jobs WHERE id = 'ret-new'"), 1);
  reset();
});

test("the cutoff compares instants, not text — the boundary day is not silently spared", () => {
  // The cutoff `datetime('now','-30 days')` renders "2026-06-29 12:00:00" with a SPACE, while stored
  // dates are ISO with a T. 'T' (0x54) sorts above ' ' (0x20), so under plain text comparison EVERY
  // row on the cutoff day counted as newer than the cutoff regardless of its actual time — the
  // retention window was silently a day wider than the setting said. 704 rows on production.
  //
  // This job is one hour PAST the cutoff instant but lands on the cutoff calendar day, which is the
  // only shape where text comparison and instant comparison disagree.
  reset();
  const pastCutoff = new Date(Date.now() - (30 * 86_400_000 + 3_600_000)).toISOString();
  insAged.run("ret-boundary", "ret-boundary", "https://example.com/ret-boundary", "open", "-1 days", "-1 days", "-1 days", null);
  db.prepare("UPDATE raw_jobs SET posted_at = ? WHERE id = 'ret-boundary'").run(pastCutoff);
  assert.equal(dbPurgeOldJobs(30), 1, "a job an hour past the cutoff must be deleted, not spared by its T");
  reset();
});

test("the sweep closes jobs not seen for the stale window, and stamps closed_at", () => {
  reset(); forgetFetches();
  seedAged("ret-stale", 60);   // last_seen_at 60 days ago
  seedAged("ret-fresh", 1);
  sawAt("hiringcafe@ret-client", 0);   // the source looked TODAY and did not find ret-stale
  const { stale } = dbSweepClosed(14);
  assert.ok(stale >= 1, "the 60-day-old job must be closed");
  const row = db.prepare("SELECT status, closed_at FROM raw_jobs WHERE id = 'ret-stale'").get() as { status: string; closed_at: string | null };
  assert.equal(row.status, "closed");
  assert.ok(row.closed_at, "closing without stamping closed_at breaks the open/closed invariant");
  const fresh = db.prepare("SELECT status FROM raw_jobs WHERE id = 'ret-fresh'").get() as { status: string };
  assert.equal(fresh.status, "open", "a job seen yesterday must stay open");
  reset();
});

test("the sweep closes a job past its explicit expiry", () => {
  reset();
  insAged.run("ret-exp", "ret-exp", "https://example.com/ret-exp", "open", "-1 days", "-1 days", "-1 days",
    new Date(Date.now() - 86_400_000).toISOString());
  const { expired } = dbSweepClosed(14);
  assert.ok(expired >= 1);
  assert.equal((db.prepare("SELECT status FROM raw_jobs WHERE id = 'ret-exp'").get() as { status: string }).status, "closed");
  reset();
});

test("the sweep is idempotent — a second pass closes nothing new", () => {
  reset(); forgetFetches();
  seedAged("ret-stale", 60);
  sawAt("hiringcafe@ret-client", 0);
  dbSweepClosed(14);
  const second = dbSweepClosed(14);
  assert.equal(second.stale, 0, "an already-closed job must not be re-closed, or closed_at would keep moving");
  reset();
});

test("orphan purge drops matches for clients that no longer exist, and spares real ones", () => {
  reset();
  seedAged("ret-keep", 1);
  db.prepare("INSERT OR REPLACE INTO clients (name, config, updated_at) VALUES ('ret-real', '{}', datetime('now'))").run();
  insMatch.run("ret-keep", "ret-real");     // client exists
  insMatch.run("ret-keep", "ret-ghost");    // client was deleted
  const dropped = dbPurgeOrphans();
  assert.ok(dropped >= 1, "the ghost client's match must be dropped");
  assert.equal(n("SELECT COUNT(*) c FROM matches WHERE client = 'ret-ghost'"), 0);
  assert.equal(n("SELECT COUNT(*) c FROM matches WHERE client = 'ret-real'"), 1, "a live client's match must survive");
  db.prepare("DELETE FROM clients WHERE name = 'ret-real'").run();
  reset();
});

// ── account_cache eviction ────────────────────────────────────────────────────────────────────
//
// dbGetAccountCache filters on `fetched_at >= datetime('now', -ttl hours)`, so a row past the TTL can
// never be returned again. Nothing deleted one. The table holds a row per company checked, each
// carrying that company's whole job list as JSON, and it only ever grew.
//
// Measured on production before the eviction existed: 5,282 rows, 103.7 MB, and the count still
// readable was ZERO — every row was already unreachable. That is ~10% of the 1,089 MB database file.
//
// The eviction runs on exactly the read clock. Shorter would throw away rows still in use; longer
// leaves rows nothing can ever read. Both directions are asserted below.
import { dbPurgeAccountCache, dbGetAccountCache, dbSetAccountCache } from "./db.ts";

const cacheReset = () => db.prepare("DELETE FROM account_cache WHERE company_key LIKE 'ac-cache-%'").run();
const ageCache = (key: string, hours: number) =>
  db.prepare("UPDATE account_cache SET fetched_at = datetime('now', ?) WHERE company_key = ?").run(`-${hours} hours`, key);

test("eviction removes what the reader can no longer see, and keeps what it can", () => {
  cacheReset();
  dbSetAccountCache("ac-cache-fresh", [{ id: 1 }]);
  dbSetAccountCache("ac-cache-stale", [{ id: 2 }]);
  ageCache("ac-cache-stale", 48);

  // The fixture must actually be in the state the test claims, or the assertions below prove nothing.
  const before = dbGetAccountCache(["ac-cache-fresh", "ac-cache-stale"], 12);
  assert.equal(before.has("ac-cache-fresh"), true, "fixture: the fresh row must be readable");
  assert.equal(before.has("ac-cache-stale"), false, "fixture: the stale row must already be unreadable");

  assert.equal(dbPurgeAccountCache(12), 1, "exactly the unreadable row");
  assert.equal(n("SELECT COUNT(*) c FROM account_cache WHERE company_key = 'ac-cache-stale'"), 0);
  assert.equal(n("SELECT COUNT(*) c FROM account_cache WHERE company_key = 'ac-cache-fresh'"), 1,
    "evicting a row the reader would still have used loses a real cache hit");
  cacheReset();
});

test("nothing past the TTL survives an eviction", () => {
  // The invariant, rather than a count: after evicting on the read clock, no row may remain that the
  // reader could not return. This is what was false on production for every row in the table.
  cacheReset();
  for (const [k, h] of [["ac-cache-a", 13], ["ac-cache-b", 100], ["ac-cache-c", 1]] as const) {
    dbSetAccountCache(k, []); ageCache(k, h);
  }
  dbPurgeAccountCache(12);
  assert.equal(n("SELECT COUNT(*) c FROM account_cache WHERE fetched_at < datetime('now','-12 hours')"), 0);
  assert.equal(n("SELECT COUNT(*) c FROM account_cache WHERE company_key LIKE 'ac-cache-%'"), 1, "the 1-hour-old row stays");
  cacheReset();
});

test("an empty cached result is still a real cache entry and is evicted like any other", () => {
  // "[]" means "checked, not hiring" — the whole point is to avoid re-querying. It is cheap to store
  // but it is not free, and 4,399 of production's 5,282 rows were exactly this.
  cacheReset();
  dbSetAccountCache("ac-cache-empty", []);
  ageCache("ac-cache-empty", 48);
  assert.equal(dbPurgeAccountCache(12), 1);
  cacheReset();
});

// ── the daily job actually runs the cleanup ───────────────────────────────────────────────────
//
// Every fix above is inert unless the 3am pass invokes it, and that pass logs to a console nobody
// watches. An item quietly dropped from it has NO symptom — the table just keeps growing. A mutation
// that stopped the maintenance calling dbPurgeAccountCache passed every other test in this file.
import { runDailyMaintenance } from "./scheduler.ts";

test("the daily maintenance pass evicts the account cache", () => {
  cacheReset();
  dbSetAccountCache("ac-cache-daily", [{ id: 1 }]);
  ageCache("ac-cache-daily", 500);
  assert.equal(n("SELECT COUNT(*) c FROM account_cache WHERE company_key = 'ac-cache-daily'"), 1, "fixture guard");

  const did = runDailyMaintenance();

  assert.ok(did.cache >= 1, "the daily pass must evict, not merely be capable of evicting");
  assert.equal(n("SELECT COUNT(*) c FROM account_cache WHERE company_key = 'ac-cache-daily'"), 0);
  cacheReset();
});

test("the daily maintenance pass closes stale jobs and prunes old run history", () => {
  // The other two unattended items, asserted for the same reason.
  reset();
  seedAged("ret-daily-stale", 60);
  db.prepare(`INSERT INTO fetch_runs (fetch_key, client, kind, started_at, finished_at)
              VALUES ('ret-daily', 'ret-daily', 'search', datetime('now','-90 days'), datetime('now','-90 days'))`).run();

  const did = runDailyMaintenance();

  assert.ok(did.stale >= 1, "a job unseen for 60 days must be closed");
  assert.ok(did.runs >= 1, "a 90-day-old run record must be pruned");
  assert.equal(n("SELECT COUNT(*) c FROM fetch_runs WHERE client = 'ret-daily'"), 0);
  reset();
});

test("the daily pass does NOT hard-delete jobs unless retention is set to delete", () => {
  // The one destructive item is opt-in. Running it under the default setting would delete a user's
  // data because a housekeeping job was reorganised.
  reset();
  seedAged("ret-daily-old", 400);
  db.prepare("INSERT INTO settings (key, value) VALUES ('retentionMode','off') ON CONFLICT(key) DO UPDATE SET value='off'").run();
  const did = runDailyMaintenance();
  assert.equal(did.jobs, 0, "retentionMode is off — nothing may be hard-deleted");
  assert.equal(n("SELECT COUNT(*) c FROM raw_jobs WHERE id = 'ret-daily-old'"), 1);
  reset();
});


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// "CLOSED" MUST MEAN "WE LOOKED AND IT WAS GONE".
//
// The sweep used to decide on last_seen_at alone, which makes "closed" mean two different things —
// the posting was taken down, or nobody fetched — and the dashboard renders both as a company that
// stopped hiring. Measured on the live database on 2026-07-31, with the sweep running on every
// reload: 12,574 jobs would have closed on 08-07 and all 26,356 by 08-13, while the search carrying
// 63% of the match table had had exactly ONE successful fetch, sixteen days earlier.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a job is NOT closed when its source has not looked since", () => {
  reset(); forgetFetches();
  seedAged("ret-nolook", 60);
  sawAt("hiringcafe@ret-client", 90);   // the last clean fetch predates the sighting
  const { stale } = dbSweepClosed(14);
  assert.equal(stale, 0, "nothing has looked since this job was last seen — it cannot be known to be gone");
  assert.equal((db.prepare("SELECT status FROM raw_jobs WHERE id='ret-nolook'").get() as { status: string }).status, "open");
  reset(); forgetFetches();
});

test("…and IS closed as soon as that source completes a clean fetch without it", () => {
  reset(); forgetFetches();
  seedAged("ret-look", 60);
  sawAt("hiringcafe@ret-client", 0);
  assert.equal(dbSweepClosed(14).stale, 1);
  assert.equal((db.prepare("SELECT status FROM raw_jobs WHERE id='ret-look'").get() as { status: string }).status, "closed");
  reset(); forgetFetches();
});

test("one source's fetch cannot close another source's jobs", () => {
  // The whole reason the evidence is keyed per source. A watchlist refreshing daily must not license
  // the sweep to close a keyword search's jobs, which is exactly the shape the live data was in.
  reset(); forgetFetches();
  seedAged("ret-other", 60, "open", "hiringcafe@ret-otherclient");
  sawAt("hiringcafe@ret-client", 0);    // a DIFFERENT source looked
  assert.equal(dbSweepClosed(14).stale, 0, "a fetch of one source says nothing about another's postings");
  reset(); forgetFetches();
  db.prepare("DELETE FROM source_fetches WHERE key LIKE '%ret-otherclient'").run();
});

test("a job with no recorded source is never closed by staleness", () => {
  // Every row written before origin_key existed, plus anything a script imports. Leaving a dead
  // posting open is a smaller error than reporting a live company as dormant, and the row starts
  // behaving normally the moment any working source sees it once.
  reset(); forgetFetches();
  seedAged("ret-legacy", 60, "open", null);
  sawAt("hiringcafe@ret-client", 0);
  assert.equal(dbSweepClosed(14).stale, 0);
  assert.equal((db.prepare("SELECT status FROM raw_jobs WHERE id='ret-legacy'").get() as { status: string }).status, "open");
  reset(); forgetFetches();
});

test("an explicit expiry still closes, with or without a fetch", () => {
  // An expiry date IS evidence — the source told us when it ends — so that branch is untouched.
  reset(); forgetFetches();
  insAged.run("ret-exp2", "ret-exp2", "https://example.com/ret-exp2", "open", "-1 days", "-1 days", "-1 days",
    new Date(Date.now() - 86_400_000).toISOString());
  assert.ok(dbSweepClosed(14).expired >= 1, "an expiry needs no fetch to be believed");
  reset(); forgetFetches();
});

test("the unverified-stale report names what is NOT being closed, and why", () => {
  // Silence is what made the old rule dangerous. A job the sweep declines to close has to be
  // visible, or "we have not checked in a while" is indistinguishable from "nothing has changed".
  reset(); forgetFetches();
  seedAged("ret-unver", 60);
  sawAt("hiringcafe@ret-client", 90);
  const rows = dbUnverifiedStale(14).filter((r) => r.originKey === "hiringcafe@ret-client");
  assert.equal(rows.length, 1, "the stale-but-unverified job must be reported");
  assert.equal(rows[0]!.jobs, 1);
  reset(); forgetFetches();
});
