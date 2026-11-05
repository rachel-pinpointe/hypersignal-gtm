// Canonical shapes shared across the engine.

/** A normalized job posting from any source. */
export interface RawJob {
  /** stable dedup id = sha1(source + ":" + externalId) */
  id: string;
  source: string;        // e.g. "rss:remoteok", "ats:greenhouse:stripe", "craigslist:newyork"
  externalId: string;    // guid/link/api job id
  title: string;
  company: string | null;
  location: string | null;
  state: string | null;  // 2-letter US state if derivable (US locations only)
  country?: string | null; // ISO alpha-2 when the location says so confidently, else null (= unknown, NOT "US")
  remote: boolean;
  url: string;
  postedAt: string | null; // ISO
  domain?: string | null;    // company domain, when the job URL points at the company's own site
  dedupKey?: string | null;  // canonical identity across sources/boards (collapse_key ▸ url ▸ source:id)
  expiresAt?: string | null; // explicit close date where a source provides one (Himalayas, ATS)
  status?: "open" | "closed"; // explicit lifecycle when a source tells us (hiring.cafe is_expired)
  raw: unknown;          // original payload (stored as JSON)
  /** Searchable description text (the stored raw_jobs.description column, or composed from raw at
   *  ingest time). Optional — used by the matcher's keyword refinement; never persisted from here. */
  description?: string | null;
}

/** One reason a job matched: a term that hit, and the field it hit in. Surfaced as the "What matched"
 *  column. `field` is "title" | "description" | "company" | "location" | "tech" | "rule" (a matchFilter
 *  condition that passed). Best-effort — an empty/absent array just renders nothing. */
export interface MatchedOn {
  term: string;
  field: "title" | "description" | "company" | "location" | "tech" | "rule";
}

/** A job that matched a client's filters. */
export interface Match {
  jobId: string;
  client: string;
  matchReason: string;
  /** Per-match provenance: which terms matched in which fields (keyword scope, technologies, rules). */
  matchedOn?: MatchedOn[];
}

// ---- Advanced-filter query tree (shared shapes) ----
// The visual filter builder's model. Compiled to SQL by src/db.ts (compileQueryTree) for stored-job
// views, evaluated per-RawJob by src/queryEval.ts (evalQueryTreeJob) for tracker-time matching, and
// mirrored in the browser (web/app.js evalQueryTree) for account-check results.
export type QueryOp =
  | "contains" | "ncontains" | "eq" | "neq" | "empty" | "nempty"
  | "is" | "isnot" | "anyof" | "noneof" | "istrue" | "isfalse" | "withindays" | "olderdays"
  | "gte" | "lte" | "between" | "has" | "nhas" | "matches" | "nmatches"
  | "word" | "nword"          // whole-word (exact) contains / does-not-contain (§ exact matches)
  | "containsany" | "ncontainsany"; // contains ANY / NONE of several values (Clay-style multi-value)
export interface QueryCond { field: string; op: QueryOp; value?: string | number | string[]; }
export interface QueryGroup { combinator: "AND" | "OR"; children: Array<QueryCond | QueryGroup>; caseSensitive?: boolean; }

// ---- Client config (validated by src/config.ts) ----

export interface CompanySignalRules {
  min_open_roles?: number;
  flag_repeat_postings?: boolean;
}

export interface SourceConfig {
  type: "hiringcafe" | "hcorg" | "craigslist" | "simplyhired" | "ats" | "remoteboards";
  interval: string;          // cron expression
  enabled?: boolean;         // default true
  /** Scheduled re-fetch: sort newest-first and stop paginating once a whole page is already stored.
   *  Set by runSource for scheduled runs only — manual fetches always crawl the full depth. */
  incremental?: boolean;
  [key: string]: unknown;    // per-adapter params
}

/** A structured place from hiring.cafe's /api/searchLocation (its `placeDetail`). Goes verbatim
 *  into searchState.locations[] so hiring.cafe filters location server-side (true 1:1). */
export interface HcPlace {
  id?: string;
  types?: string[];          // ["country"] | ["administrative_area_level_1"] | ["locality"] …
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
  geometry?: { location?: { lat: number; lon: number } };
  formatted_address: string; // e.g. "London, England, GB"
  population?: number;
  options?: { flexible_regions?: string[] };
}

/**
 * The search a user fills in — modeled 1:1 on hiring.cafe's filters. Sent (via buildSearchState)
 * as hiring.cafe's `searchState` so hiring.cafe filters server-side. `exclude`/`excludeCompanies`
 * are the only locally-applied filters; in "corporate_local" mode the local sources get the subset
 * they natively support (keywords/location/date) plus the slim matcher.
 */
