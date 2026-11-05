// hiring.cafe — a Next.js (Pages Router) app that server-renders every search result into
// window.__NEXT_DATA__.props.pageProps.ssrHits[]. We read that structured payload instead of
// scraping card text, which gives us the REAL apply_url, the ATS source+board_token, is_expired
// (exact open/closed), an accurate publish date, the company name, the company's real homepage
// (enriched_company_data.homepage_uri — note the card's company_website is obfuscated), and a
// deep facet set (industry, size, funding, seniority, YOE, visa, clearance, compensation).
import { jitter } from "./browser.ts";
import { hcFetchHtml, hcCooldownWait, gateWave, gateWaveJitter } from "./hcGate.ts";
import { load } from "cheerio";
import { makeJob, extractDomain, normalizeOrgDomain, jobId } from "../normalize.ts";
import { reportDegraded } from "./degraded.ts";
import { dbJobKnown, dbJobKnownAndAttributed } from "../db.ts";
// Incremental early-stop probes the STORED id, which is sha1(source:externalId) — NOT the raw hiring.cafe
// hit id. Hash the raw id with its source before the lookup, or every probe misses and the stop never fires.
const knownBySource = (source: string) => (rawId: string) => dbJobKnown(jobId(source, rawId));
// The /org path is the only source that knows an employer's domain for certain, so for it "known"
// means known AND already carrying that domain — otherwise the early stop skips exactly the pages
// whose rows still need it. See dbJobKnownAndAttributed for the measured reason.
const attributedForOrg = (rawId: string) => dbJobKnownAndAttributed(jobId("hcorg", rawId));
import type { RawJob, SourceConfig } from "../types.ts";

const BASE = "https://hiring.cafe";
const HCORG_RETRIES = Math.max(0, Number(process.env.HCORG_RETRIES ?? 2)); // block-retries per domain

// ───────────────────────── transport-agnostic parsers (HTML string → data) ─────────────────────────
// Both transports (plain HTTP and the fingerprinted browser) return page HTML; these extract the same
// structured payload from it, so the two lanes are interchangeable.
/** Pull the Next.js __NEXT_DATA__ JSON out of a page's HTML. Regex fast-path (Next always emits the exact
 *  script tag; it escapes `<` so the JSON never contains a literal </script>), cheerio fallback. Null when
 *  absent (a 404 or block page). */
function extractNextData(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (m) { try { return JSON.parse(m[1]!); } catch { /* fall through to cheerio */ } }
  try { const t = load(html)("#__NEXT_DATA__").first().html(); if (t) return JSON.parse(t); } catch { /* none */ }
  return null;
}
/** Search results → ssrHits[] (the full server payload; unaffected by the DOM's list virtualization). */
function parseSearchHits(html: string): Hit[] {
  return (extractNextData(html)?.props?.pageProps?.ssrHits ?? []) as Hit[];
}
/** /org/<domain> page → its jobs + the /job/ detail hrefs (for hc_url pairing) + total/notInDatabase. */
function parseOrgPage(html: string): { jobs: Hit[]; anchors: (string | null)[]; notInDatabase: boolean; total: number } {
  const pp = extractNextData(html)?.props?.pageProps ?? {};
  const $ = load(html);
  const anchors = $('a[href^="/job/"]').map((_, a) => $(a).attr("href") ?? null).get() as (string | null)[];
  return { jobs: (pp.initialJobs ?? []) as Hit[], anchors, notInDatabase: !!pp.notInDatabase, total: Number(pp.totalJobs ?? 0) };
}
/** Job detail page → the full description as plain text (HTML stripped), or null. */
function parseJobDetail(html: string): string | null {
  const desc = extractNextData(html)?.props?.pageProps?.job?.job_information?.description;
  if (typeof desc !== "string" || !desc) return null;
  return load(desc).text().replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() || null;
}

