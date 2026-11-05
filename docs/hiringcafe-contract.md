# hiring.cafe filter contract (reverse-engineered)

Captured from the live site's `__NEXT_DATA__` + JS bundle (`src/probeHiringCafe*.ts`). This is the
ground truth for building the exact `searchState` so hiring.cafe filters server-side (true 1:1).

## Search request
- Jobs page: `GET https://hiring.cafe/?searchState=<urlencoded JSON>&page=N` → SSR `__NEXT_DATA__.props.pageProps.ssrHits[]` (already used by `scrapeHiringCafe`).
- `POST /api/search-jobs` → 405 (not usable). SSR param is the way.

## Org page (deterministic per-company lookup)  ✅ used by `scrapeHiringCafeOrg`
- `GET https://hiring.cafe/org/<domain>?page=N` (e.g. `/org/scorpiogroup.net`) — a company's openings
  keyed by **domain** (unique; no fuzzy name matching). Verified live 2026-06.
- Jobs are at `__NEXT_DATA__.props.pageProps.initialJobs[]` — **NOT** `ssrHits`. Each entry has the
  identical shape `mapHit()` consumes (`id, apply_url, source, board_token, is_expired,
  job_information, v5_processed_job_data, enriched_company_data`).
- Other `pageProps`: `totalJobs` (number — stop paginating once collected ≥ it), `companyURI`
  (the domain), `companyInfo` (firmographics), `notInDatabase: true` when hiring.cafe doesn't know the
  domain (→ 0 jobs, not an error), `serverError`.
- Pagination: `?page=N`, **25 per page** (probe: page0=25, page1=9 of a 34-total company).
- **The full job description is NOT in `initialJobs`** (only structured `requirements_summary` /
  `role_activities` in `v5_processed_job_data`). It lives on the detail page:
  `GET /job/<slug>-<token>` → `__NEXT_DATA__.props.pageProps.job.job_information.description` (HTML).
  The bare `/job/<id>` form (raw job id) **404s** — you must use the DOM anchor href from the org/list
  page (`a[href^="/job/"]`), which `scrapeHiringCafeOrg` pairs to jobs by index.

## Location autocomplete  ✅ plain server-side fetch works (no Cloudflare, no cookies)
- `GET https://hiring.cafe/api/searchLocation?query=<text>`  (only `?query=` works; `?q`/`?searchString` → `[]`; POST → 405)
- Returns: `[{ label, value, placeDetail }]`
- **`placeDetail` is exactly what goes into `searchState.locations[]`.** Shape:
  ```json
  { "id": "xRg1yZQBoEtHp_8UXQ1z", "types": ["locality"],
    "address_components": [
      {"long_name":"London","short_name":"London","types":["locality"]},
      {"long_name":"England","short_name":"ENG","types":["administrative_area_level_1"]},
      {"long_name":"United Kingdom","short_name":"GB","types":["country"]}],
    "geometry": {"location": {"lat":51.50853,"lon":-0.12574}},
    "formatted_address": "London, England, GB", "population": 8961989 }
  ```
  Granularity comes back per match: `types:["country"]` / `["administrative_area_level_1"]` (state) / `["locality"]` (city).
  Country/state entries omit `geometry`. The auto-detected initial location adds `options.flexible_regions`.

## searchState keys (from bundle `saveSearchKeys` + initialState defaults)
Default/empty state:
```
searchQuery:"", locations:[], workplaceTypes:[], commitmentTypes:[], seniorityLevel:[],
departments:[], categories:[], roleTypes:[], industries:[], excludedIndustries:[],
companyNames:[], companyKeywords:[], excludedCompanyKeywords:[], companyKeywordsBooleanOperator,
roleYoeRange:[null,null] (max bound 20), excludeIfRoleYoeIsNotSpecified,
managementYoeRange:[null,null], excludeIfManagementYoeIsNotSpecified,
currency, frequency, minCompensationLowEnd, minCompensationHighEnd, maxCompensationHighEnd,
restrictJobsToTransparentSalaries, hideJobTypes,
companySizeRanges:[], minYearFounded:null, maxYearFounded:null,
latestInvestmentSeries:[], excludedLatestInvestmentSeries:[], latestInvestmentYearRange:[null,null],
latestInvestmentAmount, latestInvestmentCurrency:[], investors:[], excludedInvestors:[],
companyPublicOrPrivate:"all", isNonProfit:"all", organizationTypes:[], excludedOrganizationTypes:[],
securityClearances:[], languageRequirements:[], educationRequirements (associates/bachelors/masters/doctorate…),
benefitsAndPerks:[], encouragedToApply:[], dateFetchedPastNDays:121, sortBy:"default",
jobTitleQuery, technologyKeywordsQuery, jobDescriptionQuery, requirementsKeywordsQuery,
airTravelRequirement, landTravelRequirement, morning/evening/overnightShiftWork,
weekend/holidayAvailabilityRequired, overtimeRequired, onCallRequirements
```
Defaults: `dateFetchedPastNDays:121`, `defaultRadius:50`, `maxYearsOfExperience:20`, `sortBy:"default"`.

