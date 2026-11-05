// Best-guess company → domain resolver. HyperSignal only stores a domain on a job when it can be
// trusted (own homepage or own-site apply link); companies that post only through a third-party ATS
// end up with no domain. This fills that gap on demand: generate candidate domains from the company
// NAME, fetch each candidate's homepage, and accept ONLY when the page identifies itself as that
// company (title / og:site_name matches the name). Verification is the whole point — an unverified
// guess would silently attach a wrong domain and mis-target every signal check, so we never accept a
// candidate that doesn't prove itself. Fetches go through safeFetch (SSRF-guarded).
import { safeFetch } from "./safeFetch.ts";
import { companyNameMatches } from "./signals/company.ts";
import { normalizeOrgDomain, registrable } from "./normalize.ts";
import { dbCompaniesMissingDomain, dbSetCompanyDomain, dbGetCompanyDomain, dbMarkResolveFailed, dbCompanyCountries } from "./db.ts";
import { CC_TLDS, foldDiacritics, transliterate, stripLegalSuffix } from "./geo.ts";

const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0)";
const TLDS = ["com", "io", "co", "ai", "net", "org"]; // most common first — we stop at the first verified hit
const MAX_CANDIDATES = 14;
const BUDGET_MS = 25000; // whole-resolution wall clock — 14 candidates × 6s could otherwise reach 84s
const RESOLVE_WAVE = 4;  // candidates probed concurrently: 14 candidates become 4 waves, not 14 hops

/** Candidate bare domains for a company name, best-guess first. e.g. "Everhope Oncology" →
 *  everhopeoncology.com, everhope.com, everhopeoncology.io …
 *
 *  `countries` (ISO alpha-2, strongest first — from the company's ccTLD/job locations) adds that
 *  country's TLDs to the list, because a UK or German company frequently has no .com at all and used
 *  to be unresolvable, which then left it with no domain and therefore NO signals of any kind.
 *  Candidates are interleaved by rank (best stem × best TLD first) rather than grouped by stem, so a
 *  cap or a timeout cuts off the weak guesses, not the good ones. */