/** type: hiringcafe — { searchState, maxPages?, enabled? }. searchState is built by buildSearchState()
 *  (src/hiringcafeFilters.ts) so hiring.cafe filters server-side. Legacy { query } still works. */
export async function hiringCafeAdapter(cfg: SourceConfig): Promise<RawJob[]> {
  if (cfg.enabled === false) return [];
  const maxPages = Number(cfg.maxPages ?? 25);
  let searchState = ((cfg.searchState as Record<string, unknown>) ?? { searchQuery: String(cfg.query ?? "").trim() });
  // Incremental (scheduled) runs: newest-first ordering makes the all-known early stop sound — the
  // first fully-stored page proves everything deeper is stored too.
  const incremental = cfg.incremental === true;
  if (incremental) searchState = { ...searchState, sortBy: "date" };
  const jobs = await scrapeHiringCafe(searchState, maxPages, incremental ? { isKnown: knownBySource("hiringcafe") } : {});
  console.log(`[hiringcafe] ${JSON.stringify(searchState).slice(0, 60)} → ${jobs.length} jobs (structured${incremental ? ", incremental" : ""})`);
  return jobs;
}

/** Scrape hiring.cafe's structured ssrHits for a given searchState. Each page goes through the free
 *  HTTP-first gate (hcFetchHtml → HTTP, browser fallback only when challenged). Shared by the search
 *  adapter and the account-check. shouldStop lets a caller (e.g. a cancelled account-check) wind down.
 *  NOTE: no detail-href capture for keyword searches — the search list's /job/ anchors use a token absent
 *  from the ssrHit, so full-JD scraping is only reliable on the /org/ path (scrapeHiringCafeOrg). */
export interface ScrapeOpts {
  shouldStop?: () => boolean;
  /** Incremental refresh: returns true when a job id is already in the DB. When a whole page is
   *  already-known jobs, pagination stops — a scheduled re-fetch that finds nothing new costs one
   *  page instead of re-crawling the full depth. Callers only pass this for newest-first ordering
   *  (scheduled search runs force sortBy:"date"; org pages list newest openings first). */
  isKnown?: (id: string) => boolean;
  /** Called when the PAGE LIMIT — not the end of the company's list — is what ended an /org/ scan.
   *  reportDegraded already surfaces this on a fetch run; this is for callers with their own
   *  per-company channel to the user (the Account Check shows it against that company's row). */
  onTruncated?: (info: { domain: string; collected: number; total: number; maxPages: number }) => void;
}

export async function scrapeHiringCafe(searchState: Record<string, unknown>, maxPages: number, opts: ScrapeOpts = {}): Promise<RawJob[]> {
  const { shouldStop, isKnown } = opts;
  const enc = encodeURIComponent(JSON.stringify(searchState));
  const url = (n: number) => `${BASE}/?searchState=${enc}${n > 0 ? `&page=${n}` : ""}`;
  const hits: Hit[] = [];
  const seen = new Set<string>();
  // No total is available for keyword searches, so pages are fetched in WAVES of W concurrent
  // requests (the adaptive gate does the real pacing); each wave's pages are processed in order and
  // the loop stops at the first empty / all-dupe / all-known page. 5-10x faster than one-at-a-time
  // with a per-page sleep, same request count.
  const W = Math.max(1, Math.min(gateWave(), maxPages));
  const [jMin, jMax] = gateWaveJitter();
  outer:
  for (let start = 0; start < maxPages; start += W) {
    if (start > 0 && shouldStop?.()) break; // cancelled → keep what we have
    const count = Math.min(W, maxPages - start);
    const pages = await Promise.all(Array.from({ length: count }, (_, i) => {
      const n = start + i;
      return hcFetchHtml(url(n)).then((html) => ({ n, hits: parseSearchHits(html) }), (e: Error) => ({ n, err: e }));
    }));
    for (const p of pages) { // in order — a stop condition on page n discards fetched pages > n (correctness over waste)
      if ("err" in p) {
        if (p.n === 0 && !hits.length) throw p.err; // nothing collected yet → surface the failure
        console.warn(`[hiringcafe] page ${p.n} failed (${p.err.message}) — keeping ${hits.length} hits from earlier pages`);
        break outer; // partial result beats losing every page already fetched
      }
      if (!p.hits.length) break outer; // end of results
      let fresh = 0, unknown = 0;
      for (const h of p.hits) {
        const id = h?.id; if (!id || seen.has(id)) continue;
        seen.add(id); hits.push(h); fresh++;
        if (!isKnown || !isKnown(id)) unknown++;
      }
      if (fresh === 0) break outer;              // only dupes → end of results
      if (isKnown && unknown === 0) break outer; // incremental: a whole page of already-stored jobs → nothing newer deeper
    }
    if (start + W < maxPages) await jitter(jMin, jMax); // between waves only
  }
  return hits.map((h) => mapHit(h)).filter((j): j is RawJob => !!j && !!j.title && j.title !== "(untitled)");
}