## Option vocabularies (exact values)
- **workplaceTypes**: `Remote, Hybrid, Onsite, Field`
- **commitmentTypes**: `Full Time, Part Time, Contract, Internship, Temporary, Seasonal, Volunteer`
- **seniorityLevel**: `No Prior Experience Required, Entry Level, Mid Level, Senior Level`
- **roleTypes**: `Individual Contributor, People Manager`
- **securityClearances**: `None, Confidential, Secret, Top Secret, Top Secret/SCI, Public Trust, Interim Clearances, Other`
- **organizationTypes**: `private, public, non-profit, government, cooperative / mutual`
- **frequency** (salary): `Hourly, Daily, Weekly, Bi-Weekly, Monthly, Yearly` (Any = null)
- **salary mapping (verified empirically against live results):** the filter has 4 comp keys
  (`min/maxCompensationLowEnd/HighEnd`). A user range maps as **min → `minCompensationLowEnd`**
  (job pay floor ≥ min) and **max → `maxCompensationHighEnd`** (job pay ceiling ≤ max).
  `currency` and `frequency` are **`{label, value}` objects** (e.g. `{label:"USD",value:"USD"}`,
  `{label:"Yearly",value:"Yearly"}`) — bare strings are ignored — plus a `calcFrequency` string
  (e.g. `"Yearly"`). `restrictJobsToTransparentSalaries` (bool) limits to comp-bearing jobs.
  Note: `minCompensationHighEnd` (the only comp key in `saveSearchKeys`) does NOT gate results in
  practice; `minCompensationLowEnd` is the one that works.
- **companySizeRanges** (value = `[min,max]` tuple): `[1,10] (Micro), [11,50] (Small), [51,200] (Mid-size), [201,500], [501,1000], [1001,2000], [2001,5000], [5001,10000], [10001,null] (Enterprise)`
- **sortBy**: `default` (Relevance), `date` (Most recent), `date_asc` (Oldest), `compensation_desc` (Highest salary), `compensation_asc` (Lowest salary), `experience_asc` (Least experience), `experience_desc` (Most experience)
- **latestInvestmentSeries**: `angel, pre-seed, seed, series a … series i, crowdfunding, private equity, convertible note, debt financing, secondary market, grant, corporate round, initial coin offering (ico), post-ipo equity, post-ipo debt, post-ipo secondary, non-equity assistance, funding round`
- **roleYoeRange**: `[min, max]`, UI max bound 20; pair with `excludeIfRoleYoeIsNotSpecified` (bool)
- **dateFetchedPastNDays**: number of days (our "posted within"); site default 121
- **departments** (grouped taxonomy; leaf values are what go in `departments[]`): Engineering/IT/Software/Product/Design/Data groups + Business Operations, Legal and Compliance, Finance and Accounting, Human Resources, Administrative & Clerical Support; Sales, Marketing, Communications and Public Affairs, Business Development; Healthcare Services - {Advanced Practice, Allied Health, Nursing, Pharmacy, Veterinary}; Education services; Customer Service, Social Services; Skilled Trades - {Construction, Mechanical and Electrical, Manufacturing and Industrial, Maintenance and Repair, General Labor}; Transportation Services, Supply Chain / Logistics / Procurement; Quality Assurance, Environment Health and Safety; Research and Development (R&D); Food and Beverage Services; Protective Services; Custodial Services.
- **industries / currency list**: referenced via minified vars (not inlined). Derive industries from job data / fetch later; currency default `USD`, expose common ISO codes.

## Mapping note for account check
Account check sets `companyNames:[...]` (the company facet) PLUS the same filter keys above. Everything
else is server-side; we only keep company-name grouping + per-posting dedupe locally.
