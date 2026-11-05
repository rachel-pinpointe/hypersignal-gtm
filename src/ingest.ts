import { getAdapter } from "./sources/index.ts";
import { collectDegraded } from "./sources/degraded.ts";
import { withSourceKey } from "./fetchContext.ts";
import { dbRecordSourceFetch } from "./db.ts";
import { db, upsertJob, upsertMatch, markMatchDeliveredByJobClient, dbUpdateJobRaw, rawDescription, dbStartRun, dbFinishRun, dbSaveAtsProbe, dbIsBoardQuarantined } from "./db.ts";
import { evaluate } from "./matcher.ts";
import { materializeSources } from "./materialize.ts";
import { deliver, isRealtime } from "./delivery.ts";
import { scrapeJobDescription } from "./sources/hiringcafe.ts";
import { gateDescConcurrency } from "./sources/hcGate.ts";
import { atsSourcesForDomains, hcBoardHint, dropQuarantinedJobs, type AtsVendor } from "./sources/ats.ts";
import { normalizeOrgDomain } from "./normalize.ts";
import { Semaphore } from "./sources/browser.ts";
import { fetchStarted, fetchSetTotal, fetchNote, fetchProgress, fetchDone, isFetching, isStopRequested, clientKey } from "./fetchBus.ts";
import type { ClientConfig, RawJob, SourceConfig } from "./types.ts";

// JD scrapes per source-run. DEFAULT UNLIMITED — scrape a full description for EVERY newly-matched
// job that carries a detail URL (the adaptive hiring.cafe gate bounds real load). Set FETCH_DESC_MAX=<n>
// to cap, or FETCH_DESC_MAX=0 to disable JD scraping entirely.
const _fdm = process.env.FETCH_DESC_MAX;
const FETCH_DESC_MAX = (_fdm == null || _fdm === "") ? Infinity : Math.max(0, Number(_fdm));

/** Scrape the full hiring.cafe job description for newly-matched jobs that carry a detail URL
 *  (raw.hc_url), store it in raw.description, and persist it — so the dashboard and webhook carry the
 *  full JD, always. Routed through the adaptive gate, concurrency-limited, capped per call. Best-effort:
 *  a blocked/failed JD just leaves description null. Set FETCH_DESC_MAX=0 to disable. */
async function enrichJobDescriptions(jobs: RawJob[]): Promise<number> {
  if (FETCH_DESC_MAX <= 0) return 0;
  const targets: RawJob[] = [];
  for (const j of jobs) {
    const raw = (j.raw ?? {}) as Record<string, unknown>;
    if (raw.hc_url && !raw.description) targets.push(j);
    if (targets.length >= FETCH_DESC_MAX) break;
  }
  if (!targets.length) return 0;
  const sem = new Semaphore(gateDescConcurrency()); // scales with the Settings speed dial
  let done = 0;
  await Promise.all(targets.map((j) => sem.run(async () => {
    const raw = j.raw as Record<string, unknown>;
    try {
      const text = await scrapeJobDescription(raw.hc_url as string);
      if (text) { raw.description = text; dbUpdateJobRaw(j.id, JSON.stringify(raw)); done++; }
    } catch { /* leave description null — best-effort */ }
  })));
  return done;
}

const JOB_COLS = "id, source, external_id, title, company, location, state, remote, url, posted_at, domain, description";

function rowToJob(r: Record<string, unknown>): RawJob {
  return {
    id: String(r.id), source: String(r.source), externalId: String(r.external_id),
    title: String(r.title), company: (r.company as string) ?? null, location: (r.location as string) ?? null,
    state: (r.state as string) ?? null, remote: !!r.remote, url: String(r.url),
    postedAt: (r.posted_at as string) ?? null, domain: (r.domain as string) ?? null, raw: null,
    description: (r.description as string) ?? null, // stored column → keyword refinement sees the JD
  };
}

