// SQLite via Node's built-in node:sqlite (no native build step).
// Isolated here so it can be swapped for Postgres/Neon if ever hosted.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
const statSize = (p: string): number => { try { return statSync(p).size; } catch { return 0; } };
import { dirname } from "node:path";
import { extractDomain, isPlatformDomain, deriveCountry, fixMojibake } from "./normalize.ts";
import { currentSourceKey } from "./fetchContext.ts";
import { countryFromLocation, countryFromDomain } from "./geo.ts";
import { SIGNAL_TYPE_META, categoryOf, rankOf, RANK_UNKNOWN, collapseGroupCaseSql, collapseWindowCaseSql } from "./signals/taxonomy.ts";
import type { RawJob, Match, QueryOp, QueryCond, QueryGroup } from "./types.ts";
import { keywordHit } from "./keywordMatch.ts";

const DEFAULT_DB = "data/signals.db";

// FAIL-CLOSED IN TESTS. This module opens the database and migrates it at IMPORT time, so merely
// importing anything that transitively reaches db.ts is enough to touch whatever DB_PATH points at.
// Combined with a default of the real database, that makes `npx tsx --test src/anything.test.ts` a
// live write against production — the runner is not doing anything unusual, the default is.
//
// This is not hypothetical and it is not once. It has fired three times in this repo:
//   • `npm test` silently added two indexes to the 1.1GB production database;
//   • a one-off `npx tsx some.ts` opened and migrated it;
//   • worst, running src/domainBackfill.test.ts directly — including a MUTATION run with the safety
//     guard deliberately removed to prove the test catches the bug — executed the destructive
//     re-derive against production and blanked 7,492 employer domains (12,249 -> 4,757; ups.com,
//     fedex.com, expeditors.com all to zero). Restored from the Round-0 snapshot, verified row by
//     row, but only because a snapshot happened to exist.
//
// scripts/test.mjs sets SIGNAL_DB before any import and remains the supported way to run the suite.
// It is not sufficient on its own: it only protects the paths that go through it, and the failure
// mode of forgetting is silent and destructive. So the default itself now refuses in a test context.
const inTestRun = process.env.NODE_ENV === "test"
  || !!process.env.NODE_TEST_CONTEXT
  || process.argv.some((a) => a === "--test" || /\.test\.[cm]?[jt]s$/.test(a));
if (inTestRun && !process.env.SIGNAL_DB) {
  throw new Error(
    "REFUSING to open the production database from a test run.\n"
    + `  src/db.ts defaults SIGNAL_DB to "${DEFAULT_DB}" and migrates at import time, so this would\n`
    + "  have written to real data. Run the suite with:  npm test\n"
    + "  (scripts/test.mjs points SIGNAL_DB at a throwaway file first). To run one file directly:\n"
    + "  SIGNAL_DB=$(mktemp -d)/t.db npx tsx --test src/your.test.ts",
  );
}

const DB_PATH = process.env.SIGNAL_DB ?? DEFAULT_DB;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// Free throughput: WAL lets reads run concurrently with the writer; NORMAL sync keeps writes fast (safe
// under WAL); a busy timeout rides out brief lock contention under higher fetch concurrency. Batched
// transactions (backfill/dedupe/bulk ops) already avoid per-row fsyncs.
// auto_vacuum MUST be set before the first table exists — it is ignored on a database that already
// has one, and cannot be turned on later without a full VACUUM. Set here, at module load, ahead of
// dbMigrate(). INCREMENTAL rather than FULL so reclaiming is a cheap explicit step (dbCheckpoint on
// graceful shutdown) instead of extra work on every delete.
db.exec("PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
// SQLite's default page cache is 2 MB. This database is 553 MB, so every dashboard query that reads a
// column outside a covering index was thrashing a cache 0.4% the size of the file — and because
// node:sqlite is synchronous, that thrash is not a slow query, it is a frozen server.
//
// Measured on the live database, two read-only handles on the same file, best-of-5, identical SQL and
// parameters, the ONLY difference being this line:
//     status counts (the biggest slice of /api/stats)   162.1ms -> 27.5ms
//     the companies rollup, one page                    217.6ms -> 54.2ms
//     the postings id page                              143.2ms -> 29.7ms
//     /api/stats end to end                             301.5ms -> 92.2ms
// 256 MB is a ceiling, not an allocation — SQLite grows into it only as pages are touched.
//
// mmap lets reads come from the page cache without a copy into user space; it is a smaller, additive
// win on top of the above and is capped at 1 GB so it cannot map an unbounded future file.
db.exec("PRAGMA cache_size = -262144; PRAGMA mmap_size = 1073741824;");
// Fold the WAL back into the main file on boot — an app killed mid-run (or long-lived readers) can
// leave the -wal sidecar growing into the hundreds of MB; TRUNCATE reclaims it. Cheap when small.
try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* another connection holds it — harmless */ }

/** Checkpoint + truncate the WAL (called on graceful shutdown so the sidecar doesn't accumulate). */
/** Reclaim free pages, if this file was created with auto_vacuum on.
 *
 *  The production database is 1.09 GB of which 683 MB (63%) is freelist — pages that deleting and
 *  re-ingesting jobs released and that SQLite will reuse but never hand back. Live data is ~406 MB.
 *  wal_checkpoint(TRUNCATE) below only truncates the -wal sidecar; it reclaims none of this.
 *
 *  auto_vacuum cannot be switched on for an EXISTING file by setting the pragma — it only takes
 *  effect on a database created with it, or after a full VACUUM. So this is a no-op on today's
 *  production file and a real reclaim on any database created from here on. Shrinking the existing
 *  one needs a one-off `VACUUM;` run offline, which wants roughly the live size in spare disk and
 *  an exclusive lock — deliberately NOT done automatically at shutdown, where it could take minutes
 *  and be interrupted. */
export function dbIncrementalVacuum(): void {
  try {
    const mode = (db.prepare("PRAGMA auto_vacuum").get() as Record<string, number>);
    if (Number(Object.values(mode)[0] ?? 0) === 2) db.exec("PRAGMA incremental_vacuum;");
  } catch { /* best-effort */ }
}

export function dbCheckpoint(): void {
  dbIncrementalVacuum();
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* best-effort */ }
}

/** Allow-list of sortable columns → SQL, on a NULL prototype.
 *  These maps gate a value that is string-interpolated into ORDER BY, and the gate is
 *  `MAP[key] ? MAP[key] : default`. A plain object literal inherits Object.prototype, so
 *  ?sort=constructor (or toString, valueOf, hasOwnProperty…) passed the check and put a function's
 *  source text into the SQL — a 500 rather than a silent default. Object.create(null) has no
 *  inherited keys, so only the columns actually listed can ever match. */
const sortMap = (m: Record<string, string>): Record<string, string> =>
  Object.assign(Object.create(null) as Record<string, string>, m);
/** sortMap for a registry whose values are not strings. Same purpose: a user-supplied key must
 *  never resolve to an inherited Object.prototype member. */
const nullProto = <T extends object>(m: T): T => Object.assign(Object.create(null) as T, m);

// SQLite's built-in LOWER() only folds ASCII: lower('ŠKODA') is 'Škoda', while JavaScript's
// toLowerCase() gives 'škoda'. Keys are WRITTEN from JS (company_key = company.trim().toLowerCase())
// and were READ back with SQL LOWER(), so any company with a non-ASCII capital could never match its
// own row: it never left the "needs a domain" backlog, "Resolve all domains" looped on it forever,
// and it therefore produced no signals at all. jslower is the same function on both sides.
db.function("jslower", { deterministic: true }, (s: unknown) => (s == null ? null : String(s).toLowerCase()));
// Whole-word (exact) containment for the advanced filter's "is exactly (whole word)" text operator.
// Uses the SAME boundary rules as the matcher's exact keyword mode (src/keywordMatch.ts) so a
// stored-job filter and a tracker's exact match agree on what "react" matches. Returns 1/0.
db.function("jsword", { deterministic: true }, (hay: unknown, term: unknown) =>
  hay == null || term == null ? 0 : (keywordHit(String(hay), String(term), true) ? 1 : 0));

// One-shot markers for work that must happen exactly once (a backfill), so it is not re-attempted —
// or worse, re-scanned to find nothing — on every subsequent boot. See dbMigrate() at the bottom of
// the schema section for why that matters.
db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
const metaGetStmt = db.prepare("SELECT v FROM meta WHERE k = ?");
const metaSetStmt = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
const getMeta = (k: string): string | null => ((metaGetStmt.get(k) as { v: string } | undefined)?.v ?? null);
const setMeta = (k: string, v: string): void => { metaSetStmt.run(k, v); };

db.exec(`
  CREATE TABLE IF NOT EXISTS raw_jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT,
    location TEXT,
    state TEXT,
    remote INTEGER DEFAULT 0,
    url TEXT,
    posted_at TEXT,
    seen_at TEXT DEFAULT (datetime('now')),
    raw TEXT,
    UNIQUE(source, external_id)
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES raw_jobs(id),
    client TEXT NOT NULL,
    match_reason TEXT,
    matched_on TEXT,
    delivered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(job_id, client)
  );
  CREATE TABLE IF NOT EXISTS technologies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    canonical TEXT NOT NULL UNIQUE,     -- lowercased dedup key
    category TEXT,
    aliases TEXT,                       -- JSON array of alternate names
    companies_count INTEGER DEFAULT 0,  -- popularity (from the source list) — ranks the leaderboard
    jobs_count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS job_technologies (
    job_id TEXT NOT NULL,
    tech_id INTEGER NOT NULL,
    PRIMARY KEY (job_id, tech_id)
  );
  CREATE TABLE IF NOT EXISTS fetch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fetch_key TEXT, client TEXT, kind TEXT,
    started_at TEXT DEFAULT (datetime('now')), finished_at TEXT,
    fetched INTEGER DEFAULT 0, fresh INTEGER DEFAULT 0, matched INTEGER DEFAULT 0,
    error TEXT,
    -- A run that WORKED but was incomplete: a board rejected, a feed dead, a page cap hit. Distinct
    -- from the error column, which means the whole run failed. Without this the only trace of a
    -- broken scraper was a console.warn nobody reads, and the run rendered as a clean "found 0 jobs".
    warnings TEXT
  );
  -- When each configured source last completed a fetch WITHOUT error. The job-close sweep reads
  -- it to answer "did we actually look?" — see dbSweepClosed. Keyed by the runSource label
  -- (type@owner), which is also what raw_jobs.origin_key stores.
  CREATE TABLE IF NOT EXISTS source_fetches (
    key TEXT PRIMARY KEY,
    last_ok_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ats_boards (
    domain TEXT NOT NULL,
    vendor TEXT NOT NULL,               -- greenhouse | lever | ashby
    slug TEXT,                          -- the board slug (null when no board found)
    found INTEGER NOT NULL DEFAULT 0,   -- 1 = a live board exists, 0 = probed, none found
    checked_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (domain, vendor)
  );
  CREATE TABLE IF NOT EXISTS job_origins (
    job_id TEXT NOT NULL REFERENCES raw_jobs(id),
    origin TEXT NOT NULL,               -- "ac:<check-id>": the Account Check whose run inserted the job
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (job_id, origin)
  );
  CREATE TABLE IF NOT EXISTS clients (
    name TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_cache (
    company_key TEXT PRIMARY KEY,   -- normalized company name
    jobs_json TEXT NOT NULL,        -- that company's hiring.cafe jobs (RawJob[])
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  -- Saved account-check searches: each is named, persists its params + results, and the
  -- results table is built incrementally as the run progresses (so it survives a tab close).
  CREATE TABLE IF NOT EXISTS account_searches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    params TEXT NOT NULL,                 -- JSON { companies:[], search:{}, maxPages }
    status TEXT NOT NULL DEFAULT 'running', -- running | done | stopped | error
    total INTEGER DEFAULT 0,              -- companies to check
    checked INTEGER DEFAULT 0,            -- companies checked so far
    found INTEGER DEFAULT 0,              -- companies with ≥1 matching opening
    total_hits INTEGER DEFAULT 0,         -- matching openings found
    hits TEXT DEFAULT '[]',               -- AccountHit[] (the export, grown as the run goes)
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_account_searches_created ON account_searches(created_at DESC);
  -- One row per matching opening, replacing the ever-growing JSON blob on the parent row. The PK is
  -- what makes a resumed run idempotent: re-found hits collide and are ignored, and hits the rebuild
  -- can no longer see survive instead of being wiped. account_searches.hits stays as a legacy column
  -- so an older build can still read a run it wrote; nothing writes it any more.
  CREATE TABLE IF NOT EXISTS account_search_hits (
    search_id     TEXT NOT NULL,
    input_company TEXT NOT NULL DEFAULT '',
    url           TEXT NOT NULL DEFAULT '',
    hit           TEXT NOT NULL,
    PRIMARY KEY (search_id, input_company, url)
  );
  CREATE INDEX IF NOT EXISTS idx_account_search_hits_sid ON account_search_hits(search_id);
  -- Generic sales signals beyond hiring (funding, tech changes, DNS tools, news, …). One table for
  -- every producer; dedup_key makes emission idempotent (a re-scan can never double-fire).
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL DEFAULT '',
    company TEXT,
    type TEXT NOT NULL,                   -- producer-defined, e.g. velocity-spike | tech-added | dns-tool-added
    title TEXT NOT NULL,                  -- human-readable one-liner
    detail TEXT,                          -- JSON facts backing the signal
    url TEXT,
    client TEXT,                          -- watchlist attribution (continuous monitoring)
    check_id TEXT,                        -- one-off signal-check attribution
    observed_at TEXT,                     -- when the underlying event happened (best-known)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_signals_client ON signals(client);
  CREATE INDEX IF NOT EXISTS idx_signals_domain ON signals(domain);
  -- per-company history lookups ("was <domain> funded in the past year?"): domain + type, plus the
  -- event date so the range filter stays fast over a large retained history.
  CREATE INDEX IF NOT EXISTS idx_signals_domain_type ON signals(domain, type);
  CREATE INDEX IF NOT EXISTS idx_signals_observed ON signals(observed_at);
  -- Per-domain snapshot state for change detection: a signal = a DIFF between scans. First scan of a
  -- (domain, producer) is baseline-only (rows written, no signals) so history never floods webhooks.
  CREATE TABLE IF NOT EXISTS domain_state (
    domain TEXT NOT NULL,
    producer TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (domain, producer, key)
  );
  -- Saved multi-signal checks: upload a domain list, tick signal types, run — results build live
  -- (per-domain facts grid) and survive a tab close / restart, mirroring account_searches.
  CREATE TABLE IF NOT EXISTS signal_checks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    params TEXT NOT NULL,                   -- JSON { domains:[], signals:[] }
    status TEXT NOT NULL DEFAULT 'running', -- running | done | stopped | error | paused
    total INTEGER DEFAULT 0,
    checked INTEGER DEFAULT 0,
    found INTEGER DEFAULT 0,                -- domains with >=1 signal
    total_hits INTEGER DEFAULT 0,           -- signals recorded by this check
    results TEXT DEFAULT '[]',              -- SignalCheckDomainResult[] (grown as the run goes)
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signal_checks_created ON signal_checks(created_at DESC);
  -- One row per checked domain, replacing the whole-array rewrite on the parent row. Same reason as
  -- account_search_hits: a resumed run starts its in-memory array EMPTY and re-checks from scratch, so
  -- writing the array back wiped every domain the rebuild could not reach again. Keyed by domain, so a
  -- re-check updates its own row and a domain the resume never reaches keeps the result it already had.
  -- signal_checks.results stays as a legacy column; nothing writes it any more.
  CREATE TABLE IF NOT EXISTS signal_check_results (
    check_id TEXT NOT NULL,
    domain   TEXT NOT NULL,
    result   TEXT NOT NULL,
    PRIMARY KEY (check_id, domain)
  );
  -- Current-state flag per (domain, producer): "does this company show signal X right now?" — powers
  -- the job-finder signal filters + the on-demand per-company check. Unlike the diff-based signals
  -- feed (baseline-suppressed), this captures present state (e.g. "running ads", "raised", "uses X").
  CREATE TABLE IF NOT EXISTS domain_flags (
    domain TEXT NOT NULL,
    producer TEXT NOT NULL,
    hit INTEGER NOT NULL DEFAULT 0,        -- 1 = this producer flagged something noteworthy for the domain
    summary TEXT,                          -- short human string ("1,240 active ads", "raised — Form D 2026-03")
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (domain, producer)
  );
  CREATE INDEX IF NOT EXISTS idx_domain_flags_producer_hit ON domain_flags(producer, hit);
  -- Work queue for RATE-LIMITED producers, so the scheduled scan never waits on one.
  -- GDELT allows roughly one lookup every 5 seconds. runClientSignals walks domains serially, so
  -- putting GDELT in the inline fan-out made EVERY producer for EVERY domain queue behind that gap:
  -- a 1,300-domain watchlist needed ~1.9 hours on GDELT alone before the scan could finish. In
  -- practice the run ended long before that, which is why GDELT had reached only 24 domains while
  -- its siblings had reached 1,283. The scan now ENQUEUES these producers and returns; a background
  -- worker drips through the queue at the producer's own pace, whether or not a scan is running.
  --
  -- PRIMARY KEY (producer, domain): re-enqueuing a domain already waiting UPDATES it rather than
  -- adding a duplicate, so the queue is bounded by the watchlist size no matter how often scans run.
  -- Rows are DELETED on success, so "queued" always means "still owed", and the next scan re-adds it.
  CREATE TABLE IF NOT EXISTS slow_queue (
    producer    TEXT NOT NULL,
    domain      TEXT NOT NULL,
    client      TEXT,                    -- attribution for emitted signals (NULL = no watchlist)
    company     TEXT,                    -- name resolved by the scan; saves the worker a homepage fetch
    enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    next_at     TEXT NOT NULL DEFAULT (datetime('now')),   -- backoff: not before this time
    PRIMARY KEY (producer, domain)
  );
  CREATE INDEX IF NOT EXISTS idx_slow_queue_ready ON slow_queue(producer, next_at);
  -- Company → domain overrides. Fills the Companies view's Domain when the job records carry none
  -- (a company that only posts through a third-party ATS has no own-domain on its rows). source =
  -- 'manual' (user typed it) or 'auto' (guessed + verified by the resolver) so the UI can badge guesses.
  CREATE TABLE IF NOT EXISTS company_domains (
    company_key TEXT PRIMARY KEY,          -- LOWER(company), matches the companies GROUP BY key
    company TEXT NOT NULL,                 -- original display name (for reference)
    domain TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS resolve_attempts (
    company_key TEXT PRIMARY KEY,          -- LOWER(company) — negative cache for failed resolutions
    attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_seen ON raw_jobs(seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_matches_created ON matches(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_job_origins_origin ON job_origins(origin);
  CREATE INDEX IF NOT EXISTS idx_fetch_runs_started ON fetch_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_job_tech_tech ON job_technologies(tech_id);
`);

/**
 * A 'running' row can only be live in memory; after a restart there's no run behind it, so any row
 * still marked running at boot is orphaned — mark it stopped (its partial results are kept).
 *
 * fetch_runs belongs here too and was missed. It has no status column — a run is "still going" when
 * finished_at is NULL — and runSource wraps everything in try/catch, so the only way a row stays open
 * is the process dying mid-run (a crash, a kill, or the auto-shutdown). Production had 5 of 11 runs
 * stuck open, three of them started exactly on a scheduled half-hour. The System panel showed every
 * one as "running…" with a live "duration" of now-minus-started_at, which had been climbing for days.
 *
 * finished_at is set to started_at rather than now: the run did NOT finish at boot, and dating it now
 * would report a duration that includes however long the app was switched off. The real end time is
 * unrecoverable, so the error column says so — a 0s duration next to an explicit "interrupted" chip
 * reads as "no measurement", which is the truth, where a large invented number would not.
 */
export function reconcileOrphanedRuns(): void {
  db.exec("UPDATE account_searches SET status = 'stopped', updated_at = datetime('now') WHERE status = 'running'");
  db.exec("UPDATE signal_checks SET status = 'stopped', updated_at = datetime('now') WHERE status = 'running'");
  db.exec(`UPDATE fetch_runs SET finished_at = started_at,
             error = 'interrupted — the app stopped before this run finished (end time unknown)'
           WHERE finished_at IS NULL`);
}
reconcileOrphanedRuns();

