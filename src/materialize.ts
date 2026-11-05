// Maps the ONE hiring.cafe-modeled search onto concrete adapter configs.
//   Corporate           → hiring.cafe only (1:1 server-side filtering)
//   Corporate + Local   → hiring.cafe + Craigslist + SimplyHired (local-SMB reach; best-effort filters)
import type { ClientConfig, SourceConfig } from "./types.ts";
import { buildSearchState, locationLabel, locationLabels } from "./hiringcafeFilters.ts";
import { countryFromLocation, usStateFromLocation, placeFromLocation } from "./geo.ts";

const DUMMY_INTERVAL = "0 * * * *"; // per-client cron drives timing; adapters ignore this

// Map a human location label → a Craigslist city site (local mode only).
//
// Every entry carries its COUNTRY, and that is not decoration. Dozens of these names exist in more
// than one country, and the lookup used to be a bare substring test that returned the first key in
// insertion order — so "Birmingham, AL" matched the UK's Birmingham. Verified against the live site
// while sweeping: that search returns postings in Dudley, in the English West Midlands, and they
// would have been presented to the user as local matches for Alabama. "Manchester, NH" reached
// England, "Paris, TX" reached France, "Vancouver, WA" reached British Columbia, and "Berlin, CT"
// reached Germany. The country now has to agree before a city site is used.
const CITY_MAP: Record<string, { site: string; cc: string }> = {
  "new york": { site: "newyork", cc: "US" }, "los angeles": { site: "losangeles", cc: "US" },
  "san francisco": { site: "sfbay", cc: "US" }, "bay area": { site: "sfbay", cc: "US" },
  chicago: { site: "chicago", cc: "US" }, houston: { site: "houston", cc: "US" },
  miami: { site: "miami", cc: "US" }, atlanta: { site: "atlanta", cc: "US" },
  dallas: { site: "dallas", cc: "US" }, seattle: { site: "seattle", cc: "US" },
  boston: { site: "boston", cc: "US" }, denver: { site: "denver", cc: "US" },
  phoenix: { site: "phoenix", cc: "US" }, austin: { site: "austin", cc: "US" },
  philadelphia: { site: "philadelphia", cc: "US" }, "san diego": { site: "sandiego", cc: "US" },
  portland: { site: "portland", cc: "US" }, washington: { site: "washingtondc", cc: "US" },
  "las vegas": { site: "lasvegas", cc: "US" }, nashville: { site: "nashville", cc: "US" },
  charlotte: { site: "charlotte", cc: "US" }, orlando: { site: "orlando", cc: "US" },
  detroit: { site: "detroit", cc: "US" },
  // Craigslist runs city sites outside the US too — without these, a search for London or Berlin
  // silently fell back to scraping five US cities and returned irrelevant local ads.
  london: { site: "london", cc: "GB" }, manchester: { site: "manchester", cc: "GB" },
  birmingham: { site: "birmingham", cc: "GB" }, glasgow: { site: "glasgow", cc: "GB" },
  dublin: { site: "dublin", cc: "IE" },
  berlin: { site: "berlin", cc: "DE" }, munich: { site: "munich", cc: "DE" },
  hamburg: { site: "hamburg", cc: "DE" }, frankfurt: { site: "frankfurt", cc: "DE" },
  paris: { site: "paris", cc: "FR" }, amsterdam: { site: "amsterdam", cc: "NL" },
  brussels: { site: "brussels", cc: "BE" }, zurich: { site: "zurich", cc: "CH" },
  geneva: { site: "geneva", cc: "CH" }, madrid: { site: "madrid", cc: "ES" },
  barcelona: { site: "barcelona", cc: "ES" }, rome: { site: "rome", cc: "IT" },
  milan: { site: "milan", cc: "IT" }, lisbon: { site: "lisbon", cc: "PT" },
  stockholm: { site: "stockholm", cc: "SE" }, copenhagen: { site: "copenhagen", cc: "DK" },
  oslo: { site: "oslo", cc: "NO" }, helsinki: { site: "helsinki", cc: "FI" },
  warsaw: { site: "warsaw", cc: "PL" }, prague: { site: "prague", cc: "CZ" },
  vienna: { site: "vienna", cc: "AT" },
  toronto: { site: "toronto", cc: "CA" }, vancouver: { site: "vancouver", cc: "CA" },
  montreal: { site: "montreal", cc: "CA" }, calgary: { site: "calgary", cc: "CA" },
  ottawa: { site: "ottawa", cc: "CA" },
  sydney: { site: "sydney", cc: "AU" }, melbourne: { site: "melbourne", cc: "AU" },
  brisbane: { site: "brisbane", cc: "AU" }, perth: { site: "perth", cc: "AU" },
  auckland: { site: "auckland", cc: "NZ" },
  tokyo: { site: "tokyo", cc: "JP" }, singapore: { site: "singapore", cc: "SG" },
  "hong kong": { site: "hongkong", cc: "HK" }, seoul: { site: "seoul", cc: "KR" },
  bangkok: { site: "bangkok", cc: "TH" },
  mumbai: { site: "mumbai", cc: "IN" }, delhi: { site: "delhi", cc: "IN" },
  bangalore: { site: "bangalore", cc: "IN" }, chennai: { site: "chennai", cc: "IN" },
  pune: { site: "pune", cc: "IN" },
  "mexico city": { site: "mexicocity", cc: "MX" }, "sao paulo": { site: "saopaulo", cc: "BR" },
  "são paulo": { site: "saopaulo", cc: "BR" }, "buenos aires": { site: "buenosaires", cc: "AR" },
  "tel aviv": { site: "telaviv", cc: "IL" }, dubai: { site: "dubai", cc: "AE" },
  "cape town": { site: "capetown", cc: "ZA" }, johannesburg: { site: "johannesburg", cc: "ZA" },
};
const DEFAULT_CL_CITIES = ["newyork", "losangeles", "chicago", "houston", "miami"];