/** type: hcorg — { domain? | domains?, maxPages?, enabled? }. Pulls companies' openings via
 *  hiring.cafe's deterministic /org/<domain> route (no fuzzy name matching). Org results are
 *  UNFILTERED (every role at the company) and tagged source "hcorg" so the matcher applies local
 *  keyword/date/geo refinement. Both the single-`domain` (Client Monitoring) and the `domains` array
 *  (Account Monitoring watchlists) run through the adaptive gate (hcFetchHtml) — concurrency-managed, backs
 *  off on blocks — so a single-domain scan no longer waits behind other scrapes in a serial queue. */
export async function hiringCafeOrgAdapter(cfg: SourceConfig): Promise<RawJob[]> {
  if (cfg.enabled === false) return [];
  const maxPages = Number(cfg.maxPages ?? 25);
  const raw = Array.isArray(cfg.domains) ? (cfg.domains as unknown[]).map(String)
    : (cfg.domain != null ? [String(cfg.domain)] : []);
  const domains = [...new Set(raw.map((d) => normalizeOrgDomain(d)).filter(Boolean))];
  if (!domains.length) return [];

  const scrapeOpts: ScrapeOpts = cfg.incremental === true ? { isKnown: attributedForOrg } : {};

  if (domains.length === 1) { // single domain (Client Monitoring)
    const jobs = await scrapeHiringCafeOrg(domains[0]!, maxPages, scrapeOpts);
    console.log(`[hcorg] ${domains[0]} → ${jobs.length} jobs`);
    return jobs;
  }

  // Many domains (watchlist chunk) — fetched concurrently; the gate bounds real concurrency and cools
  // down on a block. One blocked/unknown domain can't sink the batch (per-domain block-retry).
  const all: RawJob[] = [];
  await Promise.all(domains.map((domain) => (async () => {
    for (let attempt = 0; ; attempt++) {
      try { all.push(...await scrapeHiringCafeOrg(domain, maxPages, scrapeOpts)); return; }
      catch (e) {
        const blocked = String((e as Error)?.message ?? e).includes("blocked");
        if (blocked && attempt < HCORG_RETRIES) { await hcCooldownWait(); continue; } // wait out the gate cooldown, then retry
        console.warn(`[hcorg] ${domain} failed: ${(e as Error).message}`);
        return;
      }
    }
  })()));
  console.log(`[hcorg] ${domains.length} domains → ${all.length} jobs`);
  return all;
}