// Additive migration: matches.dismissed — soft-hide a match from the dashboard (reversible;
// the raw job stays in the DB and other searches keep it). Added here, NOT in the CREATE above,
// so it runs on pre-existing DBs too. Index created unconditionally right after.
{
  const cols = db.prepare("PRAGMA table_info(matches)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "dismissed")) db.exec("ALTER TABLE matches ADD COLUMN dismissed INTEGER DEFAULT 0");
  // "What matched where" provenance (JSON array of {term,field}); nullable, older rows just render nothing.
  if (!cols.some((c) => c.name === "matched_on")) db.exec("ALTER TABLE matches ADD COLUMN matched_on TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_matches_dismissed ON matches(dismissed)");
}

// Additive migration: raw_jobs gains company domain + open/closed lifecycle tracking.
//   domain      — employer domain parsed from the job URL (null for aggregator-hosted URLs)
//   status      — 'open' (default) | 'closed'
//   last_seen_at— refreshed every time a fetch still lists the job (drives disappearance close)
//   expires_at  — explicit close date where a source provides one (Himalayas, ATS)
//   closed_at   — when we marked it closed
{
  const cols = db.prepare("PRAGMA table_info(raw_jobs)").all() as { name: string }[];
  const has = (n: string) => cols.some((c) => c.name === n);
  // fetch_runs.warnings, for databases created before it existed. Same additive, gated shape as
  // every migration in this block — see the CREATE TABLE for what it records and why it is not `error`.
  {
    const runCols = db.prepare("PRAGMA table_info(fetch_runs)").all() as { name: string }[];
    if (!runCols.some((c) => c.name === "warnings")) db.exec("ALTER TABLE fetch_runs ADD COLUMN warnings TEXT");
  }
  if (!has("origin_key")) db.exec("ALTER TABLE raw_jobs ADD COLUMN origin_key TEXT");
  if (!has("domain")) db.exec("ALTER TABLE raw_jobs ADD COLUMN domain TEXT");
  if (!has("status")) db.exec("ALTER TABLE raw_jobs ADD COLUMN status TEXT DEFAULT 'open'");
  if (!has("last_seen_at")) db.exec("ALTER TABLE raw_jobs ADD COLUMN last_seen_at TEXT");
  if (!has("expires_at")) db.exec("ALTER TABLE raw_jobs ADD COLUMN expires_at TEXT");
  if (!has("closed_at")) db.exec("ALTER TABLE raw_jobs ADD COLUMN closed_at TEXT");
  // dedup_key: canonical identity of a posting across sources/boards (collapse_key ▸ url ▸ source:id),
  // so the same role isn't stored twice (e.g. via a keyword search AND an /org/ scan, or across ATS boards).
  if (!has("dedup_key")) db.exec("ALTER TABLE raw_jobs ADD COLUMN dedup_key TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status ON raw_jobs(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_domain ON raw_jobs(domain)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_dedup ON raw_jobs(dedup_key)");
  // /api/stats scopes the live company aggregation by (client, dismissed); this composite keeps that
  // GROUP BY fast as matches grow (the dashboard polls stats on load + every 60s).
  db.exec("CREATE INDEX IF NOT EXISTS idx_matches_client_dismissed ON matches(client, dismissed)");
  // backfill existing rows from their URL (pre-existing rows have no collapse_key captured).
  // Index-backed via idx_jobs_dedup, so the steady-state no-op costs nothing.
  // jslower(), not SQLite's LOWER(). LOWER() is ASCII-only, so a URL containing a non-ASCII
  // character (an IDN host, a percent-free path segment) was WRITTEN with one fold and later
  // looked up with JavaScript's Unicode toLowerCase() — the write-with-one-fold/read-with-the-
  // other split this file's header calls out as silent data loss. Every other writer and reader of
  // dedup_key already uses the JS fold; this backfill was the last holdout.
  db.exec("UPDATE raw_jobs SET dedup_key = jslower(TRIM(url)) WHERE (dedup_key IS NULL OR dedup_key = '') AND url IS NOT NULL AND TRIM(url) <> ''");
  // Seed last_seen_at from seen_at so existing jobs aren't instantly stale. This must stay
  // unconditional (a future NULL has to be repaired too) but WITHOUT the partial index it was a full
  // scan of the widest table on EVERY boot — 664ms at 200k rows to match zero rows. The partial index
  // turns the steady-state no-op into an empty index probe.
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_last_seen_null ON raw_jobs(last_seen_at) WHERE last_seen_at IS NULL");
  db.exec("UPDATE raw_jobs SET last_seen_at = COALESCE(last_seen_at, seen_at, datetime('now')) WHERE last_seen_at IS NULL");
  // Same trick for dbSweepClosed's two UPDATEs, which run on EVERY reload. idx_jobs_status can't help
  // them — every row is 'open', so it has no selectivity and the planner picks a full scan of the
  // widest table. Measured on the 16,275-job production copy that scan cost 154ms per reload while
  // closing zero rows, and after the match backfill was chunked it became the LONGEST remaining block
  // of a config save. Indexing the date column with status folded into the partial WHERE turns each
  // one into a range seek that stops at the first non-matching entry.
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_sweep_expires ON raw_jobs(expires_at) WHERE status = 'open' AND expires_at IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_sweep_stale ON raw_jobs(last_seen_at) WHERE status = 'open' AND last_seen_at IS NOT NULL");
  // strip the legacy "· src:<source>" suffix from stored match reasons (we no longer surface sources)
  db.exec("UPDATE matches SET match_reason = rtrim(substr(match_reason, 1, instr(match_reason, ' · src:') - 1)) WHERE match_reason LIKE '% · src:%'");
  // Denormalized `description` column — composed at write time by rawDescription() so the dashboard/admin
  // can search + filter on job-description text (and read it without re-composing per row). Added here
  // (never in the main CREATE) so it runs on pre-existing DBs. The ALTER is instant; the BACKFILL is
  // deferred to dbMigrate() because it materializes every row's raw blob (+394MB heap at 200k).
  if (!has("description")) {
    db.exec("ALTER TABLE raw_jobs ADD COLUMN description TEXT");
    setMeta("backfill:description", "1");
  }
  // Salary ceiling, lifted out of the raw JSON blob into a real column. The Companies view took
  // MAX(json_extract(j.raw,'$.comp_max')) over every matched row, which meant parsing a 3.7 KB blob
  // per row to read one number: measured 60% of that page's cost (LIMIT 15 fell from 220ms to 85ms
  // when the expression was replaced with NULL). A generated column cannot help here — SQLite only
  // allows ALTER TABLE to add a VIRTUAL one, which still parses on read — so this is a stored column,
  // written on insert and backfilled once.
  if (!has("comp_max")) {
    db.exec("ALTER TABLE raw_jobs ADD COLUMN comp_max REAL");
    setMeta("backfill:comp_max", "1");
  }
  // The currency the number above is denominated in, lifted for the same reason and beside it on
  // purpose: a salary without its currency is not a quantity, it is a digit string. The column was
  // absent, so every place that COMPARED salaries — the two Salary column sorts, the query builder's
  // salary filter — compared 11,000,000 INR against 400,000 USD as if the first were larger. On the
  // live data 97 of the top 100 rows of "highest salary" are not USD, and there was no way to write
  // "USD only" because no currency field existed to filter on.
  //
  // Not read with json_extract for the same measured reason as comp_max: adding one json_extract to
  // the /api/stats facet pass took it from 19ms to 320ms, and node:sqlite is synchronous, so that is
  // 300ms of frozen server on every dashboard load.
  if (!has("currency")) {
    db.exec("ALTER TABLE raw_jobs ADD COLUMN currency TEXT");
    setMeta("backfill:currency", "1");
  }
  // Triage: star a job (a per-job flag, so it's starred in every view). Additive.
  if (!has("starred")) db.exec("ALTER TABLE raw_jobs ADD COLUMN starred INTEGER DEFAULT 0");
  // `country`: ISO alpha-2 when the location says so confidently, NULL when unknown (never a guess).
  // Added because `state` alone can't represent a worldwide job set — and because the old 2-letter
  // scan mis-filed "Berlin, DE" as Delaware and "Mumbai, IN" as Indiana. Backfill deferred (below).
  if (!has("country")) {
    db.exec("ALTER TABLE raw_jobs ADD COLUMN country TEXT");
    setMeta("backfill:country", "1");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_country ON raw_jobs(country)");
  // /api/stats runs five facet aggregations over matches JOIN raw_jobs; each was a rowid lookup into
  // a 3.7KB-average row, costing ~450ms of FROZEN event loop (node:sqlite is synchronous) every 60s.
  // This covering index answers all five from the index alone: measured 388ms -> 124ms.
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_facets ON raw_jobs(id, source, state, country, company, title)");
  // /api/health counted starred jobs with a full scan of the widest table (56ms). Partial index →
  // covering probe, measured 0ms, and cheap on writes because starred rows are rare.
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_starred ON raw_jobs(starred) WHERE starred = 1");
  // The matches feed groups by job and orders by MAX(m.created_at) over every match in scope; this
  // partial index covers that read for the live (non-dismissed) rows it actually pages over.
  db.exec("CREATE INDEX IF NOT EXISTS idx_matches_live ON matches(job_id, created_at) WHERE dismissed = 0");
}

// Additive migration: signals gain a CATEGORY (what the event MEANS, shared across the regional
// variants of the same event) and an EVIDENCE RANK (official filing > our own data > press), both
// derived from src/signals/taxonomy.ts. Stored rather than derived per query so category filtering,
// GROUP BY category and the collapse partition are index-backed — and kept honest by the reconcile
// pass, which re-syncs every row at boot whenever the taxonomy map changes.
{
  const cols = db.prepare("PRAGMA table_info(signals)").all() as { name: string }[];
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has("category")) db.exec("ALTER TABLE signals ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  if (!has("evidence_rank")) db.exec("ALTER TABLE signals ADD COLUMN evidence_rank INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_signals_category_created ON signals(category, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_signals_collapse ON signals(domain, category, observed_at)");
  // The reconcile issues one UPDATE per signal type; no existing index leads with `type`, so each was
  // a full table scan (28 of them = 215ms at 30k signals, on every boot, changing nothing).
  db.exec("CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type)");
  // The reconcile itself moved to dbMigrate() — it runs after the server is listening, and only when
  // the taxonomy map has actually changed.
}

// Full-text search index (porter stemming + prefix): powers the "fuzzy" keyword search — `manage`
// matches "managing", `salesf*` matches Salesforce, word-level so `java` doesn't hit "javascript".
// Standalone (not external-content) so we control sync explicitly from the write paths below.
let ftsReady = false;
try {
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(job_id UNINDEXED, title, company, description, tokenize='porter unicode61')");
  ftsReady = true;
  // The backfill (the single biggest boot cost — it alone accounted for 13.0s of a 13.4s cold start
  // at 200k jobs) is deferred to dbMigrate().
} catch (e) { console.warn(`[fts] unavailable (${(e as Error).message}) — fuzzy search disabled, LIKE fallback used`); }

const ftsIns = ftsReady ? db.prepare("INSERT INTO jobs_fts (job_id, title, company, description) VALUES (?, ?, ?, ?)") : null;
const ftsDel = ftsReady ? db.prepare("DELETE FROM jobs_fts WHERE job_id = ?") : null;
/** Keep the FTS row for a job in sync (delete + re-insert). Called from every write path. */
function ftsSync(jobId: string, title: string, company: string | null, description: string | null): void {
  if (!ftsReady) return;
  try { ftsDel!.run(jobId); ftsIns!.run(jobId, title ?? "", company ?? "", description ?? ""); } catch { /* best-effort */ }
}
export const dbFtsReady = () => ftsReady;

// ─────────────────────── Deferred migration: the expensive half of boot ───────────────────────
// Everything above runs at IMPORT time, because prepared statements need the columns to exist.
// That is fine — DDL is metadata-only and costs milliseconds. The DATA work is not: it used to run
// at import too, which meant it ran BEFORE startServer() could call listen(), so the dashboard was
// connection-refused (not "loading") for the whole duration: measured 1.0s warm and 3.0s cold at
// 16k jobs, and 13.4s at 200k. index.ts's own header comment promised the opposite.
//
// So the server now listens first and calls this afterwards. Each step is gated — a marker for the
// one-shot backfills, a hash for the taxonomy reconcile — so a steady-state boot does no work at
// all, and each yields to the event loop between chunks so the loading screen keeps painting.
const CHUNK = 2000;
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export async function dbMigrate(): Promise<void> {
  repairStoredMojibake();   // deferred: it calls dbGetMeta, whose statement is prepared below this block
  // 1. description: composed from the raw blob. Chunked — reading every raw at once cost +394MB heap.
  if (getMeta("backfill:description")) {
    const ids = db.prepare("SELECT id FROM raw_jobs").all() as Array<{ id: string }>;
    const get = db.prepare("SELECT raw FROM raw_jobs WHERE id = ?");
    const upd = db.prepare("UPDATE raw_jobs SET description = ? WHERE id = ?");
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      db.exec("BEGIN");
      try {
        for (const { id } of slice) upd.run(rawDescription((get.get(id) as { raw: string | null } | undefined)?.raw ?? null), id);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      await yieldToLoop();
    }
    setMeta("backfill:description", "");
    if (ids.length) console.log(`[jobs] description backfill: ${ids.length} row(s)`);
  }

  // 2. country, and clearing the US states the old 2-letter scan wrongly derived for non-US rows.
  if (getMeta("backfill:country")) {
    const rows = db.prepare("SELECT id, location, state FROM raw_jobs WHERE location IS NOT NULL AND location <> ''")
      .all() as Array<{ id: string; location: string; state: string | null }>;
    const upd = db.prepare("UPDATE raw_jobs SET country = ?, state = ? WHERE id = ?");
    let cleared = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      db.exec("BEGIN");
      try {
        for (const r of rows.slice(i, i + CHUNK)) {
          const cc = countryFromLocation(r.location);
          const state = cc && cc !== "US" ? null : r.state;  // a confidently non-US row has no US state
          if (state === null && r.state) cleared++;
          upd.run(cc ?? (state ? "US" : null), state, r.id); // a surviving US state implies US
        }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      await yieldToLoop();
    }
    setMeta("backfill:country", "");
    if (cleared) console.log(`[jobs] country backfill cleared ${cleared} wrongly-derived US state(s) on non-US locations`);
  }

  // 2a. Lift comp_max out of the raw blob. Chunked and yielding like the others: the expression is
  //     evaluated inside SQLite so nothing is materialized in JS, but a single UPDATE over every row
  //     would still hold the loop for the whole parse.
  if (getMeta("backfill:comp_max")) {
    const ids = db.prepare("SELECT id FROM raw_jobs WHERE comp_max IS NULL AND raw IS NOT NULL AND raw <> 'null'").all() as { id: string }[];
    const upd = db.prepare("UPDATE raw_jobs SET comp_max = json_extract(raw,'$.comp_max') WHERE id = ?");
    for (let i = 0; i < ids.length; i += CHUNK) {
      db.exec("BEGIN");
      try { for (const r of ids.slice(i, i + CHUNK)) upd.run(r.id); db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
      await yieldToLoop();
    }
    setMeta("backfill:comp_max", "");
    if (ids.length) console.log(`[jobs] comp_max backfilled on ${ids.length} row(s)`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_compmax ON raw_jobs(comp_max) WHERE comp_max IS NOT NULL");

  // 2a-bis. The currency beside it. Scoped to rows that actually carry a salary — a currency with no
  //     number is not a fact about anything, and on the live data that is 15,397 of 24,945 rows this
  //     never has to touch.
  if (getMeta("backfill:currency")) {
    const ids = db.prepare("SELECT id FROM raw_jobs WHERE currency IS NULL AND comp_max IS NOT NULL AND raw IS NOT NULL AND raw <> 'null'").all() as { id: string }[];
    const upd = db.prepare("UPDATE raw_jobs SET currency = json_extract(raw,'$.currency') WHERE id = ?");
    for (let i = 0; i < ids.length; i += CHUNK) {
      db.exec("BEGIN");
      try { for (const r of ids.slice(i, i + CHUNK)) upd.run(r.id); db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
      await yieldToLoop();
    }
    setMeta("backfill:currency", "");
    if (ids.length) console.log(`[jobs] currency backfilled on ${ids.length} row(s)`);
  }
  // Partial and covering, so listing the currencies present — which /api/stats does on every dashboard
  // load to fill the query builder's dropdown — is an index-only scan over ~17 distinct values rather
  // than a table walk. Measured on the live data: 89ms without it, 0.24ms with.
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_currency ON raw_jobs(currency) WHERE currency IS NOT NULL");

  // 2b. Move account-check results out of the per-run JSON blob and into account_search_hits, one row
  //     per opening. Runs once, gated on its own marker. The blob column is left in place (an older
  //     build can still read a run it wrote) but is blanked here so the 36 MB it holds on a real run
  //     stops being carried in every backup and every SELECT that touches the parent row.
  if (!getMeta("migrate:account-hits")) {
    const rows = db.prepare("SELECT id, hits FROM account_searches WHERE hits IS NOT NULL AND hits <> '' AND hits <> '[]'")
      .all() as Array<{ id: string; hits: string }>;
    let moved = 0;
    for (const r of rows) {
      let hits: Record<string, unknown>[] = [];
      try { hits = JSON.parse(r.hits); } catch { continue; }   // unparseable legacy blob: leave it alone
      if (!Array.isArray(hits) || !hits.length) continue;
      db.exec("BEGIN");
      try {
        for (const h of hits) {
          insertAccountHit.run(r.id, String(h?.input_company ?? ""), String(h?.url ?? ""), JSON.stringify(h));
          moved++;
        }
        db.prepare("UPDATE account_searches SET hits = '[]', total_hits = (SELECT COUNT(*) FROM account_search_hits WHERE search_id = ?) WHERE id = ?").run(r.id, r.id);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      await yieldToLoop();
    }
    setMeta("migrate:account-hits", "1");
    if (moved) console.log(`[account] moved ${moved} hit(s) from ${rows.length} run(s) into account_search_hits`);
  }

  // 2c. The same move for signal checks: per-domain results out of signal_checks.results and into
  //     signal_check_results, one row per domain. Same one-shot marker gate; the blob is blanked so
  //     it stops riding along on every parent-row SELECT.
  if (!getMeta("migrate:signal-check-results")) {
    const rows = db.prepare("SELECT id, results FROM signal_checks WHERE results IS NOT NULL AND results <> '' AND results <> '[]'")
      .all() as Array<{ id: string; results: string }>;
    let moved = 0;
    for (const r of rows) {
      let items: Record<string, unknown>[] = [];
      try { items = JSON.parse(r.results); } catch { continue; }  // unparseable legacy blob: leave it alone
      if (!Array.isArray(items) || !items.length) continue;
      db.exec("BEGIN");
      try {
        for (const it of items) {
          insertSignalCheckResult.run(r.id, String(it?.domain ?? ""), JSON.stringify(it));
          moved++;
        }
        db.prepare("UPDATE signal_checks SET results = '[]' WHERE id = ?").run(r.id);
        updateSignalCheckProgress.run(r.id, r.id, r.id, r.id);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      await yieldToLoop();
    }
    setMeta("migrate:signal-check-results", "1");
    if (moved) console.log(`[signal-check] moved ${moved} result(s) from ${rows.length} run(s) into signal_check_results`);
  }

  // 2d. Drop company_rollup. A removed feature left the table behind — 67,479 rows / 4.2 MB in the
  //     production file — with no CREATE TABLE in this file and no query anywhere in the repo that
  //     reads, writes or purges it. It is carried in every backup and every VACUUM, and it reads to
  //     the next person as live state. The reclaimed pages come back on the next incremental vacuum.
  if (!getMeta("migrate:drop-company-rollup")) {
    const present = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='company_rollup'").get() as { c: number };
    if (present.c) {
      const n = (db.prepare("SELECT COUNT(*) c FROM company_rollup").get() as { c: number }).c;
      db.exec("DROP TABLE company_rollup");
      console.log(`[db] dropped the orphaned company_rollup table (${n} stale row(s))`);
    }
    setMeta("migrate:drop-company-rollup", "1");
  }

  // 3. Repair rows written by the OLD insert path, which (unlike the backfill) did not apply
  //    "a US state implies US" — leaving a state with a NULL country, so a Country=US filter dropped
  //    jobs the State facet simultaneously listed under NY/CA/TX. One-shot; the write path agrees now.
  if (!getMeta("repair:state-implies-us")) {
    const n = db.prepare("UPDATE raw_jobs SET country = 'US' WHERE country IS NULL AND state IS NOT NULL AND state <> ''").run().changes;
    setMeta("repair:state-implies-us", "1");
    if (n) console.log(`[jobs] set country=US on ${n} row(s) that had a US state but no country`);
  }

  // 4. FTS index, for any job missing from it.
  //    Gated by a durable marker like every other step here, NOT by "is the index empty". It used
  //    to be `if (ftsCount === 0)`, which was safe only while the backfill was one atomic
  //    transaction. Once it was chunked to keep the loading screen alive, the first committed chunk
  //    made ftsCount non-zero — so an interruption (the auto-quit timer fires when the user closes
  //    the tab mid-migration, or a crash, or Ctrl+C) froze a partially-built index permanently, and
  //    every later fuzzy search silently returned matches from a fraction of the corpus.
  //    Selecting only the rows actually missing also makes this resumable AND idempotent: it picks
  //    up exactly where it stopped, and costs one cheap anti-join when there is nothing to do.
  //    The resume cursor is the last raw_jobs.id written, advanced inside the SAME transaction as
  //    its chunk — so the marker can never claim progress that rolled back. It deliberately does
  //    NOT ask jobs_fts which ids are missing: job_id is an UNINDEXED FTS5 column, so an anti-join
  //    would scan the entire index once per job.
  if (ftsReady && ftsIns && getMeta("backfill:fts") !== "1") {
    const jobCount = (db.prepare("SELECT COUNT(*) c FROM raw_jobs").get() as { c: number }).c;
    const ftsCount = (db.prepare("SELECT COUNT(*) c FROM jobs_fts").get() as { c: number }).c;
    let cursor = getMeta("backfill:fts:cursor");
    if (cursor == null) {
      // Fresh start. An index that already covers every job was built by an older version that
      // finished — adopt it. Anything else is partial or unknown, so clear it and rebuild rather
      // than guess which rows are present (and risk duplicate FTS rows for the ones that are).
      if (jobCount > 0 && ftsCount >= jobCount) {
        setMeta("backfill:fts", "1");
      } else {
        if (ftsCount > 0) console.log(`[fts] search index is incomplete (${ftsCount}/${jobCount}) — rebuilding`);
        db.exec("DELETE FROM jobs_fts");
        cursor = "";
      }
    } else {
      console.log(`[fts] resuming the search-index backfill where it stopped`);
    }
    if (cursor != null && getMeta("backfill:fts") !== "1") {
      const page = db.prepare(
        "SELECT id, title, company, description FROM raw_jobs WHERE id > ? ORDER BY id LIMIT ?",
      );
      let n = 0;
      for (;;) {
        const rows = page.all(cursor, CHUNK) as
          Array<{ id: string; title: string; company: string | null; description: string | null }>;
        if (!rows.length) break;
        db.exec("BEGIN");
        try {
          for (const r of rows) ftsIns.run(r.id, r.title, r.company ?? "", r.description ?? "");
          cursor = rows[rows.length - 1]!.id;
          setMeta("backfill:fts:cursor", cursor);
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        n += rows.length;
        await yieldToLoop();
      }
      setMeta("backfill:fts", "1");
      if (n) console.log(`[fts] backfilled ${n} job(s) into the search index`);
    }
  }

  // 5. Table statistics. Without these SQLite's planner will not USE the covering indexes created
  //    above — measured on a copy of the 1.1GB production DB, adding idx_jobs_facets alone changed
  //    /api/stats by 1.04x (the plan kept the rowid autoindex), while indexes + ANALYZE took the six
  //    hot dashboard queries from 408.8ms to 167.0ms (2.4x), and /api/stats itself 284.7 -> 95.2ms.
  //    Re-run when the table has grown or shrunk enough that the old estimates are misleading.
  const jobRows = (db.prepare("SELECT COUNT(*) c FROM raw_jobs").get() as { c: number }).c;
  const analyzedAt = Number(getMeta("analyze:rows") ?? "-1");
  const stale = analyzedAt < 0 || Math.abs(jobRows - analyzedAt) > Math.max(500, analyzedAt * 0.25);
  if (stale) {
    const t = Date.now();
    db.exec("ANALYZE");
    setMeta("analyze:rows", String(jobRows));
    console.log(`[db] table statistics refreshed in ${Date.now() - t}ms (${jobRows} jobs)`);
  }

  // 6. Taxonomy reconcile — only when the map changed. It issues one UPDATE per signal type and its
  //    own comment says it matters "whenever the taxonomy map changes", but it ran unconditionally on
  //    every boot: 28 statements, 215ms at 30k signals, changing nothing.
  // Key by m.type, NOT by Object.entries(). SIGNAL_TYPE_META is an ARRAY, so entries() yields the
  // indices "0","1","2"… — categoryOf("0") falls through to "other"/rank 10 for all 27 entries, and
  // the stamp came out byte-identical whenever a type's category or evidence_rank changed. Those are
  // precisely the two columns dbReconcileSignalTaxonomy exists to propagate, so the gate could only
  // ever notice a label edit or a change in the number of types.
  const taxonomyStamp = JSON.stringify(SIGNAL_TYPE_META.map((m) => [m.type, categoryOf(m.type), rankOf(m.type), m.label]));
  if (getMeta("taxonomy:stamp") !== taxonomyStamp) {
    const n = dbReconcileSignalTaxonomy();
    setMeta("taxonomy:stamp", taxonomyStamp);
    console.log(`[signals] taxonomy reconciled (${n} row(s) re-labelled)`);
  }
}

// ---- Client config store (UI-editable; YAML seeds it once) ----
export function dbGetAllClientConfigs(): Array<{ name: string; config: string }> {
  return db.prepare("SELECT name, config FROM clients ORDER BY name").all() as Array<{ name: string; config: string }>;
}
export function dbGetClientConfig(name: string): string | null {
  const row = db.prepare("SELECT config FROM clients WHERE name = ?").get(name) as { config: string } | undefined;
  return row?.config ?? null;
}
export function dbClientExists(name: string): boolean {
  return !!db.prepare("SELECT 1 FROM clients WHERE name = ?").get(name);
}
const upsertClient = db.prepare(`
  INSERT INTO clients (name, config, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at
`);
export function dbUpsertClientConfig(name: string, configJson: string): void {
  upsertClient.run(name, configJson);
}
export function dbDeleteClient(name: string): void {
  db.exec("BEGIN"); // atomic: never leave matches orphaned by a partial delete
  try {
    db.prepare("DELETE FROM clients WHERE name = ?").run(name);
    db.prepare("DELETE FROM matches WHERE client = ?").run(name);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
// ---- App settings (key/value) + job retention ----
export interface AppSettings {
  retentionMode: "off" | "hide" | "delete"; // off = keep+show all; hide = filter old from dashboard; delete = purge old
  retentionDays: number;                      // jobs older than this are hidden/deleted (by posted_at, else seen_at)
  webhookBatchSize: number;                   // max signals per webhook POST (0 = unlimited)
  fetchSpeed: "gentle" | "normal" | "aggressive"; // scraping speed dial (scales the adaptive gate; still AIMD-bounded)
  autoShutdown: boolean;                      // true = quit the server shortly after the last dashboard tab closes
  companiesHouseKey: string;                  // UK Companies House API key ("" = the UK-filings signal stays off)
  autoResolveDomains: boolean;                // true = auto-find missing company websites after each fetch
  adCountry: string;                          // Meta Ad Library region: "ALL" (worldwide, default) or one ISO code
}
export const DEFAULT_SETTINGS: AppSettings = { retentionMode: "off", retentionDays: 30, webhookBatchSize: 100, fetchSpeed: "normal", autoShutdown: false, companiesHouseKey: "", autoResolveDomains: true, adCountry: "ALL" };

export function dbGetSettings(): AppSettings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const speed = map.get("fetchSpeed");
  return {
    retentionMode: (map.get("retentionMode") as AppSettings["retentionMode"]) || DEFAULT_SETTINGS.retentionMode,
    retentionDays: Number(map.get("retentionDays") ?? DEFAULT_SETTINGS.retentionDays),
    webhookBatchSize: Number(map.get("webhookBatchSize") ?? DEFAULT_SETTINGS.webhookBatchSize),
    fetchSpeed: (speed === "gentle" || speed === "aggressive") ? speed : "normal",
    autoShutdown: map.get("autoShutdown") === "true",
    companiesHouseKey: map.get("companiesHouseKey") ?? "",
    autoResolveDomains: map.get("autoResolveDomains") !== "false", // default ON
    adCountry: (map.get("adCountry") || "ALL").toUpperCase(),      // default worldwide, not US
  };
}
const setSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
export function dbSaveSettings(s: AppSettings): void {
  setSetting.run("retentionMode", String(s.retentionMode));
  setSetting.run("retentionDays", String(s.retentionDays));
  setSetting.run("webhookBatchSize", String(s.webhookBatchSize));
  setSetting.run("fetchSpeed", String(s.fetchSpeed));
  setSetting.run("autoShutdown", String(s.autoShutdown));
  setSetting.run("companiesHouseKey", s.companiesHouseKey ?? "");
  setSetting.run("autoResolveDomains", String(s.autoResolveDomains));
  setSetting.run("adCountry", (s.adCountry || "ALL").toUpperCase());
}
// Generic meta key/value (reuses the settings table) — e.g. the match-backfill config fingerprint that
// lets boot skip the full match reconcile when no search/watchlist config has changed.
const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
/**
 * One-time repair of rows stored before fixMojibake() existed at ingest.
 *
 * Some feeds serve UTF-8 that has already been decoded as Latin-1 on their side — RemoteOK does, and
 * 19% of everything we had ingested from it showed "Universia PerÃº" where the employer is
 * "Universia Perú". New rows are repaired in normalize.makeJob(); this fixes the history.
 *
 * The SQL pre-filter is only a cheap narrowing (GLOB on the lead-byte range); fixMojibake makes the
 * real decision per row and returns the input unchanged unless the Latin-1 round-trip is provably
 * lossless, so a false positive here costs a no-op UPDATE, never a corrupted name. Gated on a meta
 * key so it runs once rather than re-scanning the widest table on every boot.
 */
function repairStoredMojibake(): void {
  const KEY = "mojibakeRepair.v1";
  if (dbGetSetting(KEY)) return;
  const rows = db.prepare(
    `SELECT id, company, title, location FROM raw_jobs
      WHERE company GLOB '*[Â-ô]*' OR title GLOB '*[Â-ô]*' OR location GLOB '*[Â-ô]*'`,
  ).all() as Array<{ id: string; company: string | null; title: string | null; location: string | null }>;
  const upd = db.prepare("UPDATE raw_jobs SET company = ?, title = ?, location = ? WHERE id = ?");
  let fixed = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const company = fixMojibake(r.company), title = fixMojibake(r.title), location = fixMojibake(r.location);
      if (company === r.company && title === r.title && location === r.location) continue;
      upd.run(company, title, location, r.id); fixed++;
    }
    dbSetSetting(KEY, String(Date.now()));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  if (fixed) console.log(`[jobs] repaired mis-encoded text on ${fixed} row(s)`);
}

// NOT the `meta` table. These read and write `settings` — the same store the Settings screen uses —
// and they were called dbGetMeta/dbSetMeta, sitting a few hundred lines below the private
// getMeta/setMeta that DO use `meta`. Two names one prefix apart, two different tables.
//
// That is a trap with a real consequence, because `meta` is where every one-shot backfill marker
// lives (backfill:domain-rules, backfill:fts, tech:rules, taxonomy:stamp). The next person adding a
// backfill would import the exported, obvious-looking dbSetMeta, write their marker into `settings`
// beside the user's webhook and speed-dial preferences, and it would work — until anything that
// resets or exports settings touched it, at which point a completed migration would silently look
// un-run.
//
// This is not hypothetical: it had already happened twice in this file. `mojibakeRepair.v1` (a
// one-shot text repair) and engine.ts's `matchBackfillFingerprint` both live in `settings`, while
// every other marker of the same kind — backfill:domain-rules, backfill:fts, tech:rules,
// taxonomy:stamp — lives in `meta`. Renamed to say which store it is, so the next one lands
// deliberately rather than by autocomplete. Every KEY is unchanged, so nothing re-migrates.
export function dbGetSetting(key: string): string | null { const r = getSettingStmt.get(key) as { value: string } | undefined; return r ? r.value : null; }
export function dbSetSetting(key: string, value: string): void { setSetting.run(key, value); }

// ---- Account-check cache (per company → its hiring.cafe jobs, with a TTL) ----
/** Return cached jobs for the given normalized keys that are still fresh (within ttlHours). */
export function dbGetAccountCache(keys: string[], ttlHours: number): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  if (!keys.length) return out;
  const ph = keys.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT company_key, jobs_json FROM account_cache
     WHERE company_key IN (${ph}) AND fetched_at >= datetime('now', ?)`,
  ).all(...keys, `-${ttlHours} hours`) as { company_key: string; jobs_json: string }[];
  for (const r of rows) { try { out.set(r.company_key, JSON.parse(r.jobs_json)); } catch { /* skip bad json */ } }
  return out;
}
const upsertAccountCache = db.prepare(
  `INSERT INTO account_cache (company_key, jobs_json, fetched_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(company_key) DO UPDATE SET jobs_json = excluded.jobs_json, fetched_at = excluded.fetched_at`,
);
/** Cache a company's jobs (store [] for not-hiring so we don't re-query it). */
export function dbSetAccountCache(key: string, jobs: unknown[]): void {
  upsertAccountCache.run(key, JSON.stringify(jobs ?? []));
}
/**
 * Evict cache rows past the read TTL. Returns how many went.
 *
 * dbGetAccountCache filters on `fetched_at >= datetime('now', -ttl hours)`, so a row older than that
 * can never be returned again — but nothing ever deleted one. The table only grows, one row per
 * company checked, each holding that company's full job list as JSON.
 *
 * Measured on production before this existed: 5,282 rows, 103.7 MB, every single one already past the
 * 12-hour TTL and therefore unreachable. That is ~10% of the 1,089 MB database file held in rows no
 * code path can read, and it grows with every account check.
 *
 * Evicting on exactly the read clock is the point: a shorter window would throw away rows still in
 * use, a longer one leaves rows nothing can ever read.
 */
export function dbPurgeAccountCache(ttlHours: number): number {
  return Number(db.prepare("DELETE FROM account_cache WHERE fetched_at < datetime('now', ?)")
    .run(`-${Math.max(1, ttlHours)} hours`).changes);
}

// ---- Saved account-check searches (named, searchable, stoppable, exportable) ----
export interface AccountSearchSummary {
  id: string; name: string; status: string;
  total: number; checked: number; found: number; totalHits: number;
  createdAt: string; updatedAt: string;
}
export interface AccountSearchFull extends AccountSearchSummary {
  params: { companies?: string[]; search?: Record<string, unknown>; maxPages?: number };
  hits: unknown[];
  error: string | null;
}

const insertAccountSearch = db.prepare(
  "INSERT INTO account_searches (id, name, params, status, total) VALUES (?, ?, ?, 'running', ?)",
);
/** Create a saved search row (status 'running') the moment a check is kicked off. */
export function dbCreateAccountSearch(id: string, name: string, params: unknown, total: number): void {
  insertAccountSearch.run(id, name, JSON.stringify(params ?? {}), total);
}

const insertAccountHit = db.prepare(
  `INSERT OR IGNORE INTO account_search_hits (search_id, input_company, url, hit) VALUES (?, ?, ?, ?)`,
);
// `found` uses max(): a resumed run rebuilds its counters from scratch and must never revise the
// stored figure downward. total_hits is derived from the rows that actually exist, so the number on
// screen can no longer disagree with the table behind it.
const updateAccountProgress = db.prepare(
  `UPDATE account_searches SET checked = ?, found = max(found, ?),
     total_hits = (SELECT COUNT(*) FROM account_search_hits WHERE search_id = ?),
     updated_at = datetime('now') WHERE id = ?`,
);
/** Persist a progress snapshot mid-run: append only the NEW hits, then refresh the counters.
 *
 *  This used to re-serialise and rewrite the entire cumulative hits array into one TEXT column on
 *  every callback, so a run's write cost was O(domains x hits). The real production row held a
 *  36.3 MB blob at 1,659 of 9,588 domains — meaning it had been rewritten 1,659 times. Replayed
 *  against a real on-disk file with these pragmas: 167.9 s of synchronous time and 25.8 GB written
 *  to store 32 MB of results, freezing the whole dashboard in multi-second bursts throughout
 *  (node:sqlite is synchronous and Node is single-threaded).
 *
 *  Appending also fixes the resume wipe: startAccountRun begins with an empty in-memory array, and
 *  the first progress write used to replace the whole column with it, so anything the first run had
 *  found that the rebuild could not re-find was gone. INSERT OR IGNORE on (search_id, input_company,
 *  url) makes a resume idempotent — re-found hits are no-ops, unfindable ones survive. */
export function dbAccountProgress(
  id: string,
  p: { checked: number; found: number; totalHits?: number; newHits?: unknown[] },
): void {
  // This signature changed from `hits` (the whole cumulative array) to `newHits` (the delta). tsc
  // catches every caller in src/, but .mjs callers are untyped — start-test.mjs kept passing `hits`
  // and silently seeded nothing, which is exactly the kind of quiet miss this change was meant to end.
  if ("hits" in p && !("newHits" in p)) {
    throw new TypeError("dbAccountProgress: `hits` was replaced by `newHits` (pass only the new hits, not the cumulative array)");
  }
  dbTransaction(() => {
    for (const h of (p.newHits ?? []) as Record<string, unknown>[]) {
      insertAccountHit.run(id, String(h?.input_company ?? ""), String(h?.url ?? ""), JSON.stringify(h));
    }
    updateAccountProgress.run(p.checked, p.found, id, id);
  });
}
/** Every hit for a search, oldest first. Kept unpaginated deliberately: the detail view and the CSV
 *  export both expect the whole set, and capping here would trade a slow response for a silently
 *  short one. Paginating it is a UI change, not a storage change. */
/** What this check has actually recorded for one domain, read back from the signals table.
 *
 *  The runner used to count only rows dbInsertSignal newly INSERTED. dedup_key is UNIQUE and the key
 *  is `${checkId}:${producerKey}`, so on a resume every re-found signal collided, returned false, and
 *  was not counted — a resumed check reported 0 for every domain it had already scanned, and then
 *  wrote those zeros over the correct stored numbers. Counting what is in the table is right for a
 *  resume AND for a producer that emits the same dedup key twice inside a single run. */
// ── Webhook delivery health ────────────────────────────────────────────────────────────────────
// Delivery failures used to go to console.warn and NOWHERE else: no row, no status, no timestamp,
// nothing any endpoint exposed. A user whose endpoint had rotated or started 500ing kept seeing a
// static "webhook set" pill and had no way to learn they had stopped being notified. Recorded per
// target so the dashboard can say so.
export interface DeliveryHealth { target: string; ok: boolean; note: string; at: string; failures: number }
export function dbRecordDelivery(target: string, ok: boolean, note = ""): void {
  const key = "deliver:" + target;
  const prev = (() => { try { return JSON.parse(getMeta(key) ?? "null") as DeliveryHealth | null; } catch { return null; } })();
  const failures = ok ? 0 : ((prev && !prev.ok ? prev.failures : 0) + 1);
  setMeta(key, JSON.stringify({ target, ok, note: note.slice(0, 200), at: new Date().toISOString(), failures }));
}
export function dbDeliveryHealth(): DeliveryHealth[] {
  const rows = db.prepare("SELECT k, v FROM meta WHERE k LIKE 'deliver:%'").all() as { k: string; v: string }[];
  const out: DeliveryHealth[] = [];
  for (const r of rows) { try { out.push(JSON.parse(r.v)); } catch { /* skip a corrupt entry */ } }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export interface IndustrySuggestion { name: string; jobs: number }
/**
 * Industries seen on stored jobs, commonest first — the suggestion source for the industry filter.
 *
 * NOT a closed vocabulary, and the UI must not present it as one. hiring.cafe's industry field is
 * open-ended: 841 distinct values across 28,252 stored rows, with a long tail (the top 12 cover half
 * the rows; 264 are needed for 95%). This is what WE happen to have fetched, not what hiring.cafe
 * knows, so the field it feeds accepts free text and these are only hints.
 *
 * CACHED, because the value lives inside each row's raw JSON blob and node:sqlite is synchronous —
 * a slow query here is a frozen dashboard, not a slow response. Measured on the live database: the
 * full aggregation is 232ms, and the autocomplete fires per keystroke. So it is built at most once
 * per TTL and every request after that filters the cached array in memory. (Doing it in JS instead —
 * reading 28,252 blobs and parsing each — measured 470ms and produced an identical 841 values, so
 * SQLite does it in half the time.)
 */
const INDUSTRY_TTL_MS = 10 * 60_000;
let industryCache: { at: number; rows: IndustrySuggestion[] } | null = null;
/** Drop the cached vocabulary. Called when a fetch run ends, because that is exactly when new
 *  industries arrive — without it a freshly-seen industry is unsuggestable for up to the TTL, which
 *  is the same "stale answer presented as current" the TTL is meant to bound, just smaller. */
export function dbIndustriesInvalidate(): void { industryCache = null; }
export function dbIndustries(q = "", limit = 20): { items: IndustrySuggestion[]; matched: number; known: number } {
  if (!industryCache || Date.now() - industryCache.at > INDUSTRY_TTL_MS) {
    // json_type guards the two shapes the field actually takes — an array (the normal case) or a bare
    // string — and yields an empty array for anything else, so a malformed blob is skipped rather
    // than throwing and taking the whole request with it.
    const rows = db.prepare(
      `SELECT je.value AS name, COUNT(*) AS jobs
         FROM raw_jobs,
              json_each(CASE WHEN json_valid(raw) AND json_type(raw, '$.industry') = 'array'
                               THEN json_extract(raw, '$.industry')
                             WHEN json_valid(raw) AND json_type(raw, '$.industry') = 'text'
                               THEN json_array(json_extract(raw, '$.industry'))
                             ELSE json_array() END) je
        WHERE raw IS NOT NULL AND trim(je.value) <> ''
        GROUP BY je.value ORDER BY jobs DESC`).all() as unknown as IndustrySuggestion[];
    industryCache = { at: Date.now(), rows };
  }
  const needle = q.trim().toLowerCase();
  const rows = needle
    ? industryCache.rows.filter((r) => r.name.toLowerCase().includes(needle))
    : industryCache.rows;
  // `matched` is the count BEFORE the slice. Returning the capped length would say "20 industries
  // match" whenever more than 20 do, which is the page-limit defect this codebase keeps finding in
  // other shapes: a truncated read reported as the whole answer.
  return { items: rows.slice(0, Math.max(1, Math.min(50, limit))), matched: rows.length, known: industryCache.rows.length };
}

export interface DeliveryBacklog { owner: string; kind: "matches" | "signals"; n: number; oldest: string | null }
/**
 * What is queued for delivery and how long it has been waiting.
 *
 * Delivery retires anything with no sink — a signal whose type routes nowhere is marked delivered
 * immediately, because the dashboard is then the only destination. So a row still sitting undelivered
 * does NOT mean "no webhook is configured": it means no pass has ever run over it. That is a fault,
 * and it had no way to reach the screen. The dashboard reads the matches and signals tables directly,
 * never the delivered flag, so the app looks completely healthy while a backlog ages.
 *
 * Measured on the live database: 350 signals for a realtime client produced by the paced worker over
 * four hours with no delivery path at all, plus 110 from two one-off checks stuck permanently because
 * the call that would have retired them was guarded on a webhook being configured.
 *
 * Grouped by OWNER (client name, or the check id) because the fix differs per owner, and the operator
 * needs to know which one is stuck, not just that something is.
 */
export function dbDeliveryBacklog(): { owners: DeliveryBacklog[]; total: number } {
  const owners: DeliveryBacklog[] = [];
  for (const r of db.prepare(
    `SELECT COALESCE(client, 'check ' || substr(COALESCE(check_id,'?'), 1, 8)) AS owner,
            COUNT(*) AS n, MIN(created_at) AS oldest
       FROM signals WHERE delivered IS NULL OR delivered = 0
      GROUP BY owner ORDER BY n DESC LIMIT 20`).all() as unknown as Array<{ owner: string; n: number; oldest: string | null }>)
    owners.push({ owner: r.owner, kind: "signals", n: r.n, oldest: r.oldest });
  for (const r of db.prepare(
    `SELECT client AS owner, COUNT(*) AS n, MIN(created_at) AS oldest
       FROM matches WHERE delivered IS NULL OR delivered = 0
      GROUP BY client ORDER BY n DESC LIMIT 20`).all() as unknown as Array<{ owner: string; n: number; oldest: string | null }>)
    owners.push({ owner: r.owner, kind: "matches", n: r.n, oldest: r.oldest });
  // THE TOTAL IS COUNTED, NOT SUMMED FROM THE LIST ABOVE.
  //
  // The owner breakdown is capped at 20 per kind so the card stays readable. The card also shows a
  // headline number, and summing the capped rows to produce it would undercount the moment a 21st
  // owner exists — the exact defect this function was written to expose, reintroduced one level up.
  // Owners are not few: every one-off check with undelivered signals is its own owner, and they
  // accumulate. Two separate queries, so the headline is always the truth and the list is a top-20.
  const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const total = n("SELECT COUNT(*) AS c FROM signals WHERE delivered IS NULL OR delivered = 0")
    + n("SELECT COUNT(*) AS c FROM matches WHERE delivered IS NULL OR delivered = 0");
  return { owners: owners.sort((a, b) => b.n - a.n), total };
}

export function dbSignalsForCheckDomain(checkId: string, domain: string): { count: number; types: string[] } {
  const rows = db.prepare("SELECT DISTINCT type FROM signals WHERE check_id = ? AND domain = ?").all(checkId, domain) as { type: string }[];
  const n = db.prepare("SELECT COUNT(*) c FROM signals WHERE check_id = ? AND domain = ?").get(checkId, domain) as { c: number };
  return { count: n?.c ?? 0, types: rows.map((r) => r.type) };
}

export function dbAccountSearchHits(id: string): unknown[] {
  const rows = db.prepare(`SELECT hit FROM account_search_hits WHERE search_id = ? ORDER BY rowid`).all(id) as { hit: string }[];
  const out: unknown[] = [];
  for (const r of rows) { try { out.push(JSON.parse(r.hit)); } catch { /* skip a corrupt row rather than fail the whole read */ } }
  return out;
}

const finishAccountSearch = db.prepare(
  `UPDATE account_searches SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
);
/** Mark a search done/stopped/error (results were already persisted by dbAccountProgress). */
export function dbFinishAccountSearch(id: string, status: string, error?: string | null): void {
  finishAccountSearch.run(status, error ?? null, id);
}

/** List saved searches (newest first), optionally filtered by a name substring. No heavy payloads. */
export function dbListAccountSearches(q?: string): AccountSearchSummary[] {
  const base = `SELECT id, name, status, total, checked, found, total_hits AS totalHits,
                created_at AS createdAt, updated_at AS updatedAt FROM account_searches`;
  const rows = q
    ? db.prepare(`${base} WHERE name LIKE ? ORDER BY created_at DESC`).all(`%${q}%`)
    : db.prepare(`${base} ORDER BY created_at DESC`).all();
  return rows as unknown as AccountSearchSummary[];
}

/** Full saved search incl. params + the results array (for the detail view + export). */
export function dbGetAccountSearch(id: string): AccountSearchFull | null {
  const r = db.prepare(
    `SELECT id, name, params, status, total, checked, found, total_hits AS totalHits, hits, error,
            created_at AS createdAt, updated_at AS updatedAt FROM account_searches WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const safeJson = (s: unknown, fb: unknown) => { try { return JSON.parse(String(s)); } catch { return fb; } };
  const rowHits = dbAccountSearchHits(id);
  return {
    id: r.id as string, name: r.name as string, status: r.status as string,
    total: r.total as number, checked: r.checked as number, found: r.found as number,
    totalHits: r.totalHits as number, createdAt: r.createdAt as string, updatedAt: r.updatedAt as string,
    params: safeJson(r.params, {}), error: (r.error as string) ?? null,
    // Hits come from account_search_hits now. The legacy blob is still read when that table has
    // nothing for this run, so a row written by an older build still renders. (`?? []` would never
    // fall through — dbAccountSearchHits returns an empty array, not null.)
    hits: rowHits.length ? rowHits : safeJson(r.hits, []),
  };
}

/**
 * Delete an account check and everything hanging off it.
 *
 * Two tables key off the search id — account_search_hits and job_origins ("ac:<id>") — and only the
 * second was being cleaned. Production carried 7,589 orphaned hit rows from one deleted check, 47% of
 * that table, invisible because nothing joins hits back to searches.
 *
 * One transaction, matching dbBulkDeleteJobs and dbPurgeOldJobs. As separate autocommits, anything
 * that interrupted the sequence left a half-deleted check — and this app has demonstrably been killed
 * mid-operation (see reconcileOrphanedRuns).
 */
export function dbDeleteAccountSearch(id: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM account_search_hits WHERE search_id = ?").run(id);
    db.prepare("DELETE FROM job_origins WHERE origin = ?").run("ac:" + id); // attribution tags go; the jobs stay
    db.prepare("DELETE FROM account_searches WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** How many jobs are older than `days` (by posted_at, falling back to seen_at). */
export function dbCountOldJobs(days: number): number {
  const row = db.prepare(
    "SELECT COUNT(*) c FROM raw_jobs WHERE julianday(COALESCE(posted_at, seen_at)) < julianday(datetime('now', ?))",
  ).get(`-${days} days`) as { c: number };
  return row.c;
}
/** Hard-delete jobs older than `days` and their matches. Returns deleted job count.
 *
 *  ONE transaction across all five tables. As five autocommitted statements, anything that
 *  interrupted the sequence (a crash, the auto-quit timer, a power cut) left jobs whose matches,
 *  technologies, origins or FTS rows were already gone — or orphan child rows with no parent.
 *  The id set is also resolved ONCE: each statement re-evaluated `datetime('now', ?)`, so a purge
 *  straddling a day boundary could delete a child row whose parent the last statement then spared. */
export function dbPurgeOldJobs(days: number): number {
  const ids = (db.prepare(
    "SELECT id FROM raw_jobs WHERE julianday(COALESCE(posted_at, seen_at)) < julianday(datetime('now', ?))",
  ).all(`-${days} days`) as { id: string }[]).map((r) => r.id);
  if (!ids.length) return 0;
  let deleted = 0;
  db.exec("BEGIN");
  try {
    // Chunked to stay under SQLite's variable limit (999 by default) on a large purge.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const ph = chunk.map(() => "?").join(",");
      db.prepare(`DELETE FROM matches WHERE job_id IN (${ph})`).run(...chunk);
      db.prepare(`DELETE FROM job_origins WHERE job_id IN (${ph})`).run(...chunk);
      // parity with the single/bulk delete paths — else purged jobs leak orphan tech rows
      db.prepare(`DELETE FROM job_technologies WHERE job_id IN (${ph})`).run(...chunk);
      if (ftsReady) db.prepare(`DELETE FROM jobs_fts WHERE job_id IN (${ph})`).run(...chunk);
      deleted += Number(db.prepare(`DELETE FROM raw_jobs WHERE id IN (${ph})`).run(...chunk).changes);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return deleted;
}

// ---- Reversible "hide old jobs" (per-search or all) ----
// Hiding sets matches.dismissed=1 so the job drops off the dashboard but stays in the DB and
// can be restored. Scope by `client` (one search's tab) or omit for ALL searches.

// Scope a match query to one client, or to a set of clients (a kind/tab), or all. An empty `clients`
// array means "a kind with no clients" → match nothing (1=0), so an All-watchlists view with zero
// watchlists never silently falls through to every client.
export interface MatchScope { client?: string; clients?: string[] }
function scopeClause(s: MatchScope | undefined, col = "client"): { sql: string; params: string[] } {
  if (s?.client) return { sql: ` AND ${col} = ?`, params: [s.client] };
  if (s?.clients) return s.clients.length
    ? { sql: ` AND ${col} IN (${s.clients.map(() => "?").join(",")})`, params: s.clients }
    : { sql: " AND 1 = 0", params: [] };
  return { sql: "", params: [] };
}

/** Count not-yet-hidden matches older than `days` (by posted_at, else seen_at), in scope. */
export function dbCountOldMatches(days: number, scope?: MatchScope): number {
  const sc = scopeClause(scope, "m.client");
  const sql = `SELECT COUNT(*) c FROM matches m JOIN raw_jobs j ON j.id = m.job_id
    WHERE m.dismissed = 0 AND julianday(COALESCE(j.posted_at, j.seen_at)) < julianday(datetime('now', ?))${sc.sql}`;
  return (db.prepare(sql).get(`-${days} days`, ...sc.params) as { c: number }).c;
}
/** Hide matches older than `days` in scope. Returns how many were hidden. */
export function dbHideOldMatches(days: number, scope?: MatchScope): number {
  const sc = scopeClause(scope, "client");
  const sql = `UPDATE matches SET dismissed = 1
    WHERE dismissed = 0 AND job_id IN (SELECT id FROM raw_jobs WHERE julianday(COALESCE(posted_at, seen_at)) < julianday(datetime('now', ?)))${sc.sql}`;
  return Number(db.prepare(sql).run(`-${days} days`, ...sc.params).changes);
}
/** How many hidden matches exist in scope (drives the Restore button). */
export function dbCountHidden(scope?: MatchScope): number {
  const sc = scopeClause(scope, "client");
  return (db.prepare(`SELECT COUNT(*) c FROM matches WHERE dismissed = 1${sc.sql}`).get(...sc.params) as { c: number }).c;
}
/** Hide (reversibly) one job's matches — triage "not interested". Scoped so hiding on a client's tab
 *  only hides it there; the existing Restore brings it back. Returns rows hidden. */
export function dbHideJob(jobId: string, scope?: MatchScope): number {
  const sc = scopeClause(scope, "client");
  return Number(db.prepare(`UPDATE matches SET dismissed = 1 WHERE dismissed = 0 AND job_id = ?${sc.sql}`).run(jobId, ...sc.params).changes);
}
/** Un-hide one job's matches in scope (per-row undo). Returns rows restored. */
export function dbUnhideJob(jobId: string, scope?: MatchScope): number {
  const sc = scopeClause(scope, "client");
  return Number(db.prepare(`UPDATE matches SET dismissed = 0 WHERE dismissed = 1 AND job_id = ?${sc.sql}`).run(jobId, ...sc.params).changes);
}
/** Un-hide every hidden match in scope. Returns how many were restored. */
export function dbRestoreHidden(scope?: MatchScope): number {
  const sc = scopeClause(scope, "client");
  return Number(db.prepare(`UPDATE matches SET dismissed = 0 WHERE dismissed = 1${sc.sql}`).run(...sc.params).changes);
}

/** Purge matches whose client no longer exists (self-heal after deletes/races). */
export function dbPurgeOrphans(): number {
  const m = db.prepare("DELETE FROM matches WHERE client NOT IN (SELECT name FROM clients)").run();
  return Number(m.changes);
}

// ---- Open/Closed lifecycle + domain backfill ----

/** (Re)compute employer domain. Targets rows not yet computed (NULL) and rows that DID resolve
 *  to a domain (non-empty) so an expanded platform denylist corrects them; pure-'' rows are skipped. */
// Bump when extractDomain's rules change, to re-derive every row once. Without this the function
// has no way to roll out a smarter extractor, which is what the old catch-all predicate was really
// for — at the cost of never converging.
// "2": the re-derive below stopped being destructive (see dbBackfillDomains), and extractDomain
// learned multi-label public suffixes plus a dozen missing ATS hosts. Bumping this is now SAFE —
// under version "1" it was not, and the comment above cheerfully invited the next person to do it.
// "3": PLATFORM_HOSTS gained 16 vendors that were only visible AFTER a re-derive (they sat one level
// down, behind an outer platform, so the many-employers-per-host detector could not see them).
// "4": PLATFORM_HOSTS gained nine vendors found by NAME rather than by employer count — a vendor used
// by only one of your companies is invisible to the many-employers detector at any threshold.
const DOMAIN_RULES_VERSION = "4";
/** Fill in raw_jobs.domain from the posting URL. Converges: after the one-shot re-derive it only
 *  visits rows that have never been computed, so a config reload does no work at all.
 *
 *  The old predicate was `WHERE domain IS NULL OR domain <> ''` — which selects the rows that
 *  ALREADY HAVE a domain (3,567 of them in production) and skips the 12,708 whose URL yields
 *  none. It re-ran the same UPDATEs on every boot and every config save, one of the ~600ms
 *  freezes a save used to cause, and it never revisited the empty ones it was named for. */
export function dbBackfillDomains(): number {
  const reDerive = getMeta("backfill:domain-rules") !== DOMAIN_RULES_VERSION;
  const rows = db.prepare(
    reDerive ? "SELECT id, url, domain FROM raw_jobs" : "SELECT id, url, domain FROM raw_jobs WHERE domain IS NULL",
  ).all() as { id: string; url: string; domain: string | null }[];
  if (!rows.length) { if (reDerive) setMeta("backfill:domain-rules", DOMAIN_RULES_VERSION); return 0; }
  // The extra predicate makes `changes` mean "actually differed", so the return value is a real
  // count of corrections rather than a count of rows visited.
  const upd = db.prepare("UPDATE raw_jobs SET domain = ? WHERE id = ? AND (domain IS NULL OR domain <> ?)");
  let changed = 0;
  db.exec("BEGIN");
  try {
    // THE RE-DERIVE MUST NEVER BLANK A DOMAIN IT SIMPLY CANNOT RE-DERIVE.
    //
    // This used to be `extractDomain(r.url) ?? ""` for every row, which assumes the domain always
    // came from the posting URL. It does not: sources/hiringcafe.ts:303 prefers the company's own
    // HOMEPAGE and only falls back to the URL, so ups.com, fedex.com and expeditors.com are stored
    // correctly while their apply links point at an ATS that extractDomain deliberately returns null
    // for. Under the old line, bumping DOMAIN_RULES_VERSION cleared the employer domain on 6,105 of
    // 24,957 rows — and the comment on that constant invites exactly that bump whenever the rules
    // change. A documented procedure that destroys data is worse than an undocumented one.
    //
    // The rule is REPLACE ONLY WHAT IS PROVABLY WRONG. A stored domain is overwritten only when it is
    // NULL (never computed) or fails isPlatformDomain (a shared ATS host, or a bare public suffix left
    // by the old last-two-labels parser). Otherwise it is left exactly as it is.
    //
    // "a fresh derivation always wins" was tried first and was WRONG in the same direction as the old
    // code, just less often. Measured on the 24,957-row snapshot: 1,111 FedEx postings are stored as
    // fedex.com (correct, from the homepage) while their apply URLs live on fedex.paradox.ai — a
    // recruiting-AI vendor. Letting the URL win relabelled all 1,111 as "paradox.ai", i.e. it took
    // correct data and made it wrong. The URL is the WEAKER source here; it only gets to speak when
    // the stored value has disqualified itself.
    for (const r of rows) {
      if (r.domain !== null && !isPlatformDomain(r.domain)) continue;   // trusted as-is
      // "" means "computed, and there is none" — distinct from NULL ("never computed"), which is what
      // the converging predicate above keys on.
      const d = extractDomain(r.url) ?? "";
      changed += Number(upd.run(d, r.id, d).changes);
    }
    if (reDerive) setMeta("backfill:domain-rules", DOMAIN_RULES_VERSION);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return changed;
}

/** Record that a source completed a fetch with no error. The evidence dbSweepClosed requires. */
export function dbRecordSourceFetch(key: string): void {
  if (!key) return;
  db.prepare(
    `INSERT INTO source_fetches (key, last_ok_at) VALUES (?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET last_ok_at = excluded.last_ok_at`,
  ).run(key);
}

/**
 * Mark jobs closed: an explicit expiry has passed, or the source LOOKED AND THE POSTING WAS GONE.
 *
 * The second half used to be "not re-seen in `staleDays`", full stop — a date comparison with no
 * knowledge of whether anything had actually gone looking. That makes "closed" mean two completely
 * different things: the posting was taken down, or nobody fetched. The dashboard renders both as a
 * company that stopped hiring.
 *
 * It was days away from mattering. Measured on the live database on 2026-07-31, with the sweep
 * running on every reload:
 *
 *     2026-08-07:  12,574 jobs would close
 *     2026-08-08:   3,690
 *     2026-08-10:   6,625
 *     2026-08-13:   3,467   — i.e. all 26,356 of them
 *
 * …while "Any funding activity", which carries 16,687 matches (63% of the whole match table), had
 * had exactly ONE successful fetch, on 2026-07-24, and "Companies Using Clay" one on 07-23. Unless
 * those searches happened to run again first, the app would have reported every one of those
 * companies as having stopped hiring, and the cause would have been that it stopped asking.
 *
 * The rule now: a posting closes only when the source that last saw it has since completed a fetch
 * WITHOUT error and did not find it. raw_jobs.origin_key records who saw it (stamped on every
 * sighting, see touchJob) and source_fetches records who has looked since.
 *
 * A job with no origin_key — every row written before this existed, plus anything imported by a
 * script — is never closed by staleness. That is the conservative side on purpose: leaving a dead
 * posting open is a smaller error than reporting a live company as dormant, and such a row starts
 * behaving normally the moment any working source sees it once. The expiry branch is untouched,
 * because an expiry date IS evidence.
 */
export function dbSweepClosed(staleDays = 14): { expired: number; stale: number } {
  const exp = db.prepare(
    "UPDATE raw_jobs SET status='closed', closed_at=datetime('now') WHERE status='open' AND expires_at IS NOT NULL AND expires_at < datetime('now')",
  ).run();
  const stale = db.prepare(
    `UPDATE raw_jobs SET status='closed', closed_at=datetime('now')
      WHERE status='open'
        AND last_seen_at IS NOT NULL
        AND last_seen_at < datetime('now', ?)
        AND origin_key IS NOT NULL
        AND EXISTS (SELECT 1 FROM source_fetches f
                     WHERE f.key = raw_jobs.origin_key
                       AND f.last_ok_at > raw_jobs.last_seen_at)`,
  ).run(`-${staleDays} days`);
  return { expired: Number(exp.changes), stale: Number(stale.changes) };
}

/** Jobs the sweep is deliberately NOT closing because nothing has looked for them. Surfaced in the
 *  System panel so "we have not checked in a while" is visible rather than silently indistinguishable
 *  from "nothing has changed". */
export function dbUnverifiedStale(staleDays = 14): Array<{ originKey: string | null; jobs: number; lastSeen: string }> {
  return db.prepare(
    `SELECT COALESCE(origin_key, '(unknown source)') AS originKey, COUNT(*) AS jobs, MAX(last_seen_at) AS lastSeen
       FROM raw_jobs
      WHERE status='open' AND last_seen_at IS NOT NULL AND last_seen_at < datetime('now', ?)
        AND (origin_key IS NULL
             OR NOT EXISTS (SELECT 1 FROM source_fetches f
                             WHERE f.key = raw_jobs.origin_key AND f.last_ok_at > raw_jobs.last_seen_at))
      GROUP BY originKey ORDER BY jobs DESC`,
  ).all(`-${staleDays} days`) as Array<{ originKey: string | null; jobs: number; lastSeen: string }>;
}

/** Counts for the dashboard status filter (open vs closed across visible matches in scope). */
export function dbStatusCounts(client?: string, clients?: string[]): { open: number; closed: number } {
  let w = "", p: string[] = [];
  if (client) { w = "AND m.client = ?"; p = [client]; }
  else if (clients) { w = "AND m.client IN (" + (clients.length ? clients.map(() => "?").join(",") : "?") + ")"; p = clients.length ? clients : [""]; }
  const row = db.prepare(
    `SELECT SUM(CASE WHEN j.status='open' THEN 1 ELSE 0 END) o, SUM(CASE WHEN j.status='closed' THEN 1 ELSE 0 END) c
     FROM matches m JOIN raw_jobs j ON j.id=m.job_id WHERE m.dismissed=0 ${w}`).get(...p) as { o: number; c: number };
  return { open: row.o ?? 0, closed: row.c ?? 0 };
}
/** Rename a client across config + matches (keeps its history). Atomic: a crash mid-rename must not
 * leave both old+new client rows, or the clients row renamed while its matches are not. */
export function dbRenameClient(oldName: string, newName: string, configJson: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO clients (name, config, updated_at) VALUES (?, ?, datetime('now'))").run(newName, configJson);
    db.prepare("DELETE FROM clients WHERE name = ?").run(oldName);
    db.prepare("UPDATE matches SET client = ? WHERE client = ?").run(newName, oldName);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

const insertJob = db.prepare(`
  INSERT OR IGNORE INTO raw_jobs
    (id, source, external_id, title, company, location, state, country, remote, url, posted_at, domain, expires_at, last_seen_at, status, raw, dedup_key, description, comp_max, currency)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, json_extract(?, '$.comp_max'), json_extract(?, '$.currency'))
`);
// Is the same posting already stored under a DIFFERENT row (another source/board with the same
// canonical key)? If so we refresh that row instead of inserting a duplicate.
const findByDedup = db.prepare("SELECT id, status FROM raw_jobs WHERE dedup_key = ? AND id <> ? LIMIT 1");
// Re-sighting an existing job: bump last_seen_at and re-open it (it's still listed).
// origin_key rides along on the re-sighting, and the WHERE gains a clause for it: without that, the
// one-hour throttle below would skip the update entirely and a job re-seen by a DIFFERENT source
// would keep pointing at the old one — so the sweep would ask the wrong source whether it looked.
const touchJob = db.prepare(`
  UPDATE raw_jobs SET last_seen_at = datetime('now'), status = 'open', closed_at = NULL,
                      origin_key = COALESCE(?, origin_key)
  WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 hour')
                    OR status = 'closed' OR (? IS NOT NULL AND origin_key IS NOT ?))
`);
// Re-sighting a job the source still reports as CLOSED (e.g. hiring.cafe is_expired): keep it closed.
const touchClosed = db.prepare(`
  UPDATE raw_jobs SET last_seen_at = datetime('now'), status = 'closed',
                      closed_at = COALESCE(closed_at, datetime('now')), origin_key = COALESCE(?, origin_key)
  WHERE id = ?
`);

// ---- ATS board discovery cache (domain → which Greenhouse/Lever/Ashby boards it publishes) ----
// Positive results re-verify after ~24h; negative (no board found) results are trusted ~7 days so we
// don't re-probe a domain that has no ATS on every fetch.
const ATS_POS_TTL_DAYS = 1;   // a live board is re-verified daily
const ATS_NEG_TTL_DAYS = 7;   // a vendor that has never heard of this company is unlikely to change
export interface AtsBoardRow { domain: string; vendor: string; slug: string | null; found: number }
const atsRows = db.prepare(
  `SELECT domain, vendor, slug, found, checked_at AS checkedAt FROM ats_boards WHERE domain = ?`);
const atsUpsert = db.prepare(
  `INSERT INTO ats_boards (domain, vendor, slug, found, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
   ON CONFLICT(domain, vendor) DO UPDATE SET slug = excluded.slug, found = excluded.found, checked_at = excluded.checked_at`);
/** Cached board rows for a domain that are still within TTL (empty → needs a fresh probe).
 *
 *  Freshness is a property of the DOMAIN, not of each row, because dbSaveAtsProbe writes the whole
 *  set — the hit and the six negative markers — in one call with one timestamp. Judging each row
 *  separately meant that from 24h to 7d after a probe the positive had expired while the negatives
 *  had not: the caller saw a non-empty cache, filtered it down to the (now missing) found rows, and
 *  concluded the company had no board. A discovered board was therefore actually fetched roughly one
 *  day in seven, and the day-7 re-probe restamped everything so the cycle repeated forever. */
export function dbGetAtsBoards(domain: string): AtsBoardRow[] {
  const rows = atsRows.all(domain) as unknown as Array<AtsBoardRow & { checkedAt: string }>;
  if (!rows.length) return [];
  const ttlDays = rows.some((r) => r.found === 1) ? ATS_POS_TTL_DAYS : ATS_NEG_TTL_DAYS;
  // SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC.
  const newest = Math.max(...rows.map((r) => Date.parse(String(r.checkedAt).replace(" ", "T") + "Z")));
  if (!Number.isFinite(newest) || Date.now() - newest > ttlDays * 86400e3) return [];
  return rows.map(({ checkedAt: _drop, ...r }) => r);
}
/**
 * Persist a probe result set: the found boards, plus negative markers for the vendors that were
 * ACTUALLY CONTACTED and returned nothing.
 *
 * `probed` is required rather than defaulted to "all vendors" precisely because that default was the
 * bug. Discovery runs the four non-US vendors only when the three US ones find nothing, so a domain
 * with a Greenhouse board never has Workable, Personio, Recruitee or SmartRecruiters contacted — yet
 * all four were being written as found=0, and dbGetAtsBoards then reports the whole domain as freshly
 * checked. Two harms: the cache answers "not on Workable" about a request never sent, and a genuine
 * negative gets its timestamp rewritten to "just now" every re-probe, so it never ages out into a
 * real check. Recording only what was asked keeps the domain's rows consistently stamped, which is
 * what dbGetAtsBoards's whole-domain freshness rule above depends on.
 */
/** Record one domain's ATS probe: a row per vendor, hit or miss. ONE transaction — as 7-14
 *  autocommits it was an fsync per row (measured 3.7x slower over 500 domains), against this
 *  file's own pattern everywhere else. It also makes the probe atomic: a half-written probe used
 *  to leave some vendors recorded and others not, which reads as "we checked and it wasn't there". */
export function dbSaveAtsProbe(domain: string, found: Array<{ vendor: string; slug: string }>, probed: readonly string[]): void {
  const hitV = new Set(found.map((f) => f.vendor));
  db.exec("BEGIN");
  try {
    for (const f of found) atsUpsert.run(domain, f.vendor, f.slug, 1);
    for (const v of probed) if (!hitV.has(v)) atsUpsert.run(domain, v, null, 0);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// ---- Phase 21: board quarantine + manual allow-list ----
// ats_quarantine: (domain, vendor, slug) boards confirmed to belong to a DIFFERENT company than the
// domain they were attributed to (onyx.security → ashby:onyx is onyx.app's board). A quarantined board
// is never probed, fetched or accepted for that domain, and any job tied to it — by source tag,
// hiring.cafe's raw.ats hint or its apply URL — is dropped at ingest, whichever lane delivered it.
// ats_board_overrides: hand-confirmed boards that must survive strict re-verification.
// ats_quarantine_closed: which raw_jobs rows the quarantine closed, so it can be audited or undone.
// All three start EMPTY; scripts/phase21-quarantine.mts seeds them. Slugs are stored lowercased.
db.exec(`
  CREATE TABLE IF NOT EXISTS ats_quarantine (
    domain TEXT NOT NULL, vendor TEXT NOT NULL, slug TEXT NOT NULL,
    reason TEXT, created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (domain, vendor, slug)
  );
  CREATE TABLE IF NOT EXISTS ats_board_overrides (
    domain TEXT NOT NULL, vendor TEXT NOT NULL, slug TEXT NOT NULL,
    note TEXT, created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (domain, vendor, slug)
  );
  CREATE TABLE IF NOT EXISTS ats_quarantine_closed (
    job_id TEXT PRIMARY KEY, domain TEXT NOT NULL, vendor TEXT NOT NULL, slug TEXT NOT NULL,
    prior_status TEXT, closed_at TEXT DEFAULT (datetime('now'))
  );
`);
type BoardKey = { domain: string; vendor: string; slug: string };
const boardKey = (domain: string, vendor: string, slug: string) =>
  `${String(domain ?? "").trim().toLowerCase()}|${String(vendor ?? "").toLowerCase()}|${String(slug ?? "").trim().toLowerCase()}`;
// Read on every probe and every ingested job, so cached in memory. Reloaded after a local write and at
// most every 60s otherwise, so a quarantine applied by another process reaches a long-running server.
let boardListCache: { at: number; quarantine: Set<string>; overrides: Map<string, BoardKey[]> } | null = null;
function boardLists() {
  if (!boardListCache || Date.now() - boardListCache.at > 60_000) {
    const q = db.prepare("SELECT domain, vendor, slug FROM ats_quarantine").all() as unknown as BoardKey[];
    const o = db.prepare("SELECT domain, vendor, slug FROM ats_board_overrides").all() as unknown as BoardKey[];
    const overrides = new Map<string, BoardKey[]>();
    for (const r of o) {
      const d = r.domain.toLowerCase();
      overrides.set(d, [...(overrides.get(d) ?? []), { domain: d, vendor: r.vendor, slug: r.slug }]);
    }
    boardListCache = { at: Date.now(), quarantine: new Set(q.map((r) => boardKey(r.domain, r.vendor, r.slug))), overrides };
  }
  return boardListCache;
}
export function dbIsBoardQuarantined(domain: string, vendor: string, slug: string): boolean {
  return boardLists().quarantine.has(boardKey(domain, vendor, slug));
}
export function dbIsBoardOverridden(domain: string, vendor: string, slug: string): boolean {
  const k = boardKey(domain, vendor, slug);
  return (boardLists().overrides.get(String(domain ?? "").trim().toLowerCase()) ?? [])
    .some((o) => boardKey(o.domain, o.vendor, o.slug) === k);
}
export function dbOverridesForDomain(domain: string): BoardKey[] {
  return boardLists().overrides.get(String(domain ?? "").trim().toLowerCase()) ?? [];
}
export function dbQuarantineBoard(domain: string, vendor: string, slug: string, reason: string): void {
  db.prepare("INSERT OR REPLACE INTO ats_quarantine (domain, vendor, slug, reason) VALUES (?, ?, ?, ?)")
    .run(domain.trim().toLowerCase(), vendor.toLowerCase(), slug.trim().toLowerCase(), reason);
  // A cached positive for this exact board is withdrawn, so discovery stops handing it out.
  db.prepare("UPDATE ats_boards SET found = 0, slug = NULL WHERE domain = ? AND vendor = ? AND lower(slug) = ?")
    .run(domain.trim().toLowerCase(), vendor.toLowerCase(), slug.trim().toLowerCase());
  boardListCache = null;
}
export function dbAddBoardOverride(domain: string, vendor: string, slug: string, note: string): void {
  db.prepare("INSERT OR REPLACE INTO ats_board_overrides (domain, vendor, slug, note) VALUES (?, ?, ?, ?)")
    .run(domain.trim().toLowerCase(), vendor.toLowerCase(), slug.trim().toLowerCase(), note);
  boardListCache = null;
}
/** Close raw_jobs rows a quarantine covers, recording each so the step is auditable and reversible. */
export function dbCloseQuarantinedJobs(rows: Array<{ id: string; status: string | null }>, board: BoardKey): number {
  if (!rows.length) return 0;
  const log = db.prepare("INSERT OR IGNORE INTO ats_quarantine_closed (job_id, domain, vendor, slug, prior_status) VALUES (?, ?, ?, ?, ?)");
  const close = db.prepare("UPDATE raw_jobs SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status = 'open'");
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      log.run(r.id, board.domain.toLowerCase(), board.vendor.toLowerCase(), board.slug.toLowerCase(), r.status ?? null);
      n += Number(close.run(r.id).changes);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
}

// Fast id-existence probe for the scrapers' incremental early-stop (a page of already-stored jobs
// on a newest-first listing means everything deeper is stored too — stop paginating).
const jobKnownStmt = db.prepare("SELECT 1 FROM raw_jobs WHERE id = ?");
export function dbJobKnown(id: string): boolean {
  return jobKnownStmt.get(id) !== undefined;
}

/**
 * STORED IS NOT THE SAME AS LEARNED, AND THE EARLY STOP CANNOT TELL THE DIFFERENCE.
 *
 * An /org/<domain> scan is the one source that knows an employer's domain for certain — it asked for
 * that domain by name. When it re-sights a job, learnDomain fills a blank domain on the stored row.
 * The incremental early stop then makes sure that never happens: it halts at the first page whose
 * jobs are all already stored, and a job stored WITHOUT a domain is "already stored". So the pages
 * holding the rows that need teaching are exactly the pages the scan refuses to read.
 *
 * Measured in production: 7,189 hcorg rows — 40% of everything that source has ever collected, across
 * 351 employers including iHeartMedia (631) and Nexstar (600) — carry no domain. They cannot be
 * recovered from what is stored: 6,976 of them belong to a company that has no domain on any other
 * row either. dbBackfillDomains cannot reach them, because it only revisits domain IS NULL and these
 * are empty string, which means "computed, and the URL yielded nothing" — true, and permanent.
 *
 * So the org path treats a stored-but-unattributed job as NOT known. The scan keeps paginating until
 * it has taught every page it can, and once a company is fully attributed the early stop resumes
 * exactly as before. The cost is one deeper scan per affected company, once; the alternative is rows
 * that stay unattributed forever.
 */
const jobAttributedStmt = db.prepare("SELECT 1 FROM raw_jobs WHERE id = ? AND domain IS NOT NULL AND domain <> ''");
export function dbJobKnownAndAttributed(id: string): boolean {
  return jobAttributedStmt.get(id) !== undefined;
}

// ---- Fetch-run history + health (the System panel) ----
const insRun = db.prepare("INSERT INTO fetch_runs (fetch_key, client, kind) VALUES (?, ?, ?)");
const finRun = db.prepare("UPDATE fetch_runs SET finished_at = datetime('now'), fetched = ?, fresh = ?, matched = ?, error = ?, warnings = ? WHERE id = ?");
/** Open a run row; returns its id to close with dbFinishRun. */
export function dbStartRun(fetchKey: string, client: string, kind: string): number {
  return Number(insRun.run(fetchKey, client, kind).lastInsertRowid);
}
export function dbFinishRun(
  id: number,
  r: { fetched: number; fresh: number; matched: number; error?: string | null; warnings?: string[] },
): void {
  finRun.run(r.fetched, r.fresh, r.matched, r.error ?? null,
    r.warnings?.length ? JSON.stringify(r.warnings.slice(0, 50)) : null, id);
  // New jobs mean possible new industries, and this is the moment they land. Rebuilding the
  // suggestion vocabulary lazily on the next request costs one query; leaving it stale means an
  // industry we just fetched cannot be suggested for another ten minutes.
  dbIndustriesInvalidate();
}
export function dbListRuns(limit = 15, offset = 0, sort = "started_at", dir: "asc" | "desc" = "desc"): { total: number; items: Array<Record<string, unknown>> } {
  const SORTS: Record<string, string> = sortMap({
    started_at: "started_at", client: "LOWER(client)", fetched: "fetched", fresh: "fresh", matched: "matched",
    // The three columns the Fetch history showed but would not sort by. `took` is the computed run
    // duration — "which fetches are slow?" is the whole reason to look at this table — and `result`
    // sorts failures to one end, which beats hunting for red text down a long list.
    type: "LOWER(kind)",
    took: "(julianday(COALESCE(finished_at, datetime('now'))) - julianday(started_at))",
    result: "CASE WHEN error IS NOT NULL AND error <> '' THEN 0 WHEN finished_at IS NULL THEN 1 ELSE 2 END",
  });
  const col = SORTS[sort] ?? "started_at"; const d = dir === "asc" ? "ASC" : "DESC";
  const total = (db.prepare("SELECT COUNT(*) c FROM fetch_runs").get() as { c: number }).c;
  const items = db.prepare(
    `SELECT id, fetch_key AS fetchKey, client, kind, started_at AS startedAt, finished_at AS finishedAt,
            fetched, fresh, matched, error, warnings,
            CAST((julianday(COALESCE(finished_at, datetime('now'))) - julianday(started_at)) * 86400 AS INTEGER) AS durationSec
     FROM fetch_runs ORDER BY ${col} ${d}, id DESC LIMIT ${Math.min(limit, 200)} OFFSET ${Math.max(offset, 0)}`,
  ).all() as Array<Record<string, unknown>>;
  return { total, items };
}
/** Prune run history older than N days (daily maintenance). */
export function dbPurgeRuns(days: number): number {
  return Number(db.prepare("DELETE FROM fetch_runs WHERE started_at < datetime('now', ?)").run(`-${days} days`).changes);
}
/** DB + content stats for the System health strip. */
export function dbHealth(): Record<string, unknown> {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const pragma = (name: string) => { const r = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>; return Number(Object.values(r)[0] ?? 0); };
  let dbBytes = 0, walBytes = 0;
  try {
    dbBytes = pragma("page_count") * pragma("page_size");
    walBytes = statSize(DB_PATH + "-wal");
  } catch { /* best-effort */ }
  return {
    jobs: one("SELECT COUNT(*) c FROM raw_jobs"),
    matches: one("SELECT COUNT(*) c FROM matches WHERE dismissed = 0"),
    starred: one("SELECT COUNT(*) c FROM raw_jobs WHERE starred = 1"),
    clients: one("SELECT COUNT(*) c FROM clients"),
    accountChecks: one("SELECT COUNT(*) c FROM account_searches"),
    atsBoards: one("SELECT COUNT(*) c FROM ats_boards WHERE found = 1"),
    runs: one("SELECT COUNT(*) c FROM fetch_runs"),
    dbBytes, walBytes,
  };
}

// ---- Technologies: dictionary lookup + per-job detections ----
/** Typeahead over the dictionary (by popularity), for the filter picker. */
export function dbTechSearch(q: string, limit = 20): Array<{ id: number; name: string; category: string | null; companies: number; jobs: number }> {
  const like = `%${q}%`;
  return db.prepare(
    `SELECT id, name, category, companies_count AS companies, jobs_count AS jobs FROM technologies WHERE name LIKE ? ORDER BY (LOWER(name) = LOWER(?)) DESC, companies_count DESC, name ASC LIMIT ?`,
  ).all(like, q, Math.min(limit, 50)) as Array<{ id: number; name: string; category: string | null; companies: number; jobs: number }>;
}
/** Names of the technologies detected on one job (for the detail drawer). */
export function dbJobTechnologies(jobId: string): string[] {
  return (db.prepare(
    `SELECT t.name FROM job_technologies jt JOIN technologies t ON t.id = jt.tech_id WHERE jt.job_id = ? ORDER BY t.companies_count DESC, t.name`,
  ).all(jobId) as Array<{ name: string }>).map((r) => r.name);
}
/** Most-mentioned technologies across matches in scope (the leaderboard). */
export function dbTechLeaderboard(scope: { client?: string; clients?: string[] }, limit = 20): Array<{ name: string; category: string | null; jobs: number }> {
  let w = "m.dismissed = 0"; const p: (string | number | null)[] = [];
  if (scope.client) { w += " AND m.client = ?"; p.push(scope.client); }
  else if (scope.clients) { if (!scope.clients.length) w += " AND 1=0"; else { w += " AND m.client IN (" + scope.clients.map(() => "?").join(",") + ")"; for (const c of scope.clients) p.push(c); } }
  p.push(Math.min(limit, 100));
  return db.prepare(
    `SELECT t.name, t.category, COUNT(DISTINCT jt.job_id) AS jobs
     FROM job_technologies jt
     JOIN technologies t ON t.id = jt.tech_id
     JOIN matches m ON m.job_id = jt.job_id
     WHERE ${w}
     GROUP BY t.id ORDER BY jobs DESC, t.companies_count DESC LIMIT ?`,
  ).all(...p) as Array<{ name: string; category: string | null; jobs: number }>;
}
export function dbTechCount(): number {
  return (db.prepare("SELECT COUNT(*) c FROM technologies").get() as { c: number }).c;
}
/** Browse the dictionary — most-adopted first (for the Technologies view's default listing, no query). */
/** Sortable columns for the Technologies list. Server-side, so a sort covers all 29k rows rather
 *  than reordering the page you happen to be on. Text folds case-insensitively via jslower. */
const TECH_SORTS: Record<string, string> = sortMap({
  name: "jslower(name)", category: "jslower(COALESCE(category,''))",
  // companies_count and jobs_count are the SOURCE DICTIONARY's worldwide figures — TheirStack's view
  // of how many companies and job posts mention each technology globally. They say nothing about this
  // database: 18,067 of 29,334 rows disagree with the local tag count, and not by a little. Microsoft
  // PowerPoint claims 6,200,000 jobs where 207 stored postings mention it; Python 6,000,000 vs 2,268;
  // AWS 3,900,000 vs 51.
  //
  // Sorting by them is legitimate — "what is big in the market" is a real question — but the keys have
  // to say which question they answer, because "jobs" next to a list of the user's own jobs reads as
  // the local count and is off by four orders of magnitude. The old `jobs` key is kept as an alias so
  // an existing bookmark or saved view does not break.
  marketCompanies: "companies_count", marketJobs: "jobs_count",
  companies: "companies_count", jobs: "jobs_count",
  // …and the LOCAL count, which is what the list is actually about and could not be sorted by at all.
  localJobs: "(SELECT COUNT(*) FROM job_technologies jt WHERE jt.tech_id = technologies.id)",
});
export interface TechListRow {
  id: number; name: string; category: string | null;
  /** The SOURCE dictionary's WORLDWIDE figures, not this database's. See TECH_SORTS. */
  companies: number; jobs: number;
  /** How many stored postings actually mention it. */
  localJobs: number;
}
export function dbTechList(limit = 100, offset = 0, sort?: string, dir?: string): { total: number; items: TechListRow[] } {
  const total = dbTechCount();
  const col = (sort && TECH_SORTS[sort]) || null;
  const d = dir === "asc" ? "ASC" : "DESC";
  // id is the unique tiebreaker so paging can't repeat or skip a row (see queryMatches).
  const order = col ? `${col} ${d}, id ASC` : "companies_count DESC, jobs_count DESC, jslower(name) ASC, id ASC";
  const items = db.prepare(
    `SELECT id, name, category, companies_count AS companies, jobs_count AS jobs,
            (SELECT COUNT(*) FROM job_technologies jt WHERE jt.tech_id = technologies.id) AS localJobs
     FROM technologies ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(Math.min(limit, 500), Math.max(offset, 0)) as unknown as TechListRow[];
  return { total, items };
}

// ───────────────────────── Signals: generic sales-signal store + snapshot state ─────────────────────────
export interface SignalRow {
  dedupKey: string; domain: string; company?: string | null; type: string; title: string;
  detail?: unknown; url?: string | null; client?: string | null; checkId?: string | null; observedAt?: string | null;
}
const insSignal = db.prepare(`
  INSERT INTO signals (dedup_key, domain, company, type, category, evidence_rank, title, detail, url, client, check_id, observed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(dedup_key) DO NOTHING
`);
/** Record a signal. Idempotent by dedup_key — returns true only when the signal is NEW.
 *  category/evidence_rank are denormalized from the taxonomy at write time (and re-synced at boot). */
export function dbInsertSignal(s: SignalRow): boolean {
  const r = insSignal.run(
    s.dedupKey, s.domain, s.company ?? null, s.type, categoryOf(s.type), rankOf(s.type), s.title,
    s.detail == null ? null : JSON.stringify(s.detail), s.url ?? null,
    s.client ?? null, s.checkId ?? null, s.observedAt ?? null,
  );
  return Number(r.changes) > 0;
}
/** Re-sync signals.category / signals.evidence_rank from src/signals/taxonomy.ts. Idempotent and
 *  cheap (one indexed UPDATE per known type), run at boot — so editing the type→category map
 *  re-labels ALL history, and a type the map no longer knows falls back to the "other" category
 *  instead of rendering uncoloured. Hoisted: the migration block above calls it. */
export function dbReconcileSignalTaxonomy(): number {
  const upd = db.prepare(
    "UPDATE signals SET category = ?, evidence_rank = ? WHERE type = ? AND (category <> ? OR evidence_rank <> ?)");
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const m of SIGNAL_TYPE_META) n += Number(upd.run(m.category, m.rank, m.type, m.category, m.rank).changes);
    const ph = SIGNAL_TYPE_META.map(() => "?").join(",");
    n += Number(db.prepare(
      `UPDATE signals SET category = 'other', evidence_rank = ${RANK_UNKNOWN}
        WHERE type NOT IN (${ph}) AND (category <> 'other' OR evidence_rank <> ${RANK_UNKNOWN})`,
    ).run(...SIGNAL_TYPE_META.map((m) => m.type)).changes);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  if (n) console.log(`[signals] taxonomy reconcile updated ${n} row(s)`);
  return n;
}
// The best-known event date for a signal: when the underlying event actually happened (observed_at,
// e.g. a funding filing date) falling back to when we recorded it. Used for every date-range query so
// "funded in the past year" means the FUNDING date, not the scan date.
const SIGNAL_EVENT_DATE = "COALESCE(observed_at, created_at)";
export interface SignalFilter {
  client?: string; clients?: string[]; checkId?: string; types?: string[]; categories?: string[]; q?: string;
  domain?: string;          // exact-domain scope (per-company history lookups)
  since?: string; until?: string; // event-date range (ISO/date strings), inclusive
  history?: boolean;        // include dismissed signals — a dismissed signal must stay in the record
  collapse?: boolean;       // merge the same real-world event reported by several sources into one row
  sort?: string; dir?: string; // column sort (validated against SIGNAL_SORTS) — server-side, whole set
  limit?: number; offset?: number;
}
/** Sortable columns for the Signals feed. Applied server-side so a sort covers every signal in
 *  scope, not just the rows currently on screen. `signal` sorts by the human label's lifecycle-ish
 *  grouping (category, then type) rather than the raw key, which is meaningless to read. */
const SIGNAL_SORTS: Record<string, string> = sortMap({
  when: SIGNAL_EVENT_DATE, company: "jslower(COALESCE(company, domain, ''))",
  signal: "category || '|' || type", what: "jslower(title)", monitor: "jslower(COALESCE(client,''))",
});
/** Paginated signal list. Scope by watchlist client(s)/check, filter by type/text/domain, and — for
 * historical reference ("was this company funded in the past year?") — by an event-date range and
 * whether to include dismissed rows. Ordered by event date when a range is set, else newest-recorded. */
/** Fall back to the company name we already know for a domain when the signal itself carries none.
 *  Velocity (and any other producer derived from our own data rather than a named third-party
 *  record) never sets `company`, so those rows showed a bare domain with an empty Company cell
 *  while every other type showed the name. Same lookup dbListCurrentSignals already uses:
 *  the manual/auto domain override first, then the most-seen employer name on that domain. */
const SIGNAL_COMPANY_SQL = `COALESCE(company,
      (SELECT cd.company FROM company_domains cd WHERE cd.domain = signals.domain LIMIT 1),
      (SELECT j.company FROM raw_jobs j WHERE j.domain = signals.domain AND j.company IS NOT NULL AND j.company <> '' LIMIT 1))`;
export function dbListSignals(f: SignalFilter): { total: number; items: Array<Record<string, unknown>> } {
  const w: string[] = []; const p: (string | number)[] = [];
  if (!f.history) w.push("dismissed = 0"); // default feed hides dismissed; history mode keeps them
  if (f.client) { w.push("client = ?"); p.push(f.client); }
  else if (f.clients) { if (!f.clients.length) w.push("1=0"); else { w.push(`client IN (${f.clients.map(() => "?").join(",")})`); p.push(...f.clients); } }
  if (f.checkId) { w.push("check_id = ?"); p.push(f.checkId); }
  if (f.domain) { w.push("domain = ?"); p.push(f.domain); }
  if (f.types?.length) { w.push(`type IN (${f.types.map(() => "?").join(",")})`); p.push(...f.types); }
  if (f.categories?.length) { w.push(`category IN (${f.categories.map(() => "?").join(",")})`); p.push(...f.categories); }
  if (f.q) { w.push("(company LIKE ? OR domain LIKE ? OR title LIKE ?)"); const like = `%${f.q}%`; p.push(like, like, like); }
  // Compare on the DATE (not the raw timestamp): the event date is a mix of date-only strings
  // (observed_at from filings) and full timestamps (created_at fallback, "YYYY-MM-DD HH:MM:SS"), so a
  // raw `<= until` wrongly drops same-day-as-until rows that carry a time component. date() normalizes
  // both sides so an inclusive day range means what a user expects ("through <until>").
  if (f.since) { w.push(`date(${SIGNAL_EVENT_DATE}) >= date(?)`); p.push(f.since); }
  if (f.until) { w.push(`date(${SIGNAL_EVENT_DATE}) <= date(?)`); p.push(f.until); }
  const clause = w.length ? `WHERE ${w.join(" AND ")}` : "";
  const lim = Math.min(f.limit ?? 15, 200), off = Math.max(f.offset ?? 0, 0);
  if (f.collapse) return collapsedSignals(clause, p, f, lim, off);
  const order = signalOrder(f, "");
  const total = (db.prepare(`SELECT COUNT(*) c FROM signals ${clause}`).get(...p) as { c: number }).c;
  const items = db.prepare(
    // evidenceRank must appear in BOTH projections. dbListSignals has two query paths — this
    // uncollapsed one and the windowed collapse below — and adding a column to only one gives the
    // caller a field that is present or undefined depending on a setting it never asked about. The
    // signals CSV reads it; with it missing here every row exported as rank 0.
    `SELECT id, domain, ${SIGNAL_COMPANY_SQL} AS company, type, category, evidence_rank AS evidenceRank, title, detail, url, client, check_id AS checkId, observed_at AS observedAt, created_at AS createdAt
     FROM signals ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(...p, lim, off) as Array<Record<string, unknown>>;
  for (const it of items) { it.groupCount = 1; it.sources = []; } // same shape as the collapsed path
  return { total, items };
}
/** ORDER BY for both signal paths. An explicit column sort wins; otherwise event date when a date
 *  range is set, else newest-recorded. `prefix` is the collapsed path's column qualifier, which
 *  reads the group's newest event so a group led by an older filing doesn't sink. id always last. */
function signalOrder(f: SignalFilter, prefix: "" | "collapsed"): string {
  const d = f.dir === "asc" ? "ASC" : "DESC";
  const col = f.sort && SIGNAL_SORTS[f.sort];
  if (col) return `${col} ${d}, id DESC`;
  if (prefix === "collapsed") return (f.since || f.until) ? "group_jd DESC, id DESC" : "group_created DESC, id DESC";
  return (f.since || f.until) ? `${SIGNAL_EVENT_DATE} DESC, id DESC` : "created_at DESC, id DESC";
}
/** One row per real-world EVENT instead of per report: a raise found in an SEC filing, a UK filing
 *  and two articles is ONE thing to a salesperson. Gaps-and-islands — a new cluster starts whenever
 *  the gap to the previous event in the same (domain, collapse group) exceeds that group's window,
 *  so two raises months apart stay separate. The strongest evidence leads (official filing > our own
 *  data > press) and the rest ride along in `sources`. Types with collapse=null get a singleton
 *  group key ('#'||id) and a 0-day window, so they can never merge.
 *  Pagination + total both operate on collapsed rows, so "showing X-Y of N" stays truthful. */
function collapsedSignals(clause: string, p: (string | number)[], f: SignalFilter, lim: number, off: number,
): { total: number; items: Array<Record<string, unknown>> } {
  const core = `
    WITH base AS (
      SELECT id, domain, ${SIGNAL_COMPANY_SQL} AS company, type, category, evidence_rank, title, detail, url, client,
             check_id, observed_at, created_at,
             julianday(${SIGNAL_EVENT_DATE}) AS jd, ${collapseGroupCaseSql()} AS cg, ${collapseWindowCaseSql()} AS win
        FROM signals ${clause}),
    marked AS (
      SELECT *, CASE WHEN LAG(jd) OVER w IS NULL OR (LAG(jd) OVER w - jd) > win THEN 1 ELSE 0 END AS st
        FROM base WINDOW w AS (PARTITION BY domain, cg ORDER BY jd DESC, id DESC)),
    grouped AS (
      SELECT *, SUM(st) OVER (PARTITION BY domain, cg ORDER BY jd DESC, id DESC ROWS UNBOUNDED PRECEDING) AS grp
        FROM marked),
    ranked AS (
      SELECT g.*,
             ROW_NUMBER() OVER pw AS rn,
             COUNT(*)     OVER pw AS group_count,
             MAX(created_at) OVER pw AS group_created,
             MAX(jd)         OVER pw AS group_jd,
             json_group_array(json_object('id', id, 'type', type, 'category', category, 'title', title,
                                          'url', url, 'observedAt', observed_at, 'rank', evidence_rank)) OVER pw AS sources
        FROM grouped g
       WINDOW pw AS (PARTITION BY domain, cg, grp ORDER BY evidence_rank DESC, jd DESC, id DESC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING))`;
  // Order by the GROUP's newest event, not the primary's — otherwise a group led by an older filing
  // sinks below newer, weaker rows.
  const order = signalOrder(f, "collapsed");
  // ONE evaluation of the CTE, not two. The total comes from COUNT(*) OVER () on the same pass:
  // LIMIT cannot be pushed under LAG/SUM/ROW_NUMBER/json_group_array, so every page costs a full
  // walk of the filtered set regardless of limit or offset — and running it a second time just for
  // the count doubled that. Measured at 30k signals: 611ms per page, of which half was the count.
  const rows = db.prepare(
    `${core}
     SELECT id, domain, company, type, category, evidence_rank AS evidenceRank, title, detail, url, client,
            check_id AS checkId, observed_at AS observedAt, created_at AS createdAt,
            group_count AS groupCount, sources,
            COUNT(*) OVER () AS collapsed_total
       FROM ranked WHERE rn = 1 ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(...p, lim, off) as Array<Record<string, unknown>>;
  // COUNT(*) OVER () is the count of collapsed rows BEFORE LIMIT/OFFSET, so pagination stays
  // truthful. An empty page (offset past the end) carries no row to read it from — fall back to the
  // separate count only in that case, which is rare and cheap relative to being wrong.
  let total: number;
  if (rows.length) total = Number(rows[0]!.collapsed_total);
  else if (off === 0) total = 0;
  else total = (db.prepare(`${core} SELECT COUNT(*) c FROM ranked WHERE rn = 1`).get(...p) as { c: number }).c;
  for (const r of rows) {
    delete r.collapsed_total;
    // sources always an array (length 1 when nothing merged) so the UI needs no branch.
    try { r.sources = JSON.parse(String(r.sources ?? "[]")); } catch { r.sources = []; }
  }
  return { total, items: rows };
}
export function dbDismissSignal(id: number, dismissed = true): boolean {
  return Number(db.prepare("UPDATE signals SET dismissed = ? WHERE id = ?").run(dismissed ? 1 : 0, id).changes) > 0;
}
/** CURRENT signals (present state), not the diff feed: every domain currently flagged for a producer,
 *  one row per (domain, producer), newest check first, with the company name resolved. Powers the
 *  Signals feed's "no changes yet — here's the current state" fallback so the tab is never blank. */
export function dbListCurrentSignals(f: { q?: string; limit?: number; offset?: number }): { total: number; items: Array<Record<string, unknown>> } {
  const companyExpr = `COALESCE(
      (SELECT cd.company FROM company_domains cd WHERE cd.domain = df.domain LIMIT 1),
      (SELECT j.company FROM raw_jobs j WHERE j.domain = df.domain AND j.company IS NOT NULL AND j.company <> '' LIMIT 1))`;
  const w = ["df.hit = 1"]; const p: (string | number)[] = [];
  if (f.q) { w.push(`(df.domain LIKE ? OR df.summary LIKE ? OR ${companyExpr} LIKE ?)`); const like = `%${f.q}%`; p.push(like, like, like); }
  const clause = `WHERE ${w.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) c FROM domain_flags df ${clause}`).get(...p) as { c: number }).c;
  // ORDER BY must end on the table's full key. domain_flags is PK (domain, producer) and one
  // per-domain check writes every producer's flag in the same second, so (checked_at, domain) left
  // whole groups of rows tied — SQLite is free to order ties differently per query, which made rows
  // repeat on one page and vanish from the next.
  const items = db.prepare(
    `SELECT df.domain, df.producer, df.summary, df.checked_at AS checkedAt, ${companyExpr} AS company
     FROM domain_flags df ${clause} ORDER BY df.checked_at DESC, df.domain ASC, df.producer ASC LIMIT ? OFFSET ?`,
  ).all(...p, Math.min(f.limit ?? 15, 200), Math.max(f.offset ?? 0, 0)) as Array<Record<string, unknown>>;
  return { total, items };
}
/** Feed KPI strip: totals in scope. Same scoping as dbListSignals (watchlist client, else all). */
/** KPI strip + category breakdown for the Signals screen.
 *
 *  `grouped` must match the feed's grouping toggle. Without it the screen showed two different
 *  totals for the same thing side by side — "Signals 9" above a feed of 5 rows — and every
 *  breakdown cell's number was larger than the feed it filtered to, because the stats counted raw
 *  signals while the feed collapses several reports of one event into a single row. Counting the
 *  same primaries the feed shows (rn = 1 over the identical partitioning) makes the numbers mean
 *  what the screen says they mean. */
export function dbSignalStats(f: { client?: string; grouped?: boolean }): {
  total: number; last24h: number; companies: number;
  topType: { type: string; c: number } | null;
  byType: Array<{ type: string; c: number; last24h: number }>;
  topCategory: { category: string; c: number } | null;
  byCategory: Array<{ category: string; c: number; last24h: number }>;
} {
  const w: string[] = ["dismissed = 0"]; const p: (string | number)[] = [];
  if (f.client) { w.push("client = ?"); p.push(f.client); }
  const clause = `WHERE ${w.join(" AND ")}`;
  // The same partitioning collapsedSignals uses, reduced to "one row per group". Everything below
  // then reads from `src` instead of the signals table, so raw and grouped modes share one shape.
  const src = f.grouped === false ? `(SELECT * FROM signals ${clause})` : `(
    WITH base AS (
      SELECT *, julianday(${SIGNAL_EVENT_DATE}) AS jd, ${collapseGroupCaseSql()} AS cg, ${collapseWindowCaseSql()} AS win
        FROM signals ${clause}),
    marked AS (
      SELECT *, CASE WHEN LAG(jd) OVER w IS NULL OR (LAG(jd) OVER w - jd) > win THEN 1 ELSE 0 END AS st
        FROM base WINDOW w AS (PARTITION BY domain, cg ORDER BY jd DESC, id DESC)),
    grouped AS (
      SELECT *, SUM(st) OVER (PARTITION BY domain, cg ORDER BY jd DESC, id DESC ROWS UNBOUNDED PRECEDING) AS grp
        FROM marked),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY domain, cg, grp
                                   ORDER BY evidence_rank DESC, jd DESC, id DESC) AS rn
        FROM grouped)
    SELECT * FROM ranked WHERE rn = 1)`;
  // Each statement repeats the WHERE parameters as many times as `src` inlines the clause (once).
  const one = (sql: string) => (db.prepare(sql).get(...p) as { c: number }).c;
  const total = one(`SELECT COUNT(*) c FROM ${src}`);
  const last24h = one(`SELECT COUNT(*) c FROM ${src} WHERE created_at >= datetime('now','-1 day')`);
  const companies = one(`SELECT COUNT(DISTINCT COALESCE(company, domain)) c FROM ${src}`);
  // Per-signal-type breakdown: total + last-24h count for every type that has at least one live signal.
  const byType = db.prepare(
    `SELECT type,
            COUNT(*) c,
            SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) last24h
       FROM ${src} GROUP BY type ORDER BY c DESC, type ASC`
  ).all(...p) as Array<{ type: string; c: number; last24h: number }>;
  // Same breakdown by CATEGORY — what the feed shows by default (one cell per meaning, not per source).
  const byCategory = db.prepare(
    `SELECT category,
            COUNT(*) c,
            SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) last24h
       FROM ${src} GROUP BY category ORDER BY c DESC, category ASC`
  ).all(...p) as Array<{ category: string; c: number; last24h: number }>;
  return { total, last24h, companies, topType: byType[0] ?? null, byType, topCategory: byCategory[0] ?? null, byCategory };
}
/** Current snapshot for one (domain, producer) as a key→value map. Empty map = never scanned (baseline). */
export function dbGetDomainState(domain: string, producer: string): Map<string, string> {
  const rows = db.prepare("SELECT key, value FROM domain_state WHERE domain = ? AND producer = ?").all(domain, producer) as Array<{ key: string; value: string | null }>;
  return new Map(rows.map((r) => [r.key, r.value ?? ""]));
}
const upsertState = db.prepare(`
  INSERT INTO domain_state (domain, producer, key, value) VALUES (?, ?, ?, ?)
  ON CONFLICT(domain, producer, key) DO UPDATE SET value = excluded.value, last_seen = datetime('now')
`);
/** Replace one (domain, producer)'s snapshot: upsert current keys (first_seen preserved), drop vanished ones. */
export function dbReplaceDomainState(domain: string, producer: string, entries: Record<string, string>): void {
  const keys = Object.keys(entries);
  db.exec("BEGIN");
  try {
    if (keys.length) {
      db.prepare(`DELETE FROM domain_state WHERE domain = ? AND producer = ? AND key NOT IN (${keys.map(() => "?").join(",")})`).run(domain, producer, ...keys);
    } else {
      db.prepare("DELETE FROM domain_state WHERE domain = ? AND producer = ?").run(domain, producer);
    }
    for (const k of keys) upsertState.run(domain, producer, k, entries[k] ?? "");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
// ---- domain_flags: current-state "does this company show signal X right now?" for filtering + lookup.
// Unlike the diff-based `signals` feed (baseline-suppressed), a flag captures PRESENT state (running
// ads / raised / uses Ashby). Written whenever a producer definitively determines its state; a producer
// that couldn't determine (no name, unreachable) passes no flag, leaving the prior one untouched.
const upsertDomainFlag = db.prepare(`
  INSERT INTO domain_flags (domain, producer, hit, summary, checked_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(domain, producer) DO UPDATE SET hit = excluded.hit, summary = excluded.summary, checked_at = excluded.checked_at
`);
export function dbSetDomainFlag(domain: string, producer: string, hit: boolean, summary?: string | null): void {
  upsertDomainFlag.run(domain, producer, hit ? 1 : 0, summary ?? null);
}
export interface DomainFlagRow { producer: string; hit: number; summary: string | null; checkedAt: string }
/** All current flags for one domain (for the per-company signal panel). */
export function dbGetDomainFlags(domain: string): DomainFlagRow[] {
  return db.prepare("SELECT producer, hit, summary, checked_at AS checkedAt FROM domain_flags WHERE domain = ? ORDER BY producer").all(domain) as unknown as DomainFlagRow[];
}
// ---- slow_queue: work owed to rate-limited producers (see the table comment). ----
const enqueueSlow = db.prepare(`
  INSERT INTO slow_queue (producer, domain, client, company) VALUES (?, ?, ?, ?)
  ON CONFLICT(producer, domain) DO UPDATE SET
    client  = COALESCE(excluded.client,  slow_queue.client),
    company = COALESCE(excluded.company, slow_queue.company)
`);
/**
 * Queue one (producer, domain). Already queued → refresh its attribution, keep its place and backoff.
 *
 * Queue a domain for a paced producer — UNLESS it was checked recently enough to still be true.
 *
 * Without the recency test this is not a queue, it is a leak. Every scheduled scan enqueued every
 * watched domain, the worker drains one per paceMs, and a watchlist larger than
 * (scan interval / paceMs) can therefore never converge: it is refilled faster than it empties, and
 * coverage freezes at whatever the first few dozen items were.
 *
 * Measured on the live database: GDELT had reached 26 domains of 1,313, with 947 queued — and the
 * queue GREW by 54 during four hours of observation. 802 of those had never been attempted at all.
 * At its 5.2s gap, draining once is 82 minutes of the app running continuously, and the app quits
 * with the dashboard.
 *
 * `recheckDays` on the producer is how long an answer stays good. A domain whose flag was written
 * inside that window is skipped, so each scan enqueues only what has actually gone stale and the
 * queue drains to empty instead of ratcheting.
 */
export function dbEnqueueSlow(
  producer: string, domain: string, client: string | null, company: string | null, recheckDays = 0,
): void {
  if (recheckDays > 0) {
    const fresh = db.prepare(
      "SELECT 1 FROM domain_flags WHERE domain = ? AND producer = ? AND checked_at > datetime('now', ?)",
    ).get(domain, producer, `-${recheckDays} days`);
    if (fresh) return;
  }
  enqueueSlow.run(producer, domain, client, company);
}
export interface SlowQueueItem { producer: string; domain: string; client: string | null; company: string | null; attempts: number }
/** The next due item for a producer, oldest first. Returns null when nothing is ready yet. */
export function dbTakeSlow(producer: string): SlowQueueItem | null {
  const r = db.prepare(`SELECT producer, domain, client, company, attempts FROM slow_queue
     WHERE producer = ? AND next_at <= datetime('now') ORDER BY enqueued_at LIMIT 1`).get(producer);
  return (r ?? null) as SlowQueueItem | null;
}
/** Done — drop it. The next scan re-enqueues, which is what rotates coverage across the watchlist. */
export function dbDoneSlow(producer: string, domain: string): void {
  db.prepare("DELETE FROM slow_queue WHERE producer = ? AND domain = ?").run(producer, domain);
}
/** How many times a domain may fail before the queue gives up on it for this round. */
export const SLOW_MAX_ATTEMPTS = 8;
/** Failed — keep it, but push it out so one unreachable domain can't monopolise the drip. Exponential
 *  to a 6h ceiling; the row survives a restart, so a transient outage costs coverage, not the item.
 *  Returns false when the item was dropped at the attempt cap instead of deferred. */
export function dbDeferSlow(producer: string, domain: string, error: string): boolean {
  const row = db.prepare("SELECT attempts FROM slow_queue WHERE producer = ? AND domain = ?")
    .get(producer, domain) as { attempts: number } | undefined;
  // GIVE UP rather than retry forever. On the live queue, 81 items sat at attempts=7 against errors
  // that do not clear by trying again in an hour — "HTTP 429" (39), "aborted due to timeout" (59),
  // "fetch failed" (47). Each one holds a slot the paced worker could have spent on a domain it has
  // never looked at, and 802 of the 947 queued had never been attempted once.
  //
  // Dropping the item is not dropping the work: the next scan re-enqueues it, subject to the recency
  // test above. That turns an unreachable domain from a permanent occupant into one retried on the
  // next round — which is what the caller's own "will retry next scan" message already claims.
  if (row && row.attempts + 1 >= SLOW_MAX_ATTEMPTS) {
    db.prepare("DELETE FROM slow_queue WHERE producer = ? AND domain = ?").run(producer, domain);
    return false;
  }
  db.prepare(`UPDATE slow_queue SET attempts = attempts + 1, last_error = ?,
      next_at = datetime('now', '+' || MIN(360, 2 * (1 << MIN(attempts, 7))) || ' minutes')
    WHERE producer = ? AND domain = ?`).run(error.slice(0, 200), producer, domain);
  return true;
}
export interface SlowQueueStat { producer: string; queued: number; ready: number; failing: number; oldest: string | null }
/** Per-producer queue depth for the System panel. `ready` excludes items still in backoff. */
export function dbSlowQueueStats(): SlowQueueStat[] {
  return db.prepare(`SELECT producer, COUNT(*) AS queued,
      SUM(CASE WHEN next_at <= datetime('now') THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS failing,
      MIN(enqueued_at) AS oldest
    FROM slow_queue GROUP BY producer ORDER BY producer`).all() as unknown as SlowQueueStat[];
}
/** Drop everything queued for a producer (used when a watchlist stops asking for it). */
export function dbClearSlow(producer: string): number {
  return db.prepare("DELETE FROM slow_queue WHERE producer = ?").run(producer).changes as number;
}
// ---- company_domains: fill a company's Domain when its job records carry none. ----
const upsertCompanyDomain = db.prepare(`
  INSERT INTO company_domains (company_key, company, domain, source, created_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(company_key) DO UPDATE SET domain = excluded.domain, source = excluded.source, created_at = excluded.created_at
`);
/** Store a company→domain override. `source`: 'manual' (user typed) or 'auto' (resolver guess). A manual
 *  entry always replaces an auto one; an auto entry never overwrites a manual one (guarded by caller). */
export function dbSetCompanyDomain(company: string, domain: string, source: "manual" | "auto"): void {
  const key = company.trim().toLowerCase();
  if (!key || !domain) return;
  upsertCompanyDomain.run(key, company.trim(), domain, source);
}
/** The current override for a company, if any. */
export function dbGetCompanyDomain(company: string): { domain: string; source: string } | undefined {
  return db.prepare("SELECT domain, source FROM company_domains WHERE company_key = ?").get(company.trim().toLowerCase()) as { domain: string; source: string } | undefined;
}

/** Matched companies with NO domain from any source — no job domain, no override — skipping companies
 *  whose resolution failed within the retry window (negative cache). Returns display names, most
 *  recently active first, plus the total backlog so callers can report progress honestly. */
/** Companies with no known website, oldest-relevant last. The grouped HAVING aggregate is the
 *  expensive part (~145ms on the production DB), and it is run TWICE — once for the page, once
 *  for the total. Callers that only need one of the two pass `want` and skip the other; a
 *  "resolve all" loop asked for both four times per batch and used one. */
export function dbCompaniesMissingDomain(
  limit: number, retryDays = 7, want: "both" | "items" | "total" = "both",
): { items: string[]; total: number } {
  const base = `
    FROM matches m JOIN raw_jobs j ON j.id = m.job_id
    WHERE m.dismissed = 0 AND j.company IS NOT NULL AND j.company <> ''
    GROUP BY jslower(j.company)
    HAVING NULLIF(GROUP_CONCAT(DISTINCT NULLIF(j.domain,'')),'') IS NULL
       AND NOT EXISTS (SELECT 1 FROM company_domains cd WHERE cd.company_key = jslower(j.company))
       AND NOT EXISTS (SELECT 1 FROM resolve_attempts ra WHERE ra.company_key = jslower(j.company)
                        AND ra.attempted_at > datetime('now', ?))`;
  const win = `-${Math.max(1, retryDays)} days`;
  const total = want === "items" ? 0
    : (db.prepare(`SELECT COUNT(*) c FROM (SELECT 1 ${base})`).get(win) as { c: number }).c;
  const rows = want === "total" ? []
    : db.prepare(`SELECT j.company AS company ${base} ORDER BY MAX(j.seen_at) DESC LIMIT ${Math.max(1, limit)}`).all(win) as { company: string }[];
  return { items: rows.map((r) => r.company), total };
}
/** Countries this company operates in, strongest evidence first: its domain's ccTLD, then the
 *  countries of its stored job postings (most postings first). Empty = we genuinely don't know —
 *  callers must treat that as "unknown", never as "US". Used to pick which app storefronts, news
 *  editions and ccTLD guesses are worth trying for a company. */
export function dbDomainCountries(domain: string, companyName?: string | null): string[] {
  const out: string[] = [];
  const fromTld = countryFromDomain(domain);
  if (fromTld) out.push(fromTld);
  const rows = db.prepare(
    `SELECT country, COUNT(*) c FROM raw_jobs
     WHERE country IS NOT NULL AND country <> '' AND (domain = ? ${companyName ? "OR jslower(company) = ?" : ""})
     GROUP BY country ORDER BY c DESC LIMIT 5`,
  ).all(...(companyName ? [domain, companyName.toLowerCase()] : [domain])) as { country: string }[];
  for (const r of rows) if (!out.includes(r.country)) out.push(r.country);
  return out;
}

/** Countries a company posts jobs in, most postings first. Used by the domain resolver, which runs
 *  BEFORE a company has any domain — so it can only key on the name. Empty = unknown. */
export function dbCompanyCountries(company: string): string[] {
  const rows = db.prepare(
    `SELECT country, COUNT(*) c FROM raw_jobs
     WHERE jslower(company) = ? AND country IS NOT NULL AND country <> ''
     GROUP BY country ORDER BY c DESC LIMIT 3`,
  ).all(company.trim().toLowerCase()) as { country: string }[];
  return rows.map((r) => r.country);
}

const markResolveAttempt = db.prepare("INSERT INTO resolve_attempts (company_key, attempted_at) VALUES (?, datetime('now')) ON CONFLICT(company_key) DO UPDATE SET attempted_at = datetime('now')");
export function dbMarkResolveFailed(company: string): void {
  const key = company.trim().toLowerCase();
  if (key) markResolveAttempt.run(key);
}

/** SQL fragment (+ params) matching jobs whose domain is currently flagged for ANY of `producers`.
 * Empty list → null (no constraint). Used as an EXISTS clause in the job/match queries. */
export function domainFlagExists(producers: string[], jobAlias = "j"): { clause: string; params: string[] } | null {
  const ps = producers.filter(Boolean);
  if (!ps.length) return null;
  return {
    clause: `EXISTS (SELECT 1 FROM domain_flags df WHERE df.domain = ${jobAlias}.domain AND df.hit = 1 AND df.producer IN (${ps.map(() => "?").join(",")}))`,
    params: ps,
  };
}
// ---- Signal checks: saved multi-signal runs over an uploaded domain list ----
export function dbCreateSignalCheck(id: string, name: string, params: unknown, total: number): void {
  db.prepare("INSERT INTO signal_checks (id, name, params, total) VALUES (?, ?, ?, ?)").run(id, name, JSON.stringify(params), total);
}
const insertSignalCheckResult = db.prepare(
  `INSERT INTO signal_check_results (check_id, domain, result) VALUES (?, ?, ?)
   ON CONFLICT(check_id, domain) DO UPDATE SET result = excluded.result`,
);
// Counters are DERIVED from signal_check_results rather than trusted from the caller. A resumed run
// restarts its own checked/found/totalHits at zero and re-walks the list, so taking the caller's
// numbers made a resume appear to lose everything it had already done until it caught up.
const updateSignalCheckProgress = db.prepare(
  `UPDATE signal_checks SET
     checked    = (SELECT COUNT(*) FROM signal_check_results WHERE check_id = ?),
     found      = (SELECT COUNT(*) FROM signal_check_results WHERE check_id = ? AND json_extract(result, '$.signals') > 0),
     total_hits = (SELECT COALESCE(SUM(json_extract(result, '$.signals')), 0) FROM signal_check_results WHERE check_id = ?),
     updated_at = datetime('now')
   WHERE id = ?`,
);
/** Append the DELTA of newly-checked domains. Pass ONLY the results this callback produced — never
 *  the cumulative array (see the signal_check_results comment for what that cost). */
export function dbSignalCheckProgress(id: string, p: { newResults: Array<{ domain: string }> }): void {
  if ("results" in p) {
    throw new TypeError("dbSignalCheckProgress: `results` was replaced by `newResults` (pass only the new results, not the cumulative array)");
  }
  db.exec("BEGIN");
  try {
    for (const r of p.newResults) insertSignalCheckResult.run(id, String(r?.domain ?? ""), JSON.stringify(r));
    updateSignalCheckProgress.run(id, id, id, id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
/**
 * Re-derive a check's counters from the `signals` table — the rows that actually exist.
 *
 * updateSignalCheckProgress above derives from signal_check_results.$.signals, which is a JSON blob
 * written once when the domain was checked and never revisited. That is fine while a check is
 * running and wrong forever afterwards: every path that DELETES from `signals` (each of the five
 * repair scripts, and any future one) leaves the counters at their original values.
 *
 * Measured on the live database: the "Docxster Signal Check" advertised 773 signals across 152 of
 * 1,280 domains where the truth was 107 across 48 — a 7.2x overstatement the user cannot reconcile
 * with the feed underneath it, because that feed is drawn from `signals`. 130 of 1,280 per-domain
 * rows had drifted; 19 of 44 on the smaller bulk check.
 *
 * account_searches never had this bug (db.ts re-derives total_hits from account_search_hits on every
 * write); signal_checks derived from a snapshot instead of from the rows, which is the whole
 * difference. Returns the number of checks touched.
 */
export function dbRederiveSignalCheckCounts(checkId?: string): number {
  const ids = checkId
    ? [checkId]
    : (db.prepare("SELECT id FROM signal_checks").all() as Array<{ id: string }>).map((r) => r.id);
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      // Rewrite each per-domain result's `signals` count from the real rows, so the grid's per-row
      // number and the header's total cannot disagree.
      db.prepare(
        `UPDATE signal_check_results
            SET result = json_set(result, '$.signals',
                  (SELECT COUNT(*) FROM signals s WHERE s.check_id = signal_check_results.check_id
                                                    AND s.domain = signal_check_results.domain))
          WHERE check_id = ?`,
      ).run(id);
      updateSignalCheckProgress.run(id, id, id, id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return ids.length;
}

/** Every stored per-domain result for a check, oldest first. */
export function dbSignalCheckResults(id: string): unknown[] {
  const rows = db.prepare("SELECT result FROM signal_check_results WHERE check_id = ? ORDER BY rowid").all(id) as { result: string }[];
  const out: unknown[] = [];
  for (const r of rows) { try { out.push(JSON.parse(r.result)); } catch { /* skip a corrupt row rather than sink the read */ } }
  return out;
}
/** Just the counters, without materialising every per-domain result. Used to close out a run's
 *  history row: a RESUMED run's in-flight progress restarts at zero, so the last progress tick is
 *  not the run's total — the stored, derived counters are. */
export function dbCheckCounters(table: "signal_checks" | "account_searches", id: string): { totalHits: number; found: number; checked: number } {
  const r = db.prepare(`SELECT total_hits AS totalHits, found, checked FROM ${table} WHERE id = ?`).get(id) as
    { totalHits: number; found: number; checked: number } | undefined;
  return r ?? { totalHits: 0, found: 0, checked: 0 };
}
export function dbFinishSignalCheck(id: string, status: string, error: string | null = null): void {
  db.prepare("UPDATE signal_checks SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?").run(status, error, id);
}
// found + total_hits are DERIVED HERE, from the rows that actually exist, rather than read from the
// stored columns. Those columns are written while a check runs and never revisited, so every path
// that deletes from `signals` afterwards — each of the six repair scripts, and any future one —
// leaves them frozen at their original values. Measured live: a check advertised 773 signals across
// 152 of 1,280 domains where the truth was 107 across 48, a 7.2x overstatement the user cannot
// reconcile with the feed underneath it, because that feed is drawn from `signals`.
//
// Deriving at READ time rather than patching the six scripts is what makes it stay fixed: a seventh
// script cannot reintroduce it. `checked` still comes from the stored column — it counts domains
// visited, which deleting a signal does not change. dbRederiveSignalCheckCounts remains for
// repairing the stored columns and the per-domain JSON the results grid reads.
const DERIVED = `(SELECT COUNT(DISTINCT s.domain) FROM signals s WHERE s.check_id = signal_checks.id) AS found,
     (SELECT COUNT(*) FROM signals s WHERE s.check_id = signal_checks.id) AS totalHits`;
export interface SignalCheckSummary { id: string; name: string; status: string; total: number; checked: number; found: number; totalHits: number; createdAt: string; updatedAt: string }
export function dbListSignalChecks(q?: string): SignalCheckSummary[] {
  const base = `SELECT id, name, status, total, checked, ${DERIVED}, created_at AS createdAt, updated_at AS updatedAt FROM signal_checks`;
  const rows = q ? db.prepare(`${base} WHERE name LIKE ? ORDER BY created_at DESC`).all(`%${q}%`) : db.prepare(`${base} ORDER BY created_at DESC`).all();
  return rows as unknown as SignalCheckSummary[];
}
export function dbGetSignalCheck(id: string): (SignalCheckSummary & { params: unknown; results: unknown[]; error: string | null }) | null {
  const r = db.prepare(
    `SELECT id, name, params, status, total, checked, ${DERIVED}, results, error, created_at AS createdAt, updated_at AS updatedAt FROM signal_checks WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const safe = (s: unknown, fb: unknown) => { try { return JSON.parse(String(s)); } catch { return fb; } };
  // Results come from signal_check_results now. The legacy blob is only read when that table has
  // nothing for this check — a run written by an older build and not yet migrated.
  const rowResults = dbSignalCheckResults(id);
  const results = rowResults.length ? rowResults : safe(r.results, []);
  return { ...(r as object), params: safe(r.params, {}), results } as ReturnType<typeof dbGetSignalCheck> & object;
}
/** Delete a signal check and everything hanging off it. The table list here is complete (verified
 *  against every table carrying a check_id) — unlike its account-check twin above, which had been
 *  missing one. Wrapped for the same reason: a half-delete is not a state either table should reach. */
export function dbDeleteSignalCheck(id: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM signals WHERE check_id = ?").run(id); // a check's signals go with it
    db.prepare("DELETE FROM signal_check_results WHERE check_id = ?").run(id);
    db.prepare("DELETE FROM signal_checks WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// Webhook delivery for signals — mirrors the matches path (2xx-gated, batched, stop-on-failure).
// Both readers are CAPPED. Selecting the entire undelivered set and materialising it in one JS array
// is the unbounded-materialisation defect already fixed on the matches path, left unfixed on its
// twin — and a backlog that built up while an endpoint was down has no natural size limit. The cap is
// per CALL, not per delivery: delivered rows drop out of the predicate, so the next cycle takes the
// rest. Oldest first, so the backlog drains in order.
export const SIGNAL_BACKLOG_CAP = 5000;
const SIGNAL_COLS = "id, domain, company, type, category, evidence_rank, title, detail, url, observed_at, created_at";
export function getUndeliveredSignals(client: string): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT ${SIGNAL_COLS} FROM signals WHERE client = ? AND delivered = 0 AND dismissed = 0
     ORDER BY created_at ASC, id ASC LIMIT ${SIGNAL_BACKLOG_CAP}`,
  ).all(client) as Array<Record<string, unknown>>;
}
/** Undelivered signals from a one-off check (for its optional webhook). */
export function getUndeliveredCheckSignals(checkId: string): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT ${SIGNAL_COLS} FROM signals WHERE check_id = ? AND delivered = 0 AND dismissed = 0
     ORDER BY created_at ASC, id ASC LIMIT ${SIGNAL_BACKLOG_CAP}`,
  ).all(checkId) as Array<Record<string, unknown>>;
}
/** How many undelivered rows are left after a capped read — so a caller can say "N left for the next
 *  cycle" instead of silently truncating. */
export function countUndeliveredSignals(client: string): number {
  return (db.prepare("SELECT COUNT(*) c FROM signals WHERE client = ? AND delivered = 0 AND dismissed = 0")
    .get(client) as { c: number }).c;
}
const markSigDelivered = db.prepare("UPDATE signals SET delivered = 1 WHERE id = ?");
export function markSignalDelivered(id: number): void {
  markSigDelivered.run(id);
}
/** Mark MANY signals delivered in ONE transaction. The per-row call above autocommits (and fsyncs)
 *  once per row — O(rows) disk syncs on a delivery of any size. The matches path was wrapped for
 *  exactly this reason (markMatchesDelivered); its twin was not. */
export function markSignalsDelivered(ids: number[]): void {
  if (!ids.length) return;
  db.exec("BEGIN");
  try { for (const id of ids) markSigDelivered.run(id); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

// ---- Triage: star a job (per-job flag) ----
const setStar = db.prepare("UPDATE raw_jobs SET starred = ? WHERE id = ?");
/** Set/clear a job's star. Returns the new state, or null if the job doesn't exist. */
export function dbSetStar(id: string, starred: boolean): boolean | null {
  const res = setStar.run(starred ? 1 : 0, id);
  return Number(res.changes) > 0 ? starred : null;
}

// Re-sight description upgrade: a stored row with NO description learns one from a later sighting
// that carries richer raw (e.g. first seen via keyword search, later re-seen by an /org/ scan or
// account check whose payload includes the scraped JD). Never overwrites an existing description.
// comp_max and currency read the PARAMETER, not the `raw` column: in an UPDATE, the right-hand side
// of SET sees the OLD row, so `json_extract(raw, …)` here would recompute from the blob being replaced.
// They are COALESCEd against the old value so a later sighting that carries prose but no salary cannot
// erase a figure we already have — FILL, NEVER CORRECT, the same rule learnDomain and learnCompany use.
//
// THE GUARD IS THE POINT. It used to be `description IS NULL OR description = ''`, and under that
// condition this statement could never fire for the case the comment above describes — which is the
// only case it was written for.
//
// `description` is not always a scraped job description. When the payload has no prose, rawDescription
// COMPOSES one out of hiring.cafe's structured facets ("Requirements:\n• Mid Level"). Every
// keyword-search result has a seniority, so every one of them composes something, so the column is
// never empty, so the guard never opened. Measured on the live database: 7,552 rows hold a composed
// stub averaging 458 characters where a real description averages 3,920 — and 2,642 of them have
// already been re-seen at least once, each sighting refused. The split is not incidental: 7,546 of
// those stubs are `hiringcafe` (keyword search, no prose reachable) and 16,351 of the real ones are
// `hcorg` (the /org/ scan, which scrapes the JD). First seen by keyword, later re-seen by an org scan
// is the everyday path through this app, and it was throwing the description away every time.
//
// That column is not decoration: it is what FTS search indexes and what the technology tagger reads.
// A third of the corpus was being searched and tech-tagged from a 458-character summary.
//
// So: fill an empty description as before, AND let a real scraped one replace a composed stub. Never
// the reverse — a stub cannot overwrite prose, because the stored row must be the weaker of the two.
const upgradeDesc = db.prepare(`UPDATE raw_jobs
   SET raw = ?, description = ?,
       comp_max = COALESCE(json_extract(?, '$.comp_max'), comp_max),
       currency = COALESCE(json_extract(?, '$.currency'), currency)
 WHERE id = ?
   AND (description IS NULL OR description = ''
        OR (json_extract(raw, '$.description') IS NULL AND json_extract(?, '$.description') IS NOT NULL))`);

/**
 * The same idea for the EMPLOYER DOMAIN, which had no equivalent and needed one badly.
 *
 * A re-sighting carries a domain the stored row may not have. An /org/<domain> scan always knows the
 * domain — it is the thing being scraped — while the same posting first seen through a keyword search
 * usually does not, because its apply URL is an ATS host that extractDomain deliberately refuses.
 * Without this, the row keeps whatever it was born with forever: touchJob updates last_seen_at and
 * status and nothing else.
 *
 * That "forever" is not hypothetical. 12,708 rows in the live database — 6,162 of them from /org/
 * scans, which is to say rows that were stamped CORRECTLY at insert — hold an empty domain today,
 * blanked by the destructive re-derive this file's own backfill comment describes. The re-derive was
 * fixed on 2026-07-29, but a fix stops the bleeding; it does not put the data back. And nothing else
 * could: the safe rule now skips a stored "" rather than overwrite it, and touchJob ignored the
 * domain, so every future scrape of those exact jobs would carry the right domain and throw it away.
 *
 * A job with no domain is invisible to everything keyed on domain — it matches no watchlist, counts
 * toward no company's hiring velocity, and appears under no account. iHeartMedia's 631 stored
 * postings and Nexstar's 596 currently attach to nothing at all.
 *
 * STRICTLY A FILL, never a correction. It writes only when the stored value is NULL or empty, so a
 * domain we already believe is never overwritten by a weaker later reading — the same "replace only
 * what is provably wrong" rule dbBackfillDomains follows, and the reason the FedEx rows survived
 * there. The empty-string guard on the parameter keeps a source with no domain from writing one.
 */
const learnDomain = db.prepare("UPDATE raw_jobs SET domain = ? WHERE id = ? AND ? <> '' AND (domain IS NULL OR domain = '')");

/**
 * And the same for the COMPANY NAME, which completes the set: description, domain, company are the
 * three things a later sighting can know that the first one didn't, and until now only the first
 * could be learned.
 *
 * Company is the identity every NAME-keyed producer matches on — EDGAR, Companies House, WARN, news,
 * app listings all take a name, not a domain — so a row without one contributes to none of them and
 * shows a blank employer in the dashboard. 105 rows are in that state today, every one of them from
 * a Lever, Ashby or Personio board: those APIs genuinely do not return a company name (verifyBoard
 * says so in as many words), while Greenhouse, SmartRecruiters and hiring.cafe all do.
 *
 * That matters because those routes overlap. 3,866 stored hiring.cafe rows have an apply URL on a
 * direct ATS board we also scrape ourselves, and both routes derive the same URL-based dedup key, so
 * the two sightings collapse onto ONE row. Whichever arrived first wins the insert — and when that
 * is the ATS route, the hiring.cafe sighting that follows carries the company name straight into the
 * dedup branch, where it was read for the description and dropped for the name.
 *
 * HONEST SCOPE: this repairs nothing in the current database. I checked — all 105 company-less rows
 * carry purely Lever/Ashby-shaped raw with no hiring.cafe enrichment, so the naming sighting has not
 * actually arrived for any of them yet. It is shipped because the asymmetry is the bug: two of the
 * three learnable fields heal and the third silently does not, which is exactly the shape that made
 * the domain case unrecoverable for 6,162 rows before anyone noticed.
 *
 * Same rule as its siblings: FILL, NEVER CORRECT. Only NULL/'' is written to.
 */
const learnCompany = db.prepare("UPDATE raw_jobs SET company = ? WHERE id = ? AND ? <> '' AND (company IS NULL OR TRIM(company) = '')");

/** Insert a job if new (and stamp last_seen_at); if it already exists, refresh last_seen_at.
 *  Returns true when it was newly inserted (not a dupe). App-wide dedup: a posting already stored
 *  under a different row (another source/board with the same canonical dedup_key) is treated as a
 *  re-sight of that row, not a new job — so the same role is never stored twice. */
export function upsertJob(j: RawJob): boolean {
  const dk = (j.dedupKey ?? "").trim().toLowerCase() || `${j.source}:${j.externalId}`.toLowerCase();
  const rawStr = JSON.stringify(j.raw ?? null);
  const desc = rawDescription(rawStr);
  const canon = findByDedup.get(dk, j.id) as { id: string } | undefined;
  if (canon) { // dupe of an existing posting → touch it, and let it learn what it lacked
    const ok = currentSourceKey();
    if (j.status === "closed") touchClosed.run(ok, canon.id); else touchJob.run(ok, canon.id, ok, ok);
    learnDomain.run(j.domain ?? "", canon.id, j.domain ?? "");
    const co = (j.company ?? "").trim();
    // company is an INDEXED field, so learning one has to reindex or the job stays unfindable by the
    // name it just acquired. `||` short-circuits, so this must sit BEFORE the description test rather
    // than after it — otherwise a sighting that teaches only the name skips the resync entirely.
    const learned = Number(learnCompany.run(co, canon.id, co).changes) > 0;
    // A row that just LEARNED a description is the case retagTech exists for: the insert path
    // tagged the pre-enrichment summary, and this is where the full text arrives.
    const gotDesc = !!desc && Number(upgradeDesc.run(rawStr, desc, rawStr, rawStr, canon.id, rawStr).changes) > 0;
    if (gotDesc) retagTech(canon.id);
    if (learned || gotDesc) ftsSyncFromRow(canon.id);
    return false;
  }
  const res = insertJob.run(
    j.id, j.source, j.externalId, j.title, j.company, j.location, j.state,
    j.country ?? deriveCountry(j.location, j.state), j.remote ? 1 : 0, j.url, j.postedAt, j.domain ?? "", j.expiresAt ?? null, j.status ?? "open", rawStr, dk, desc, rawStr, rawStr,
  );
  if (res.changes === 0) { // same (source,external_id) → refresh
    const ok2 = currentSourceKey();
    if (j.status === "closed") touchClosed.run(ok2, j.id); else touchJob.run(ok2, j.id, ok2, ok2);
    learnDomain.run(j.domain ?? "", j.id, j.domain ?? "");   // an /org/ re-scan knows the domain a keyword hit didn't
    const co = (j.company ?? "").trim();
    learnCompany.run(co, j.id, co);                          // ...and a naming source knows the employer an ATS API doesn't
    if (desc && Number(upgradeDesc.run(rawStr, desc, rawStr, rawStr, j.id, rawStr).changes) > 0) retagTech(j.id);
    ftsSyncFromRow(j.id);                                    // unconditional here, so both learns are indexed
  } else {
    ftsSync(j.id, j.title, j.company ?? null, desc); // newly inserted → index it
    tagTech?.(j.id, `${j.title} ${desc ?? ""}`);     // detect technologies mentioned (lazy import avoids a cycle)
  }
  return res.changes > 0;
}
// Technology tagger, injected after boot to avoid a circular import (techDetect imports db).
let tagTech: ((jobId: string, text: string) => number) | null = null;
export function registerTechTagger(fn: (jobId: string, text: string) => number): void { tagTech = fn; }
// Re-read the stored row and refresh its FTS entry (used after a raw/description update).
const ftsRowStmt = db.prepare("SELECT id, title, company, description FROM raw_jobs WHERE id = ?");
function ftsSyncFromRow(id: string): void {
  if (!ftsReady) return;
  const r = ftsRowStmt.get(id) as { id: string; title: string; company: string | null; description: string | null } | undefined;
  if (r) ftsSync(r.id, r.title, r.company, r.description);
}

const updJobRaw = db.prepare("UPDATE raw_jobs SET raw = ?, description = ? WHERE id = ?");
/** Replace a job's stored raw JSON — used to persist a scraped full description into raw.description.
 *  Keeps the denormalized `description` column in sync (recomposed from the new raw). */
export function dbUpdateJobRaw(id: string, rawJson: string): void {
  updJobRaw.run(rawJson, rawDescription(rawJson), id);
  ftsSyncFromRow(id);
  retagTech(id);
}

/** Re-run technology detection over a job's CURRENT title + description.
 *
 *  Only the insert path tagged, using the pre-enrichment summary — so the scraped full job
 *  description, which is the entire point of the enrichment pass, never had its technologies
 *  detected, and an admin edit left job_technologies describing the old text. Replace rather than
 *  add, so a technology removed from the description also disappears from the index. */
function retagTech(id: string): void {
  if (!tagTech) return;
  const row = db.prepare("SELECT title, description FROM raw_jobs WHERE id = ?").get(id) as
    { title: string | null; description: string | null } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM job_technologies WHERE job_id = ?").run(id);
  tagTech(id, `${row.title ?? ""} ${row.description ?? ""}`);
}

// Which one-off run inserted a job. Written by Account Checks (origin "ac:<check-id>") for the jobs
// their run NEWLY added — a job that already existed keeps its original attribution — so a bad
// check's rows can be isolated in the Jobs database's "Matched by" filter and bulk-cleaned.
const insOrigin = db.prepare("INSERT OR IGNORE INTO job_origins (job_id, origin) VALUES (?, ?)");
export function dbTagJobOrigin(jobId: string, origin: string): void {
  insOrigin.run(jobId, origin);
}

const insertMatch = db.prepare(`
  INSERT OR IGNORE INTO matches (job_id, client, match_reason, matched_on) VALUES (?, ?, ?, ?)
`);

/** Record a match. Returns true if newly inserted for this (job, client). */
export function upsertMatch(m: Match): boolean {
  const res = insertMatch.run(m.jobId, m.client, m.matchReason, m.matchedOn?.length ? JSON.stringify(m.matchedOn) : null);
  return res.changes > 0;
}

// Only the columns toSignal() actually reads — NOT j.*, which dragged in the denormalized
// `description` column (2.6KB average) that the payload never uses, on top of the `raw` blob
// (3.7KB) that it does. Reading the whole undelivered backlog this way measured 198ms and +68MB
// heap in one array for 14,291 matches.
// m.created_at is WHEN THIS BECAME A MATCH for this client, which is not the same as when the job was
// ingested: a job already in the database is matched the moment a new watchlist starts watching its
// domain, so seen_at can predate the match by weeks. The CSV export carries it and the webhook did not
// — it was not even selected here — so a webhook consumer building a CRM record had no way to date it.
// technologies: the SAME subquery dbAdminJobsForExport uses, so the two channels cannot disagree
// about what a job's detected stack is. It was in the CSV and absent from the webhook entirely.
//
// That gap is worse than an ordinary missing field, because the matcher can REQUIRE a technology:
// matcher.ts gates a match on `f.technologies` — "only alert me when these companies hire for React".
// So a client could ask to be told only about React roles, be told about one, and not be told that
// React was what matched. The whole reason the match happened was the one fact left out of it.
const UNDELIVERED_COLS = `m.id as match_id, m.client, m.match_reason as matchReason, m.created_at as matched_at,
  j.id, j.title, j.company, j.domain, j.location, j.state, j.remote, j.status, j.url,
  j.source, j.posted_at, j.seen_at, j.raw,
  (SELECT GROUP_CONCAT(t.name, '; ') FROM job_technologies jt JOIN technologies t ON t.id = jt.tech_id
    WHERE jt.job_id = j.id) AS technologies`;
const undelivered = db.prepare(`
  SELECT ${UNDELIVERED_COLS}
  FROM matches m JOIN raw_jobs j ON j.id = m.job_id
  WHERE m.client = ? AND m.delivered = 0
  ORDER BY m.created_at ASC LIMIT ?
`);
const undeliveredCount = db.prepare(`SELECT COUNT(*) c FROM matches WHERE client = ? AND delivered = 0`);
const markDelivered = db.prepare(`UPDATE matches SET delivered = 1 WHERE id = ?`);

/** One page of the undelivered backlog. Marking a batch delivered removes it from this query, so
 *  repeated calls walk the whole backlog without an OFFSET — and without holding it all in memory. */
export function getUndelivered(client: string, limit = -1): Array<Record<string, unknown>> {
  return undelivered.all(client, limit) as Array<Record<string, unknown>>;
}
export function countUndelivered(client: string): number {
  return (undeliveredCount.get(client) as { c: number }).c;
}
const markAllDeliveredForClient = db.prepare("UPDATE matches SET delivered = 1 WHERE client = ? AND delivered = 0");
/** Mark a client's whole undelivered backlog as delivered, for the no-webhook case where the
 *  dashboard is the only sink. One UPDATE: the previous route read every row — each carrying its
 *  full `raw` JSON blob — into an array purely to collect the ids, then issued one UPDATE per id. */
export function markAllUndeliveredDelivered(client: string): number {
  return Number(markAllDeliveredForClient.run(client).changes ?? 0);
}
/** Run a batch of writes in one transaction. SQLite autocommits every statement otherwise, which
 *  measured 3-8x slower on the write loops here even under WAL + synchronous=NORMAL. */
export function dbTransaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try { const out = fn(); db.exec("COMMIT"); return out; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}
/** Mark a whole batch delivered in ONE transaction (autocommit per row measured 8x slower). */
export function markMatchesDelivered(matchIds: number[]): void {
  if (!matchIds.length) return;
  db.exec("BEGIN");
  try { for (const id of matchIds) markDelivered.run(id); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}
export function markMatchDelivered(matchId: number): void {
  markDelivered.run(matchId);
}

const markByJobClient = db.prepare("UPDATE matches SET delivered = 1 WHERE job_id = ? AND client = ?");
/** Mark a match delivered without sending (used by backfill so historical matches don't flood a new webhook). */
export function markMatchDeliveredByJobClient(jobId: string, client: string): void {
  markByJobClient.run(jobId, client);
}

/** Collapse duplicate job rows that represent the SAME posting (same canonical dedup key — e.g. the
 *  same role across ATS boards, or picked up by a keyword search AND an /org/ scan). Keeps one row
 *  per group (prefer open + resolved-domain + oldest), re-points each duplicate's matches onto the
 *  survivor (UPDATE OR IGNORE so a client that matched both keeps a single match), deletes the
 *  leftovers. Returns groups collapsed + rows removed. */
export function dbDedupeJobs(): { groups: number; removed: number } {
  const rows = db.prepare(
    `SELECT id, COALESCE(NULLIF(dedup_key, ''), NULLIF(LOWER(TRIM(url)), ''), source || ':' || external_id) AS k,
            status, domain, seen_at
     FROM raw_jobs`,
  ).all() as { id: string; k: string; status: string; domain: string | null; seen_at: string }[];

  const groups = new Map<string, typeof rows>();
  for (const r of rows) { const g = groups.get(r.k); if (g) g.push(r); else groups.set(r.k, [r]); }

  const rank = (r: { status: string; domain: string | null }) =>
    (r.status === "closed" ? 2 : 0) + (r.domain && r.domain !== "" ? 0 : 1); // open + resolved-domain ranks first
  const repoint = db.prepare("UPDATE OR IGNORE matches SET job_id = ? WHERE job_id = ?");
  const delMatches = db.prepare("DELETE FROM matches WHERE job_id = ?");
  const delJob = db.prepare("DELETE FROM raw_jobs WHERE id = ?");
  // Move the dup's tech + origin attribution onto the survivor (same posting → same detections), then
  // clear the dup's rows in every side table so no orphan job_technologies / job_origins / jobs_fts remain.
  const repointTech = db.prepare("INSERT OR IGNORE INTO job_technologies (job_id, tech_id) SELECT ?, tech_id FROM job_technologies WHERE job_id = ?");
  const delTech = db.prepare("DELETE FROM job_technologies WHERE job_id = ?");
  const repointOrigins = db.prepare("INSERT OR IGNORE INTO job_origins (job_id, origin) SELECT ?, origin FROM job_origins WHERE job_id = ?");
  const delOrigins = db.prepare("DELETE FROM job_origins WHERE job_id = ?");
  const delFtsRow = db.prepare("DELETE FROM jobs_fts WHERE job_id = ?");

  let groupCount = 0, removed = 0;
  db.exec("BEGIN");
  try {
    for (const grp of groups.values()) {
      if (grp.length < 2) continue;
      groupCount++;
      grp.sort((a, b) => (rank(a) - rank(b)) || (a.seen_at < b.seen_at ? -1 : 1));
      const keepId = grp[0]!.id;
      for (const dup of grp.slice(1)) {
        repoint.run(keepId, dup.id); // move matches we can onto the survivor (UNIQUE collisions ignored)
        delMatches.run(dup.id);       // drop any that collided (survivor already has that client's match)
        repointTech.run(keepId, dup.id); delTech.run(dup.id);       // tech attribution → survivor, no orphans
        repointOrigins.run(keepId, dup.id); delOrigins.run(dup.id); // origin attribution → survivor
        if (ftsReady) delFtsRow.run(dup.id);                        // drop the dup's FTS entry
        delJob.run(dup.id);
        removed++;
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  return { groups: groupCount, removed };
}

// ───────────────────── Advanced filter: visual condition tree → SQL (injection-safe) ─────────────────────
// The client sends a tree of groups/conditions. We ONLY ever emit SQL from this fixed field registry + op
// set, and EVERY value is a bound parameter — the client never supplies SQL text. Unknown field/op or an
// over-sized/over-nested tree throws (callers return 400). Used by the matches view AND the Jobs database.
// QueryOp/QueryCond/QueryGroup are the canonical shapes in ./types.ts; re-exported here so existing
// importers (server.ts) keep resolving them from db.ts unchanged.
export type { QueryOp, QueryCond, QueryGroup };

// Sanitize a user string into a SAFE FTS5 MATCH query. FTS5 MATCH has its own syntax (AND/OR/NOT,
// quotes, prefix `*`, column filters) — passing raw user text would let a stray quote or operator
// break the query or change its meaning. We tokenize, keep OR/AND/NOT keywords, double-quote every
// other word (neutralizing FTS operators inside it), and allow a trailing `*` for prefix matching.
// Returns null when nothing searchable remains (→ the caller emits a never-match / always-match).
export function sanitizeFts(input: string): string | null {
  const toks = String(input ?? "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const out: string[] = [];
  for (const t of toks) {
    const up = t.toUpperCase();
    if (up === "OR" || up === "AND" || up === "NOT") { out.push(up); continue; }
    const prefix = t.endsWith("*");
    const bare = t.replace(/[*"]/g, "").replace(/[^\p{L}\p{N}\-_]/gu, ""); // letters/numbers/-/_ only
    if (!bare) continue;
    out.push(`"${bare}"${prefix ? "*" : ""}`);
  }
  // Drop a dangling leading/trailing operator so the MATCH is always well-formed.
  while (out.length && ["OR", "AND", "NOT"].includes(out[0]!)) out.shift();
  while (out.length && ["OR", "AND", "NOT"].includes(out[out.length - 1]!)) out.pop();
  return out.length ? out.join(" ") : null;
}
type FieldType = "text" | "enum" | "bool" | "date" | "monitor" | "number" | "list" | "fts" | "tech";
// json_extract expressions read the rich facet set stored on every hiring.cafe/ATS job's raw payload.
// sortMap() (null prototype) for the same reason as every other lookup gate in this file, and
// more so: FIELD_SQL's value is interpolated into SQL TEXT. A query naming the field
// "constructor" or "toString" reached a live Object.prototype member instead of undefined, so the
// "unknown field" guard did not fire and the lookup blew up further in — a 500-class TypeError
// surfaced to the user as a 400. This was the last registry left un-converted.
const FIELD_SQL: Record<string, { expr: string; type: FieldType }> = nullProto({
  anytext: { expr: "", type: "fts" }, // full-text fuzzy across title+company+description (FTS5)
  title: { expr: "j.title", type: "text" }, company: { expr: "j.company", type: "text" },
  description: { expr: "j.description", type: "text" }, location: { expr: "j.location", type: "text" },
  status: { expr: "j.status", type: "enum" }, state: { expr: "j.state", type: "enum" },
  country: { expr: "j.country", type: "enum" }, // ISO alpha-2; NULL = we couldn't tell (not "US")
  source: { expr: "j.source", type: "enum" }, seniority: { expr: "json_extract(j.raw,'$.seniority')", type: "enum" },
  industry: { expr: "json_extract(j.raw,'$.industry')", type: "text" },
  remote: { expr: "j.remote", type: "bool" }, posted: { expr: "j.posted_at", type: "date" },
  starred: { expr: "j.starred", type: "bool" }, // triage: starred jobs
  // numeric facets (comp band, years of experience, company headcount)
  //
  // These are the figures AS POSTED, in whatever currency and pay period the posting stated. They are
  // deliberately not normalised: the app has no exchange rates, and the upstream field that is meant
  // to be annual demonstrably is not (30 rows are hourly wages, and two USD rows are an annual figure
  // that something upstream multiplied by 2,080 as if it were hourly). Inventing a conversion would
  // turn a visible mismatch into an invisible wrong number.
  //
  // `currency` exists so a rule can say what it means — "salary min >= 100000 AND currency is USD".
  // Without it, that first condition alone also returns 393 rows priced in INR, HUF, JPY and 14 other
  // currencies, where 100,000 is nothing like 100,000 dollars.
  salaryMin: { expr: "json_extract(j.raw,'$.comp_min')", type: "number" },
  salaryMax: { expr: "j.comp_max", type: "number" },
  currency: { expr: "j.currency", type: "enum" },
  yoe: { expr: "json_extract(j.raw,'$.yoe')", type: "number" },
  companySize: { expr: "json_extract(j.raw,'$.employees')", type: "number" },
  // tools/tech list (raw.tools is a JSON array) — has/doesn't-have a named tool
  tools: { expr: "json_extract(j.raw,'$.tools')", type: "list" },
  tech: { expr: "", type: "tech" },       // detected technology (job_technologies ⋈ technologies by name)
  monitor: { expr: "", type: "monitor" }, // special: compiles to an EXISTS over matches.client
});
const OPS_BY_TYPE: Record<FieldType, ReadonlySet<QueryOp>> = nullProto({
  text: new Set(["contains", "ncontains", "containsany", "ncontainsany", "word", "nword", "eq", "neq", "empty", "nempty", "matches", "nmatches"]),
  enum: new Set(["is", "isnot", "anyof", "noneof", "empty", "nempty"]),
  bool: new Set(["istrue", "isfalse"]),
  date: new Set(["withindays", "olderdays"]),
  monitor: new Set(["is", "isnot", "anyof", "noneof"]),
  number: new Set(["gte", "lte", "between", "empty", "nempty"]),
  list: new Set(["has", "nhas", "empty", "nempty"]),
  fts: new Set(["matches", "nmatches"]),
  tech: new Set(["has", "nhas", "anyof", "noneof", "empty", "nempty"]),
});
// FTS column filter for a given text field (which raw_jobs column the fuzzy match scopes to).
const FTS_COLUMN: Record<string, string> = sortMap({ title: "title", company: "company", description: "description" });
const isGroup = (n: QueryCond | QueryGroup): n is QueryGroup => Array.isArray((n as QueryGroup).children);
type P = (string | number | bigint | null)[];

/** SQL for "job was produced by one of these monitors/checks". Client-monitoring / watchlist values
 *  are client names (attribution via the matches table); Account Check values are "ac:<check-id>"
 *  (attribution via job_origins, stamped on the jobs a check's run newly inserted). Mixed lists OR
 *  the two EXISTS clauses together. Params are pushed in the same order the placeholders appear. */
function monitorExists(values: string[], out: P): string {
  const clients = values.filter((v) => !v.startsWith("ac:"));
  const checks = values.filter((v) => v.startsWith("ac:"));
  const parts: string[] = [];
  if (clients.length) {
    for (const v of clients) out.push(v);
    parts.push(`EXISTS (SELECT 1 FROM matches m2 WHERE m2.job_id = j.id AND m2.client IN (${clients.map(() => "?").join(",")}))`);
  }
  if (checks.length) {
    for (const v of checks) out.push(v);
    parts.push(`EXISTS (SELECT 1 FROM job_origins o2 WHERE o2.job_id = j.id AND o2.origin IN (${checks.map(() => "?").join(",")}))`);
  }
  return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
}

function compileCond(c: QueryCond, cs: boolean, out: P): string {
  const def = FIELD_SQL[c.field];
  if (!def) throw new Error(`bad filter field: ${c.field}`);
  if (!OPS_BY_TYPE[def.type].has(c.op)) throw new Error(`bad op '${c.op}' for field '${c.field}'`);
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : (v == null || v === "" ? [] : [String(v)]);
  if (def.type === "monitor") { // which run/feature produced the job (matches for monitors, job_origins for account checks)
    const vs = arr(c.value); if (!vs.length) return "1=1";
    const ex = monitorExists(vs, out);
    return (c.op === "isnot" || c.op === "noneof") ? `NOT ${ex}` : ex;
  }
  if (def.type === "tech") { // job mentions one of these detected technologies (matched by name, case-insensitive)
    if (c.op === "empty" || c.op === "nempty") { // has none / has any detected technology at all
      const any = `EXISTS (SELECT 1 FROM job_technologies jt WHERE jt.job_id = j.id)`;
      return c.op === "nempty" ? any : `NOT ${any}`;
    }
    const vs = arr(c.value); if (!vs.length) return "1=1";
    for (const v of vs) out.push(v.toLowerCase());
    const ex = `EXISTS (SELECT 1 FROM job_technologies jt JOIN technologies t ON t.id = jt.tech_id WHERE jt.job_id = j.id AND jslower(t.name) IN (${vs.map(() => "?").join(",")}))`;
    return (c.op === "nhas" || c.op === "noneof") ? `NOT ${ex}` : ex;
  }
  // Fuzzy full-text (FTS5): the `anytext` field matches all columns; a text field's matches/nmatches
  // scopes to that column. Input is sanitized (never raw) before it reaches MATCH.
  if (c.op === "matches" || c.op === "nmatches") {
    if (!ftsReady) return c.op === "matches" ? "1=0" : "1=1"; // no index → matches nothing / excludes nothing
    const q = sanitizeFts(String(c.value ?? ""));
    if (!q) return c.op === "matches" ? "1=0" : "1=1";
    const col = FTS_COLUMN[c.field]; // undefined for anytext → search all columns
    out.push(col ? `${col} : (${q})` : q);
    const ex = `j.id IN (SELECT job_id FROM jobs_fts WHERE jobs_fts MATCH ?)`;
    return c.op === "matches" ? ex : `j.id NOT IN (SELECT job_id FROM jobs_fts WHERE jobs_fts MATCH ?)`;
  }
  const E = def.expr;
  if (def.type === "number") {
    switch (c.op) {
      case "gte": { out.push(Number(c.value) || 0); return `(CAST(${E} AS REAL) >= ?)`; }
      case "lte": { out.push(Number(c.value) || 0); return `(CAST(${E} AS REAL) <= ?)`; }
      case "between": { const [lo, hi] = Array.isArray(c.value) ? c.value : [c.value, c.value]; out.push(Number(lo) || 0, Number(hi) || 0); return `(CAST(${E} AS REAL) BETWEEN ? AND ?)`; }
      case "empty": return `(${E} IS NULL)`;
      case "nempty": return `(${E} IS NOT NULL)`;
    }
    throw new Error(`unhandled numeric op '${c.op}'`);
  }
  if (def.type === "list") { // raw.tools is a JSON array; membership via json_each
    switch (c.op) {
      case "has": case "nhas": {
        const v = String(c.value ?? ""); out.push(v.toLowerCase());
        const ex = `EXISTS (SELECT 1 FROM json_each(${E}) WHERE jslower(json_each.value) = ?)`;
        return c.op === "has" ? ex : `NOT ${ex}`;
      }
      case "empty": return `(${E} IS NULL OR ${E} = '[]')`;
      case "nempty": return `(${E} IS NOT NULL AND ${E} <> '[]')`;
    }
    throw new Error(`unhandled list op '${c.op}'`);
  }
  switch (c.op) {
    case "contains": { const v = String(c.value ?? ""); out.push(cs ? v : v.toLowerCase()); return cs ? `instr(${E}, ?) > 0` : `instr(jslower(${E}), ?) > 0`; }
    case "ncontains": { const v = String(c.value ?? ""); out.push(cs ? v : v.toLowerCase()); return cs ? `(${E} IS NULL OR instr(${E}, ?) = 0)` : `(${E} IS NULL OR instr(jslower(${E}), ?) = 0)`; }
    // Whole-word (exact) contains via the jsword() function — same boundary rules as the matcher's
    // exact keyword mode. Case-insensitivity is handled inside keywordHit (regex /i), so no jslower.
    case "word": { const v = String(c.value ?? ""); out.push(v); return `jsword(${E}, ?) = 1`; }
    case "nword": { const v = String(c.value ?? ""); out.push(v); return `(${E} IS NULL OR jsword(${E}, ?) = 0)`; }
    // Contains ANY / NONE of several values (one condition, multiple needles — the Clay "contains any of").
    case "containsany": case "ncontainsany": {
      const vs = arr(c.value); if (!vs.length) return "1=1";
      const parts = vs.map((v) => { out.push(cs ? v : v.toLowerCase()); return cs ? `instr(${E}, ?) > 0` : `instr(jslower(${E}), ?) > 0`; });
      const any = `(${parts.join(" OR ")})`;
      return c.op === "containsany" ? any : `(${E} IS NULL OR NOT ${any})`;
    }
    case "eq": { const v = String(c.value ?? ""); out.push(cs ? v : v.toLowerCase()); return cs ? `${E} = ?` : `jslower(${E}) = ?`; }
    case "neq": { const v = String(c.value ?? ""); out.push(cs ? v : v.toLowerCase()); return cs ? `(${E} IS NULL OR ${E} <> ?)` : `(${E} IS NULL OR jslower(${E}) <> ?)`; }
    case "empty": return `(${E} IS NULL OR TRIM(${E}) = '')`;
    case "nempty": return `(${E} IS NOT NULL AND TRIM(${E}) <> '')`;
    case "is": case "anyof": { const vs = arr(c.value); if (!vs.length) return "1=1"; for (const v of vs) out.push(v); return `${E} IN (${vs.map(() => "?").join(",")})`; }
    case "isnot": case "noneof": { const vs = arr(c.value); if (!vs.length) return "1=1"; for (const v of vs) out.push(v); return `(${E} IS NULL OR ${E} NOT IN (${vs.map(() => "?").join(",")}))`; }
    case "istrue": return `${E} = 1`;
    case "isfalse": return `${E} = 0`;
    case "withindays": { out.push(`-${Math.max(0, Number(c.value) || 0)} days`); return `(j.posted_at IS NULL OR julianday(j.posted_at) >= julianday(datetime('now', ?)))`; }
    case "olderdays": { out.push(`-${Math.max(0, Number(c.value) || 0)} days`); return `(j.posted_at IS NOT NULL AND julianday(j.posted_at) < julianday(datetime('now', ?)))`; }
  }
  throw new Error(`unhandled op '${c.op}'`);
}
function compileGroup(g: QueryGroup, cs: boolean, out: P, ctx: { n: number; depth: number }): string {
  if (++ctx.depth > 6) throw new Error("filter nested too deeply");
  const parts: string[] = [];
  for (const child of g.children ?? []) {
    if (++ctx.n > 100) throw new Error("filter has too many conditions");
    parts.push(isGroup(child) ? `(${compileGroup(child, cs, out, ctx)})` : compileCond(child, cs, out));
  }
  ctx.depth--;
  if (!parts.length) return "1=1";
  return parts.join(g.combinator === "OR" ? " OR " : " AND ");
}
/** Compile an advanced-filter tree to a parameterized SQL fragment, or null when empty. Throws on a bad
 *  field/op or an over-sized tree (caller → 400). The root's caseSensitive applies to all text ops. */
export function compileQueryTree(root: QueryGroup | undefined | null): { sql: string; params: P } | null {
  if (!root || !Array.isArray(root.children) || !root.children.length) return null;
  const out: P = [];
  const sql = compileGroup(root, !!root.caseSensitive, out, { n: 0, depth: 0 });
  return sql && sql !== "1=1" ? { sql: `(${sql})`, params: out } : null;
}

export interface MatchFilter {
  client?: string; clients?: string[]; source?: string; state?: string; remote?: boolean;
  sinceHours?: number; postedWithinDays?: number; q?: string; limit?: number; offset?: number;
  hideOlderThanDays?: number; // retention "hide" mode: drop jobs older than this (posted_at, else seen_at)
  status?: "open" | "closed"; // filter by job lifecycle
  fuzzy?: boolean;            // route the quick search `q` through FTS5 (stemming + prefix) instead of LIKE
  seniority?: string[];       // quick filter: job seniority level(s) (raw.seniority)
  tech?: string[];            // quick filter: detected technology name(s) — job must mention ANY of them
  starred?: boolean;          // quick filter: starred jobs only
  signalFlags?: string[];     // quick filter: company currently flagged for ANY of these signal producers
  newSince?: string;          // count/filter matches found after this ISO timestamp (unseen)
  query?: QueryGroup;         // advanced visual filter tree (compiled to SQL via compileQueryTree)
  grouped?: boolean;          // collapse to one row per job, aggregating clients (the "All" view)
  sort?: string;              // column sort key (validated whitelist); starred always sorts first
  dir?: "asc" | "desc";
}
// Sortable match columns → their SQL expression (whitelist; text folds case-insensitively, status by
// lifecycle order not alphabetically, NULLs last). Starred always wins as the first tiebreak.
const MATCH_SORTS: Record<string, string> = sortMap({
  matched: "matchedAt", posted: "j.posted_at", company: "jslower(j.company)", title: "jslower(j.title)",
  location: "jslower(j.location)", state: "j.state", salary: "j.comp_max",
  status: "CASE j.status WHEN 'open' THEN 0 ELSE 1 END",
  // The last three columns the postings table showed but would not sort by. `client` groups a monitor's
  // rows together; `description` sorts by how much JD text there is, which is how you find postings that
  // came in without one; `reason` groups by match type (corporate / corporate·org / local).
  client: "jslower(m.client)", description: "LENGTH(COALESCE(j.description, ''))", reason: "jslower(m.match_reason)",
});

// Quick "Technology" filter (job mentions ANY of the selected detected technologies). Shared by the
// matches + Jobs-database WHERE builders. Pushes lowercased names as bound params; returns "" if empty.
function techClause(tech: string[] | undefined, params: (string | number | bigint | null)[]): string {
  if (!tech?.length) return "";
  for (const t of tech) params.push(t.toLowerCase());
  return `EXISTS (SELECT 1 FROM job_technologies jt JOIN technologies t ON t.id = jt.tech_id WHERE jt.job_id = j.id AND jslower(t.name) IN (${tech.map(() => "?").join(",")}))`;
}

function buildWhere(opts: MatchFilter): { clause: string; params: (string | number | bigint | null)[] } {
  const where: string[] = [];
  const params: (string | number | bigint | null)[] = [];
  where.push("m.dismissed = 0"); // hidden (reversibly removed) matches never show on the dashboard
  if (opts.client) { where.push("m.client = ?"); params.push(opts.client); }
  else if (opts.clients) { // scope the "All" view to a set of clients (e.g. one kind/tab)
    if (!opts.clients.length) where.push("1 = 0"); // a kind with no clients → match nothing
    else { where.push("m.client IN (" + opts.clients.map(() => "?").join(",") + ")"); for (const c of opts.clients) params.push(c); }
  }
  if (opts.source) {
    const srcs = opts.source.split(",").map((s) => s.trim()).filter(Boolean);
    if (srcs.length) {
      where.push("(" + srcs.map(() => "j.source LIKE ?").join(" OR ") + ")");
      for (const s of srcs) params.push(s + "%");
    }
  }
  if (opts.state) { where.push("j.state = ?"); params.push(opts.state); }
  if (opts.remote !== undefined) { where.push("j.remote = ?"); params.push(opts.remote ? 1 : 0); }
  if (opts.sinceHours) { where.push("m.created_at >= datetime('now', ?)"); params.push(`-${opts.sinceHours} hours`); }
  if (opts.postedWithinDays) { where.push("(j.posted_at IS NULL OR julianday(j.posted_at) >= julianday(datetime('now', ?)))"); params.push(`-${opts.postedWithinDays} days`); }
  if (opts.hideOlderThanDays) { where.push("julianday(COALESCE(j.posted_at, j.seen_at)) >= julianday(datetime('now', ?))"); params.push(`-${opts.hideOlderThanDays} days`); }
  if (opts.status) { where.push("j.status = ?"); params.push(opts.status); }
  if (opts.q) {
    if (opts.fuzzy && ftsReady) { const fq = sanitizeFts(opts.q); if (fq) { where.push("j.id IN (SELECT job_id FROM jobs_fts WHERE jobs_fts MATCH ?)"); params.push(fq); } }
    else { where.push("(j.title LIKE ? OR j.company LIKE ?)"); params.push(`%${opts.q}%`, `%${opts.q}%`); }
  }
  if (opts.seniority?.length) { where.push("json_extract(j.raw,'$.seniority') IN (" + opts.seniority.map(() => "?").join(",") + ")"); for (const s of opts.seniority) params.push(s); }
  { const tc = techClause(opts.tech, params); if (tc) where.push(tc); } // quick "Technology" filter (any of)
  { const sf = domainFlagExists(opts.signalFlags ?? [], "j"); if (sf) { where.push(sf.clause); for (const x of sf.params) params.push(x); } } // "Company signal" filter
  if (opts.starred) where.push("j.starred = 1"); // quick "Starred only" filter
  if (opts.newSince) { where.push("m.created_at > ?"); params.push(opts.newSince); } // matches found after the given time (unseen)
  const adv = compileQueryTree(opts.query);
  if (adv) { where.push(adv.sql); for (const p of adv.params) params.push(p); }
  return { clause: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

/** Total count for pagination. In grouped mode it's the number of distinct JOBS (one row each),
 *  not the number of (job, client) matches — so a job matched by 4 clients counts once. */
export function countMatches(opts: MatchFilter = {}): number {
  const { clause, params } = buildWhere(opts);
  const sel = opts.grouped ? "COUNT(DISTINCT m.job_id)" : "COUNT(*)";
  const row = db.prepare(`SELECT ${sel} c FROM matches m JOIN raw_jobs j ON j.id = m.job_id ${clause}`).get(...params) as { c: number };
  return row.c;
}

/** Pull a display description out of a stored raw blob: the full scraped JD when present
 *  (org/watchlist/account-check jobs), else the free requirements summary hiring.cafe ships for every
 *  keyword-search job — so a job description is visible in the row wherever any exists. */
export function rawDescription(raw: unknown): string | null {
  let o: unknown;
  try { o = raw ? JSON.parse(String(raw)) : null; } catch { return null; }
  if (!o || typeof o !== "object") return null; // raw stored as "null" / a primitive / unparseable → no description
  const r = o as Record<string, any>;
  // Full scraped JD (org / watchlist / account-check jobs) wins outright.
  if (typeof r.description === "string" && r.description.trim()) return r.description;
  // Else compose a readable description from hiring.cafe's STRUCTURED fields — keyword-search results
  // ship a rich facet set but no raw prose (the detail-page token isn't reachable; see README), so we
  // reconstruct one. Only sections with data are included.
  const arr = (x: unknown): string[] => Array.isArray(x) ? x.filter((y): y is string => typeof y === "string" && !!y.trim())
    : (typeof x === "string" && x.trim() ? [x.trim()] : []);
  const out: string[] = [];
  if (typeof r.requirements_summary === "string" && r.requirements_summary.trim()) out.push(r.requirements_summary.trim());
  const acts = arr(r.role_activities);
  if (acts.length) out.push("Responsibilities:\n" + acts.map((a) => "• " + a).join("\n"));
  const req: string[] = [];
  if (typeof r.yoe === "number" && r.yoe > 0) req.push(`${r.yoe}+ years experience`);
  if (typeof r.seniority === "string" && r.seniority.trim()) req.push(r.seniority);
  if (typeof r.degrees === "string" && r.degrees.trim()) req.push(r.degrees);
  const certs = arr(r.certifications); if (certs.length) req.push("Certifications: " + certs.join(", "));
  const tools = arr(r.tools); if (tools.length) req.push("Tools: " + tools.join(", "));
  const langs = arr(r.languages).filter((l) => !/^english$/i.test(l)); if (langs.length) req.push("Languages: " + langs.join(", "));
  if (req.length) out.push("Requirements:\n" + req.map((x) => "• " + x).join("\n"));
  if (typeof r.comp_min === "number" || typeof r.comp_max === "number") {
    // No invented currency: a number with no currency is shown as a bare number. Labelling a
    // €70,000 salary "USD 70,000" is a wrong figure, and it read as one for every non-US source.
    const cur = typeof r.currency === "string" && r.currency.trim() ? r.currency.trim() : "";
    const n = (v: any) => typeof v === "number" ? v.toLocaleString("en-US") : null; // server locale may be non-US → pin grouping
    const range = (n(r.comp_min) && n(r.comp_max)) ? `${n(r.comp_min)}–${n(r.comp_max)}` : (n(r.comp_min) || n(r.comp_max));
    if (range) out.push(`Compensation: ${cur ? cur + " " : ""}${range}/year`);
  }
  const benefits = arr(r.benefits); if (benefits.length) out.push("Benefits: " + benefits.join(", "));
  return out.length ? out.join("\n\n") : null;
}

// Rich facet columns pulled from raw for the tables + detail drawer (salary band, YOE, headcount,
// industry, seniority, tools JSON). Selected once server-side so the client never parses raw itself.
const FACET_COLS =
  `json_extract(j.raw,'$.comp_min') AS compMin, j.comp_max AS compMax,
   j.currency AS currency, json_extract(j.raw,'$.yoe') AS yoe,
   json_extract(j.raw,'$.employees') AS employees, json_extract(j.raw,'$.industry') AS industry,
   json_extract(j.raw,'$.seniority') AS seniority, json_extract(j.raw,'$.tools') AS toolsJson, j.starred AS starred`;

/** Dashboard query: recent matches joined to job data, filterable + paginated. In grouped mode
 *  (the "All" view) it collapses to ONE row per job and returns `clients` = a comma-joined list of
 *  every client that matched it, so a job shared by N clients shows once with N client tags. */
export function queryMatches(opts: MatchFilter = {}): Array<Record<string, unknown>> {
  const { clause, params } = buildWhere(opts);
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  // Optional column sort (validated whitelist), always after the starred-first tiebreak. Grouped mode
  // uses MAX(m.created_at) for the "matched" key.
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  // In grouped mode the query is GROUP BY j.id, so any key that reads a MATCHES column has to be
  // aggregated — a bare m.client there picks an arbitrary row of the group and orders differently
  // between executions, which is the same non-determinism the j.id tiebreak below exists to prevent.
  const GROUPED_AGG: Record<string, string> = {
    matched: "MAX(m.created_at)", client: "MIN(jslower(m.client))", reason: "MIN(jslower(m.match_reason))",
  };
  const sortCol = opts.sort && MATCH_SORTS[opts.sort]
    ? ((opts.grouped && GROUPED_AGG[opts.sort]) || MATCH_SORTS[opts.sort])
    : null;
  // j.id is the tiebreaker, and it is NOT optional. Every sortable column here is non-unique and
  // created_at is only second-granularity — 11,133 of 11,185 matches share a second with another,
  // and one single second holds 3,325 of them. Without a unique last key SQLite's temp b-tree may
  // order a tie block differently per execution, so paging shows a row twice and skips another.
  const orderBy = (sortCol
    ? `ORDER BY j.starred DESC, ${sortCol} ${dir} NULLS LAST`
    : `ORDER BY j.starred DESC, ${opts.grouped ? "MAX(m.created_at)" : "m.created_at"} DESC`) + ", j.id DESC";
  // TWO STEPS, because a 15-row page used to cost the same as the whole table.
  //
  // Measured on production (16,275 jobs / 11,185 live matches), best-of-4: LIMIT 1 = 281ms,
  // LIMIT 15 = 277ms, LIMIT 200 = 279ms — page size was irrelevant, because the single query hauled
  // j.description (avg 2.6 KB) and eight json_extract(j.raw,…) facet columns (avg raw 3.7 KB) for
  // EVERY matched row before the LIMIT threw all but 15 away. Isolating the cost: ids-only 40ms,
  // +description 111-121ms, +the facet columns 159-200ms. And because node:sqlite is synchronous,
  // the whole server was unresponsive for that window — a concurrent /api/health went from a 2ms
  // median to 543ms.
  //
  // Step 1 pages the identifiers with the SAME FROM / WHERE / GROUP BY / ORDER BY, so filtering,
  // sorting, grouping and the j.id tiebreak are byte-identical to before — but with nothing heavy in
  // the SELECT list. Step 2 then reads the wide columns for just those rows.
  const keyCol = opts.grouped ? "j.id" : "m.rowid";
  const idSql = `
    SELECT ${keyCol} AS k
    FROM matches m JOIN raw_jobs j ON j.id = m.job_id
    ${clause}
    ${opts.grouped ? "GROUP BY j.id" : ""}
    ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;
  const keys = (db.prepare(idSql).all(...params) as Array<{ k: string | number }>).map((r) => r.k);
  if (!keys.length) return [];

  // CHUNKED, because step 2 binds one SQL variable per returned row and SQLite's hard ceiling is
  // 32,766 of them. The CSV export calls this with limit -1 (deliberately unbounded), so the whole
  // export was one query away from a flat failure: measured live at 22,721 non-dismissed matches,
  // 69% of the ceiling, and rising with every fetch. Proved on a scratch copy — at 34,721 rows it
  // throws "too many SQL variables" and the route answers HTTP 400 with a raw SQLite message. No
  // partial file, no warning, the button simply stops working one day.
  //
  // 500 per chunk mirrors dbPurgeOldJobs, and leaves room for the WHERE clause's own parameters
  // (tech / signal / monitor lists bind from the same budget).
  const CHUNK = 500;
  const rows: Array<Record<string, unknown>> = [];
  for (let c = 0; c < keys.length; c += CHUNK) {
    const slice = keys.slice(c, c + CHUNK);
    const ph = slice.map(() => "?").join(",");
    const rowSql = opts.grouped
      ? `
      SELECT GROUP_CONCAT(DISTINCT m.client) as clients, MAX(m.match_reason) as matchReason, MAX(m.matched_on) as matchedOn, MAX(m.created_at) as matchedAt,
             j.id, j.source, j.title, j.company, j.location, j.state, j.remote, j.url, j.posted_at as postedAt,
             j.domain, j.status, j.last_seen_at as lastSeenAt, j.description AS description, ${FACET_COLS}
      FROM matches m JOIN raw_jobs j ON j.id = m.job_id
      ${clause} AND j.id IN (${ph})
      GROUP BY j.id`
      : `
      SELECT m.rowid AS _k, m.client, m.match_reason as matchReason, m.matched_on as matchedOn, m.created_at as matchedAt,
             j.id, j.source, j.title, j.company, j.location, j.state, j.remote, j.url, j.posted_at as postedAt,
             j.domain, j.status, j.last_seen_at as lastSeenAt, j.description AS description, ${FACET_COLS}
      FROM matches m JOIN raw_jobs j ON j.id = m.job_id
      ${clause} AND m.rowid IN (${ph})`;
    rows.push(...(db.prepare(rowSql).all(...params, ...slice) as Array<Record<string, unknown>>));
  }

  // Step 2 has no ORDER BY — re-imposing it would mean duplicating the sort expression and risking
  // drift from step 1. Restore step 1's exact order here instead, which is also stable for the
  // ungrouped path where one job can appear under several matches.
  const byKey = new Map<string | number, Record<string, unknown>>();
  for (const r of rows) { byKey.set(opts.grouped ? (r.id as string) : (r._k as number), r); if (!opts.grouped) delete r._k; }
  return keys.map((k) => byKey.get(k)).filter(Boolean) as Array<Record<string, unknown>>;
}

// ───────────────────────── Companies view (hiring-signal rollup + score) ─────────────────────────
export interface CompanyFilter { client?: string; clients?: string[]; signalFlags?: string[]; q?: string; sort?: string; dir?: "asc" | "desc"; limit?: number; offset?: number }
// `company` must be QUALIFIED. Bare `company` is ambiguous here — raw_jobs and company_domains both
// have a column by that name, and the SELECT adds a third as an output alias — so SQLite rejected the
// whole statement with "ambiguous column name: company" and sorting any of the three company tables
// by their first column answered HTTP 500. Every other key is an output alias unique to this SELECT.
const COMPANY_SORTS: Record<string, string> = sortMap({
  score: "score", company: "jslower(j.company)", openRoles: "openRoles", roles: "roles",
  lastSeen: "lastSeen", firstSeen: "firstSeen", salary: "maxSalary",
  // The two columns the Companies table displayed but would not sort by. Sorting on `domains` groups
  // the ones still missing a website together, which is exactly what the Resolve-domains flow needs.
  domain: "jslower(COALESCE(NULLIF(GROUP_CONCAT(DISTINCT NULLIF(j.domain, '')), ''), cd.domain))",
  monitors: "jslower(GROUP_CONCAT(DISTINCT m.client))",
});
/** One row per hiring company in scope: open roles, monitors that flagged it, salary ceiling, a repeat
 *  flag, first/last seen, and a hiring-signal SCORE (more open roles + repeats + recent posting velocity
 *  rank hotter). Server-side sorted + paginated. `count`=true returns just the group count. */
function companyBase(f: CompanyFilter): { clause: string; params: P } {
  const w: string[] = ["m.dismissed = 0", "j.company IS NOT NULL", "j.company <> ''"];
  const p: P = [];
  if (f.client) { w.push("m.client = ?"); p.push(f.client); }
  else if (f.clients) { if (!f.clients.length) w.push("1=0"); else { w.push("m.client IN (" + f.clients.map(() => "?").join(",") + ")"); for (const c of f.clients) p.push(c); } }
  { const sf = domainFlagExists(f.signalFlags ?? [], "j"); if (sf) { w.push(sf.clause); for (const x of sf.params) p.push(x); } } // "Company signal" filter
  if (f.q) { w.push("(j.company LIKE ? OR j.domain LIKE ?)"); const t = `%${f.q}%`; p.push(t, t); } // search box
  return { clause: "WHERE " + w.join(" AND "), params: p };
}
export function dbCompaniesCount(f: CompanyFilter): number {
  const { clause, params } = companyBase(f);
  return (db.prepare(`SELECT COUNT(*) c FROM (SELECT 1 FROM matches m JOIN raw_jobs j ON j.id = m.job_id ${clause} GROUP BY jslower(j.company))`).get(...params) as { c: number }).c;
}
/** The paged UI's ceiling on ?limit=. It must NOT reach the export path — see below. */
const COMPANY_PAGE_MAX = 200;
export function dbCompanies(f: CompanyFilter): Array<Record<string, unknown>> {
  return companyRows(f, Math.min(f.limit ?? 15, COMPANY_PAGE_MAX), Math.max(f.offset ?? 0, 0));
}
/** One page PLUS its group total, from a single aggregation.
 *  A window function is evaluated before LIMIT, so `COUNT(*) OVER ()` on a grouped query yields the
 *  number of groups in scope, not the number returned. Zero rows genuinely means zero groups. */
export function dbCompaniesPage(f: CompanyFilter): { total: number; items: Array<Record<string, unknown>> } {
  const items = dbCompanies(f);
  const total = items.length ? Number(items[0]?._total ?? 0) : 0;
  for (const r of items) delete r._total;   // internal plumbing, never part of the API shape
  return { total, items };
}
/** limit < 0 emits no LIMIT clause (SQLite reads a negative limit as "no limit"). */
function companyRows(f: CompanyFilter, limit: number, offset: number): Array<Record<string, unknown>> {
  const { clause, params } = companyBase(f);
  const sortKey = COMPANY_SORTS[f.sort ?? "score"] ?? "score";
  const dir = f.dir === "asc" ? "ASC" : "DESC";
  // score = open-role weight + repeat bonus + recent-posting velocity (roles posted in the last 14d),
  // all counted server-side over the group. A company hiring many recent roles ranks hottest.
  const sql = `
    SELECT j.company AS company,
           COALESCE(NULLIF(GROUP_CONCAT(DISTINCT NULLIF(j.domain, '')), ''), cd.domain) AS domains,
           CASE WHEN NULLIF(GROUP_CONCAT(DISTINCT NULLIF(j.domain, '')), '') IS NULL AND cd.domain IS NOT NULL THEN cd.source END AS domainSource,
           GROUP_CONCAT(DISTINCT m.client) AS monitors,
           COUNT(DISTINCT j.id) AS roles,
           SUM(CASE WHEN j.status != 'closed' THEN 1 ELSE 0 END) AS openRoles,
           SUM(CASE WHEN julianday(j.posted_at) >= julianday(datetime('now','-14 days')) THEN 1 ELSE 0 END) AS recentRoles,
           MAX(j.comp_max) AS maxSalary,
           -- The group total, from the SAME pass. /api/companies used to call dbCompaniesCount as a
           -- second, independent full aggregation over the identical join (52-88ms on production) to
           -- learn a number this pass already knows. collapsedSignals uses exactly this trick.
           COUNT(*) OVER () AS _total,
           MAX(j.posted_at) AS lastSeen, MIN(j.seen_at) AS firstSeen,
           (SUM(CASE WHEN j.status != 'closed' THEN 1 ELSE 0 END) * 3
            + SUM(CASE WHEN julianday(j.posted_at) >= julianday(datetime('now','-14 days')) THEN 1 ELSE 0 END) * 2
            + (COUNT(DISTINCT j.id) - COUNT(DISTINCT j.title)) * 2) AS score
    FROM matches m JOIN raw_jobs j ON j.id = m.job_id
    LEFT JOIN company_domains cd ON cd.company_key = jslower(j.company)
    ${clause}
    GROUP BY jslower(j.company)
    ORDER BY ${sortKey} ${dir}, jslower(j.company) ASC
    ${limit < 0 ? "" : `LIMIT ${limit} OFFSET ${offset}`}`;
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}
/** All companies in scope (genuinely no pagination) for CSV / clipboard export and bulk select-all.
 *  This used to call dbCompanies({ limit: 100000 }) — which the 200 page-ceiling silently clamped,
 *  so "export every company" returned 200 of 2,334 and the UI reported success either way. */
export function dbCompaniesForExport(f: CompanyFilter): Array<Record<string, unknown>> {
  const rows = companyRows(f, -1, 0);
  for (const r of rows) delete r._total;   // the page-total window column must never reach the CSV
  return rows;
}

// ───────────────────────── Admin: direct raw_jobs management ─────────────────────────
export interface AdminJobFilter {
  q?: string; fuzzy?: boolean; source?: string; status?: "open" | "closed"; state?: string;
  remote?: boolean; postedWithinDays?: number; hasMatches?: "yes" | "no";
  seniority?: string[];              // quick filter: seniority level(s)
  tech?: string[];                   // quick filter: detected technology name(s) — job must mention ANY of them
  monitor?: string[];               // quick filter: jobs matched by these searches/watchlists (the run that produced them)
  hasDescription?: "yes" | "no";    // quick filter: has a job description or not
  signalFlags?: string[];           // quick filter: company currently flagged for ANY of these signal producers
  query?: QueryGroup;               // advanced visual filter tree
  sort?: string; dir?: "asc" | "desc"; // column sort (validated whitelist)
  limit?: number; offset?: number;
}
function adminWhere(f: AdminJobFilter): { clause: string; params: (string | number | bigint | null)[] } {
  const w: string[] = []; const p: (string | number | bigint | null)[] = [];
  if (f.q) {
    if (f.fuzzy && ftsReady) { const fq = sanitizeFts(f.q); if (fq) { w.push("j.id IN (SELECT job_id FROM jobs_fts WHERE jobs_fts MATCH ?)"); p.push(fq); } }
    else { w.push("(j.title LIKE ? OR j.company LIKE ? OR j.domain LIKE ? OR j.url LIKE ?)"); const t = `%${f.q}%`; p.push(t, t, t, t); }
  }
  if (f.source) { w.push("j.source LIKE ?"); p.push(f.source + "%"); }
  if (f.status) { w.push("j.status = ?"); p.push(f.status); }
  if (f.state) { w.push("j.state = ?"); p.push(f.state); }
  if (f.remote !== undefined) { w.push("j.remote = ?"); p.push(f.remote ? 1 : 0); }
  if (f.postedWithinDays) { w.push("(j.posted_at IS NULL OR julianday(j.posted_at) >= julianday(datetime('now', ?)))"); p.push(`-${f.postedWithinDays} days`); }
  if (f.hasMatches === "yes") w.push("EXISTS (SELECT 1 FROM matches m WHERE m.job_id = j.id)");
  else if (f.hasMatches === "no") w.push("NOT EXISTS (SELECT 1 FROM matches m WHERE m.job_id = j.id)");
  if (f.seniority?.length) { w.push("json_extract(j.raw,'$.seniority') IN (" + f.seniority.map(() => "?").join(",") + ")"); for (const s of f.seniority) p.push(s); }
  { const tc = techClause(f.tech, p); if (tc) w.push(tc); } // quick "Technology" filter (any of)
  if (f.monitor?.length) w.push(monitorExists(f.monitor, p)); // monitors via matches, "ac:<id>" checks via job_origins
  if (f.hasDescription === "yes") w.push("(j.description IS NOT NULL AND TRIM(j.description) <> '')");
  else if (f.hasDescription === "no") w.push("(j.description IS NULL OR TRIM(j.description) = '')");
  { const sf = domainFlagExists(f.signalFlags ?? [], "j"); if (sf) { w.push(sf.clause); for (const x of sf.params) p.push(x); } } // "Company signal" filter
  const adv = compileQueryTree(f.query);
  if (adv) { w.push(adv.sql); for (const x of adv.params) p.push(x); }
  return { clause: w.length ? "WHERE " + w.join(" AND ") : "", params: p };
}
export function dbAdminJobsCount(f: AdminJobFilter): number {
  const { clause, params } = adminWhere(f);
  return (db.prepare(`SELECT COUNT(*) c FROM raw_jobs j ${clause}`).get(...params) as { c: number }).c;
}
const ADMIN_SORTS: Record<string, string> = sortMap({
  seen: "j.seen_at", posted: "j.posted_at", company: "jslower(j.company)", title: "jslower(j.title)",
  location: "jslower(j.location)", status: "CASE j.status WHEN 'open' THEN 0 ELSE 1 END",
  salary: "j.comp_max", source: "j.source",
  matches: "(SELECT COUNT(*) FROM matches m WHERE m.job_id = j.id)",
  // Sorting a description column alphabetically is useless; sorting it by how much text there is
  // is not — it's how you find the records that came in without a scraped JD, which is the actual
  // question anyone asks of that column. Empty and NULL both sort as 0.
  description: "LENGTH(COALESCE(j.description, ''))",
});
export function dbAdminJobs(f: AdminJobFilter): Array<Record<string, unknown>> {
  const { clause, params } = adminWhere(f);
  const limit = Math.min(f.limit ?? 50, 200); const offset = Math.max(f.offset ?? 0, 0);
  const col = f.sort && ADMIN_SORTS[f.sort] ? ADMIN_SORTS[f.sort] : "j.seen_at";
  const dir = f.dir === "asc" ? "ASC" : "DESC";
  const rows = db.prepare(
    `SELECT j.id, j.source, j.external_id AS externalId, j.title, j.company, j.location, j.state, j.remote,
            j.url, j.posted_at AS postedAt, j.seen_at AS seenAt, j.domain, j.status, j.last_seen_at AS lastSeenAt, j.description AS description, ${FACET_COLS},
            (SELECT COUNT(*) FROM matches m WHERE m.job_id = j.id) AS matchCount,
            (SELECT GROUP_CONCAT(DISTINCT m.client) FROM matches m WHERE m.job_id = j.id) AS clients,
            -- "What matched where" across every monitor that matched this job: each match's provenance
            -- JSON, joined by CHAR(30) (never appears in JSON) for the client to parse + union.
            (SELECT GROUP_CONCAT(m.matched_on, char(30)) FROM matches m WHERE m.job_id = j.id AND m.matched_on IS NOT NULL) AS matchedOnAll
     FROM raw_jobs j ${clause} ORDER BY ${col} ${dir} NULLS LAST, j.id DESC LIMIT ${limit} OFFSET ${offset}`,
  ).all(...params) as Array<Record<string, unknown>>; // description is a stored column now
  return rows;
}
/** All jobs matching a filter (no pagination), incl. raw — for CSV export. */
export function dbAdminJobsForExport(f: AdminJobFilter): Array<Record<string, unknown>> {
  const { clause, params } = adminWhere(f);
  return db.prepare(
    // j.raw is NOT selected. The CSV writer reads only the stored `description` column (see the
    // comment there) — the blob averages 3.7 KB per row and was pure transfer: measured 108 MB
    // materialised vs 48 MB without it, and 467ms of SQL vs 342ms, on 16,275 rows.
    // The enrichment the WEBHOOK has always carried and the CSV had not — the other half of the
    // parity gap that channelParity.test.ts exists to catch and only checked for signals.
    //
    // These are json_extract, NOT `j.raw`, and that distinction is what makes them free here. The
    // comment above is about TRANSFER: selecting the blob shipped 3.7 KB per row to JS for fields
    // worth a few bytes. json_extract pulls the value out inside SQLite and returns only the value,
    // so the measured 108 MB → 48 MB saving stands. The same expressions already run in FACET_COLS
    // on the paginated dashboard query, so this adds no new SQL shape.
    `SELECT j.source, j.title, j.company, j.location, j.state, j.remote, j.url,
            j.posted_at AS postedAt, j.seen_at AS seenAt, j.domain, j.status, j.description,
            json_extract(j.raw,'$.seniority') AS seniority,
            json_extract(j.raw,'$.commitment') AS commitment,
            json_extract(j.raw,'$.workplace_type') AS workplaceType,
            j.comp_max AS compMax,
            j.currency AS currency,
            (SELECT COUNT(*) FROM matches m WHERE m.job_id = j.id) AS matchCount,
            (SELECT GROUP_CONCAT(DISTINCT m.client) FROM matches m WHERE m.job_id = j.id) AS clients,
            (SELECT GROUP_CONCAT(t.name, '; ') FROM job_technologies jt JOIN technologies t ON t.id = jt.tech_id WHERE jt.job_id = j.id) AS technologies
     FROM raw_jobs j ${clause} ORDER BY j.seen_at DESC`,
  ).all(...params) as Array<Record<string, unknown>>;
}
/** One job's full editable data. The description comes from the stored column — the same text the
 *  list shows (scraped JD, or composed from hiring.cafe's structured fields for keyword-search jobs);
 *  reading raw.description alone left the editor blank for exactly the rows the grid showed text for. */
export function dbAdminJob(id: string): Record<string, unknown> | null {
  const r = db.prepare("SELECT * FROM raw_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const { raw: _raw, ...rest } = r;
  return { ...rest, description: (r.description as string) ?? null };
}
const ADMIN_COLS = ["title", "company", "location", "state", "url", "posted_at", "domain", "status"] as const;
/** Update editable fields on a job (columns + description-in-raw; dedup_key follows a changed url). */
export function dbUpdateJob(id: string, fields: Record<string, unknown>): boolean {
  const sets: string[] = []; const vals: (string | number | null)[] = [];
  for (const col of ADMIN_COLS) if (col in fields) { sets.push(`${col} = ?`); vals.push((fields[col] as string) ?? null); }
  if ("remote" in fields) { sets.push("remote = ?"); vals.push(fields.remote ? 1 : 0); }
  if ("url" in fields && fields.url) { sets.push("dedup_key = ?"); vals.push(String(fields.url).trim().toLowerCase()); }
  if ("description" in fields) {
    const row = db.prepare("SELECT raw FROM raw_jobs WHERE id = ?").get(id) as { raw: string } | undefined;
    let raw: Record<string, unknown> = {}; try { raw = row?.raw ? JSON.parse(row.raw) : {}; } catch { /* reset */ }
    raw.description = (fields.description as string) || null;
    const rawStr = JSON.stringify(raw);
    sets.push("raw = ?"); vals.push(rawStr);
    sets.push("description = ?"); vals.push(rawDescription(rawStr)); // keep the column in sync with the edit
  }
  if (!sets.length) return false;
  vals.push(id);
  const changed = Number(db.prepare(`UPDATE raw_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes) > 0;
  if (changed) ftsSyncFromRow(id); // keep the search index current with admin edits
  return changed;
}
/** Delete one job + its matches. */
export function dbDeleteJob(id: string): boolean {
  // ONE transaction across all five tables — the same rule dbBulkDeleteJobs and dbPurgeOldJobs
  // already follow, and this single-item path was the one that did not. Anything that interrupted
  // the sequence (an exception, a kill, the auto-shutdown timer) left a job whose matches, tech tags,
  // origins or FTS row were already gone — and an orphaned FTS row still MATCHes a fuzzy search, so
  // a deleted job walks back onto the screen.
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM matches WHERE job_id = ?").run(id);
    db.prepare("DELETE FROM job_origins WHERE job_id = ?").run(id);
    db.prepare("DELETE FROM job_technologies WHERE job_id = ?").run(id);
    if (ftsReady) ftsDel!.run(id);
    const res = db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(id);
    db.exec("COMMIT");
    return Number(res.changes) > 0;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
/** Bulk-delete jobs (+ their matches / origins / tech / FTS rows) by explicit ids OR by a filter.
 *  Returns count removed.
 *
 *  A filter (incl. "delete everything") deletes SET-BASED — one DELETE per child table — instead of
 *  looping per id. node:sqlite is synchronous and single-connection, so a per-row loop over 200k+ jobs
 *  (5 statements each = ~1M executions) blocks the event loop for minutes and freezes the whole UI.
 *  One statement per table clears the same rows in well under a second. Children + FTS go first (their
 *  subquery still resolves against raw_jobs), raw_jobs last. */
export function dbBulkDeleteJobs(opts: { ids?: string[]; filter?: AdminJobFilter }): number {
  // Explicit id selection (a bounded page / multi-select) → per-row loop is fine and keeps the exact count.
  if (opts.ids?.length) {
    const ids = opts.ids;
    const delM = db.prepare("DELETE FROM matches WHERE job_id = ?");
    const delO = db.prepare("DELETE FROM job_origins WHERE job_id = ?");
    const delT = db.prepare("DELETE FROM job_technologies WHERE job_id = ?");
    const delJ = db.prepare("DELETE FROM raw_jobs WHERE id = ?");
    db.exec("BEGIN");
    let gone = 0;
    try {
      // Count what was actually REMOVED, not how many ids were handed in. Returning ids.length
      // reported a deletion for an id that no longer existed (a stale multi-select, a double-click,
      // a row another tab already deleted), and the UI shows that number back to the user as fact.
      for (const id of ids) { delM.run(id); delO.run(id); delT.run(id); if (ftsReady) ftsDel!.run(id); gone += Number(delJ.run(id).changes); }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return gone;
  }
  if (!opts.filter) return 0;
  const { clause, params } = adminWhere(opts.filter);
  const n = (db.prepare(`SELECT COUNT(*) c FROM raw_jobs j ${clause}`).get(...params) as { c: number }).c;
  if (!n) return 0;
  db.exec("BEGIN");
  try {
    if (!clause) {
      // Delete-all fast path: whole-table clears, no subquery needed.
      db.exec("DELETE FROM matches; DELETE FROM job_origins; DELETE FROM job_technologies;");
      if (ftsReady) db.exec("DELETE FROM jobs_fts;");
      db.exec("DELETE FROM raw_jobs;");
    } else {
      const sub = `SELECT j.id FROM raw_jobs j ${clause}`;
      db.prepare(`DELETE FROM matches WHERE job_id IN (${sub})`).run(...params);
      db.prepare(`DELETE FROM job_origins WHERE job_id IN (${sub})`).run(...params);
      db.prepare(`DELETE FROM job_technologies WHERE job_id IN (${sub})`).run(...params);
      if (ftsReady) db.prepare(`DELETE FROM jobs_fts WHERE job_id IN (${sub})`).run(...params);
      db.prepare(`DELETE FROM raw_jobs WHERE id IN (${sub})`).run(...params);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
}
/** Bulk set open/closed status by ids OR filter. Returns count changed. A filter updates SET-BASED
 *  (one UPDATE) rather than looping per id — see dbBulkDeleteJobs for why the loop freezes the UI. */
export function dbBulkSetStatus(status: "open" | "closed", opts: { ids?: string[]; filter?: AdminJobFilter }): number {
  const setClose = "closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, datetime('now')) ELSE NULL END";
  if (opts.ids?.length) {
    const ids = opts.ids;
    const upd = db.prepare(`UPDATE raw_jobs SET status = ?, ${setClose} WHERE id = ?`);
    db.exec("BEGIN");
    let changed = 0;
    // Same honesty rule as dbBulkDeleteJobs: report rows actually updated, not ids submitted. An id
    // that no longer exists changes nothing, and counting it tells the user work happened that did not.
    try { for (const id of ids) changed += Number(upd.run(status, status, id).changes); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
    return changed;
  }
  if (!opts.filter) return 0;
  const { clause, params } = adminWhere(opts.filter);
  const n = (db.prepare(`SELECT COUNT(*) c FROM raw_jobs j ${clause}`).get(...params) as { c: number }).c;
  if (!n) return 0;
  // Scope the UPDATE by the same predicate via id-subquery (adminWhere is written for the `j` alias).
  const sub = `SELECT j.id FROM raw_jobs j ${clause}`;
  db.exec("BEGIN");
  try { db.prepare(`UPDATE raw_jobs SET status = ?, ${setClose} WHERE id IN (${sub})`).run(status, status, ...params); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
}
