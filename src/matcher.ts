import type { ClientConfig, HcPlace, Match, MatchedOn, QueryCond, QueryGroup, RawJob, SearchSpec } from "./types.ts";
import { getFilters } from "./materialize.ts";
import { normalizeOrgDomain } from "./normalize.ts";
import { countryFromLocation } from "./geo.ts";
import { orgFacetsAllowed } from "./orgFacets.ts";
import { detectedTechNames } from "./techDetect.ts";
import { keywordHit } from "./keywordMatch.ts";
import { evalQueryTreeJob } from "./queryEval.ts";

export { keywordHit }; // re-exported for callers that used matcher.keywordHit historically

/** Would this search's MATCH decision read a job's description body? True when it filters on include
 *  keywords that aren't Title-only, on technologies (detected from title+description), or on a
 *  matchFilter that names description/anytext/tech. The /org and account-check paths use this to
 *  decide whether to pre-attach the full JD BEFORE matching — otherwise a body-only keyword can never
 *  match, because those paths only scrape descriptions for already-matched jobs. Exclude keywords are
 *  deliberately not counted: a missed exclude keeps an extra job (mild), and "exclude anywhere" is
 *  common enough that counting it would force a description fetch on almost every run. */
export function specNeedsDescription(search: SearchSpec | undefined | null): boolean {
  if (!search) return false;
  if ((search.keywords ?? []).some(Boolean) && (search.keywordScope ?? "anywhere") !== "title") return true;
  if ((search.technologies ?? []).some(Boolean)) return true;
  const tree = search.matchFilter;
  if (tree) {
    const scan = (n: QueryCond | QueryGroup): boolean => Array.isArray((n as QueryGroup).children)
      ? (n as QueryGroup).children.some(scan)
      : ["description", "anytext", "tech"].includes((n as QueryCond).field);
    if (Array.isArray(tree.children) && tree.children.some(scan)) return true;
  }
  return false;
}

type KwScope = "anywhere" | "title" | "description";

// Per-job lowercased field bundle. Keyword scope needs the fields SEPARATELY (title-only vs
// description-only vs everywhere), and "what matched where" needs to know which field a term hit —
// so the old single-string haystack becomes a small bundle. Cached per job object exactly as before:
// evaluate() runs once per (job × client) and descriptions average 2.6 KB, so rebuilding these
// strings per client was the single most expensive thing in a backfill. The `desc` guard is not
// paranoia: enrichJobDescriptions() (ingest.ts) fills job.description in AFTER the first evaluation,
// so a cache keyed on identity alone would hand back a bundle missing the body.
interface Hay { desc: string | null | undefined; title: string; company: string; location: string; description: string; all: string; }
const hayCache = new WeakMap<object, Hay>();
function hayOf(job: RawJob): Hay {
  const hit = hayCache.get(job);
  if (hit && hit.desc === job.description) return hit;
  const title = (job.title ?? "").toLowerCase();
  const company = (job.company ?? "").toLowerCase();
  const location = (job.location ?? "").toLowerCase();
  const description = (job.description ?? "").toLowerCase();
  const all = `${title} ${company} ${location} ${description}`;
  const h: Hay = { desc: job.description, title, company, location, description, all };
  hayCache.set(job, h);
  return h;
}
/** The text an include/exclude keyword tests against, given its scope. "anywhere" = the whole
 *  posting (title + company + location + description); "title"/"description" scope to that one field. */
const scopedText = (h: Hay, scope: KwScope): string =>
  scope === "title" ? h.title : scope === "description" ? h.description : h.all;
/** The (field, text) pairs a scope covers — used to record WHICH field a keyword hit ("what matched
 *  where"). "anywhere" reports the specific field, not a generic "anywhere". */
function scopeFields(h: Hay, scope: KwScope): Array<[MatchedOn["field"], string]> {
  if (scope === "title") return [["title", h.title]];
  if (scope === "description") return [["description", h.description]];
  return [["title", h.title], ["description", h.description], ["company", h.company], ["location", h.location]];
}

// A client's watched org-domains as a normalized Set, computed ONCE per client (cached by object
// identity). evaluate() runs per (job, client), so without this a watchlist with N domains re-normalized
// all N domains and did an O(N) Array.includes for EVERY job — O(jobs × domains). A 4,575-domain
// watchlist over 220k jobs was ~1 billion regex ops (minutes of boot backfill). Now it's O(domains) once
// + O(1) Set.has per job. Config reloads create new client objects → fresh cache entries (no staleness).
const watchedCache = new WeakMap<object, Set<string>>();
function watchedDomainSet(client: ClientConfig): Set<string> {
  let s = watchedCache.get(client);
  if (!s) { s = new Set((client.search?.orgDomains ?? []).map(normalizeOrgDomain).filter(Boolean)); watchedCache.set(client, s); }
  return s;
}