export function domainCandidates(company: string, countries: string[] = []): string[] {
  // Strip the legal form in any language ("Acme GmbH" → "Acme"), then fold accents so "Société"
  // becomes the "societe" a domain actually uses.
  const clean = foldDiacritics(stripLegalSuffix(company)).toLowerCase().replace(/[®™,.]/g, " ")
    .replace(/\b(the|group|holdings|technologies|technology|labs|software|solutions|systems|global|worldwide)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  // Non-Latin names (CJK, Arabic) leave nothing usable after the ASCII filter. Try a romanisation
  // where one exists (Cyrillic/Greek); otherwise return nothing rather than guess.
  const fallback = words.length ? [] : transliterate(company).replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const parts = words.length ? words : fallback;
  if (!parts.length) return [];

  const stems: string[] = [parts.join("")];                              // "everhopeoncology"
  if (parts.length > 1) stems.push(parts[0]!);                           // "everhope"
  if (parts.length > 2) stems.push(parts.slice(0, 2).join(""));          // "everhopeoncology" dup-safe
  // A company we KNOW is British is likelier to be acme.co.uk than acme.ai, so its own ccTLDs sit
  // right behind .com rather than at the back of the queue where the budget/cap would cut them off.
  const ccTlds: string[] = [];
  for (const cc of countries) for (const t of CC_TLDS[cc] ?? []) if (!ccTlds.includes(t)) ccTlds.push(t);
  const tlds = [...new Set(["com", ...ccTlds, ...TLDS])];

  // Interleave: rank = stem index + tld index, so (best stem, best tld) leads and the long tail trails.
  const scored: Array<{ d: string; rank: number }> = [];
  for (const [si, stem] of stems.entries()) {
    if (stem.length < 2 || stem.length > 40) continue;
    for (const [ti, tld] of tlds.entries()) scored.push({ d: `${stem}.${tld}`, rank: si * 2 + ti });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return [...new Set(scored.map((s) => s.d))].slice(0, MAX_CANDIDATES);
}

/** Extract the site's self-declared name from its HTML <title> / og:site_name. */
function siteNames(html: string): string[] {
  const out: string[] = [];
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1];
  const og = /<meta[^>]+(?:property|name)=["']og:site_name["'][^>]+content=["']([^"']{1,120})["']/i.exec(html)?.[1]
    || /<meta[^>]+content=["']([^"']{1,120})["'][^>]+(?:property|name)=["']og:site_name["']/i.exec(html)?.[1];
  if (title) out.push(title.replace(/\s+/g, " ").trim());
  if (og) out.push(og.replace(/\s+/g, " ").trim());
  return out;
}

/** Resolve a batch of specific company names (bounded concurrency). Skips manual overrides; records a
 *  negative-cache entry for failures so they aren't retried for a week. Shared by the API route. */
export async function resolveCompanyBatch(names: string[]): Promise<{ resolved: Array<{ company: string; domain: string }>; failed: string[] }> {
  const resolved: Array<{ company: string; domain: string }> = [];
  const failed: string[] = [];
  let idx = 0;
  const worker = async () => {
    while (idx < names.length) {
      const company = names[idx++]!;
      if (dbGetCompanyDomain(company)?.source === "manual") continue; // never override a user-set domain
      try {
        const domain = await resolveCompanyDomain(company);
        if (domain) { dbSetCompanyDomain(company, domain, "auto"); resolved.push({ company, domain }); }
        else { dbMarkResolveFailed(company); failed.push(company); }
      } catch { dbMarkResolveFailed(company); failed.push(company); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, names.length) }, worker));
  return { resolved, failed };
}

/** Work through the WHOLE missing-domain backlog one bounded batch at a time. Returns what happened
 *  plus how many remain, so callers (UI loop / post-fetch hook) can continue or report honestly. */
export async function resolveMissingDomains(max: number): Promise<{ resolved: Array<{ company: string; domain: string }>; failed: string[]; remaining: number }> {
  // Ask for ONLY what each call needs. Both statements in dbCompaniesMissingDomain re-walk the same
  // grouped HAVING aggregate (~145ms on the production DB) and it used to run all four per batch —
  // two of them discarded — which is ~0.3s of blocked event loop thrown away per batch, ~48 batches
  // deep on a real backlog. Now: one for the page, one for what is left afterwards.
  const { items } = dbCompaniesMissingDomain(Math.max(1, Math.min(max, 60)), 7, "items");
  if (!items.length) return { resolved: [], failed: [], remaining: 0 };
  const { resolved, failed } = await resolveCompanyBatch(items);
  return { resolved, failed, remaining: dbCompaniesMissingDomain(1, 7, "total").total };
}

// Post-fetch auto-resolve: at most one run at a time (fetches can overlap), bounded batch per fetch.
let autoResolveBusy = false;
export async function autoResolveAfterFetch(batch = 15): Promise<void> {
  if (autoResolveBusy) return;
  autoResolveBusy = true;
  try {
    const r = await resolveMissingDomains(batch);
    if (r.resolved.length || r.failed.length) {
      console.log(`[resolver] post-fetch: +${r.resolved.length} domain(s), ${r.failed.length} not found, ${r.remaining} still missing`);
    }
  } catch (e) { console.warn(`[resolver] post-fetch failed: ${(e as Error).message}`); }
  finally { autoResolveBusy = false; }
}

/**
 * Remove the candidate domain from a site name before that name is used as evidence.
 *
 * The whole verification is "does this homepage call itself the company we're looking for". A PARKED
 * or FOR-SALE domain defeats that, because a parking page's title IS the domain name — and the domain
 * name is what we guessed FROM the company name. The evidence is circular, so a parked domain passes
 * almost by construction. Two real cases from the live backlog:
 *
 *   Circana   → circana.net   "circana.net | fruits"
 *   Nightfall → nightfall.in  "Buy nightfall.in – Premium Domain Name for Your Brand | DaaZ"
 *
 * Both were accepted; circana.com and nightfall.ai are the real sites. Only the FULL domain is
 * stripped, never the bare label — removing "nightfall" would also gut the genuine
 * "Nightfall: AI Data Security…" and reject the right answer.
 */
export function stripSelfReference(siteName: string, domain: string): string {
  const d = domain.replace(/^www\./, "");
  return siteName.replace(new RegExp(`(?:www\\.)?${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), " ")
    .replace(/\s+/g, " ").trim();
}

/** Registrar and broker parking pages, which announce themselves in the title. Belt and braces
 *  alongside stripSelfReference — this catches a parked page that also happens to carry the brand. */
// "nightfall.io - nightfall Resources and Information." is the stock Bodis/registrar template, and it
// survives stripSelfReference because the bare label still reads as a word afterwards.
const PARKED = /\b(?:buy this domain|domain (?:name )?(?:is )?for sale|premium domain|this domain (?:may be|is) for sale|parked (?:free )?(?:at|by)|domain parking|inquire about this domain|make an offer|resources and information|is coming soon)\b|\b(?:sedo|afternic|hugedomains|dan\.com|daaz|namecheap marketplace)\b/i;
export function looksParked(siteName: string): boolean { return PARKED.test(siteName); }

/**
 * Does this fetched homepage prove the domain belongs to the company? Pure, so every rule below is
 * testable without a network — the fetch stays in verify().
 *
 * Three gates, in order of how badly each one failed on the live backlog:
 *
 *  1. LANDED ELSEWHERE. A response whose final URL is on a different registrable domain is not this
 *     candidate's site. nightfall.co redirects to nightfall.games — a tabletop RPG publisher whose
 *     title honestly reads "Nightfall Games", so a name check alone files it as the AI-security
 *     company Nightfall. www↔apex and http→https stay inside the same registrable domain.
 *  2. PARKED. Registrar and broker pages announce themselves.
 *  3. SELF-REFERENCE. The remaining name must still identify the company once the candidate's own
 *     address is removed from it — see stripSelfReference.
 *
 * All three fail closed. A wrong domain is worse than none: company_domains feeds the DNS, tech,
 * subdomain, news, ads, WARN and filings producers, so one bad row aims all of them at a stranger.
 */
export function pageProvesCompany(input: {
  domain: string; finalUrl?: string; siteNames: string[]; wanted: string[];
}): boolean {
  const { domain, finalUrl, siteNames: raw, wanted } = input;
  if (finalUrl) {
    try {
      const landed = registrable(new URL(finalUrl).hostname);
      if (landed && landed !== registrable(domain)) return false;
    } catch { /* unparseable final URL — fall through to the content checks */ }
  }
  if (raw.some(looksParked)) return false;
  const names = raw.map((n) => stripSelfReference(n, domain)).filter(Boolean);
  return names.some((n) => wanted.some((w) => companyNameMatches(w, n) || companyNameMatches(n, w)));
}

/** Resolve one company name → a VERIFIED bare domain, or null if none of the candidates prove out.
 *  Tries candidates in order, stopping at the first whose homepage identifies as the company. */
export async function resolveCompanyDomain(company: string): Promise<string | null> {
  const name = (company ?? "").trim();
  if (name.length < 2) return null;
  const countries = dbCompanyCountries(name);   // where this company's jobs are — picks the ccTLDs to try
  const deadline = Date.now() + BUDGET_MS;
  // Accept only on a whole-word/phrase name match either direction (handles "Stripe" vs "Stripe |
  // Payments…"). Also try the name without its legal form, because a site's own title almost never
  // carries it — "Zalando SE" never appears on zalando.com, but "ZALANDO" does.
  const bare = stripLegalSuffix(name);
  const wanted = bare !== name ? [name, bare] : [name];
  const verify = async (domain: string): Promise<string | null> => {
    try {
      const res = await safeFetch(`https://${domain}`, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const html = (await res.text()).slice(0, 40000);
      return pageProvesCompany({ domain, finalUrl: res.url, siteNames: siteNames(html), wanted }) ? domain : null;
    } catch { return null; }   // unreachable / blocked / timeout
  };
  const cands = domainCandidates(name, countries)
    .map((c) => normalizeOrgDomain(c))
    .filter((d): d is string => !!d);
  // Candidates are probed in small concurrent WAVES rather than one at a time. Widening the ccTLD
  // list took the candidate count from 6 to as many as 14 ("Monzo Bank Limited" with cc=[GB]), and
  // strictly sequential 6s probes meant one company could occupy the whole 25s budget plus an
  // in-flight fetch — with POST /api/companies/resolve-domains awaiting a batch of up to 60 before
  // responding, so the request could legitimately hang for minutes with no progress signal.
  // Rank order still decides: domainCandidates returns strongest-first and the first hit WITHIN a
  // wave wins, so a wave never promotes a weaker candidate over a stronger one beside it.
  for (let i = 0; i < cands.length; i += RESOLVE_WAVE) {
    if (Date.now() > deadline) break;           // bounded wall clock: never let one name stall a batch
    const hits = await Promise.all(cands.slice(i, i + RESOLVE_WAVE).map(verify));
    const best = hits.find((h): h is string => !!h);
    if (best) return best;
  }
  return null;
}
