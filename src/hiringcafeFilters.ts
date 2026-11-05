// The single source of truth for hiring.cafe's filter contract (reverse-engineered in Step 0 — see
// docs/hiringcafe-contract.md). buildSearchState() turns our SearchSpec into the EXACT `searchState`
// hiring.cafe's own UI sends, so hiring.cafe filters server-side and we get true 1:1 results.
import type { SearchSpec, HcPlace } from "./types.ts";

/** Allowed option values, matching hiring.cafe exactly (used by the UI + for validation). */
export const HC_OPTIONS = {
  workplaceTypes: ["Remote", "Hybrid", "Onsite", "Field"],
  commitmentTypes: ["Full Time", "Part Time", "Contract", "Internship", "Temporary", "Seasonal", "Volunteer"],
  seniorityLevels: ["No Prior Experience Required", "Entry Level", "Mid Level", "Senior Level"],
  roleTypes: ["Individual Contributor", "People Manager"],
  securityClearances: ["None", "Confidential", "Secret", "Top Secret", "Top Secret/SCI", "Public Trust", "Interim Clearances", "Other"],
  organizationTypes: ["private", "public", "non-profit", "government", "cooperative / mutual"],
  salaryFrequency: ["Hourly", "Daily", "Weekly", "Bi-Weekly", "Monthly", "Yearly"],
  fundingStages: ["angel", "pre-seed", "seed", "series a", "series b", "series c", "series d", "series e",
    "series f", "series g", "series h", "series i", "crowdfunding", "private equity", "convertible note",
    "debt financing", "secondary market", "grant", "corporate round", "initial coin offering (ico)",
    "post-ipo equity", "post-ipo debt", "post-ipo secondary", "non-equity assistance", "funding round"],
  // value = [min, max|null]
  companySizeRanges: [[1, 10], [11, 50], [51, 200], [201, 500], [501, 1000], [1001, 2000], [2001, 5000], [5001, 10000], [10001, null]] as Array<[number, number | null]>,
  // sortBy value -> label
  sortBy: [
    ["default", "Relevance"], ["date", "Most recent"], ["date_asc", "Oldest"],
    ["compensation_desc", "Highest salary"], ["compensation_asc", "Lowest salary"],
    ["experience_asc", "Least experience"], ["experience_desc", "Most experience"],
  ] as Array<[string, string]>,
  // hiring.cafe's grouped department taxonomy (group -> leaf values that go into searchState.departments)
  //
  // The list was 37 values and hiring.cafe classifies jobs into more than that. Found by comparing the
  // offered options against the job_category actually stored on 26,965 rows: 15 values appeared that
  // nothing here offered, so 328 jobs sat in categories no user could ask for — and once departments
  // are enforced locally, those jobs are also rejected by any selection, with no way to include them.
  //
  // Each of the 15 was then put to hiring.cafe as searchState.departments to find out whether it is a
  // real FILTER value or merely a label it puts on jobs. 14 came back with results that were 100% in
  // the requested category, so they are real and are added below. The 15th, "Transportation",
  // returned zero jobs — accepted-but-empty and rejected look identical from here, so it is left out
  // rather than offered on a guess.
  //
  // Several sit next to a near-twin ("Finance" beside "Finance and Accounting", "Software
  // Engineering" beside "Software Development"). That duplication is hiring.cafe's taxonomy, not
  // ours, and they classify different jobs — dropping either one makes those jobs unreachable. They
  // are placed adjacent to their sibling so the pairing is visible in the menu.
  departments: {
    "Engineering & Technology": ["Software Development", "Software Engineering", "Information Technology", "Technology", "Engineering", "Data and Analytics", "Product Management", "Design", "Quality Assurance", "Quality", "Project and Program Management"],
    "Business & Operations": ["Business Operations", "Operations", "Legal and Compliance", "Finance and Accounting", "Finance", "Accounting", "Consulting Services", "Retail and Wholesale", "Human Resources", "Administrative & Clerical Support"],
    "Sales & Marketing": ["Sales", "Marketing", "Communications and Public Affairs", "Business Development"],
    "Creative & Media": ["Creative and Art Services", "Media and Communications"],
    "Healthcare": ["Healthcare Services - Advanced Practice", "Healthcare Services - Allied Health", "Healthcare Services - Nursing", "Healthcare Services - Pharmacy", "Healthcare Services - Veterinary", "Healthcare"],
    "Customer & Social Services": ["Customer Service", "Social Services"],
    "Skilled Trades": ["Skilled Trades - Construction", "Skilled Trades - Mechanical and Electrical", "Skilled Trades - Manufacturing and Industrial", "Manufacturing", "Skilled Trades - Maintenance and Repair", "Skilled Trades - General Labor"],
    "Transportation & Logistics": ["Transportation Services", "Transportation and Logistics", "Supply Chain / Logistics / Procurement"],
    "Other": ["Education services", "Research and Development (R&D)", "Research and Development", "Food and Beverage Services", "Protective Services", "Custodial Services", "Environment, Health, and Safety"],
  } as Record<string, string[]>,
} as const;

export const HC_DEFAULTS = { dateFetchedPastNDays: 121, maxYoe: 20, sortBy: "default" };

const hasItems = (a?: unknown[]): a is unknown[] => Array.isArray(a) && a.length > 0;