/** AN /org PAGE IS SUPPOSED TO BE ONE EMPLOYER. THIS CHECKS WHETHER IT ACTUALLY IS.
 *
 *  hiring.cafe groups openings under a company domain, and the scan trusted that grouping completely:
 *  whatever /org/<domain> returned was filed against <domain>. For a junk or generic domain the
 *  grouping is meaningless, and the scan filed the result anyway. Measured on the live site: us.com
 *  returns 25 openings on page 0 belonging to TEN unrelated employers — Jasper Group, Porters American
 *  Retail Services, Global Technical Systems, ITAC, Kuraray — around 200 across the full scan, every
 *  one of them attributed to a company that has nothing to do with any of them.
 *
 *  The obvious guard — "the company name must match the domain" — is wrong, and measuring showed it:
 *  aa.com is American Airlines and pg.com is Procter & Gamble. Requiring a name/stem match would have
 *  thrown away real employers. So would refusing short domains outright (hp.com, ey.com, ibm.com are
 *  all real). What actually separates the two cases is COHERENCE: a real org page is dominated by one
 *  employer, whatever it happens to be called.
 *
 *  Measured on page 0 of each: us.com 20% · 3m.com 92% · hp.com, ey.com, aa.com, ibm.com, fedex.com,
 *  stripe.com, nestle.com, abc.xyz, unilever.com, pg.com, jnj.com, rtx.com, danaher.com all 100%.
 *  Nothing legitimate lands below 92 and the junk case is at 20, so the line sits at 60 with room on
 *  both sides. Related brands still count as coherent — FedEx / FedEx Freight / FedEx Supply Chain are
 *  one employer, and the prefix test keeps them.
 *
 *  This only refuses the whole domain; it does NOT drop individual rows from a page that passed. On a
 *  coherent page a stray name is more likely a subsidiary we do not recognise than a misfiling, and
 *  discarding real openings to tidy up an 8% minority is the worse error. */
const legalTail = /(inc|llc|ltd|limited|corp|corporation|company|co|group|holdings|plc|gmbh|sa|nv|ag)$/;
const orgNameKey = (s: string) => String(s ?? "").toLowerCase().normalize("NFKD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "").replace(legalTail, "");
export function orgPageIsOneEmployer(names: string[]): { ok: boolean; coherence: number; modal: string } {
  const keys = names.map(orgNameKey).filter(Boolean);
  if (!keys.length) return { ok: true, coherence: 1, modal: "" };   // nothing stated is not a failed test
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const modal = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const related = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a)
    || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));
  const coherence = keys.filter((k) => related(k, modal)).length / keys.length;
  return { ok: coherence >= 0.6, coherence, modal };
}

/** Scrape one company's openings from hiring.cafe's /org/<domain> route, on an already-open page.
 *  Org pages embed jobs at pageProps.initialJobs (same shape as search ssrHits), 25/page, paginated
 *  by ?page=N, with pageProps.notInDatabase=true when the domain is unknown. Captures each job's
 *  hiring.cafe detail href (for optional description scraping) by pairing the page's /job/ anchors
 *  with initialJobs by index (only when the counts match). */