/**
 * Re-sync matches between raw_jobs and every active client's CURRENT config. Runs on every reload
 * (startup + after a config create/edit/delete), so an edited filter takes effect against the
 * existing job pool immediately — in BOTH directions:
 *   • ADD    — jobs that now match but aren't recorded yet (a new client, a broadened filter).
 *   • PRUNE  — recorded matches that no longer satisfy the config (a new exclude, a narrowed domain
 *              scope, includeOrgJobs turned off) — so tightening a filter clears stale matches
 *              instead of leaving them stuck on the dashboard. Idempotent.
 *
 *              TWO EXCEPTIONS, and they are worth knowing before you rely on this. Neither applies
 *              to hcorg, ATS boards, Craigslist, SimplyHired or the remote boards — every locally
 *              refined source is pruned in full. Both are about hiring.cafe SEARCH rows, which the
 *              prune evaluates with serverFiltered:true so matcher.ts trusts the filtering
 *              hiring.cafe already did rather than re-running an approximation of it:
 *                • removing a KEYWORD does not prune them — our matcher is phrase-and-prefix based
 *                  and would wrongly drop legitimate semantic matches.
 *                • narrowing the LOCATION does not prune them — geoAllowed is our own model of
 *                  hiring.cafe's place data, and is documented as best-effort.
 *              So narrowing either shrinks what is FETCHED next run, not what is already stored.
 *
 *              Everything else applies in full: excludes, domain scoping, watchlist rules, the
 *              date-posted check, and every hiring.cafe FACET filter (workplace, commitment,
 *              seniority, department, org type, clearance, industry, funding, size, founded, YoE,
 *              salary). The facets are exact rather than approximate — they compare the job's own
 *              stated value — so they run on every source; see the note in matcher.ts.
 *
 *              This block has twice claimed more than the code did. It promised "a removed keyword"
 *              outright, which was false for the source supplying most of the table; and then listed
 *              geo and date as applying in full when both sat behind the trust gate. Date now does
 *              apply everywhere. Geo does not, and says so here.
 * (Matches for deleted clients are removed separately by dbPurgeOrphans.)
 *
 * Runs as a GENERATOR that yields between bounded chunks, so the caller can hand the event loop back
 * between them. node:sqlite is synchronous: whatever this does blocks the whole server, not one route.
 *
 * The previous version loaded every raw_job into a Map — 90.4 MB retained for the whole run at 16,275
 * jobs, measured, and unbounded: it grows with the table. Chunked, the live set is 4 MB over baseline
 * whatever the table size. It also did the entire add + prune inside ONE transaction. That single
 * transaction was there for a real reason: without it node:sqlite autocommits every write separately
 * (an fsync each), and a first backfill of tens of thousands of matches takes MINUTES. One transaction
 * PER CHUNK keeps that win — commits are still hundreds of times rarer than autocommit — while capping
 * both the freeze and peak memory at one chunk's worth, whatever the table size.
 *
 * Chunked commits are safe here specifically because engine.reconcileSteps writes the config
 * fingerprint only AFTER this returns: an interrupted run leaves the fingerprint stale, so the next
 * reload simply redoes it, and the work is idempotent (upsertMatch is INSERT-OR-IGNORE-shaped). All
 * adds run before any prune, so a request landing mid-run sees a SUPERSET of the final state — it may
 * briefly show a match that is about to be pruned, never miss one that should be there.
 */