// Per-keyword page ceilings. "deep" (default) = scrape everything; adapters stop early when a query
// is exhausted. hc = hiring.cafe, cl = Craigslist, sh = SimplyHired.
const DEPTH_PAGES: Record<string, { hc: number; cl: number; sh: number }> = {
  quick:    { hc: 8,   cl: 6,  sh: 5 },
  standard: { hc: 25,  cl: 12, sh: 15 },
  // "deep" = the "All pages (most thorough)" setting: a ceiling high enough that it never cuts a query
  // off (adapters stop early when a query is exhausted). hc 250 ≈ 24.5k postings/keyword — beyond any
  // realistic single-keyword result set. Pick Fast/Balanced if you want to bound fetch time instead.
  deep:     { hc: 250, cl: 60, sh: 90 },
};

/**
 * Which country a search label is about, or null when it genuinely cannot be told.
 *
 * countryFromLocation only recognises explicit country names and codes, so "Birmingham, AL" comes
 * back null — and null used to mean "no constraint", which is what let an Alabama search reach
 * England. A US state token is just as decisive as the word "Germany", so it counts too.
 */
export function labelCountry(label: string): string | null {
  return countryFromLocation(label)
    ?? (usStateFromLocation(label) ? "US" : null)
    ?? placeFromLocation(label);
}

/**
 * Label → the Craigslist city sites to scrape. Exported for tests: the ambiguity here is the
 * failure, and it is invisible from the outside — a wrong site returns real postings, just for the
 * wrong continent.
 */