export async function scrapeHiringCafeOrg(domain: string, maxPages: number, opts: ScrapeOpts = {}): Promise<RawJob[]> {
  const { shouldStop, isKnown, onTruncated } = opts;
  const dom = normalizeOrgDomain(domain);
  if (!dom) return [];
  const url = (n: number) => `${BASE}/org/${encodeURIComponent(dom)}${n > 0 ? `?page=${n}` : ""}`;
  const collected: Array<{ hit: Hit; href: string | null }> = [];
  const seen = new Set<string>();

  // Ingest one parsed page in order; returns false when pagination should stop.
  const ingest = (pd: ReturnType<typeof parseOrgPage>): boolean => {
    if (pd.notInDatabase) return false;  // domain unknown to hiring.cafe → no openings, not an error
    if (!pd.jobs.length) return false;
    const pair = pd.anchors.length === pd.jobs.length; // 1:1 → trust index pairing for detail hrefs
    let fresh = 0, unknown = 0;
    for (let i = 0; i < pd.jobs.length; i++) {
      const h = pd.jobs[i]; const id = h?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id); collected.push({ hit: h, href: pair ? (pd.anchors[i] ?? null) : null }); fresh++;
      if (!isKnown || !isKnown(id)) unknown++;
    }
    if (fresh === 0) return false;              // only dupes → end of results
    if (isKnown && unknown === 0) return false; // incremental: whole page already stored → stop
    if (pd.total && collected.length >= pd.total) return false; // collected the whole company
    return true;
  };
  const finish = () => collected
    .map(({ hit, href }) => mapHit(hit, { source: "hcorg", domain: dom, hcUrl: href ? `${BASE}${href}` : null }))
    .filter((j): j is RawJob => !!j && !!j.title && j.title !== "(untitled)");

  // Page 0 first: it reveals the company's TOTAL job count.
  const first = parseOrgPage(await hcFetchHtml(url(0))); // page-0 failure throws — retry loops live upstream

  // Refuse the domain BEFORE collecting anything, and before paginating — page 0 is enough to tell.
  const coh = orgPageIsOneEmployer(first.jobs.map((h) =>
    String((h.enriched_company_data?.name as string) ?? (h.v5_processed_job_data?.company_name as string) ?? "")));
  if (!coh.ok) {
    reportDegraded(`${dom}: not one employer — hiring.cafe groups unrelated companies under this domain, so nothing was filed against it`);
    return [];
  }

  if (!ingest(first)) return finish();
  if (shouldStop?.()) return finish();
  const perPage = Math.max(1, first.jobs.length);
  const lastPage = first.total
    ? Math.min(maxPages - 1, Math.ceil(first.total / perPage) - 1)
    : maxPages - 1;

  // SAY SO WHEN THE PAGE LIMIT IS WHAT STOPPED US.
  //
  // Page 0 reports the company's TRUE total, so a scan that cannot reach it knows exactly how short it
  // fell — and said nothing. The caller received a shorter list and no way to tell "this company has
  // 200 openings" from "we were allowed to look at 200 of its 2,885". Every count downstream then
  // inherits the wrong number: the check's per-company total, the Companies view's role count, the
  // hiring-velocity signal that compares this scan against the last one.
  //
  // Reachable on the live data, not theoretical: at the Account Check's 90-page default (2,250
  // openings) fedex.com (2,885) and ups.com (2,405) both truncate, and at the "Fast" depth (8 pages,
  // 200 openings) ten watched companies do.
  //
  // This is arithmetic on the stated total, deliberately independent of the incremental early-stop
  // below: stopping because everything deeper is already stored is a correct optimisation, not a
  // truncation, and must not be reported as one.
  if (first.total && Math.ceil(first.total / perPage) > maxPages) {
    const reach = maxPages * perPage;
    const msg = `${dom}: page limit reached — read about ${reach} of ${first.total} openings`;
    reportDegraded(msg);
    onTruncated?.({ domain: dom, collected: reach, total: first.total, maxPages });
  }
  if (lastPage < 1) return finish();

  if (isKnown) {
    // INCREMENTAL (scheduled): fetch in WAVES with an early stop. Org pages list newest openings
    // first, so the first wholly-already-stored page proves everything deeper is stored — we bail
    // out instead of re-crawling the company. Minimizes requests (the point of a background refresh).
    const W = Math.max(1, gateWave());
    const [jMin, jMax] = gateWaveJitter();
    for (let start = 1; start <= lastPage; start += W) {
      if (shouldStop?.()) break;
      const count = Math.min(W, lastPage - start + 1);
      const pages = await Promise.all(Array.from({ length: count }, (_, i) => {
        const n = start + i;
        return hcFetchHtml(url(n)).then((html) => ({ n, pd: parseOrgPage(html) }), (e: Error) => ({ n, err: e }));
      }));
      let stop = false;
      for (const p of pages) {
        if ("err" in p) { console.warn(`[hcorg] ${dom} page ${p.n} failed (${p.err.message}) — keeping ${collected.length} jobs`); stop = true; break; }
        if (!ingest(p.pd)) { stop = true; break; }
      }
      if (stop) break;
      if (start + W <= lastPage) await jitter(jMin, jMax);
    }
  } else {
    // MANUAL (full depth): fan out ALL remaining pages CONCURRENTLY — a 20-page org scan takes ~1
    // gate round-trip instead of 20 serial fetches. The gate bounds real parallelism + backs off.
    const pages = await Promise.all(Array.from({ length: lastPage }, (_, i) => {
      const n = i + 1;
      return hcFetchHtml(url(n)).then((html) => ({ n, pd: parseOrgPage(html) }), (e: Error) => ({ n, err: e }));
    }));
    for (const p of pages) { // in order, so the collected set stays deterministic
      if ("err" in p) {
        console.warn(`[hcorg] ${dom} page ${p.n} failed (${p.err.message}) — keeping ${collected.length} jobs from earlier pages`);
        break; // partial result beats losing every page already fetched
      }
      if (!ingest(p.pd)) break;
    }
  }
  return finish();
}

