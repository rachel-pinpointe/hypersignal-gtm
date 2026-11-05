// Local enforcement of the hiring.cafe filters on rows hiring.cafe never filtered for us.
//
// THE PROBLEM. A keyword search sends `searchState` to hiring.cafe and gets back rows already filtered
// server-side — all 23 filters honoured, nothing to do here. An Account Check and a watchlist do not
// search: they fetch /org/<domain>, a URL that takes no filter parameters at all. Whatever those
// screens promise has to be enforced by us, and until now only five things were (include keywords,
// exclude words, excluded companies, technologies, date posted, location).
//
// Measured by asking evaluate() directly with a job that fails every stated filter: on the Account
// Check path 13 of the 16 filter controls had NO EFFECT. "Remote only, Senior Level, $500k minimum"
// returned an onsite junior cleaning role in Mumbai with no salary. Nothing on screen said so — the
// controls render, accept input, save, and are listed back in the check's own "search params" panel.
//
// WHAT MAKES THE FIX POSSIBLE. The facts were already there and already stored. Every /org/ row keeps
// hiring.cafe's own per-job fields in `raw`, and on a 4,000-row sample of live data: workplace_type,
// commitment, seniority, job_category, org_type, security_clearance, industry and employees are
// present on 100% of rows, founded on 88%, currency 97%, comp_min/comp_max 59%, yoe 55%,
// funding_type 43%. Nothing new has to be fetched.
//
// UNKNOWN IS NOT A FAILED TEST. A filter is applied only where the row actually states the fact. A
// posting that never said its salary is not "under $100k", and dropping it would be the same defect
// this codebase keeps finding: reporting an absent measurement as a fact about the data. hiring.cafe
// itself takes this position — it has separate opt-in flags for the stricter reading
// (`restrictJobsToTransparentSalaries`, `excludeIfRoleYoeIsNotSpecified`), and those two are honoured
// here as exactly that: opt-ins.
//
// A NOTE ON ATS ROWS. Direct Greenhouse/Lever/Ashby rows carry none of these fields, so every facet
// reads unknown and they pass. That is the intended behaviour under the rule above, not an oversight:
// those boards publish a title and a description, and inventing a seniority for them would be worse
// than admitting we do not know.
import type { RawJob, SearchSpec } from "./types.ts";

/** The stored hiring.cafe facets for a job, or an empty object for a row that has none. */
function facets(job: RawJob): Record<string, unknown> {
  const r = job.raw;
  return r && typeof r === "object" ? (r as Record<string, unknown>) : {};
}

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/**
 * Every value a stored facet actually asserts.
 *
 * A facet is not always one value. hiring.cafe joins multiple with a comma — "Full Time,Part Time" is
 * a role open to either — and an exact whole-string comparison rejects a job that genuinely matches.
 * Caught by asking hiring.cafe itself: a live search for commitmentTypes ["Part Time"] returned rows
 * stored as "Full Time,Part Time". hiring.cafe was right and the local check was wrong. 1,136 of the
 * 26,965 stored rows (4.2%) carry a comma-joined commitment.
 *
 * But splitting blindly is also wrong: "Environment, Health, and Safety" is ONE department, offered as
 * a single option, and appears with its commas on 80 rows. So the whole string is kept as a candidate
 * as well as its parts. A selection matches if it equals the whole value or any one part — which
 * answers both cases without either breaking the other. (The stray parts a split produces —
 * "environment", "health", "and safety" — collide with no offered option in any facet; checked.)
 */
function statedValues(value: unknown): string[] {
  const out: string[] = [];
  for (const v of (Array.isArray(value) ? value : [value]).map(norm).filter(Boolean)) {
    out.push(v);                                     // the value as stored, whole
    if (v.includes(",")) for (const part of v.split(",")) { const p = part.trim(); if (p) out.push(p); }
  }
  return out;
}

/** Does a stored facet match any selected option? Unknown → true (see header). */
function oneOf(value: unknown, selected: string[] | undefined): boolean {
  if (!selected?.length) return true;
  const vals = statedValues(value);
  if (!vals.length) return true;                     // the row never stated it — not a failed test
  return selected.some((s) => vals.includes(norm(s)));
}

/** Alias kept for the array-valued facets (industries arrive as an array on most rows). */
const anyOf = oneOf;

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Convert a salary bound to the YEARLY basis the stored figures use.
 *
 * raw.comp_min/comp_max are hiring.cafe's `yearly_min_compensation` / `yearly_max_compensation` —
 * always yearly, whatever the posting stated. A user asking for "min 25, Hourly" means 25/hour, and
 * comparing 25 against a yearly 52,000 would pass every job on earth. hiring.cafe does this conversion
 * server-side via calcFrequency; this is the same conversion, done locally.
 *
 * 2080 = 40h x 52w, the standard full-time year, and 260 = 5d x 52w. These are conventions, not facts
 * about any particular job, which is the honest limit of a local salary filter.
 */