// Measured on the 16,275-job production snapshot, sweeping chunk size against identical fresh copies:
// total time is FLAT (~750ms) from 200 to 100,000 rows per chunk, so a smaller chunk costs nothing —
// it only shortens the longest uninterrupted block. worst-block by chunk size: 100,000 → 556ms (i.e.
// the old monolithic behaviour), 4,000 → 144ms, 1,000 → 46ms, 400 → 31ms, 200 → 17ms. 250 sits just
// under one 60fps frame, which is the point: the block no longer scales with the table.
export function* backfillMatchesSteps(clients: ClientConfig[], chunkSize = 250): Generator<void, number, void> {
  const active = clients.filter((c) => c.active);
  if (!active.length) return 0; // nothing to add, and prune only ever touches an ACTIVE client's rows
  const byName = new Map(active.map((c) => [c.name, c]));
  let added = 0, removed = 0;
  const touched = new Set<string>();

  // Bound the prune pass to matches that already existed, which reproduces exactly what the old
  // one-shot `existing` snapshot did: rows inserted by THIS run are never re-examined below.
  const highWater = (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM matches").get() as { m: number }).m;

  // ADD: any (job, client) that matches now but isn't recorded yet. serverFiltered is NOT set here:
  // a hiringcafe row must pass the client's own keyword refinement to gain a NEW match — the
  // server-side filtering only vouched for whichever client originally fetched the row.
  // Keyset pagination on the primary key, so each chunk is an index seek, not a growing OFFSET scan.
  const selJobs = db.prepare(`SELECT ${JOB_COLS} FROM raw_jobs WHERE id > ? ORDER BY id LIMIT ?`);
  let jobCursor = "";
  for (;;) {
    const rows = selJobs.all(jobCursor, chunkSize) as Record<string, unknown>[];
    if (!rows.length) break;
    jobCursor = String(rows[rows.length - 1]!.id);
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const job = rowToJob(row);
        for (const client of active) {
          const m = evaluate(job, client);
          if (m && upsertMatch(m)) {
            added++; touched.add(client.name);
            markMatchDeliveredByJobClient(job.id, client.name); // historical → don't fire webhooks
          }
        }
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    yield;
  }

  // PRUNE: recorded matches that no longer satisfy the client's current config. Inactive/deleted
  // clients are skipped here (left to dbPurgeOrphans / their own delete path). serverFiltered IS
  // set: an EXISTING hiringcafe match was either created by this client's own server-filtered fetch
  // or already passed keyword refinement when added — re-running the (phrase-based, best-effort)
  // local keyword check here would wrongly prune legitimate server-semantic matches. Excludes,
  // domain scoping, and watchlist rules still apply in full.
  // Each chunk pulls only the jobs that chunk actually references, instead of the whole table.
  const selMatches = db.prepare("SELECT id, job_id, client FROM matches WHERE id > ? AND id <= ? ORDER BY id LIMIT ?");
  const delMatch = db.prepare("DELETE FROM matches WHERE id = ?");
  let matchCursor = 0;
  for (;;) {
    const batch = selMatches.all(matchCursor, highWater, chunkSize) as { id: number; job_id: string; client: string }[];
    if (!batch.length) break;
    matchCursor = batch[batch.length - 1]!.id;

    const wanted = [...new Set(batch.filter((e) => byName.has(e.client)).map((e) => e.job_id))];
    const jobs = new Map<string, RawJob>();
    if (wanted.length) {
      const rows = db.prepare(`SELECT ${JOB_COLS} FROM raw_jobs WHERE id IN (${wanted.map(() => "?").join(",")})`)
        .all(...wanted) as Record<string, unknown>[];
      for (const r of rows) jobs.set(String(r.id), rowToJob(r));
    }

    db.exec("BEGIN");
    try {
      for (const e of batch) {
        const client = byName.get(e.client);
        if (!client) continue;
        const job = jobs.get(e.job_id);
        if (!job || !evaluate(job, client, { serverFiltered: true })) { delMatch.run(e.id); removed++; touched.add(e.client); }
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    yield;
  }

  if (added || removed) console.log(`[backfill] +${added} matched, -${removed} pruned across ${touched.size} client(s)`);
  return added;
}

/** Straight-through driver, for boot and the CLI — nothing is being served yet, so there is nothing
 *  to yield to. The dashboard path uses backfillMatchesSteps via engine.reloadAsync instead. */
export function backfillMatches(clients: ClientConfig[]): number {
  const run = backfillMatchesSteps(clients);
  let step = run.next();
  while (!step.done) step = run.next();
  return step.value;
}

export interface SourceStats {
  type: string; owner: string; fetched: number; fresh: number; matched: number; error?: string;
  /** This run worked but was INCOMPLETE — a board rejected, a feed dead, a cap hit. See
   *  src/sources/degraded.ts for why "zero jobs" must not be the only thing a broken scraper says. */
  warnings?: string[];
}

/**
 * Run one source once. New jobs are matched against EVERY active client
 * (multi-tenant: a single posting can match several clients).
 */
export async function runSource(owner: string, source: SourceConfig, clients: ClientConfig[], scheduled = false): Promise<SourceStats> {
  const label = `${source.type}@${owner}`;
  if (source.enabled === false) return { type: source.type, owner, fetched: 0, fresh: 0, matched: 0, error: "disabled" };
  const adapter = getAdapter(source.type);
  if (!adapter) return { type: source.type, owner, fetched: 0, fresh: 0, matched: 0, error: "no adapter" };

  let fetched = 0, fresh = 0, matched = 0;
  let degraded: string[] = [];
  try {
    // Everything stored below is attributed to THIS source, and a clean finish records that this
    // source looked. Together those are what let dbSweepClosed tell "the posting is gone" from
    // "nobody fetched" — see that function for what the old date-only rule was about to do.
    return await withSourceKey(label, async () => {
      // Scheduled runs fetch incrementally (newest-first + stop at the first fully-stored page);
      // manual fetches keep full depth.
      const { result: fetchedJobs, warnings } = await collectDegraded(() =>
        adapter(scheduled ? { ...source, incremental: true } : source));
      degraded = warnings;
      // Phase 21: drop every job that comes from a quarantined (wrong-company) board for its domain,
      // whichever lane delivered it. hiring.cafe files the wrong Clasp's jobs (jobs.ashbyhq.com/clasp,
      // a benefits company) under clasp.com exactly like the ATS lane did, so filtering only the ATS
      // adapter would leave the same wrong jobs arriving through hcorg.
      const jobs = dropQuarantinedJobs(fetchedJobs);
      if (jobs.length < fetchedJobs.length) {
        console.log(`[ingest] ${source.type}: dropped ${fetchedJobs.length - jobs.length} job(s) from quarantined boards`);
      }
      fetched = jobs.length;
      // Phase 15: hiring.cafe already knows which ATS board a job lives on and its real slug
      // (raw.ats, stamped by mapHit) — ground truth a guessed slug can miss entirely (Scale AI's
      // real Greenhouse tenant is "scaleai", not the guessed "scale"). Learn it here, once per
      // unique domain per run (not once per job — Betterment alone would be 25 identical writes),
      // so the NEXT run can fetch that board directly instead of going through hiring.cafe again.
      if (source.type === "hcorg" || source.type === "hiringcafe") {
        const learned = new Map<string, { vendor: AtsVendor; slug: string }>();
        for (const j of jobs) {
          if (!j.domain || learned.has(j.domain)) continue;
          const hint = hcBoardHint(j.raw);
          // Phase 21: never relearn a board that is quarantined for this domain.
          if (hint && !dbIsBoardQuarantined(normalizeOrgDomain(j.domain), hint.vendor, hint.slug)) learned.set(j.domain, hint);
        }
        for (const [domain, hint] of learned) dbSaveAtsProbe(domain, [hint], [hint.vendor]);
      }
      const matchedNew: RawJob[] = [];
      // Process in CHUNKS: each chunk runs inside one transaction (one fsync instead of one per job —
      // upsertJob does tech-tagging + FTS sync, so a 4k-job source used to autocommit 4k times), and we
      // YIELD the event loop between chunks so queued HTTP requests (the dashboard) get served instead of
      // starving behind a long synchronous burst — the "every page shows an infinite skeleton while a
      // fetch runs" bug. node:sqlite is synchronous; this is the only way to share the single thread.
      // 50 keeps commits ~50× rarer than per-job autocommit while yielding often enough that even
      // 8 parallel source workers can't stack multi-second synchronous stretches between yields.
      const CHUNK = 50;
      for (let c = 0; c < jobs.length; c += CHUNK) {
        const slice = jobs.slice(c, c + CHUNK);
        db.exec("BEGIN");
        try {
          for (const job of slice) {
            if (!upsertJob(job)) continue; // dupe
            fresh++;
            // Give the matcher the same description text upsertJob just stored, so OTHER clients' keyword
            // refinement can see the posting body (title-only phrase matching is too brittle).
            if (job.description == null) job.description = rawDescription(JSON.stringify(job.raw ?? null));
            let matchedAny = false;
            for (const client of clients) {
              if (!client.active) continue;
              // Only the client whose search fetched this source may trust hiring.cafe's server-side
              // filtering; every other client applies its own keyword/geo refinement (no cross-client leaks).
              const m = evaluate(job, client, { serverFiltered: client.name === owner });
              if (m && upsertMatch(m)) { matched++; matchedAny = true; }
            }
            if (matchedAny) matchedNew.push(job);
          }
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        if (c + CHUNK < jobs.length) await new Promise((r) => setImmediate(r)); // let the dashboard breathe
      }
      await enrichJobDescriptions(matchedNew); // full JDs for new matches → dashboard + webhook
      // Recorded ONLY on the success path. A run that threw proves nothing about what is still listed,
      // and recording it would license the sweep to close everything that run failed to see.
      dbRecordSourceFetch(label);
      console.log(`[ingest] ${label.padEnd(24)} fetched=${fetched} new=${fresh} matched=${matched}${degraded.length ? ` DEGRADED: ${degraded.length}` : ""}`);
      return { type: source.type, owner, fetched, fresh, matched, ...(degraded.length ? { warnings: degraded } : {}) };
    });
  } catch (e) {
    return { type: source.type, owner, fetched, fresh, matched, error: (e as Error).message, ...(degraded.length ? { warnings: degraded } : {}) };
  }
}

export interface FetchProgress {
  index: number; total: number; source: string; phase: "start" | "done";
  completed?: number; // sources finished so far (sources run in parallel, so completion order ≠ index)
  fetched?: number; fresh?: number; matched?: number; error?: string;
}

/**
 * Run all of ONE client's sources (for the manual "Fetch New Jobs" button), reporting progress per
 * source. New jobs still match against every client.
 *
 * Sources run CONCURRENTLY: a 15-keyword search fetches several keywords at once instead of
 * one-at-a-time. Real hiring.cafe concurrency is bounded by the adaptive gate (src/sources/hcGate),
 * which ramps up when healthy and backs off on a block — so this goes fast without hammering. Safe
 * because JS is single-threaded and the DB writes inside runSource are synchronous: only the network
 * scraping overlaps, never the per-source matching/upserts. Progress is reported by completion count.
 */
export async function runClientSources(
  client: ClientConfig, allClients: ClientConfig[], onProgress?: (p: FetchProgress) => void,
  opts: { scheduled?: boolean } = {},
): Promise<{ fetched: number; fresh: number; matched: number; sources: SourceStats[]; skipped?: boolean; stopped?: boolean }> {
  // Never overlap two runs of the SAME client (e.g. a manual fetch while its scheduled one is mid-flight).
  const key = clientKey(client.name);
  if (isFetching(key)) return { fetched: 0, fresh: 0, matched: 0, sources: [], skipped: true };
  // Claim the key in the SAME synchronous step as the check above — this used to happen ~20 lines
  // later, after an awaited ATS-discovery step that runs six concurrent probes at 15s each. A manual
  // "Fetch New Jobs" landing inside that window ran the whole watchlist twice, and once run 1's
  // fetchDone() removed the key, isFetching() reported false while run 2 was still in flight, so the
  // guard stayed defeated for further starts. The real unit total is set once discovery is done.
  fetchStarted(key, { client: client.name, kind: client.kind ?? "search", total: 0 });
  let enabled: SourceConfig[];
  try {
    enabled = materializeSources(client); // standardized search → concrete adapter configs
    // Direct ATS boards (Greenhouse/Lever/Ashby) for the client's watched domains — discovered once and
    // cached. These pull each company's live jobs straight from the source (full descriptions, free) and
    // dedup against the hiring.cafe /org/ rows. Opt out per client with search.useAts === false.
    const orgDomains = (client.search?.orgDomains ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
    if (orgDomains.length && client.search?.useAts !== false) {
      try {
        const maxPages = Number((enabled.find((s) => s.type === "hcorg")?.maxPages) ?? 25);
        // Name this phase on screen. It runs before any job is fetched, so fetched/fresh/matched are
        // all zero for its whole duration and the unit total is not known yet — the dock had nothing
        // to show but "0 new jobs found", which reads as a hang rather than as work.
        const fmt = (n: number) => n.toLocaleString("en-US");
        fetchNote(key, `Looking for job boards at ${fmt(orgDomains.length)} companies — no jobs are fetched until this finishes`);
        const ats = await atsSourcesForDomains(orgDomains, maxPages, "0 * * * *",
          (done, total) => fetchNote(key, `Looking for job boards: ${fmt(done)} of ${fmt(total)} companies checked — no jobs are fetched until this finishes`),
          () => isStopRequested(key)); // graceful stop can interrupt discovery — the longest phase
        // Phase 15: PREPEND, not append. ATS boards are fast, free and unthrottled — the whole
        // point of fetching them directly — but a big watchlist's hcorg chunks are the opposite
        // (hiring.cafe's own rate limiting measured as low as ~75 companies/hour, see the Phase 14
        // doc), and the worker pool below claims sources in array order. Appending put every ATS
        // source behind potentially hundreds of slow hcorg chunks, so on a run that stalls or gets
        // killed before finishing — the CURRENT normal case for the full watchlist — a board that
        // was just discovered (or just learned from a hiring.cafe hit, see runSource) could go a
        // full cycle without ever actually being fetched. This is what made Betterment's Greenhouse
        // board show found=1 in the cache with zero rows ever ingested under that source: discovery
        // reached it, the fetch never got its turn. Prepending guarantees the fast, free lane always
        // runs regardless of how badly the slow lane behind it stalls.
        if (ats.length) {
          // Phase 16: skip hiring.cafe entirely for domains an ATS source already covers directly.
          // A confirmed board makes the matching hcorg fetch pure redundant load on hiring.cafe --
          // and every domain NOT sent to hcorg is one less domain competing for hiring.cafe's
          // currently-throttled capacity (Phase 14 doc: ~75 companies/hour under active blocking;
          // the 2026-09-20/21 run did far worse and was watchdog-killed after 24h with only 33
          // companies covered -- see the tracker). `ats` is this run's fresh discovery result, so
          // this set is never stale cache, and Phase 15's own dbSaveAtsProbe upsert plus the TTL in
          // discoverAndCacheAts (positive 24h) mean a domain that stops resolving here falls back to
          // hcorg again automatically once its cached board goes stale or negative.
          const atsDomains = new Set(ats.map((s) => normalizeOrgDomain(String((s as { domain?: unknown }).domain ?? ""))).filter(Boolean));
          let skipped = 0;
          enabled = enabled.filter((src) => {
            if (src.type !== "hcorg") return true;
            if (Array.isArray(src.domains)) {
              const before = (src.domains as string[]).length;
              src.domains = (src.domains as string[]).filter((d) => !atsDomains.has(normalizeOrgDomain(d)));
              skipped += before - (src.domains as string[]).length;
              return (src.domains as string[]).length > 0; // drop a chunk hollowed out entirely
            }
            if (typeof src.domain === "string" && atsDomains.has(normalizeOrgDomain(src.domain))) {
              skipped += 1;
              return false;
            }
            return true;
          });
          enabled.unshift(...ats);
          console.log(`[ats] +${ats.length} board(s) for ${client.name}, run first` + (skipped ? `; skipped hiring.cafe for ${skipped} domain(s) with a confirmed board` : ""));
        }
      } catch (e) { console.warn(`[ats] discovery failed for ${client.name}: ${(e as Error).message}`); }
    }
  } catch (e) {
    fetchDone(key, { fetched: 0, fresh: 0, matched: 0 }, (e as Error).message); // release the claim
    throw e;
  }
  const total = enabled.length;
  const sources: SourceStats[] = new Array(total);
  // Progress is reported in "units" so the bar is meaningful per client type: a keyword source is 1 unit,
  // but a chunked watchlist source counts each of its domains — so the feed shows "1247/4575 accounts"
  // rather than an opaque "12/183 chunks". Searches are unaffected (every source weighs 1).
  const unitsOf = (src: SourceConfig) => Array.isArray(src.domains) ? Math.max(1, src.domains.length) : 1;
  const totalUnits = enabled.reduce((s, src) => s + unitsOf(src), 0);
  let fetched = 0, fresh = 0, matched = 0, completed = 0, doneUnits = 0;
  // Discovery is over and the counters can move again — a note describing a finished step is
  // worse than none, because it keeps claiming nothing is being fetched while jobs are arriving.
  fetchNote(key, null);
  fetchSetTotal(key, totalUnits); // real unit count now that discovery is done (claim was taken above)
  const runId = dbStartRun(key, client.name, client.kind ?? "search"); // run-history row (System panel)
  try {
    // Sources run through a bounded worker pool, not an unbounded Promise.all. A keyword search has a
    // handful of sources (runs them all at once, as before), but a chunked watchlist has hundreds — and
    // firing every chunk simultaneously floods the adaptive gate into cascading cooldowns and makes the
    // progress bar jump only at the very end. The pool keeps a steady few chunks in flight, so progress
    // advances smoothly and matches persist incrementally. Tunable via FETCH_SOURCE_CONCURRENCY.
    const POOL = Math.max(1, Number(process.env.FETCH_SOURCE_CONCURRENCY) || 8);
    let next = 0;
    let lastProgressAt = Date.now();
    const worker = async () => {
      for (let i = next++; i < total; i = next++) {
        // Graceful stop: a worker that has finished its current source stops claiming new ones, so
        // in-flight scrapes complete and their matches persist while the queued sources are skipped.
        if (isStopRequested(key)) break;
        const source = enabled[i]!;
        onProgress?.({ index: i, total, source: source.type, phase: "start" });
        const st = await runSource(client.name, source, allClients, opts.scheduled === true);
        sources[i] = st; // keep input order; completion order is nondeterministic
        fetched += st.fetched; fresh += st.fresh; matched += st.matched; completed++; doneUnits += unitsOf(source);
        lastProgressAt = Date.now();
        onProgress?.({ index: i, total, completed, source: source.type, phase: "done", fetched: st.fetched, fresh: st.fresh, matched: st.matched, error: st.error });
        fetchProgress(key, { completed: doneUnits, fetched, fresh, matched });
      }
    };
    // Stall watchdog, added 2026-09-21 after the 2026-09-20/21 run: 33 companies got real job data in
    // the first ~4h46m, then the whole run went completely silent (no more completions, no error, no
    // crash) for the remaining ~19h until the 24h force-kill watchdog in run-cron.sh finally caught it.
    // An earlier attempt to fix the presumed cause directly (a wedged CDP `ctx.close()` in the browser
    // fallback lane, commit 9cea720) did NOT stop the very next run from freezing the same way -- so
    // rather than keep guessing at WHERE inside a single source a hang can happen, this watches for the
    // *symptom* instead: no source anywhere in the pool has finished in STALL_TIMEOUT_MS. With POOL
    // concurrent chunks in flight, real (even badly throttled) progress should produce SOME completion
    // well inside that window; total silence across every worker for that long is the same "stuck, not
    // slow" signature both real incidents showed. Deliberately coarse (default 30 min, tune via
    // STALL_TIMEOUT_MS) rather than tightly calibrated -- the goal is bounding "up to 24 hours of nothing"
    // down to "tens of minutes of nothing," not proving where the hang lives. Firing here throws, which
    // the existing catch below already turns into a clean per-client failure (fetchDone/dbFinishRun with
    // an error, then rethrown) -- runAllOnce already treats one client's failure as non-fatal to the rest,
    // so `npm run cycle` returns and the rest of run-cron.sh's steps get their turn the same day, instead
    // of the whole process sitting frozen until the 24h watchdog. Whatever completed before the stall is
    // already persisted (each source commits its own matches), so nothing already-fetched is lost.
    // NOTE: this does not force-kill an already-wedged browser subprocess -- a genuinely stuck child
    // process may still need `npm run cycle`'s own exit (cli.ts calls process.exit(0) right after) to
    // actually go away. Worth watching whether orphaned browser processes accumulate on repeat stalls.
    const STALL_TIMEOUT_MS = Math.max(60_000, Number(process.env.STALL_TIMEOUT_MS) || 30 * 60 * 1000);
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const stallWatch = new Promise<never>((_, reject) => {
      const check = () => {
        const idleMs = Date.now() - lastProgressAt;
        if (idleMs >= STALL_TIMEOUT_MS) {
          reject(new Error(`stalled: no source has completed in ${Math.round(idleMs / 60000)} min (ceiling ${Math.round(STALL_TIMEOUT_MS / 60000)} min) -- aborting this client's run rather than hanging indefinitely; everything fetched before the stall is already saved`));
          return;
        }
        stallTimer = setTimeout(check, 30_000);
      };
      stallTimer = setTimeout(check, 30_000);
    });
    try {
      await Promise.race([Promise.all(Array.from({ length: Math.min(POOL, total) }, () => worker())), stallWatch]);
    } finally {
      clearTimeout(stallTimer);
    }
    // Delivery is best-effort and must not fail the fetch: the scraping succeeded and every match is
    // already persisted — a webhook hiccup just leaves them queued (delivered = 0) for the next run.
    // Letting it throw here marked the whole fetch "error" in the feed AND escaped as an unhandled
    // rejection on the scheduled (cron) path, which has no catch of its own.
    if (isRealtime(client)) {
      try { await deliver(client); }
      catch (e) { console.error(`[deliver] ${client.name}: ${(e as Error).message} (matches saved; webhook will retry next run)`); }
    }
    // Every source's degradation notes roll up onto the run, so 'this fetch was incomplete' is
    // visible in the Fetch history rather than only in a console line nobody reads.
    const warnings = sources.flatMap((s) => s?.warnings ?? []);
    const stopped = isStopRequested(key);
    if (stopped) warnings.push("Stopped by request — queued sources were skipped; partial results kept");
    fetchDone(key, { fetched, fresh, matched }, undefined, stopped);
    dbFinishRun(runId, { fetched, fresh, matched, warnings });
    return { fetched, fresh, matched, sources, stopped };
  } catch (e) {
    fetchDone(key, { fetched, fresh, matched }, (e as Error).message);
    dbFinishRun(runId, { fetched, fresh, matched, error: (e as Error).message });
    throw e;
  }
}

/** Run every active client's materialized sources once. One client failing must not abort the rest. */
export async function runAllOnce(clients: ClientConfig[]): Promise<SourceStats[]> {
  const stats: SourceStats[] = [];
  for (const client of clients) {
    if (!client.active) continue;
    try {
      const r = await runClientSources(client, clients, undefined, { scheduled: true });
      stats.push(...r.sources);
    } catch (e) { console.error(`[ingest] ${client.name} run failed: ${(e as Error).message}`); }
  }
  return stats;
}
