// THE single source of truth for what a signal type MEANS — its human label, its plain-English
// explanation, its CATEGORY, how strong its evidence is, and whether it can be collapsed with the
// same real-world event reported by another source.
//
// Why a category layer instead of renaming types: the same event carries a different type per
// region/source — a raise is `funding-form-d` (US SEC), `ch-share-allotment` (UK Companies House),
// `news-funding` (press) or `gdelt-funding` (global press). To a salesperson that is ONE thing.
// But the type still matters: an SEC filing is harder evidence than a rumour, and renaming would
// re-fire history (EDGAR builds its dedup key from the type) and break webhook consumers matching
// the old string. So: keep the type, add the category, and let the category drive filtering,
// colour, grouping and routing.
//
// This module is PURE (zero imports) so src/db.ts can import it during the boot migration without
// a cycle. It replaces four competing "family" algorithms that existed before it (a split("-") in
// delivery.ts, another in app.js, a startsWith() guide map, and a hand-written route list).

export interface SignalCategory { key: string; label: string; blurb: string }
export interface SignalTypeMeta {
  type: string;
  label: string;
  category: string;
  explain: string;
  rank: number;              // evidence strength — decides which source leads a collapsed group
  collapse: string | null;   // cross-source event class; null = never collapse this type
  attribution: Attribution;  // HOW we decided this event belongs to this company — see below
}

/**
 * How a signal got attached to a company. This is not a quality score — it is the honest answer to
 * "why do you think this is about them?", and the feed shows it.
 *
 *  direct — we observed the company's OWN domain: its DNS, its site, its job boards, its app
 *           listings, its ad library page. The domain IS the identifier, so there is nothing to
 *           get wrong.
 *  name   — we searched a third-party corpus (news, SEC EDGAR, Companies House, state WARN lists,
 *           Product Hunt) for the company's NAME. Names are ambiguous: "Notion" is also an English
 *           noun, "Stripe" appears inside "Pantera Opportunities Fund SP Stripe". The matcher is
 *           deliberately conservative (whole-word for free text, prefix-anchored for entity names)
 *           but it can still be wrong, and a signal that MIGHT be about someone else must say so
 *           rather than being printed as plain fact.
 */
export type Attribution = "direct" | "name";
export const ATTRIBUTION_NOTE: Record<Attribution, string> = {
  direct: "Observed on the company's own domain — DNS, their website, their job boards or their app/ad listings.",
  name: "Matched to this company by NAME in a third-party source. Names are ambiguous, so open the source and confirm it is really them before acting on it.",
};

/** Display order. `other` is the catch-all so an unmapped type is grey-but-styled, never invisible. */
export const SIGNAL_CATEGORIES: SignalCategory[] = [
  { key: "funding", label: "Funding", blurb: "They raised money — from official filings (SEC, UK Companies House) or the press." },
  { key: "corporate", label: "Corporate event", blurb: "A major corporate event disclosed in an official filing." },
  { key: "layoffs", label: "Layoffs", blurb: "They're cutting jobs — government filings or news." },
  { key: "launch", label: "Launch", blurb: "They shipped something new — a product, an app, or a new web surface." },
  { key: "expansion", label: "Expansion", blurb: "New market, office or location." },
  { key: "hiring", label: "Hiring", blurb: "Derived from the jobs we already track — no extra fetching." },
  { key: "leadership", label: "Leadership", blurb: "A new decision-maker, or one leaving." },
  { key: "partnership", label: "Partnership", blurb: "A new partnership or integration." },
  { key: "tooling", label: "Tool change", blurb: "They adopted, dropped or switched a tool — from DNS records, their site, and their job boards." },
  { key: "marketing", label: "Marketing", blurb: "Their paid-advertising posture changed." },
  { key: "quiet", label: "Going quiet", blurb: "Something they used to invest in looks deprioritized." },
  { key: "other", label: "Other", blurb: "Signals not yet categorized." },
];

/** Evidence tiers — an official filing outranks our own observation, which outranks the press. */
const RANK_FILING = 100, RANK_OWN = 70, RANK_CURATED = 40, RANK_NEWS = 20;
export const RANK_UNKNOWN = 10;

/** Collapse windows (days) per event class. A round is reported over ~2-3 weeks between the filing
 *  date and the press pickup; a WARN filing precedes the press by weeks; a launch is same-fortnight. */
export const COLLAPSE_WINDOW_DAYS: Record<string, number> = {
  funding: 21, ipo: 30, layoffs: 30, launch: 14, expansion: 21, leadership: 14, partnership: 14,
};

/** Every emitted signal type. Labels + explanations moved verbatim from web/app.js so the feed, the
 *  Guide and the webhook payload can never drift apart. */