/** Multiplier per pay period. Keyed lowercase; MUST cover every HC_OPTIONS.salaryFrequency value —
 *  a period with no entry here falls through to x1 and silently filters as though it were yearly,
 *  so "25 Quarterly" would ask for 25 a year. hcOptionsParity.test.ts pins the two together. */
export const PER_YEAR: Record<string, number> = {
  hourly: 2080, daily: 260, weekly: 52, "bi-weekly": 26, monthly: 12, yearly: 1,
};
function toYearly(amount: number, frequency: string | undefined): number {
  return amount * (PER_YEAR[norm(frequency) || "yearly"] ?? 1);
}

/**
 * Apply every hiring.cafe filter that CAN be applied to a row hiring.cafe did not filter.
 *
 * Returns false only when the row states a fact and that fact fails the filter. Not enforceable here,
 * and deliberately absent rather than faked:
 *   • roleTypes (Individual Contributor / People Manager) — hiring.cafe does not put this on the job,
 *     so there is nothing to compare against. The Account Check form no longer offers it.
 *   • sortBy — ordering, not filtering. /org/ pages come back newest-first regardless.
 */
export function orgFacetsAllowed(job: RawJob, s: SearchSpec | undefined): boolean {
  if (!s) return true;
  const f = facets(job);

  // ---- plain vocabulary matches -------------------------------------------------------------
  // workplace_type is the row's own word ("Remote"/"Hybrid"/"Onsite"/"Field"). Prefer it over the
  // derived job.remote boolean, which collapses four values into two and is set by a regex.
  if (!oneOf(f.workplace_type, s.workplaceTypes)) return false;
  if (!oneOf(f.commitment, s.commitmentTypes)) return false;
  if (!oneOf(f.seniority, s.seniorityLevels)) return false;
  if (!oneOf(f.job_category, s.departments)) return false;
  if (!oneOf(f.org_type, s.organizationTypes)) return false;
  if (!oneOf(f.security_clearance, s.securityClearances)) return false;
  if (!oneOf(f.funding_type, s.fundingStages)) return false;
  if (!anyOf(f.industry, s.industries)) return false;

  // ---- company size --------------------------------------------------------------------------
  // Selected ranges are OR-ed, matching the multi-select's meaning. An open-ended range stores null
  // as its upper bound ("10001+").
  if (s.companySizeRanges?.length) {
    const n = num(f.employees);
    if (n != null && !s.companySizeRanges.some(([lo, hi]) => n >= lo && (hi == null || n <= hi))) return false;
  }

  // ---- year founded --------------------------------------------------------------------------
  const founded = num(f.founded);
  if (founded != null) {
    if (s.minYearFounded != null && founded < s.minYearFounded) return false;
    if (s.maxYearFounded != null && founded > s.maxYearFounded) return false;
  }

  // ---- years of experience -------------------------------------------------------------------
  // yoe is the role's MINIMUM required experience. yoeMin/yoeMax bound that number, which is what
  // hiring.cafe's roleYoeRange does.
  const yoe = num(f.yoe);
  if (yoe == null) {
    if (s.excludeIfNoYoe && (s.yoeMin != null || s.yoeMax != null)) return false;  // the explicit opt-in
  } else {
    if (s.yoeMin != null && yoe < s.yoeMin) return false;
    if (s.yoeMax != null && yoe > s.yoeMax) return false;
  }

  // ---- salary --------------------------------------------------------------------------------
  // Same directions buildSearchState documents against hiring.cafe: min bounds the job's FLOOR from
  // below, max bounds the job's CEILING from above.
  const lo = num(f.comp_min), hi = num(f.comp_max);
  const stated = lo != null || hi != null;
  if (s.onlyTransparentSalary && !stated) return false;                            // the explicit opt-in
  if (stated && (s.salaryMin != null || s.salaryMax != null)) {
    // Only compare like with like. The row records the currency it was posted in; comparing a USD
    // bound against a JPY figure is not a stricter filter, it is a wrong one. An unstated currency is
    // unknown, and unknown does not fail a test.
    const jobCur = norm(f.currency);
    const wantCur = norm(s.salaryCurrency) || "usd";
    if (!jobCur || jobCur === wantCur) {
      if (s.salaryMin != null && lo != null && lo < toYearly(s.salaryMin, s.salaryFrequency)) return false;
      if (s.salaryMax != null && hi != null && hi > toYearly(s.salaryMax, s.salaryFrequency)) return false;
    }
  }

  return true;
}