/** Best-effort local geo gate for /org/ results, which are NOT filtered server-side. A job passes if
 *  its location/state matches any selected place's country / state / city tokens. Remote jobs always
 *  pass (location-agnostic). With no locations selected, everything passes. */
function geoAllowed(job: RawJob, locations: HcPlace[] | undefined): boolean {
  if (!locations?.length) return true;
  if (job.remote) return true;
  const loc = (job.location ?? "").toLowerCase();
  const st = (job.state ?? "").toUpperCase();
  // Resolved once, not per component: the country the JOB is in, as far as anything can tell.
  const jobCc = job.country ?? countryFromLocation(job.location);

  for (const p of locations) {
    const comps = p.address_components ?? [];
    const pick = (t: string) => comps.find((c) => c.types?.includes(t));
    const country = pick("country");
    const region = pick("administrative_area_level_1");
    const locality = pick("locality") ?? pick("postal_town") ?? pick("administrative_area_level_2");

    // The country is a GATE on this place, not an alternative way to satisfy it. Every component
    // used to be tested independently and any hit passed the job, which broke two ways at once:
    // "Berlin, CT" and "Berlin, New Hampshire" matched a search for Berlin, GERMANY on the bare city
    // name, and "Hamburg, Germany" matched it too because the place's own country component said
    // Germany and that alone was enough. Selecting a city filtered no more narrowly than selecting
    // its country.
    if (country) {
      const want = (country.short_name ?? "").toUpperCase() === "UK" ? "GB" : (country.short_name ?? "").toUpperCase();
      const long = (country.long_name ?? "").toLowerCase();
      if (jobCc) {
        if (jobCc !== want) continue;            // confidently a different country — this place cannot match
      } else if (want === "US") {
        // Unknown country, US wanted: a US state token or an explicit "United States" is the only
        // evidence available. Consistent with geo.ts's rule that unknown never means US by default.
        if (!(st || /united states|usa|u\.s\./.test(loc))) continue;
      } else if (!(long && loc.includes(long))) {
        continue;                                 // unknown country, and the name is not in the text
      }
    }

    // Inside an agreed country, the place is satisfied at its MOST SPECIFIC level. A place with a
    // locality means that town, not the whole nation it sits in.
    if (locality) {
      const long = (locality.long_name ?? "").toLowerCase();
      if (long && loc.includes(long)) return true;
      continue;
    }
    if (region) {
      const short = (region.short_name ?? "").toUpperCase();
      const long = (region.long_name ?? "").toLowerCase();
      if (st && short === st) return true;
      if (long && loc.includes(long)) return true;
      continue;
    }
    if (country) return true;                     // country-level place, and the gate above agreed
    // No recognised component at all — fall back to the old any-name-in-the-text behaviour rather
    // than silently rejecting a place shape we do not understand.
    for (const c of comps) {
      const long = (c.long_name ?? "").toLowerCase();
      if (long && loc.includes(long)) return true;
    }
  }
  return false;
}

/**
 * Source-aware matcher.
 *  - hiring.cafe SEARCH results ("hiringcafe") are already filtered server-side by the exact
 *    searchState, so we only apply the local-only filters (exclude words / exclude companies /
 *    technologies) — PLUS the date-posted check, which runs on every source. The server parameter is
 *    dateFetchedPastNDays, i.e. hiring.cafe's indexing recency; this control names the publish date,
 *    and re-checking locally makes that exact rather than approximate. It can only tighten.
 *  - /org/ results ("hcorg") and Craigslist / SimplyHired are NOT filtered server-side, so we apply a
 *    best-effort keyword (ANY) + date-posted refinement; "hcorg" additionally gets a local geo gate.
 */