/** Fetch one job's full description (plain text) from its hiring.cafe detail page. The raw /job/<id>
 *  form 404s, so `hcUrl` must be the DOM anchor href captured by scrapeHiringCafeOrg. */
export async function scrapeJobDescription(hcUrl: string): Promise<string | null> {
  const html = await hcFetchHtml(hcUrl);
  return parseJobDetail(html);
}

interface Hit {
  id?: string; apply_url?: string; source?: string; board_token?: string; is_expired?: boolean;
  collapse_key?: string; // hiring.cafe's own key for the SAME role across multiple ATS boards
  job_information?: { title?: string };
  v5_processed_job_data?: Record<string, any>;
  enriched_company_data?: Record<string, any>;
}

/** Highest degree hiring.cafe flagged as actually required/preferred (skips "Not Mentioned"), with
 *  fields of study if given — for the composed description of keyword-search jobs (no full JD prose). */
function composeDegrees(v5: Record<string, any>): string | null {
  const levels: Array<[string, string, string]> = [
    ["doctorate_degree_requirement", "doctorate_degree_fields_of_study", "Doctorate"],
    ["masters_degree_requirement", "masters_degree_fields_of_study", "Master's degree"],
    ["bachelors_degree_requirement", "bachelors_degree_fields_of_study", "Bachelor's degree"],
    ["associates_degree_requirement", "associates_degree_fields_of_study", "Associate's degree"],
  ];
  for (const [reqK, fieldK, label] of levels) {
    const req = v5[reqK];
    if (typeof req === "string" && req.trim() && !/not mentioned|not required|none/i.test(req)) {
      const fields = Array.isArray(v5[fieldK]) ? v5[fieldK].filter((x: unknown) => typeof x === "string") : [];
      return label + (fields.length ? ` in ${fields.join(", ")}` : "") + (/preferred/i.test(req) ? " (preferred)" : "");
    }
  }
  return null;
}
/** The perks hiring.cafe flagged true → labels, for the composed description. */
function composeBenefits(v5: Record<string, any>): string[] | null {
  const map: Array<[string, string]> = [
    ["401k_matching", "401(k) matching"], ["retirement_plan", "Retirement plan"],
    ["generous_paid_time_off", "Generous PTO"], ["generous_parental_leave", "Parental leave"],
    ["tuition_reimbursement", "Tuition reimbursement"], ["relocation_assistance", "Relocation assistance"],
    ["four_day_work_week", "4-day work week"],
  ];
  const out = map.filter(([k]) => v5[k] === true).map(([, label]) => label);
  return out.length ? out : null;
}

/** Map one ssrHit/initialJobs entry → normalized RawJob, keeping a curated facet blob in `raw`.
 *  opts.source tags the job (default "hiringcafe"; "hcorg" for /org/ results so the matcher refines
 *  them locally). opts.domain overrides the derived company domain (deterministic for /org/ scans).
 *  opts.hcUrl is the hiring.cafe detail href, stashed in raw.hc_url for optional description scraping. */