export const SIGNAL_TYPE_META: SignalTypeMeta[] = [
  { type: "velocity-spike", label: "Hiring accelerating", category: "hiring", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "They posted far more roles in the last 30 days than the month before — a hiring surge (often growth or new funding). Only fires once we've tracked them 60+ days, against a real non-zero prior month." },
  { type: "velocity-location", label: "New hiring location", category: "expansion", rank: RANK_OWN, collapse: "expansion", attribution: "direct",
    explain: "A job location we hadn't seen for this company appeared recently — a possible new office or market." },
  { type: "velocity-repost", label: "Chronic repost", category: "hiring", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "The same role, at the same location, has been advertised on at least 3 separate dates spanning 3+ weeks — they're likely struggling to fill it (a staffing/recruiting opening). Same title in several DIFFERENT cities at once is not this: that is parallel hiring, and it is counted under hiring pace instead." },
  { type: "dns-mx-changed", label: "Email provider switched", category: "tooling", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "Their email provider (from DNS MX records) changed — an IT/email migration." },
  { type: "dns-tool-added", label: "Sending tool added", category: "tooling", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "A new sending tool is now authorized to send email as them (from their SPF record) — e.g. they just started using Klaviyo or Outreach." },
  { type: "dns-tool-removed", label: "Sending tool removed", category: "tooling", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "A sending tool they used to authorize is gone from their SPF record — possible churn away from that vendor." },
  { type: "ats-switched", label: "ATS switched", category: "tooling", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "Their applicant-tracking system changed (e.g. Lever → Ashby) — they're re-tooling how they hire." },
  { type: "tech-added", label: "Tech added to site", category: "tooling", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "A tool now appears on the company's own website that wasn't there at the last scan — a new rollout. Read from their live homepage, not from job ads: this is unrelated to the Technologies page, which counts what job postings mention." },
  { type: "tech-removed", label: "Tech removed from site", category: "tooling", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "A tool we detected on their website before is gone — a possible switch or churn. Read from their live homepage, not from job ads." },
  { type: "subdomain-new", label: "New subdomain", category: "launch", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "A new subdomain appeared in public certificate logs (e.g. app./shop./docs.) — a new product or surface." },
  { type: "funding-form-d", label: "Raised (Form D)", category: "funding", rank: RANK_FILING, collapse: "funding", attribution: "name",
    explain: "Form D is the SEC filing companies submit when they raise private capital (a funding round) — even when there's no press release." },
  { type: "filing-8k", label: "8-K filed", category: "corporate", rank: RANK_FILING, collapse: null, attribution: "name",
    explain: "An 8-K is the SEC filing for a major corporate event (acquisition, executive change, big news) — worth a look." },
  { type: "filing-s1", label: "IPO prep (S-1)", category: "funding", rank: RANK_FILING, collapse: "ipo", attribution: "name",
    explain: "An S-1 is the SEC registration a company files to go public (IPO prep)." },
  { type: "ch-share-allotment", label: "Raised (UK filing)", category: "funding", rank: RANK_FILING, collapse: "funding", attribution: "name",
    explain: "An SH01 filing at UK Companies House — the statement a UK company files after issuing new shares, which usually means they just raised money. The UK equivalent of a Form D." },
  { type: "gdelt-funding", label: "Funding (global news)", category: "funding", rank: RANK_NEWS, collapse: "funding", attribution: "name",
    explain: "A funding-related headline from GDELT's worldwide news index — catches regional and non-English press that the Google News editions miss. Expect this one to be rare and slow: GDELT allows roughly one company lookup every 5 seconds, so a big watchlist only gets partway through it each run." },
  { type: "app-published", label: "App published", category: "launch", rank: RANK_OWN, collapse: "launch", attribution: "direct",
    explain: "They now ship a mobile app we didn't see before — a new channel/investment." },
  { type: "app-stale", label: "App gone stale", category: "quiet", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "Their mobile app hasn't been updated in a long time — a possibly deprioritized product." },
  { type: "news-leadership", label: "Leadership change", category: "leadership", rank: RANK_NEWS, collapse: "leadership", attribution: "name",
    explain: "A news headline suggests a leadership change (new exec, departure) — a new decision-maker." },
  { type: "news-funding", label: "Funding (news)", category: "funding", rank: RANK_NEWS, collapse: "funding", attribution: "name",
    explain: "A news headline suggests they raised money." },
  { type: "news-layoffs", label: "Layoffs (news)", category: "layoffs", rank: RANK_NEWS, collapse: "layoffs", attribution: "name",
    explain: "A news headline suggests layoffs or restructuring." },
  { type: "news-expansion", label: "Expansion", category: "expansion", rank: RANK_NEWS, collapse: "expansion", attribution: "name",
    explain: "A news headline suggests expansion (new office, market, facility)." },
  { type: "news-partnership", label: "Partnership", category: "partnership", rank: RANK_NEWS, collapse: "partnership", attribution: "name",
    explain: "A news headline suggests a new partnership or integration." },
  { type: "news-launch", label: "Product launch (news)", category: "launch", rank: RANK_NEWS, collapse: "launch", attribution: "name",
    explain: "A news headline suggests a product launch." },
  { type: "warn-layoff", label: "WARN layoff notice", category: "layoffs", rank: RANK_FILING, collapse: "layoffs", attribution: "name",
    explain: "A state government WARN filing — the advance layoff notice large employers must file before cutting jobs." },
  { type: "ph-launch", label: "Product Hunt launch", category: "launch", rank: RANK_CURATED, collapse: "launch", attribution: "name",
    explain: "They launched a product on Product Hunt — growth/launch mode." },
  { type: "ads-started", label: "Started Meta ads", category: "marketing", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "They now have active ads in Meta's public Ad Library — a fresh marketing push." },
  { type: "ads-stopped", label: "Stopped Meta ads", category: "marketing", rank: RANK_OWN, collapse: null, attribution: "direct",
    explain: "They no longer have active Meta ads — a paused/ended campaign." },
];

