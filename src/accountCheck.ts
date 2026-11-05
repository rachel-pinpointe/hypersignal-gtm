// Account check: "are these companies hiring for this role?" Input is a CSV of company DOMAINS.
//
// Each domain is looked up deterministically via hiring.cafe's /org/<domain> route (no fuzzy name
// matching). The matcher then applies the user's role/seniority/date/keyword filters, results are
// CACHED per domain so repeat checks are near-instant, and (optionally) each matched role's full
// description is scraped from its hiring.cafe detail page.
import { createHash } from "node:crypto";
import { Semaphore } from "./sources/browser.ts";
import { hcCooldownWait, gateDescConcurrency } from "./sources/hcGate.ts";
import { scrapeHiringCafeOrg, scrapeJobDescription } from "./sources/hiringcafe.ts";
import { discoverAndCacheAts, atsAdapter } from "./sources/ats.ts";
import { normalizeOrgDomain, isDomainShaped } from "./normalize.ts";
import { dbGetAccountCache, dbSetAccountCache, upsertJob, dbTagJobOrigin, dbTransaction, rawDescription } from "./db.ts";
import { evaluate, specNeedsDescription } from "./matcher.ts";
import type { ClientConfig, RawJob, SearchSpec } from "./types.ts";

const CONCURRENCY = Math.max(1, Number(process.env.ACCOUNT_CONCURRENCY ?? 8));  // parallel browser sessions
const MAX_RETRIES = Math.max(0, Number(process.env.ACCOUNT_RETRIES ?? 3));      // retries for a blocked fetch
// Description fetches per run. DEFAULT UNLIMITED — scrape every matched role's JD (the gate bounds
// load). Set ACCOUNT_DESC_MAX=<n> to cap.
const _adm = process.env.ACCOUNT_DESC_MAX;
const DESC_MAX = (_adm == null || _adm === "") ? Infinity : Math.max(0, Number(_adm));
// Parallel description fetches: env override, else the speed-dial profile (gentle 4 / normal 8 / aggressive 12).
// Same batch size ingest.ts uses, for the same reason — see record() below.
const CHUNK = 50;
const descConcurrency = () => process.env.ACCOUNT_DESC_CONCURRENCY
  ? Math.max(1, Number(process.env.ACCOUNT_DESC_CONCURRENCY)) : gateDescConcurrency();
/** Read-side freshness for account_cache. Exported so the daily maintenance evicts on exactly
 *  the same clock it reads on — an eviction window shorter than this would throw away rows still in
 *  use, and one longer leaves rows nothing can ever read. */
export const CACHE_TTL_HOURS = Math.max(1, Number(process.env.ACCOUNT_CACHE_HOURS ?? 12));

/** Fetch ALL of one company's jobs: hiring.cafe /org/<domain> PLUS any direct ATS boards
 *  (Greenhouse/Lever/Ashby) the domain publishes (full descriptions, free). Deterministic — no name
 *  matching. The two sources are merged; dedup by URL happens in record(). */
/** Returns the jobs AND whether the lookup actually succeeded.
 *
 *  Every failure used to collapse to `[]` and never rethrow, and no result type carried an error, so
 *  "we checked and nobody is hiring" and "we could not check" were byte-identical: status done,
 *  error null, found 0. A hiring.cafe outage or a sustained IP block would report every domain in a
 *  10,000-row check as not-hiring, with the run finishing green. The sibling module already models
 *  this properly — SignalCheckDomainResult.errors renders a per-domain warning in the grid. */