function mapHit(h: Hit, opts: { source?: string; domain?: string | null; hcUrl?: string | null } = {}): RawJob | null {
  if (!h?.id) return null;
  const v5 = h.v5_processed_job_data ?? {};
  const ec = h.enriched_company_data ?? {};
  const company = (ec.name as string) || (v5.company_name as string) || null;
  const title = (v5.core_job_title as string) || h.job_information?.title || "(untitled)";
  const url = h.apply_url || `${BASE}/job/${h.id}`;
  // Company domain: the enriched homepage first (real, not the obfuscated company_website), else the
  // apply_url host — extractDomain() returns null for known ATS hosts (gem/workday/icims/ashby/avature/
  // breezy…), so this only yields a real domain when the employer hosts its own careers page (jobs.yum.com).
  const homepage = typeof ec.homepage_uri === "string" && /^https?:\/\//.test(ec.homepage_uri) ? ec.homepage_uri : null;
  const domain = opts.domain !== undefined ? opts.domain : ((homepage && extractDomain(homepage)) || extractDomain(url));
  const location = (v5.formatted_workplace_location as string)
    || (Array.isArray(v5.workplace_cities) ? v5.workplace_cities[0] : null) || null;
  const workplace = String(v5.workplace_type ?? "");
  const postedAt = (v5.estimated_publish_date as string) || null;
  const expired = h.is_expired === true;

  return makeJob({
    source: opts.source ?? "hiringcafe",
    externalId: h.id,
    title,
    company,
    location,
    url,
    domain,
    // NOTE: hiring.cafe's collapse_key is COMPANY-level (every role at a company shares the same value),
    // so using it as the dedup identity collapsed all of a company's roles onto one row — a watchlist
    // kept ~1 job per company, and keyword searches dropped distinct roles too. Dedup on the apply URL
    // instead (unique per role; identical-destination cross-posts still collapse) via makeJob's fallback.
    dedupKey: null,
    remote: /remote|worldwide/i.test(workplace),
    postedAt,
    status: expired ? "closed" : "open",
    expiresAt: expired ? new Date(Date.now() - 86400e3).toISOString() : null, // keep it closed across re-sights
    raw: {
      ats: h.source && h.board_token ? `${h.source}:${h.board_token}` : null,
      apply_url: h.apply_url, homepage, hc_url: opts.hcUrl ?? null,
      requirements_summary: v5.requirements_summary ?? null, role_activities: v5.role_activities ?? null,
      tools: v5.technical_tools ?? null, certifications: v5.licenses_or_certifications ?? null,
      languages: v5.language_requirements ?? null, degrees: composeDegrees(v5), benefits: composeBenefits(v5),
      industry: ec.industries ?? v5.company_sector_and_industry ?? null,
      activities: ec.activities ?? v5.company_activities ?? null,
      tagline: ec.tagline ?? v5.company_tagline ?? null,
      employees: ec.nb_employees ?? null, founded: ec.year_founded ?? null,
      org_type: ec.organization_type ?? null, stock: ec.stock_symbol ?? null,
      funding_type: ec.latest_funding_type ?? null, funding_year: ec.latest_funding_year ?? null,
      seniority: v5.seniority_level ?? null, yoe: v5.min_industry_and_role_yoe ?? null,
      job_category: v5.job_category ?? null, commitment: v5.commitment ?? null, workplace_type: v5.workplace_type ?? null,
      comp_min: v5.yearly_min_compensation ?? null, comp_max: v5.yearly_max_compensation ?? null,
      currency: v5.listed_compensation_currency ?? null,
      visa_sponsorship: v5.visa_sponsorship ?? null, security_clearance: v5.security_clearance ?? null,
      is_expired: expired,
    },
  });
}