const BY_TYPE = new Map(SIGNAL_TYPE_META.map((m) => [m.type, m]));
const CAT_KEYS = new Set(SIGNAL_CATEGORIES.map((c) => c.key));

// Fail loudly at import time rather than shipping a signal that renders uncoloured or lands in a
// phantom Guide section — and guarantee every key is safe to inline into SQL (see the builders).
const KEY_RE = /^[a-z0-9-]+$/;
for (const c of SIGNAL_CATEGORIES) if (!KEY_RE.test(c.key)) throw new Error(`bad category key: ${c.key}`);
for (const m of SIGNAL_TYPE_META) {
  if (!KEY_RE.test(m.type)) throw new Error(`bad signal type: ${m.type}`);
  if (!CAT_KEYS.has(m.category)) throw new Error(`signal ${m.type} → unknown category ${m.category}`);
  if (m.collapse !== null && !(m.collapse in COLLAPSE_WINDOW_DAYS)) throw new Error(`signal ${m.type} → unknown collapse group ${m.collapse}`);
  if (m.attribution !== "direct" && m.attribution !== "name") throw new Error(`signal ${m.type} → bad attribution ${m.attribution}`);
}

export const categoryOf = (type: string): string => BY_TYPE.get(type)?.category ?? "other";
export const rankOf = (type: string): number => BY_TYPE.get(type)?.rank ?? RANK_UNKNOWN;
export const collapseGroupOf = (type: string): string | null => BY_TYPE.get(type)?.collapse ?? null;
/** Unknown types are "name": the cautious answer, so a type added without thought is not silently
 *  presented as a first-hand observation. */
export const attributionOf = (type: string): Attribution => BY_TYPE.get(type)?.attribution ?? "name";
export const isCategory = (key: string): boolean => CAT_KEYS.has(key);
export const categoryLabel = (key: string): string => SIGNAL_CATEGORIES.find((c) => c.key === key)?.label ?? key;
/** Legacy hyphen-prefix "family" — kept ONLY so existing signal_webhooks route keys keep working. */
export const legacyFamily = (type: string): string => String(type).split("-")[0] || String(type);

// ── SQL fragment builders ───────────────────────────────────────────────────────────────────────
// Every value inlined below is a literal from THIS file, asserted against KEY_RE above — no user
// input reaches these strings. Query filters stay parameterised as usual.

/** CASE mapping a row's type to its collapse group; a non-collapsible row becomes its own group. */
export function collapseGroupCaseSql(): string {
  const arms = SIGNAL_TYPE_META.filter((m) => m.collapse)
    .map((m) => `WHEN '${m.type}' THEN '${m.collapse}'`).join(" ");
  return `CASE type ${arms} ELSE '#' || id END`;
}
/** CASE mapping a row's type to its collapse window in days (0 = never merges with a neighbour). */
export function collapseWindowCaseSql(): string {
  const arms = SIGNAL_TYPE_META.filter((m) => m.collapse)
    .map((m) => `WHEN '${m.type}' THEN ${COLLAPSE_WINDOW_DAYS[m.collapse!]!.toFixed(1)}`).join(" ");
  return `CASE type ${arms} ELSE 0.0 END`;
}