async function fetchOrgJobs(
  domain: string, maxPages: number, shouldStop?: () => boolean,
): Promise<{ jobs: RawJob[]; errors: string[] }> {
  const errors: string[] = [];
  const hc = (async () => {
    for (let attempt = 0; ; attempt++) {
      if (shouldStop?.()) return [] as RawJob[];
      try {
        return await scrapeHiringCafeOrg(domain, maxPages, { shouldStop,
          // The page limit, not the end of the company's list, is what stopped the scan. Say it against
          // THIS company's row: "142 openings" and "142 of 2,885 openings" are different answers, and
          // the check had no way to tell them apart. Reachable on live data — fedex.com (2,885) and
          // ups.com (2,405) both exceed the 90-page default.
          onTruncated: ({ collected, total }) =>
            errors.push(`only the first ${collected} of ${total} openings were read — raise the page limit to see the rest`),
        });
      }
      catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const blocked = msg.includes("blocked");
        if (blocked && attempt < MAX_RETRIES) { await hcCooldownWait(); continue; }
        console.warn(`[account] ${domain} hiring.cafe lookup failed: ${msg}`);
        errors.push(`hiring.cafe: ${msg.slice(0, 120)}`);
        return [] as RawJob[];
      }
    }
  })();
  const ats = (async () => {
    if (shouldStop?.()) return [] as RawJob[];
    try {
      const boards = await discoverAndCacheAts(domain);
      const lists = await Promise.all(boards.map((b) => atsAdapter({ type: "ats", interval: "", vendor: b.vendor, slug: b.slug, domain, maxPages })));
      return lists.flat();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      console.warn(`[account] ${domain} ATS lookup failed: ${msg}`);
      errors.push(`ATS: ${msg.slice(0, 120)}`);
      return [] as RawJob[];
    }
  })();
  const [a, b] = await Promise.all([hc, ats]);
  return { jobs: [...a, ...b], errors };
}

export interface AccountHit {
  input_company: string; matched_company: string | null; title: string;
  location: string | null; state: string | null; remote: boolean;
  posted_at: string | null; status: string; url: string; source: string;
  ats: string | null; industry: unknown; seniority: unknown; reason: string;
  matchedOn?: import("./types.ts").MatchedOn[]; // what matched where (term + field)
  description?: string | null;       // full job description (only when scrapeDescriptions is on)
  hc_url?: string | null;            // hiring.cafe detail URL (for description scraping)
}
export interface CompanyResult { input: string; matched: number; companyNames: string[]; hits: AccountHit[];
  /** Non-empty when the lookup FAILED rather than found nothing — the UI must not read matched:0 as
   *  "not hiring" when this is set. Mirrors SignalCheckDomainResult.errors. */
  errors?: string[] }

/** Build an AccountHit from a matched RawJob. `input` is the user's row (a normalized domain). */
function toHit(input: string, j: RawJob, reason: string, matchedOn?: import("./types.ts").MatchedOn[]): AccountHit {
  const raw = (j.raw ?? {}) as Record<string, unknown>;
  return {
    input_company: input, matched_company: j.company, title: j.title,
    location: j.location, state: j.state, remote: j.remote, posted_at: j.postedAt,
    status: j.status ?? "open", url: j.url, source: j.source,
    ats: (raw.ats as string) ?? null, industry: raw.industry ?? null, seniority: raw.seniority ?? null,
    reason, ...(matchedOn?.length ? { matchedOn } : {}),
    description: (raw.description as string) ?? null, hc_url: (raw.hc_url as string) ?? null,
  };
}

/** A progress snapshot: cumulative counters + the hits discovered since the last event (newHits). */
export interface AccountProgress { checked: number; total: number; found: number; totalHits: number; newHits: AccountHit[] }
export interface RunOptions {
  maxPages?: number;
  control?: { stopped: boolean };               // flip .stopped to cancel remaining domains
  onProgress?: (p: AccountProgress) => void;
  scrapeDescriptions?: boolean;                 // fetch each matched job's full description
  originTag?: string;                           // "ac:<check-id>" — stamp jobs this run NEWLY inserts (Jobs-database attribution)
}

/** Build a throwaway ClientConfig so we can reuse evaluate() for keyword/date/geo/exclude filtering. */
function searchClient(search: SearchSpec): ClientConfig {
  return { name: "_accountcheck", active: true, search };
}