/**
 * Build hiring.cafe's `searchState`. Only keys that are actually set are included (hiring.cafe
 * defaults the rest). `extra` carries the per-call facet: `{ searchQuery }` for a keyword query
 * (dashboard) or `{ companyNames }` for the account-check company facet.
 */
export function buildSearchState(s: SearchSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const st: Record<string, unknown> = {};

  if (hasItems(s.locations)) st.locations = s.locations as HcPlace[];
  if (hasItems(s.workplaceTypes)) st.workplaceTypes = s.workplaceTypes;
  if (hasItems(s.commitmentTypes)) st.commitmentTypes = s.commitmentTypes;
  if (hasItems(s.seniorityLevels)) st.seniorityLevel = s.seniorityLevels; // note: singular key, array value
  if (hasItems(s.departments)) st.departments = s.departments;
  if (hasItems(s.roleTypes)) st.roleTypes = s.roleTypes;
  if (hasItems(s.industries)) st.industries = s.industries;
  if (hasItems(s.companySizeRanges)) st.companySizeRanges = s.companySizeRanges;
  if (hasItems(s.fundingStages)) st.latestInvestmentSeries = s.fundingStages;
  if (hasItems(s.securityClearances)) st.securityClearances = s.securityClearances;
  if (hasItems(s.organizationTypes)) st.organizationTypes = s.organizationTypes;
  if (s.minYearFounded != null) st.minYearFounded = s.minYearFounded;
  if (s.maxYearFounded != null) st.maxYearFounded = s.maxYearFounded;

  // years of experience → roleYoeRange [min, max]
  if (s.yoeMin != null || s.yoeMax != null) {
    st.roleYoeRange = [s.yoeMin ?? 0, s.yoeMax ?? HC_DEFAULTS.maxYoe];
    if (s.excludeIfNoYoe) st.excludeIfRoleYoeIsNotSpecified = true;
  }

  // salary band — verified 1:1 against hiring.cafe (see docs/hiringcafe-contract.md):
  //   min → minCompensationLowEnd  (job's pay floor must be ≥ min)
  //   max → maxCompensationHighEnd (job's pay ceiling must be ≤ max)
  //   currency/frequency are {label,value} OBJECTS (bare strings are ignored), + calcFrequency string.
  if (s.salaryMin != null) st.minCompensationLowEnd = s.salaryMin;
  if (s.salaryMax != null) st.maxCompensationHighEnd = s.salaryMax;
  if (s.salaryMin != null || s.salaryMax != null) {
    // hiring.cafe requires both objects once a bound is set, so these fallbacks have to exist — but
    // they are ASSUMPTIONS, and a wrong one silently changes what the search means rather than
    // failing. "salaryMin: 40000" with no currency asks for USD 40,000, which is the wrong question
    // for a UK watchlist; "salaryMin: 25" with no frequency asks for 25 per YEAR, which is not a
    // filter at all. The dashboard always sends both (the form has explicit selects), so this only
    // reaches a hand-written clients/*.yaml or a direct API call — exactly the authors with no
    // on-screen default to notice. Say so in the log rather than assuming quietly.
    if (s.salaryCurrency == null || s.salaryFrequency == null) {
      console.warn(`[search] salary bound set without ${s.salaryCurrency == null ? "a currency" : ""}`
        + `${s.salaryCurrency == null && s.salaryFrequency == null ? " or " : ""}`
        + `${s.salaryFrequency == null ? "a pay period" : ""} — assuming `
        + `${s.salaryCurrency ?? "USD"}/${s.salaryFrequency ?? "Yearly"}. Set salaryCurrency and salaryFrequency to filter on what you mean.`);
    }
    const cur = s.salaryCurrency || "USD";
    const freq = s.salaryFrequency || "Yearly";
    st.currency = { label: cur, value: cur };
    st.frequency = { label: freq, value: freq };
    st.calcFrequency = freq;
  }
  if (s.onlyTransparentSalary) st.restrictJobsToTransparentSalaries = true;

  if (s.datePostedDays && s.datePostedDays > 0) st.dateFetchedPastNDays = s.datePostedDays;
  if (s.sortBy && s.sortBy !== "default") st.sortBy = s.sortBy;

  return { ...st, ...extra };
}

/** A short human label for a location — the FIRST one, for UI display and single-place decisions.
 *  Anything that FETCHES per location must use locationLabels() instead, or it silently covers one
 *  place while hiring.cafe covers all of them. */
export function locationLabel(s: SearchSpec): string | undefined {
  return s.locations?.[0]?.formatted_address;
}

/**
 * EVERY selected location, deduped, in the order chosen.
 *
 * searchState.locations carries the whole array to hiring.cafe, so a three-city search is a
 * three-city search there. The local tier used to read locationLabel() — the first one only — so
 * Craigslist scraped one city's site and SimplyHired ran one location string. Picking London, Berlin
 * and Paris got local coverage of London, and nothing said the other two were dropped.
 *
 * Empty when no location is set, which callers read as "no location constraint" — the same thing an
 * absent label meant before.
 */
export function locationLabels(s: SearchSpec): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of s.locations ?? []) {
    const label = (p?.formatted_address ?? "").trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out;
}

/** The country short_name (e.g. "US") from the first location, if any. */
export function locationCountry(s: SearchSpec): string | undefined {
  const ac = s.locations?.[0]?.address_components ?? [];
  return ac.find((c) => c.types?.includes("country"))?.short_name;
}