export function deriveCities(label?: string): string[] {
  if (!label) return DEFAULT_CL_CITIES;
  const low = label.toLowerCase();
  const cc = labelCountry(label);
  // Earliest position first, then longest. A location label names the CITY first and the wider
  // region after it, so position is the stronger signal: "Seattle, Washington" must pick Seattle,
  // even though "washington" is the longer key and would otherwise send it to Washington DC.
  // Length breaks ties at the same position, so "San Francisco Bay Area" is not decided by whether
  // "san francisco" happens to be written before "bay area" in the object above.
  const named = Object.entries(CITY_MAP)
    .map(([k, v]) => ({ k, v, at: low.indexOf(k) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || b.k.length - a.k.length);
  // The country has to agree. When the label names one, only a city in that country is eligible;
  // "Birmingham, AL" then finds no eligible city rather than reaching for the UK's.
  const eligible = cc ? named.filter((x) => x.v.cc === cc) : named;
  if (eligible.length) return [eligible[0]!.v.site];
  if (cc === "US") return DEFAULT_CL_CITIES;   // a US place with no city site of its own
  if (cc) {
    // Outside the US with no city site: no Craigslist source at all. The US-cities fallback would
    // otherwise scrape New York for a search about Lisbon and present the results as local matches.
    // "for this place", not "for this search": a search can now carry several locations, and the
    // others may well have city sites. Saying "this search" would report a partial skip as a total one.
    console.log(`[craigslist] no city site for "${label}" (${cc}) — no Craigslist coverage for that place`);
    return [];
  }
  // Country genuinely unknown and no city matched — the historical default.
  return DEFAULT_CL_CITIES;
}

/** Build the concrete adapter configs for a client from its hiring.cafe-modeled search. */
export function materializeSources(client: ClientConfig): SourceConfig[] {
  const s = client.search ?? { keywords: [] };
  const kws = (s.keywords ?? []).filter(Boolean);
  const orgDomains = (s.orgDomains ?? []).map((x) => (x ?? "").trim()).filter(Boolean);
  const local = s.sourceMode === "corporate_local";
  const d = DEPTH_PAGES[s.searchDepth ?? "deep"] ?? DEPTH_PAGES.deep!;
  const label = locationLabel(s);            // first location — display + single-place decisions
  const labels = locationLabels(s);          // EVERY location — anything that fetches per place
  const out: SourceConfig[] = [];

  // Account Monitoring (watchlist): strictly domain-scoped — ONE hcorg source carrying the whole
  // domain list (fetched in parallel by the adapter). Keywords are a LOCAL filter (applied by the
  // matcher), never a market-wide hiring.cafe query, so a watchlist never crawls the whole market.
  if (client.kind === "watchlist") {
    if (!orgDomains.length) return [];
    // Chunk the domain list into several hcorg sources (not one giant source). A large watchlist —
    // hundreds or thousands of domains — must fetch with VISIBLE progress and INCREMENTAL persistence:
    // each chunk is a source, so runClientSources writes matches + advances the progress bar after every
    // chunk instead of going dark (0/1, nothing saved) until all domains finish. The adapter fetches a
    // chunk's domains in parallel through the adaptive gate; runClientSources bounds how many chunks run
    // at once. Tunable via HCORG_CHUNK.
    const CHUNK = Math.max(1, Number(process.env.HCORG_CHUNK) || 25);
    const chunks: SourceConfig[] = [];
    for (let i = 0; i < orgDomains.length; i += CHUNK) {
      chunks.push({ type: "hcorg", interval: DUMMY_INTERVAL, domains: orgDomains.slice(i, i + CHUNK), maxPages: d.hc } as SourceConfig);
    }
    return chunks;
  }

  // hiring.cafe keyword search — one query per keyword (each carries the full server-side searchState).
  // An empty-keyword search browses by filters alone; but skip that broad scan when the search is
  // purely org-domain monitoring (no keywords) so we don't crawl all of hiring.cafe.
  const queryKws = kws.length ? kws : (orgDomains.length ? [] : [""]);
  for (const kw of queryKws) {
    out.push({ type: "hiringcafe", interval: DUMMY_INTERVAL, maxPages: d.hc,
      searchState: buildSearchState(s, kw ? { searchQuery: kw } : {}) } as SourceConfig);
  }

  // Org-domain monitoring — one deterministic /org/<domain> scan per domain (results filtered locally
  // by the matcher: keyword ANY + date + geo). Runs alongside any keyword searches above.
  for (const domain of orgDomains) {
    out.push({ type: "hcorg", interval: DUMMY_INTERVAL, domain, maxPages: d.hc } as SourceConfig);
  }

  // Opt-in free remote boards (RemoteOK + WeWorkRemotely) — search-only, unfiltered feeds refined
  // locally by the matcher's keyword filter. One source pulls the whole feed; the matcher keeps only
  // roles matching this search's keywords.
  // (watchlists already returned above, so this is a keyword search)
  const extraBoards = (s.extraBoards ?? []).filter(Boolean);
  if (extraBoards.length) {
    out.push({ type: "remoteboards", interval: DUMMY_INTERVAL, boards: extraBoards } as SourceConfig);
  }

  // Local tier — Craigslist + SimplyHired (keyword + location only; the matcher refines).
  //
  // FANS OUT OVER EVERY SELECTED LOCATION. hiring.cafe gets the whole locations array in its
  // searchState, so picking London, Berlin and Paris is a three-city search there. This tier used to
  // read the FIRST location only: Craigslist scraped one city's site, SimplyHired ran one location
  // string, and the other two were dropped with nothing on screen saying so — local coverage silently
  // narrower than the corporate coverage beside it, for the same search.
  //
  // `[undefined]` when no location is set preserves the no-constraint behaviour exactly: deriveCities
  // falls back to its default city set and SimplyHired sends an empty location.
  if (local) {
    const places: (string | undefined)[] = labels.length ? labels : [undefined];

    // ONE Craigslist source carrying the union of every place's city sites. The adapter already
    // takes a city LIST and walks it, so this needs no fan-out of sources — and a union deduped by
    // site means two nearby places resolving to the same Craigslist city are scraped once, not twice.
    const clCities = [...new Set(places.flatMap((p) => deriveCities(p)))];
    if (clCities.length) {
      out.push({ type: "craigslist", interval: DUMMY_INTERVAL, cities: clCities,
        category: "jjj", queries: kws.length ? kws : ["jobs"], maxPages: d.cl } as SourceConfig);
    }
    // SimplyHired takes ONE location per request, so this is a genuine keyword x location fan-out.
    for (const kw of queryKws) {
      for (const place of places) {
        out.push({ type: "simplyhired", interval: DUMMY_INTERVAL, query: kw, location: place ?? "",
          datePostedDays: s.datePostedDays || undefined, maxPages: d.sh } as SourceConfig);
      }
    }
  }
  return out;
}

/** Filters the matcher applies. hiring.cafe results are already filtered server-side, so only the
 *  local-only filters (exclude words/companies) apply to them; the keyword/date refinement is used
 *  for Craigslist/SimplyHired results (see src/matcher.ts, which switches on the job source). */
/*  Cached by client identity (same pattern as watchedDomainSet in matcher.ts). The matcher calls this
 *  once per (job × client), and every call allocated four fresh arrays and ran three filters — pure
 *  garbage on a backfill of tens of thousands of jobs. A config reload builds new client objects, so
 *  entries can never go stale. */
const filtersCache = new WeakMap<object, ReturnType<typeof buildFilters>>();
function buildFilters(client: ClientConfig) {
  const s = client.search ?? { keywords: [] };
  return {
    include_keywords: (s.keywords ?? []).filter(Boolean),
    exclude_keywords: s.exclude ?? [],
    excludeCompanies: s.excludeCompanies ?? [],
    technologies: (s.technologies ?? []).filter(Boolean),
    datePostedDays: s.datePostedDays || 0,
    keywordScope: s.keywordScope ?? "anywhere",
    excludeKeywordScope: s.excludeKeywordScope ?? "anywhere",
    exactMatch: !!s.exactMatch,
    matchFilter: s.matchFilter,
  };
}
export function getFilters(client: ClientConfig): {
  include_keywords: string[]; exclude_keywords: string[]; excludeCompanies: string[]; technologies: string[]; datePostedDays: number;
  keywordScope: "anywhere" | "title" | "description"; excludeKeywordScope: "anywhere" | "title" | "description";
  exactMatch: boolean; matchFilter: import("./types.ts").QueryGroup | undefined;
} {
  let f = filtersCache.get(client);
  if (!f) { f = buildFilters(client); filtersCache.set(client, f); }
  return f;
}