interface AcItem { name: string; key: string; norm: string }

/**
 * Run the check: scan each company's deterministic /org/<domain> page, filter the openings with the
 * matcher (role keywords / seniority / date / geo / excludes), and stream hits via onProgress.
 * Per-domain cached (any filter change → different key → fresh fetch). Optionally scrapes each matched
 * job's full description. Cooperatively cancellable via opts.control.stopped (in-flight work finishes).
 */
export async function runAccountCheck(
  domains: string[], search: SearchSpec, opts: RunOptions = {},
): Promise<CompanyResult[]> {
  const maxPages = opts.maxPages ?? 8;
  const control = opts.control;
  const onProgress = opts.onProgress;
  const scrapeDesc = !!opts.scrapeDescriptions;
  // When the filters MATCH on description/technology, the JD must be attached BEFORE the matcher runs,
  // or a body-only keyword can never match (this path only scraped descriptions for already-matched
  // jobs). needDesc forces the full-JD pass regardless of the display-only scrapeDescriptions option.
  const needDesc = specNeedsDescription(search);
  const fetchDesc = scrapeDesc || needDesc;
  const client = searchClient(search);
  // THE CACHE KEY IS WHAT CHANGES THE FETCHED BYTES — nothing else.
  //
  // It used to be a hash of the whole searchState, which was wrong in both directions at once.
  //
  // Too broad: an /org/<domain> scan takes NO filter parameters. Workplace, seniority, salary,
  // department and the rest are applied afterwards by the matcher, so changing one produced a
  // byte-identical fetch under a brand-new key. Tweaking a single filter therefore discarded the
  // entire cache and re-scraped every company — on a 1,280-domain check, hours of scraping to
  // recompute a local filter.
  //
  // Too narrow, and this is the correctness half: maxPages and scrapeDescriptions DO change what
  // comes back, and neither was in the key. They live on RunOptions rather than the SearchSpec that
  // was being hashed. So raising the page limit to reach the rest of a big company replayed the same
  // truncated list it had already stored — the user asks for more and is handed the old answer — and
  // turning descriptions on replayed rows cached without them.
  //
  // Keywords and excludes are absent for the RIGHT reason: cache hits go through record(), which
  // runs the matcher, so changing them re-filters the cached jobs correctly with no refetch.
  // fetchDesc (not scrapeDesc) keys the cache: a description-matching run fetches bodies a plain run
  // did not, so it must not replay a body-less cached entry (which would drop its body-only matches).
  const fetchShape = `p${maxPages}|d${fetchDesc ? 1 : 0}`;
  const facetKey = createHash("sha1").update(fetchShape).digest("hex").slice(0, 16);

  // de-dupe input rows → cache keys, normalizing each to its bare registrable domain
  const seenKey = new Set<string>();
  const items: AcItem[] = [];
  // A line that is not a domain is REPORTED, not silently dropped — same rule as the signal check.
  // normalizeOrgDomain reduces, it does not validate: "www." survives as "www", ".com" as "com", "a"
  // as "a", and all three used to be scanned as if they were companies. errors is already documented
  // as "the lookup FAILED rather than found nothing", which is exactly what this is.
  const rejected: CompanyResult[] = [];
  for (const raw of domains) {
    const norm = normalizeOrgDomain(raw); if (!norm) continue;
    if (!isDomainShaped(norm)) {
      rejected.push({ input: String(raw).trim().slice(0, 120), matched: 0, companyNames: [], hits: [], errors: ["not a domain — skipped"] });
      continue;
    }
    const key = `domain:${norm}|${facetKey}`;
    if (!seenKey.has(key)) { seenKey.add(key); items.push({ name: norm, key, norm }); }
  }
  const total = items.length + rejected.length;

  const cached = dbGetAccountCache(items.map((i) => i.key), CACHE_TTL_HOURS);
  const results = new Map<string, CompanyResult>();
  let found = 0, done = 0, totalHits = 0;
  // Report the rejected lines straight away — already decided, and counted in `total`, so holding them
  // back would leave the progress bar permanently short of its own total.
  if (rejected.length) { done += rejected.length; onProgress?.({ checked: done, total, found, totalHits, newHits: [] }); }
  let descBudget = fetchDesc ? DESC_MAX : 0; // per-run ceiling on detail-page fetches

  // Turn a domain's jobs into its result (matcher applies role/seniority/date/geo/keyword filters).
  const record = async (it: AcItem, jobs: RawJob[], errors: string[] = []): Promise<AccountHit[]> => {
    // Persist every checked company's openings into the main jobs DB (Admin). Jobs this run NEWLY
    // inserts get stamped with the check's origin tag, so the Jobs database's "Matched by" filter can
    // isolate (and bulk-clean) exactly what this check brought in. Pre-existing rows keep their
    // original attribution — a bad check must not make older data deletable under its name.
    // CHUNKED AND YIELDING, which is the half of ingest.ts's pattern this function was missing.
    //
    // One transaction beats one per row — autocommitting each upsert measured 2.9x slower (289ms vs
    // 100ms per 500 jobs) — and that part was adopted. The yield was not, and the comment here used to
    // say so and leave it: "this loop — unlike ingest's — never yields, so the dashboard is frozen for
    // the whole run." It was right, and node:sqlite being synchronous is what makes it matter: a block
    // here is not a slow response, it is every pending response frozen, plus the progress stream.
    //
    // Measured on the real saved check (1,280 domains x 30.9 jobs/domain average): the cache-replay
    // path below called this once per domain with no await anywhere between them, so ~39,500 upserts
    // ran as ONE uninterrupted block — about 7.9 seconds of dead dashboard, and ~60s at the
    // ACCOUNT_MAX ceiling of 10,000 domains. The fetch path had the same problem per company, just
    // smaller: fedex.com alone is 2,885 jobs, roughly 0.6s.
    //
    // CHUNK matches ingest.ts deliberately. The transaction still spans a batch, so the fsync saving
    // is kept; only the loop is broken up.
    for (let c = 0; c < jobs.length; c += CHUNK) {
      const batch = jobs.slice(c, c + CHUNK);
      dbTransaction(() => {
        for (const j of batch) { if (upsertJob(j) && opts.originTag) dbTagJobOrigin(j.id, opts.originTag); }
      });
      if (c + CHUNK < jobs.length) await new Promise((r) => setImmediate(r));
    }
    const hits: AccountHit[] = [];
    const names = new Set<string>();
    const seen = new Set<string>(); // collapse the same posting listed twice (e.g. two ATS boards)
    for (const j of jobs) {
      // Give the matcher a body to read, same as ingest.ts: a full JD if one was scraped, else the text
      // composed from the posting's structured facets. Without this, hcorg rows reach the matcher with a
      // null description and a body-only keyword can never match. (ATS rows already carry a full JD.)
      if (j.description == null) j.description = rawDescription(JSON.stringify(j.raw ?? null));
      const m = evaluate(j, client, { orgScoped: false }); // jobs are already the queried domain's
      if (!m) continue;
      const dedupKey = (j.url || j.externalId || `${j.company}|${j.title}|${j.location}`).toLowerCase();
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      if (j.company) names.add(j.company);
      hits.push(toHit(it.name, j, m.matchReason, m.matchedOn));
    }
    results.set(it.key, { input: it.name, matched: hits.length, companyNames: [...names], hits, ...(errors.length ? { errors } : {}) });
    if (hits.length) { found++; totalHits += hits.length; }
    return hits;
  };

  // Enrich the matched jobs of one company with full descriptions. Mutates each job's raw.description
  // in place so record()/toHit pick it up and a re-cache persists it. Deduped by detail URL,
  // concurrency-limited, capped per run, and cancellable.
  const enrichDescriptions = async (jobs: RawJob[]): Promise<void> => {
    if (!fetchDesc || descBudget <= 0 || control?.stopped) return;
    const targets: RawJob[] = [];
    const seenUrl = new Set<string>();
    for (const j of jobs) {
      // When the filters match on the body (needDesc), enrich BEFORE the match decision, so every job
      // is a candidate — gating on evaluate() here is exactly what stopped body-only keywords matching.
      // When descriptions are only for DISPLAY (scrapeDesc, no body-matching), keep the cheaper
      // matched-only pass.
      if (!needDesc && !evaluate(j, client, { orgScoped: false })) continue;
      const raw = (j.raw ?? {}) as Record<string, unknown>;
      const hc = raw.hc_url as string | null;
      if (!hc || raw.description) continue; // no detail URL, or already have it
      if (seenUrl.has(hc)) continue; seenUrl.add(hc);
      targets.push(j);
    }
    if (!targets.length) return;
    const sem = new Semaphore(descConcurrency());
    await Promise.all(targets.map((j) => sem.run(async () => {
      if (control?.stopped || descBudget <= 0) return;
      descBudget--;
      const raw = j.raw as Record<string, unknown>;
      try {
        const text = await scrapeJobDescription(raw.hc_url as string);
        if (text) raw.description = text;
      } catch { /* leave description null */ }
    })));
  };

  // cache hits → record immediately (no network); the rest go to the fetch queue.
  //
  // The await is load-bearing, not decoration. Every domain in this loop is a cache HIT, so there was
  // no network call to break it up and nothing else yielded either — the whole replay ran as one
  // synchronous block before the first real await further down. "Instant" was true of the network and
  // false of the dashboard.
  const toFetch: AcItem[] = [];
  const cachedHits: AccountHit[] = [];
  for (const it of items) {
    if (cached.has(it.key)) { cachedHits.push(...await record(it, cached.get(it.key) as RawJob[])); done++; }
    else toFetch.push(it);
  }
  if (done) onProgress?.({ checked: done, total, found, totalHits, newHits: cachedHits });

  // one deterministic /org/<domain> fetch per company, run concurrently through the adaptive gate
  const sem = new Semaphore(CONCURRENCY);
  await Promise.all(toFetch.map((it) => sem.run(async () => {
    if (control?.stopped) return;
    const { jobs, errors } = await fetchOrgJobs(it.norm, maxPages, () => !!control?.stopped);
    // Never cache a lookup that errored. Its job list is not "what this company has", it is "what we
    // managed to get before something broke" — writing that to the 12h cache would serve a short
    // answer as a complete one on every re-run inside the window. A STOPPED run is the same thing:
    // both lanes of fetchOrgJobs return [] with no error when shouldStop fires, so cancelling a check
    // would otherwise write "not hiring" for every domain it was part-way through.
    //
    // A genuine EMPTY result is cached, though. It used to be excluded by a `jobs.length > 0` test,
    // which meant the one answer a watchlist gets most often — this company has no openings — was the
    // one answer the cache never held, so re-running a large check re-fetched most of it from scratch.
    // "No error and not stopped" is what makes the empty list trustworthy; the row count never was.
    if (!errors.length && !control?.stopped) {
      await enrichDescriptions(jobs);   // optional full descriptions on matched jobs
      dbSetAccountCache(it.key, jobs);  // persist (incl. any scraped descriptions) so re-runs are free
    }
    const hits = await record(it, jobs, errors);
    done++;
    onProgress?.({ checked: done, total, found, totalHits, newHits: hits });
  })));
  // Rejected lines lead: they are what the user needs to fix about their list, and `total` counted them.
  return [...rejected, ...items.map((it) => results.get(it.key) ?? { input: it.name, matched: 0, companyNames: [], hits: [] })];
}