export function evaluate(
  job: RawJob, client: ClientConfig,
  opts: { orgScoped?: boolean; serverFiltered?: boolean } = {},
): Match | null {
  const f = getFilters(client);
  const h = hayOf(job);
  const exact = f.exactMatch;

  // exclude words / companies (all sources). Exclude keywords honour their own scope (title/desc/anywhere).
  if ((f.exclude_keywords ?? []).some((k) => keywordHit(scopedText(h, f.excludeKeywordScope), k, exact))) return null;
  if (job.company) {
    const co = h.company;
    if ((f.excludeCompanies ?? []).some((c) => keywordHit(co, c, exact))) return null;
  }

  // Technology gate (all sources — detection is our own layer, never done server-side): when a search
  // or watchlist requires technologies, the posting must MENTION at least one of them. This is the
  // monitor-time equivalent of the Technology quick filter — "only alert me when these companies hire
  // for React", as a standing signal + webhook, not a manual re-filter. `foundTech` is reused for the
  // "what matched where" provenance below, so detection runs at most once per matched job.
  let foundTech: Set<string> | null = null;
  const detectTech = (): Set<string> => (foundTech ??= detectedTechNames(`${job.title} ${job.description ?? ""}`));
  if (f.technologies.length) {
    const want = f.technologies.map((t) => t.toLowerCase());
    if (!want.some((w) => detectTech().has(w))) return null;
  }

  const isHiringCafe = job.source === "hiringcafe"; // exact: org pages ("hcorg") are NOT pre-filtered
  // Org-style rows are domain-scoped and UNFILTERED: hiring.cafe /org/ scans ("hcorg") AND direct ATS
  // boards ("ats:<vendor>:<slug>"). Both belong to whoever watches that domain and get local
  // keyword/date/geo refinement — never a cross-client leak.
  const isOrg = job.source === "hcorg" || job.source.startsWith("ats:");
  const isWatchlist = client.kind === "watchlist";

  // A watchlist only ever matches jobs at the domains it explicitly watches — never a job another
  // client's source happened to ingest. (Multi-tenant matching evaluates every job against every
  // client, so without this a no-keyword watchlist would scoop up unrelated postings.)
  if (isWatchlist) {
    if (!watchedDomainSet(client).has(normalizeOrgDomain(job.domain))) return null;
  }

  // An "hcorg" row is a domain-scoped /org/<domain> fetch — it belongs to whoever asked for that
  // domain (a watchlist's targets, or a search's own orgDomains). In the multi-tenant pool every job
  // is evaluated against every client, so without this guard a keyword search (or another search)
  // would silently match org rows it never fetched — e.g. companies you only ran through Account
  // Check or watch elsewhere would leak into unrelated keyword results. A client only matches an org
  // row whose domain is in its OWN orgDomains. (opts.orgScoped=false for the account-check path,
  // whose ephemeral client is already fed only the single domain it fetched.) A SEARCH can opt back
  // into the old "surface everywhere" behavior via search.includeOrgJobs — then it ALSO matches org
  // rows fetched by other monitors/account-checks (still keyword/date/geo-filtered locally). Never for
  // watchlists, which are strictly domain-scoped by design.
  const includeOrgJobs = client.search?.includeOrgJobs === true && !isWatchlist;
  if (isOrg && opts.orgScoped !== false && !includeOrgJobs) {
    if (!watchedDomainSet(client).has(normalizeOrgDomain(job.domain))) return null;
  }

  // A watchlist is ALWAYS domain-scoped with local keyword filtering — even if it's evaluating a
  // hiringcafe-sourced row (which can happen after dedup collapses a posting onto one row), it must
  // apply its own role filter, never trust another source's server-side filtering.
  //
  // A hiring.cafe SEARCH row skips keyword refinement ONLY when opts.serverFiltered says the row was
  // fetched by THIS client's own searchState (or we're re-checking a match that was — the prune path).
  // Multi-tenant matching evaluates every job against every client, and hiring.cafe's server-side
  // filtering only vouches for the client whose query fetched the row — without this gate, every
  // search client silently matched every hiringcafe row any OTHER search fetched, regardless of its
  // own keywords (cross-client contamination).
  // A scoped or exact include-keyword requirement CANNOT be vouched for by hiring.cafe's server-side
  // search (its searchQuery is full-text and prefix-aware — it never restricts to the title, nor does
  // it do whole-word). So when the tracker asks for Title-only / Description-only / Exact keywords,
  // the include refinement must run locally even on a row this client's own search fetched.
  const scopeLocal = f.keywordScope !== "anywhere" || exact;
  const trustServer = isHiringCafe && !isWatchlist && opts.serverFiltered === true && !scopeLocal;
  const localRefine = !trustServer;

  // "Posted within N days" means the PUBLISH date, on every path — checked here for ALL sources,
  // including a hiring.cafe row this client's own search fetched.
  //
  // The server-side parameter is dateFetchedPastNDays, and it does bound publish age: on the live
  // data, rows that went through a searchState stop dead at 120.9 days against the 121-day default,
  // zero over, while /org/ rows (which take no filter) run to 4,644 days with 3,653 past 121. So the
  // two axes agree closely — but "closely" is an approximation of hiring.cafe's indexing, not the
  // employer's publish date, and this control names the publish date. Re-checking it locally turns an
  // approximate promise into an exact one, and it can only ever tighten: a posting published within N
  // days cannot have been indexed before it existed, so the N-day server window already contains
  // everything that qualifies. Nothing valid is lost by asking again.
  //
  // A posting with no stated publish date is NOT dropped — unknown is not a failed test, the same rule
  // orgFacets.ts follows.
  if (f.datePostedDays && job.postedAt) {
    if (Date.now() - new Date(job.postedAt).getTime() > f.datePostedDays * 86400e3) return null;
  }

  // The hiring.cafe facet filters — workplace type, commitment, seniority, department, org type,
  // clearance, industry, funding stage, company size, year founded, years of experience, salary —
  // also run on EVERY source, including a search row this client's own searchState fetched.
  //
  // That is deliberately unlike the keyword and geo checks below, and the difference is whether the
  // check is EXACT or an approximation. The keyword matcher is phrase-and-prefix based and the geo
  // gate is our own model of hiring.cafe's places; re-running either against a server-filtered row
  // would wrongly drop legitimate matches, which is why they stay behind the trust gate. A facet
  // check is neither — it compares the job's OWN STATED value against what the user selected, and
  // search rows carry those values on 100% of stored rows. Measured against the service: a page
  // fetched per filter, our check run over rows hiring.cafe had already filtered, 0 rejections
  // across 987 jobs and 8 filters. So it can be applied without cost.
  //
  // What it BUYS is the prune path. backfillMatches re-evaluates stored matches with
  // serverFiltered:true whenever a config changes; behind the trust gate, narrowing "Workplace" to
  // Remote left every previously-matched onsite job sitting on the dashboard, because those rows
  // were fetched under the old searchState and nothing re-checked them. Now tightening a facet
  // clears what no longer qualifies, which is what the rest of the prune contract already promises.
  if (!orgFacetsAllowed(job, client.search)) return null;

  const kws = (f.include_keywords ?? []).filter(Boolean);
  if (localRefine) {
    // not server-side filtered for THIS client: refine by keyword (ANY), within its scope.
    if (kws.length && !kws.some((k) => keywordHit(scopedText(h, f.keywordScope), k, exact))) return null;
    // Local country/state gate: org rows, watchlists, and cross-client hiringcafe rows (whose geo was
    // only vetted server-side for the client that fetched them).
    if ((isOrg || isWatchlist || isHiringCafe) && !geoAllowed(job, client.search?.locations)) return null;
  }

  // Advanced matching rule (§ tracker matchFilter): a job must satisfy the saved filter tree to match.
  // Runs on EVERY source — it is a local-only gate hiring.cafe knows nothing about. Empty tree passes.
  if (f.matchFilter && !evalQueryTreeJob(f.matchFilter, job, detectTech)) return null;

  const reason = [
    isHiringCafe ? "corporate" : isOrg ? "corporate · org" : "local",
    job.remote ? "remote" : job.state ? `geo:${job.state}` : null,
  ].filter(Boolean).join(" · ");

  // "What matched where" — best-effort provenance, computed only for jobs that actually matched.
  // Include keywords: record the specific field(s) each keyword hit (title/description/company/location
  // per scope). Technologies: the wanted techs the posting mentions. matchFilter: a single "rule" chip.
  const matchedOn: MatchedOn[] = [];
  for (const k of kws) {
    for (const [field, txt] of scopeFields(h, f.keywordScope)) {
      if (keywordHit(txt, k, exact)) { matchedOn.push({ term: k, field }); break; }
    }
  }
  if (f.technologies.length) {
    const found = detectTech();
    for (const t of f.technologies) if (found.has(t.toLowerCase())) matchedOn.push({ term: t, field: "tech" });
  }
  if (f.matchFilter?.children?.length) matchedOn.push({ term: "advanced rule", field: "rule" });

  return { jobId: job.id, client: client.name, matchReason: reason, ...(matchedOn.length ? { matchedOn } : {}) };
}