export interface SearchSpec {
  keywords: string[];                       // searchQuery (one query per keyword, unioned)
  keywordScope?: "anywhere" | "title" | "description"; // which field include keywords must hit (default "anywhere" = title+company+location+description)
  exclude?: string[];                       // words that drop a posting (local)
  excludeKeywordScope?: "anywhere" | "title" | "description"; // which field exclude keywords test (default "anywhere")
  exactMatch?: boolean;                     // whole-word keyword matching for include+exclude (default false = prefix-aware). ".net"/"c++" keep no leading boundary
  excludeCompanies?: string[];              // company names to drop (local)
  technologies?: string[];                  // detected-technology gate (local): a posting must mention ANY of these to match
  matchFilter?: QueryGroup;                 // advanced matching rule tree — a job must satisfy it to match (evaluated per-job by src/queryEval.ts)
  sourceMode?: "corporate" | "corporate_local"; // corporate = hiring.cafe only; +local adds Craigslist/SimplyHired
  orgDomains?: string[];                    // deterministic per-company monitoring via hiring.cafe /org/<domain>
  includeOrgJobs?: boolean;                 // search-only opt-in: also match org-domain rows fetched by OTHER monitors / account-checks (default off = only this search's own fetches). Ignored for watchlists.
  useAts?: boolean;                         // default true: also pull each watched domain's Greenhouse/Lever/Ashby board directly. Set false to disable ATS discovery for this client.
  extraBoards?: string[];                   // opt-in free remote boards for keyword searches (e.g. ["remoteok","wwr"])
  locations?: HcPlace[];                    // structured (hiring.cafe) — also drives local-source location

  // hiring.cafe filters (sent server-side, 1:1) — see src/hiringcafeFilters.ts for value vocabularies
  workplaceTypes?: string[];                // Remote / Hybrid / Onsite / Field
  commitmentTypes?: string[];               // Full Time / Part Time / Contract / Internship / …
  seniorityLevels?: string[];               // → searchState.seniorityLevel
  departments?: string[];                   // job functions
  roleTypes?: string[];                     // Individual Contributor / People Manager
  industries?: string[];
  companySizeRanges?: Array<[number, number | null]>;
  fundingStages?: string[];                 // → latestInvestmentSeries
  securityClearances?: string[];
  organizationTypes?: string[];
  minYearFounded?: number | null;
  maxYearFounded?: number | null;
  yoeMin?: number | null;
  yoeMax?: number | null;
  excludeIfNoYoe?: boolean;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string;
  salaryFrequency?: string;                 // Hourly / Daily / Weekly / Bi-Weekly / Monthly / Yearly
  onlyTransparentSalary?: boolean;
  datePostedDays?: number;                  // → dateFetchedPastNDays (0 = any)
  sortBy?: string;                          // searchState.sortBy
  searchDepth?: "quick" | "standard" | "deep"; // per-keyword pagination ceiling
}

/** Full-control fetch schedule (replaces the fixed cron presets). One of:
 *   - interval:  run every N minute|hour|day (arbitrary N — cron can't express e.g. "every 90 min").
 *   - recurring: at specific time(s)-of-day on chosen days (every day / weekdays / weekends / specific
 *                weekdays / specific days-of-month). Compiles to one cron per time.
 *   - once:      a single run at an exact local date-time, then done (a past `at` is skipped on boot).
 *   - cron:      raw cron expression (advanced / legacy passthrough).
 * `refreshCron` stays as the back-compat fallback when `schedule` is absent. */
export type FetchSchedule =
  | { mode: "interval"; every: number; unit: "minute" | "hour" | "day" }
  | { mode: "recurring"; times: string[]; days?: "everyday" | "weekdays" | "weekends"; daysOfWeek?: number[]; daysOfMonth?: number[] }
  | { mode: "once"; at: string }
  | { mode: "cron"; expr: string };

export interface ClientConfig {
  name: string;
  active: boolean;
  /** "search" = keyword-first market monitoring (Client Monitoring). "watchlist" = account-first
   *  domain monitoring (Account Monitoring): scans only the listed orgDomains, keywords filter locally.
   *  Absent = "search" (back-compat). */
  kind?: "search" | "watchlist";
  search: SearchSpec;
  refreshCron?: string;                     // legacy fixed schedule (fallback when `schedule` is absent)
  schedule?: FetchSchedule;                 // full-control fetch schedule (interval / recurring / once / cron)
  /** Enabled signal-producer keys (src/signals) — run over orgDomains after each scheduled fetch. */
  signals?: string[];
  company_signals?: CompanySignalRules;
  delivery?: {
    webhook_url?: string;
    mode?: "realtime" | "scheduled";
    schedule?: string;
  };
  /** Per-signal-type routing: signal FAMILY ("funding"/"warn"/"velocity"/…) → webhook URL. Overrides
   *  delivery.webhook_url for matching signals; unlisted families fall back to the default. */
  signal_webhooks?: Record<string, string>;
}
