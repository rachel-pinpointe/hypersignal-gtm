// Direct ATS sources — free, public, unauthenticated job JSON that Greenhouse, Lever, and Ashby
// publish so companies can embed jobs on their own career sites. We read them straight from the
// source: fresher than hiring.cafe, FULL job descriptions for free, and coverage for companies
// hiring.cafe doesn't have. Everything normalizes through makeJob into the one standard job shape,
// tagged source "ats:<vendor>:<slug>", and the existing dedup (apply URL) collapses a posting seen via
// both hiring.cafe and its ATS onto one row — the richer ATS description wins via upgradeDesc.
//
// These hit the ATS hosts directly with a plain fetch (NOT the hiring.cafe gate — different hosts),
// at low volume (a watchlist refresh), which is exactly what these public boards are built for. No
// proxies, no keys, no cost — ever.
import { load } from "cheerio";
import { makeJob, normalizeOrgDomain, registrable, decodeEntities } from "../normalize.ts";
import { foldDiacritics, stripLegalSuffix } from "../geo.ts";
import { dbGetAtsBoards, dbSaveAtsProbe, dbIsBoardQuarantined, dbIsBoardOverridden, dbOverridesForDomain } from "../db.ts";
import { resolveCompanyName, isUsableCompanyName } from "../signals/company.ts";
import type { RawJob, SourceConfig } from "../types.ts";
import { reportDegraded } from "./degraded.ts";

// Vendors are probed in two waves (see discoverAtsBoards): the three US-centric ones first, and the
// four with heavy non-US usage only when those find nothing — so an existing US-only watchlist pays
// no extra requests for the wider coverage.
//
// Every endpoint below was probed against a live board with real jobs before its parser was written.
// A trap worth remembering: an empty board and a wrong slug look identical (Workable answers 200 with
// `jobs: []` for both), so "the endpoint returned nothing" proves nothing — find a tenant that is
// actually hiring before concluding an API is dead.
//
// Still NOT included: Teamtailor, Keka, Darwinbox and Workday all require an API key or per-tenant
// auth, so there is no keyless board to read.
export type AtsVendor = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "personio" | "workable" | "recruitee";
const US_WAVE: AtsVendor[] = ["greenhouse", "lever", "ashby"];
const EU_WAVE: AtsVendor[] = ["smartrecruiters", "personio", "workable", "recruitee"];
const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0; +local hiring-signal tool)";
const TIMEOUT_MS = Math.max(3000, Number(process.env.ATS_TIMEOUT_MS ?? 15000));

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`ats-http-${r.status}`);
  return r.json();
}
/** HTML (or entity-encoded HTML) → readable plain text. */
function htmlToText(html: unknown): string | null {
  if (typeof html !== "string" || !html.trim()) return null;
  const t = load(html).text().replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t || null;
}
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// ───────────────────────── per-vendor fetchers ─────────────────────────

/** Greenhouse: boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true (content = full HTML JD). */
export async function fetchGreenhouse(slug: string, domain: string | null): Promise<RawJob[]> {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((j: any): RawJob | null => {
    const url = String(j.absolute_url ?? "");
    if (!url || !j.title) return null;
    const description = htmlToText(j.content); // Greenhouse content is entity-encoded HTML
    const raw: Record<string, unknown> = {
      ats: "greenhouse",
      department: j.departments?.[0]?.name ?? null,
      industry: null,
      offices: (j.offices ?? []).map((o: any) => o?.name).filter(Boolean),
      hc_url: null, // ATS jobs already carry the full description; no hiring.cafe detail scrape needed
    };
    if (description) raw.description = description;
    return makeJob({
      source: `ats:greenhouse:${slug}`, externalId: `gh:${j.id}`, title: String(j.title),
      company: j.company_name ?? null, location: j.location?.name ?? null, url,
      postedAt: j.first_published ?? j.updated_at ?? null,
      domain: domain ?? undefined, raw,
    });
  }).filter((j: RawJob | null): j is RawJob => !!j);
}

/** Lever: api.lever.co/v0/postings/<slug>?mode=json (descriptionPlain + salary in categories/salaryRange). */
export async function fetchLever(slug: string, domain: string | null): Promise<RawJob[]> {
  const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  const jobs = Array.isArray(data) ? data : [];
  return jobs.map((j: any): RawJob | null => {
    const url = String(j.hostedUrl ?? j.applyUrl ?? "");
    if (!url || !j.text) return null;
    const cat = j.categories ?? {};
    const descParts = [j.descriptionPlain, j.additionalPlain].filter((s: unknown) => typeof s === "string" && s.trim());
    const raw: Record<string, unknown> = {
      ats: "lever", department: cat.department ?? null, commitment: cat.commitment ?? null,
      workplaceType: j.workplaceType ?? null, hc_url: null,
    };
    if (descParts.length) raw.description = descParts.join("\n\n");
    const sr = j.salaryRange ?? cat.salaryRange;
    if (sr) { const lo = num(sr.min), hi = num(sr.max); if (lo) raw.comp_min = lo; if (hi) raw.comp_max = hi; if (sr.currency) raw.currency = sr.currency; }
    const workplace = String(j.workplaceType ?? "").toLowerCase();
    return makeJob({
      source: `ats:lever:${slug}`, externalId: `lv:${j.id}`, title: String(j.text),
      company: null, location: cat.location ?? (Array.isArray(cat.allLocations) ? cat.allLocations[0] : null) ?? null, url,
      postedAt: j.createdAt ? new Date(Number(j.createdAt)).toISOString() : null,
      remote: workplace === "remote" ? true : undefined,
      domain: domain ?? undefined, raw,
    });
  }).filter((j: RawJob | null): j is RawJob => !!j);
}

/** Ashby: api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true. */
export async function fetchAshby(slug: string, domain: string | null): Promise<RawJob[]> {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((j: any): RawJob | null => {
    const url = String(j.jobUrl ?? j.applyUrl ?? "");
    if (!url || !j.title) return null;
    const description = (typeof j.descriptionPlain === "string" && j.descriptionPlain.trim())
      ? j.descriptionPlain.trim() : htmlToText(j.descriptionHtml);
    const raw: Record<string, unknown> = {
      ats: "ashby", department: j.department ?? null, team: j.team ?? null,
      employmentType: j.employmentType ?? null, hc_url: null,
    };
    if (description) raw.description = description;
    // Ashby compensation: compensationTiers[].components or a top-level range; extract a best-effort band.
    const comp = j.compensation;
    const tier = comp?.compensationTiers?.[0] ?? comp;
    const lo = num(tier?.minValue ?? tier?.compensationRange?.minValue);
    const hi = num(tier?.maxValue ?? tier?.compensationRange?.maxValue);
    if (lo) raw.comp_min = lo; if (hi) raw.comp_max = hi;
    const cur = tier?.currencyCode ?? tier?.compensationRange?.currencyCode; if (cur) raw.currency = cur;
    return makeJob({
      source: `ats:ashby:${slug}`, externalId: `ab:${j.id}`, title: String(j.title),
      company: null, location: j.location ?? null, url,
      postedAt: j.publishedAt ?? null, remote: j.isRemote === true ? true : undefined,
      domain: domain ?? undefined, raw,
    });
  }).filter((j: RawJob | null): j is RawJob => !!j);
}

/** SmartRecruiters: api.smartrecruiters.com/v1/companies/<slug>/postings — the public posting list.
 *  Heavily used across Europe (Bosch, Visa, Ubisoft…), keyless, and it returns a real country per job.
 *  Descriptions live behind a per-posting call, so we don't fetch them: 1 request per board beats 200. */
export async function fetchSmartRecruiters(slug: string, domain: string | null, opts?: AtsFetchOpts): Promise<RawJob[]> {
  const out: RawJob[] = [];
  const LIMIT = 100;
  // This used to be a hardcoded 5 pages, commented as "500 postings/board is far past any watchlist
  // company's real board" — in a docblock that names Bosch, Visa and Ubisoft as the reason to support
  // SmartRecruiters at all. Those boards carry thousands of postings, so the cap silently truncated
  // exactly the employers it was added for, and truncation was indistinguishable from a short board:
  // the loop simply stopped and returned. maxPages now drives it (the caller's own depth setting) and
  // hitting the ceiling is logged rather than swallowed.
  // Discovery only asks "does this board exist?", which one posting answers. Walking every page for
  // that meant up to 5 SERIAL round trips at ATS_TIMEOUT_MS each (75s) and 500 RawJob objects built
  // via makeJob and then thrown away — and the EU wave's whole wall time is this walk.
  const pages = opts?.existenceOnly ? 1 : Math.max(1, opts?.maxPages ?? 25);
  let truncated = false;
  for (let page = 0; page < pages; page++) {
    // Per-page, not per-board. getJson throws on any non-2xx or timeout, and with no catch inside the
    // loop a 429 on page 12 of 25 discarded the 1,200 postings already in `out` — atsAdapter then
    // turned the throw into an empty array, so a large board intermittently reported ZERO jobs
    // instead of 1,200. Keep what was collected and stop, which is what craigslist already does.
    let data: Record<string, any> | undefined;
    try {
      data = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${LIMIT}&offset=${page * LIMIT}`);
    } catch (e) {
      const m = `smartrecruiters:${slug} stopped at page ${page} (${(e as Error).message}) — kept the ${out.length} postings already read`;
      console.warn(`[ats] ${m}`); reportDegraded(m);
      if (page === 0) throw e;   // nothing collected yet: let the adapter report the failure
      break;
    }
    const items = Array.isArray(data?.content) ? data.content : [];
    for (const j of items) {
      if (!j?.id || !j?.name) continue;
      const loc = j.location ?? {};
      const company = j.company?.name ?? j.company?.identifier ?? null;
      const raw: Record<string, unknown> = {
        ats: "smartrecruiters", department: j.department?.label ?? null,
        industry: j.industry?.label ?? null, job_category: j.function?.label ?? null,
        commitment: j.typeOfEmployment?.label ?? null, experience_level: j.experienceLevel?.label ?? null,
        hc_url: null,
      };
      out.push(makeJob({
        source: `ats:smartrecruiters:${slug}`, externalId: `sr:${j.id}`, title: String(j.name),
        company, location: loc.fullLocation ?? ([loc.city, loc.region, loc.country].filter(Boolean).join(", ") || null),
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(j.company?.identifier ?? slug)}/${j.id}`,
        postedAt: j.releasedDate ?? null, remote: loc.remote === true ? true : undefined,
        domain: domain ?? undefined, raw,
      }));
    }
    if (items.length < LIMIT) { truncated = false; break; }
    truncated = page === pages - 1; // ran out of pages with a full page in hand → more postings exist
  }
  // Not on a discovery probe: that deliberately reads one page, so "there is more" is the expected
  // answer, not a truncation worth reporting.
  if (truncated && !opts?.existenceOnly) {
    const m = `smartrecruiters:${slug} hit the ${pages}-page ceiling at ${out.length} postings — the board has more`;
    console.warn(`[ats] ${m}`); reportDegraded(m);
  }
  if (!opts?.existenceOnly) await enrichSmartRecruitersDescriptions(slug, out);
  return out;
}

/**
 * Fill in the job text, which the LISTING endpoint does not carry.
 *
 * Found by measuring the stored table rather than by reading this code: every other ATS vendor sits
 * at 100% description coverage and SmartRecruiters sat at 0 of 464. Its list response has no `jobAd`
 * key at all — the text lives on /postings/<id>, under jobAd.sections as four separate HTML blocks
 * (companyDescription, jobDescription, qualifications, additionalInformation).
 *
 * A missing description is not cosmetic here. matcher.ts folds the description into the keyword
 * haystack, so a posting without one can only be matched on its title, and the webhook and CSV ship
 * an empty body. Every SmartRecruiters job was quietly matching on title alone.
 *
 * One request per posting, so it is bounded three ways: skipped entirely on a discovery probe,
 * capped, and run through a small semaphore. A failure leaves that job's description null — exactly
 * what it was before this existed — rather than failing the whole board.
 */
const SR_DESC_MAX = Math.max(0, Number(process.env.SR_DESC_MAX ?? 200));
const SR_DESC_CONCURRENCY = 6;
async function enrichSmartRecruitersDescriptions(slug: string, jobs: RawJob[]): Promise<void> {
  if (!SR_DESC_MAX || !jobs.length) return;
  const targets = jobs.slice(0, SR_DESC_MAX);
  if (jobs.length > SR_DESC_MAX) {
    const m = `smartrecruiters:${slug} fetched ${jobs.length} postings but only the first ${SR_DESC_MAX} got a description (SR_DESC_MAX)`;
    console.warn(`[ats] ${m}`); reportDegraded(m);
  }
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < targets.length; i = next++) {
      const j = targets[i]!;
      const id = String(j.externalId).replace(/^sr:/, "");
      try {
        const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`);
        const sections = d?.jobAd?.sections ?? {};
        // Order matters: the role comes first, then what they want, then the extras. The company
        // blurb goes LAST because it is boilerplate repeated on every posting, and putting it first
        // would make the keyword haystack and the webhook preview open with marketing copy.
        const text = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"]
          .map((k) => htmlToText(sections[k]?.text)).filter(Boolean).join("\n\n");
        if (text) {
          j.description = text;
          if (j.raw && typeof j.raw === "object") (j.raw as Record<string, unknown>).description = text;
        }
      } catch { /* best-effort: this job keeps the null description it already had */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SR_DESC_CONCURRENCY, targets.length) }, () => worker()));
}

/** Personio: <slug>.jobs.personio.de/xml — the public board feed of the dominant German-speaking HR
 *  suite, so it reaches DACH companies none of the US ATS vendors carry. XML, keyless, one request. */
export async function fetchPersonio(slug: string, domain: string | null): Promise<RawJob[]> {
  const r = await fetch(`https://${encodeURIComponent(slug)}.jobs.personio.de/xml`, {
    headers: { "User-Agent": UA, Accept: "application/xml, text/xml" }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`ats-http-${r.status}`);
  const $ = load(await r.text(), { xmlMode: true });
  const out: RawJob[] = [];
  $("position").each((_i, el) => {
    const p = $(el);
    const id = p.find("> id").first().text().trim();
    const title = p.find("> name").first().text().trim();
    if (!id || !title) return;
    // Offices are separate elements — the main one plus any additional; join so the geo layer sees them all.
    const offices = [p.find("> office").first().text().trim(), ...p.find("additionalOffices > office").map((_j, o) => $(o).text().trim()).get()]
      .filter(Boolean);
    const desc = p.find("jobDescriptions jobDescription").map((_j, d) => {
      const name = $(d).find("name").first().text().trim(), value = htmlToText($(d).find("value").first().text());
      return [name, value].filter(Boolean).join("\n");
    }).get().filter(Boolean).join("\n\n");
    const raw: Record<string, unknown> = {
      ats: "personio", department: p.find("> department").first().text().trim() || null,
      job_category: p.find("> recruitingCategory").first().text().trim() || null,
      seniority: p.find("> seniority").first().text().trim() || null,
      commitment: p.find("> schedule").first().text().trim() || null,
      employmentType: p.find("> employmentType").first().text().trim() || null,
      hc_url: null,
    };
    if (desc) raw.description = desc;
    out.push(makeJob({
      source: `ats:personio:${slug}`, externalId: `pe:${id}`, title,
      company: p.find("> subcompany").first().text().trim() || null,
      location: offices.join(", ") || null,
      url: `https://${slug}.jobs.personio.de/job/${id}`,
      postedAt: p.find("> createdAt").first().text().trim() || null,
      domain: domain ?? undefined, raw,
    }));
  });
  return out;
}

/** Workable: apply.workable.com/api/v1/widget/accounts/<slug>?details=true — the same JSON the public
 *  board renders from. Keyless, one request, and it carries the FULL HTML description plus a
 *  structured locations[] with ISO country codes. Heavy usage across Europe and the Middle East. */
export async function fetchWorkable(slug: string, domain: string | null): Promise<RawJob[]> {
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`);
  const company = typeof data?.name === "string" ? data.name : null;
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((j: any): RawJob | null => {
    const url = String(j.url ?? j.shortlink ?? j.application_url ?? "");
    if (!url || !j.title || !j.shortcode) return null;
    const loc0 = Array.isArray(j.locations) ? j.locations[0] : null;
    // City/state/country are separate fields and often blank — join what exists so the geo layer
    // sees a real location string rather than ", , Portugal".
    const location = [j.city || loc0?.city, j.state || loc0?.region, j.country || loc0?.country]
      .map((s: unknown) => (typeof s === "string" ? s.trim() : "")).filter(Boolean).join(", ") || null;
    const raw: Record<string, unknown> = {
      ats: "workable", department: j.department ?? null, industry: j.industry ?? null,
      job_category: j.function ?? null, commitment: j.employment_type ?? null,
      seniority: j.experience ?? null, degrees: j.education ?? null, hc_url: null,
    };
    const description = htmlToText(j.description);
    if (description) raw.description = description;
    return makeJob({
      source: `ats:workable:${slug}`, externalId: `wk:${j.shortcode}`, title: String(j.title),
      company, location, url,
      postedAt: j.published_on ?? j.created_at ?? null,
      remote: j.telecommuting === true ? true : undefined,
      domain: domain ?? undefined, raw,
    });
  }).filter((j: RawJob | null): j is RawJob => !!j);
}

/** Recruitee: <slug>.recruitee.com/api/offers — the documented unauthenticated careers-site API.
 *  Strong in the Benelux/DACH/Nordics. Returns description AND requirements as separate HTML, plus
 *  a real currency on the salary band (which is exactly why we stopped defaulting currency to USD). */
export async function fetchRecruitee(slug: string, domain: string | null): Promise<RawJob[]> {
  const data = await getJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers`);
  const offers = Array.isArray(data?.offers) ? data.offers : [];
  return offers.map((o: any): RawJob | null => {
    const url = String(o.careers_url ?? o.careers_apply_url ?? "");
    if (!url || !o.title || o.id == null) return null;
    if (o.status && o.status !== "published") return null; // the feed is published-only, but don't assume
    const location = [o.city, o.state_name, o.country].map((s: unknown) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean).join(", ") || null;
    const raw: Record<string, unknown> = {
      ats: "recruitee", department: o.department ?? null, job_category: o.category_code ?? null,
      commitment: o.employment_type_code ?? null, seniority: o.experience_code ?? null,
      degrees: o.education_code ?? null, workplaceType: o.remote ? "Remote" : o.hybrid ? "Hybrid" : o.on_site ? "Onsite" : null,
      hc_url: null,
    };
    const description = [htmlToText(o.description), htmlToText(o.requirements)].filter(Boolean).join("\n\n");
    if (description) raw.description = description;
    // Only a real currency is recorded — Recruitee often has the band empty with just a currency set.
    const lo = num(o.salary?.min), hi = num(o.salary?.max);
    if (lo) raw.comp_min = lo; if (hi) raw.comp_max = hi;
    if ((lo || hi) && typeof o.salary?.currency === "string" && o.salary.currency.trim()) raw.currency = o.salary.currency.trim();
    return makeJob({
      source: `ats:recruitee:${slug}`, externalId: `rc:${o.id}`, title: String(o.title),
      company: o.company_name ?? null, location, url,
      // "2026-06-11 12:23:24 UTC" is not ISO — normalise so postedAt parses everywhere.
      postedAt: typeof o.published_at === "string" ? o.published_at.replace(" UTC", "Z").replace(" ", "T") : null,
      remote: o.remote === true ? true : undefined,
      domain: domain ?? undefined, raw,
    });
  }).filter((j: RawJob | null): j is RawJob => !!j);
}

/** `existenceOnly` = the caller just needs to know whether the board has ANY posting (discovery),
 *  so a paginated fetcher may stop after the first page. `maxPages` is the caller's depth setting.
 *  Fetchers that make a single request ignore both. */
export interface AtsFetchOpts { existenceOnly?: boolean; maxPages?: number }
const FETCHERS: Record<AtsVendor, (slug: string, domain: string | null, opts?: AtsFetchOpts) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters, personio: fetchPersonio,
  workable: fetchWorkable, recruitee: fetchRecruitee,
};

// ───────────────────────── discovery ─────────────────────────

/** Candidate board slugs for a domain: `stripe.com` → ["stripe"], `acme-corp.io` → ["acme-corp","acmecorp"]. */
export function candidateSlugs(domain: string): string[] {
  const dom = normalizeOrgDomain(domain);
  if (!dom) return [];
  const base = dom.split(".")[0] ?? dom; // registrable name before the TLD
  const slugs = new Set<string>([base]);
  if (base.includes("-")) slugs.add(base.replace(/-/g, "")); // hyphen and no-hyphen variants
  return [...slugs].filter(Boolean);
}

// A slug is a GUESS derived from the domain name ("tcm.llc" → "tcm"), and ATS tenants are first-come
// namespaces shared by every company in the world. So a board answering to that slug is not evidence
// it belongs to this company — measured on the live install, 47 of 139 discovered boards came from a
// slug of 6 characters or fewer, and three were provably the wrong company's board:
//   nationalaircargo.com → personio:nationalaircargo  served Kolhorn AG's German driver vacancies
//   tcm.llc              → personio:tcm               served TCM Systems GmbH (Austria)
//   us.com               → greenhouse:us              served itel International's US roles
// Those jobs were then stamped with the watched domain and counted as that company hiring — the same
// wrong-employer attribution class as the "Home"/"Cloudflare" company-name bug, arriving by a
// different door. Before a board is accepted it now has to survive verifyBoard below.
// A slug shorter than this is not distinctive enough to attribute a board on its own. Every provably
// wrong board found on the live install was one of these, and the length is what separates a namespace
// a stranger plausibly already owns ("us", "abc", "eli", "cic") from one that is effectively unique.
const MIN_UNCORROBORATED_SLUG = 5;

// Ramp anomaly, found live 2026-09-19 (Phase 15): ramp.com's real Ashby tenant is "ramp" — the
// correctly-guessed domain stem, not a wrong guess — yet the board was rejected as "too short to
// attribute" and re-probed as a miss for 7 days. Ashby returns no company name on any posting
// (verifyBoard's own criterion 3 comment says so), so there was no name to test and nothing else to
// go on besides the slug itself — which was not merely SHORT, it was IDENTICAL to the domain's own
// stem. An identical match is stronger evidence than the ordinary prefix relationship
// MIN_UNCORROBORATED_SLUG was calibrated against, and earns one character less — but eli.edu/"eli"
// and cic.edu/"cic" (3 characters, also exact matches, also unnamed) are real collisions found on
// the same live install, so this is still a floor, not a blank check for "the guess was self-
// consistent." Only used below when names.length === 0 — an exact match to a NAME (not a slug) stays
// on the ordinary floor, since ohio.edu's board names itself "OH.io", which folds to the same string
// as "ohio" but is a different company punning the .io TLD, not Ohio.
const MIN_EXACT_MATCH_SLUG = 4;

/** Fold a company name and a domain stem onto one comparable form. The domain stem has no spaces
 *  ("1021creative", "ginkgobioworks") and the company name does ("1021 Creative", "Ginkgo Bioworks
 *  Inc."), so the two are compared with all separators removed — otherwise every multi-word company
 *  on earth reads as a mismatch, which is exactly what a first cut of this gate did to 15 correct
 *  boards. Legal suffixes go first, so "Delta Express Inc." reduces to "deltaexpress" and still
 *  prefix-matches the domain stem "deltaexpressinc". */
const nameKey = (s: string) => stripLegalSuffix(foldDiacritics(String(s ?? "")))
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Text a posting carries, for the domain-in-text and namesake checks. Vendors put the job body on
 *  `description`; older rows and some fetchers only have it under raw.description. */
const postingText = (j: RawJob): string =>
  `${j.description ?? ""} ${String((j.raw as Record<string, unknown> | null)?.description ?? "")}`.toLowerCase();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface VerifyOpts {
  /** The board was found LINKED from the company's own website (careers page / homepage). That is
   *  first-party evidence the company publishes this board, so it is accepted on its own. */
  linkedFromSite?: boolean;
}

/** Decide whether a probed board really belongs to `domain`, from the postings it just returned.
 *
 *  Phase 21 (2026-10-05): STRICT. A board is accepted only on evidence that ties it to THIS domain:
 *   1. SELF-HOSTED — a posting's apply URL is on the domain itself. trlm.com's tenant is "trillium"
 *      and every posting sits under "Open Roles", but the URLs are on www.trlm.com: proof.
 *   2. OWN DOMAIN IN THE POSTINGS — the company's registrable domain appears in a posting's text.
 *   3. LINKED FROM THE COMPANY'S OWN SITE — passed in by the caller (opts.linkedFromSite).
 *   4. SLUG IS THE DOMAIN STEM — and nothing contradicts it:
 *        - no posting names a DIFFERENT domain with the same stem ("onyx.app" on a board probed for
 *          onyx.security) unless the company's own domain is there too;
 *        - unnamed boards (Lever, Ashby) need a stem of MIN_EXACT_MATCH_SLUG characters (ramp yes,
 *          eli/cic no); NAMED boards need MIN_UNCORROBORATED_SLUG, so ohio.edu's "OH.io" pun —
 *          which folds to "ohio" — stays rejected;
 *        - a named board must not post under a real, distinctive employer unrelated to the domain
 *          (nationalaircargo.com → "Kolhorn AG").
 *
 *  What is GONE is acceptance on a name match alone. Before Phase 21 a stated company name that
 *  prefix-matched or shared a word with the domain accepted a board whose slug was NOT the stem, and
 *  an unnamed board was accepted on slug length alone. The 2026-10-02 pilot measured what that let
 *  through: greenhouse:sunset ("Sunset Magazine") for sunsethq.com, greenhouse:parallel ("Parallel
 *  Systems") for useparallel.com, greenhouse:profound ("ProFound" Therapeutics) for tryprofound.com —
 *  3 of 5 accepted pilot boards were the wrong company. Every case where slug == stem behaves as
 *  before (pingcap/"TiDB", galapagoscharter, viantinc, trillium.ag all still pass).
 *
 *  Quarantine and the manual allow-list (ats_quarantine / ats_board_overrides) are checked by the
 *  callers, not here, so this stays a pure function of the postings. */
export function verifyBoard(domain: string, slug: string, jobs: RawJob[], opts: VerifyOpts = {}): boolean {
  return explainBoard(domain, slug, jobs, opts).ok;
}

/** verifyBoard with its reason, for logs, the dry-run report and tests. */
export function explainBoard(domain: string, slug: string, jobs: RawJob[], opts: VerifyOpts = {}): { ok: boolean; why: string } {
  const dom = normalizeOrgDomain(domain);
  if (!dom) return { ok: false, why: "domain cannot be normalized" };
  for (const j of jobs) {
    try { if (j.url && registrable(new URL(j.url).hostname) === dom) return { ok: true, why: "self-hosted apply URL" }; } catch { /* unparseable URL */ }
  }
  const text = jobs.map(postingText).join(" ");
  // The domain itself or any subdomain of it ("www.icapital.com", "careers.icapital.com"), but not a
  // longer domain that merely contains it ("icapital.com.au", "noticapital.com").
  const ownInText = new RegExp(`(^|[^a-z0-9.-])(?:[a-z0-9-]+\\.)*${escapeRe(dom)}(?![a-z0-9-]|\\.[a-z0-9])`).test(text);
  if (ownInText) return { ok: true, why: "company domain appears in posting text" };
  if (opts.linkedFromSite) return { ok: true, why: "linked from the company's own site" };

  const rawStem = (dom.split(".")[0] ?? dom).toLowerCase();
  const stem = nameKey(rawStem);
  if (nameKey(slug) !== stem) {
    const msg = `slug "${slug}" is not the domain stem "${stem}" and no posting ties the board to ${dom}`;
    console.warn(`[ats] rejected ${slug} for ${dom}: ${msg}`);
    return { ok: false, why: msg };
  }
  // Namesake: a posting names another domain with the same stem, and never this one.
  const sib = new RegExp(`(?:^|[^a-z0-9.-])(?:www\\.)?(${escapeRe(rawStem)}\\.[a-z]{2,}(?:\\.[a-z]{2})?)(?![a-z0-9-]|\\.[a-z0-9])`, "g");
  // ^ a whole domain only: "neurahealth.notion.site" and "numeric.substack.com" are the company's own
  //   pages on a platform, not a rival "neurahealth.notion" / "numeric.substack".
  const others = new Set<string>();
  for (const m of text.matchAll(sib)) if (m[1] !== dom) others.add(m[1]!);
  if (others.size) {
    const msg = `postings name ${[...others].slice(0, 3).join(", ")}, not ${dom} — a namesake's board`;
    console.warn(`[ats] rejected ${slug} for ${dom}: ${msg}`);
    return { ok: false, why: msg };
  }
  const names = [...new Set(jobs.map((j) => j.company).filter((c): c is string => !!c && !!c.trim()))];
  if (!names.length) {
    if (stem.length >= MIN_EXACT_MATCH_SLUG) return { ok: true, why: "unnamed board, slug is the domain stem" };
    const msg = "slug too short to attribute and the board states no company name";
    console.warn(`[ats] rejected ${slug} for ${dom}: ${msg}`);
    return { ok: false, why: msg };
  }
  if (stem.length < MIN_UNCORROBORATED_SLUG) {
    const msg = `slug too short to attribute, and the board belongs to ${JSON.stringify(names.slice(0, 3))}`;
    console.warn(`[ats] rejected ${slug} for ${dom}: ${msg}`);
    return { ok: false, why: msg };
  }
  // NAMED AS SOMEONE ELSE (the nationalaircargo.com → "Kolhorn AG" squat). Sharing one distinctive
  // WORD with the domain is the same company written differently ("Galapagos Rockford Charter School",
  // "Viant Technology - PERM"); furniture ("Open Roles") and short brands ("TiDB") are no evidence
  // either way. isUsableCompanyName, not isDistinctiveIdentity: a place-named employer ("Kolhorn") is
  // still a real, different employer.
  const related = (n: string) => nameKey(n) && foldDiacritics(n).toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .some((w) => w.length >= MIN_UNCORROBORATED_SLUG && (stem.includes(w) || w.includes(stem)));
  const realNames = names.filter((n) => isUsableCompanyName(n)
    && nameKey(n).length >= MIN_UNCORROBORATED_SLUG && !related(n));
  if (realNames.length) {
    const msg = `the board posts under ${JSON.stringify(realNames.slice(0, 3))}, a different employer`;
    console.warn(`[ats] rejected ${slug} for ${dom}: ${msg}`);
    return { ok: false, why: msg };
  }
  return { ok: true, why: "slug is the domain stem and the stated name does not contradict it" };
}

/** Which ATS board a job came from, whatever lane delivered it: the `ats:<vendor>:<slug>` source tag,
 *  hiring.cafe's raw.ats hint, or — when hiring.cafe stamps only "ashby" with no slug, as it does for
 *  clasp.com — the apply URL itself. Slugs are lowercased (Ashby and Lever tenants are case-insensitive).
 *  Null when the job cannot be tied to a board. */
const BOARD_URL_PATTERNS: Array<[AtsVendor, RegExp]> = [
  ["greenhouse", /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/i],
  ["lever", /^jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9_.-]+)/i],
  ["ashby", /^jobs\.ashbyhq\.com\/([^/?#]+)/i],
  ["workable", /^apply\.workable\.com\/([A-Za-z0-9_-]+)/i],
  ["smartrecruiters", /^(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i],
];
/** Phase 21: the jobs that do NOT come from a board quarantined for their own domain. Applied at
 *  ingest to every lane — ATS adapters and hiring.cafe (hcorg) alike. */
export function dropQuarantinedJobs<T extends RawJob>(jobs: T[]): T[] {
  return jobs.filter((j) => {
    const dom = normalizeOrgDomain(j.domain ?? "");
    if (!dom) return true;
    const b = jobBoardOf(j);
    return !(b && dbIsBoardQuarantined(dom, b.vendor, b.slug));
  });
}

export function jobBoardOf(job: { source?: string | null; url?: string | null; raw?: unknown }): { vendor: AtsVendor; slug: string } | null {
  const src = /^ats:([a-z]+):(.+)$/.exec(String(job.source ?? ""));
  if (src) return { vendor: src[1] as AtsVendor, slug: src[2]!.toLowerCase() };
  const hint = hcBoardHint(job.raw);
  if (hint) return { vendor: hint.vendor, slug: hint.slug.toLowerCase() };
  if (job.url) {
    const u = String(job.url).replace(/^https?:\/\//i, "");
    for (const [vendor, re] of BOARD_URL_PATTERNS) {
      const m = re.exec(u);
      if (m) { let s = m[1]!; try { s = decodeURIComponent(s); } catch { /* keep raw */ } return { vendor, slug: s.toLowerCase() }; }
    }
  }
  return null;
}

/**
 * Did this probe actually get an ANSWER from the vendor, or did it just fail to ask?
 *
 * getJson throws `ats-http-<status>`; everything else that lands in the catch is a timeout, a DNS
 * failure or a socket error. A 404 or 410 is the vendor telling us the board does not exist — that
 * is a real negative. A 429, a 5xx or a timeout tells us nothing at all.
 *
 * The distinction matters because a negative is CACHED FOR SEVEN DAYS (ATS_NEG_TTL_DAYS). Recording
 * "no board" from a rate-limited request means not asking again for a week, and discovery runs a
 * burst of concurrent probes per domain across every vendor, which is exactly the shape that earns
 * a 429. This is the same defect edgar.ts had — "a lookup that FAILED is not a company with no
 * filings" — and this file's own docblock flags a sibling half of it as fixed while this half was
 * left: probe() collapsed every failure into the same `null` that means "definitely nothing here".
 */
function answered(e: unknown): boolean {
  const m = /^ats-http-(\d{3})$/.exec((e as Error)?.message ?? "");
  if (!m) return false;                       // timeout / DNS / socket — no answer
  const status = Number(m[1]);
  return status === 404 || status === 410;    // a real "this board does not exist"
}

/** One probe's outcome. `undetermined` is NOT a miss and must never be cached as one. */
type ProbeResult =
  | { hit: { vendor: AtsVendor; slug: string } }
  | { hit: null; undetermined?: boolean };

/** Probe one (vendor, slug) — a hit when the board exists, lists jobs, AND those jobs can be
 *  attributed to this domain (see verifyBoard). */
async function probe(vendor: AtsVendor, slug: string, domain: string): Promise<ProbeResult> {
  // Phase 21: a quarantined board is a confirmed wrong-company board for this domain. Never fetched,
  // never accepted — and reported as a clean miss, so the negative is cached like any other.
  if (dbIsBoardQuarantined(domain, vendor, slug)) return { hit: null };
  try {
    const jobs = await FETCHERS[vendor](slug, domain, { existenceOnly: true });
    if (!jobs.length) return { hit: null }; // an empty board is indistinguishable from a wrong slug → miss
    // A hand-confirmed board (ats_board_overrides) survives re-verification whatever its postings say.
    if (dbIsBoardOverridden(domain, vendor, slug)) return { hit: { vendor, slug } };
    return verifyBoard(domain, slug, jobs) ? { hit: { vendor, slug } } : { hit: null };
  } catch (e) {
    return answered(e) ? { hit: null } : { hit: null, undetermined: true };
  }
}

/**
 * Discover which ATS boards a domain publishes. Probes each vendor × candidate-slug in parallel and
 * returns every hit (a company can post on more than one ATS), together with the vendors actually
 * contacted.
 *
 * `probed` exists because the second wave is conditional. When the US wave hits, the EU vendors are
 * never contacted at all — but the caller was recording a negative marker for all seven regardless,
 * so the cache asserted "we checked Workable, Personio, Recruitee and SmartRecruiters and found
 * nothing" about four requests that were never sent. That is the exact failure the comment above
 * dbSaveAtsProbe warns of ("reads as 'we checked and it wasn't there'"); the atomicity half of it was
 * fixed and this half was not. It also laundered real negatives: a genuine 7-day-old miss got its
 * timestamp rewritten to "just now" every time an unrelated vendor hit, so it never aged out into a
 * real re-probe.
 */
export async function discoverAtsBoards(domain: string): Promise<{ boards: Array<{ vendor: AtsVendor; slug: string }>; probed: AtsVendor[] }> {
  const slugs = candidateSlugs(domain);
  if (!slugs.length) return { boards: [], probed: [] };
  const byVendor = new Map<AtsVendor, { vendor: AtsVendor; slug: string }>();
  const probed: AtsVendor[] = [];
  const runWave = async (vendors: AtsVendor[]) => {
    // Which vendors gave us a real answer. A vendor whose every probe timed out or was rate-limited
    // is NOT reported as probed, so dbSaveAtsProbe writes no negative for it and the next run asks
    // again — instead of a 429 silently meaning "this company has no ATS" for the next seven days.
    const answeredBy = new Set<AtsVendor>(vendors);
    const pairs = vendors.flatMap((v) => slugs.map((s) => [v, s] as const));
    // Phase 21: a hand-confirmed board is probed even when its slug is not a guessable candidate.
    for (const o of dbOverridesForDomain(domain)) {
      const v = o.vendor as AtsVendor;
      if (vendors.includes(v) && !pairs.some(([pv, ps]) => pv === v && ps.toLowerCase() === o.slug.toLowerCase())) pairs.push([v, o.slug] as const);
    }
    const results = await Promise.all(pairs.map(([v, s]) => probe(v, s, domain)));
    const undetermined = new Map<AtsVendor, number>();
    results.forEach((r, i) => {
      const v = pairs[i]![0];
      if (r.hit) { if (!byVendor.has(r.hit.vendor)) byVendor.set(r.hit.vendor, r.hit); return; }
      if (r.undetermined) undetermined.set(v, (undetermined.get(v) ?? 0) + 1);
    });
    // Only a vendor where EVERY slug came back undetermined is dropped: one slug timing out while
    // another cleanly 404s still tells us the board is not there under either name.
    for (const [v, n] of undetermined) if (n === slugs.length && !byVendor.has(v)) answeredBy.delete(v);
    if (answeredBy.size < vendors.length) {
      console.warn(`[ats] ${domain}: no answer from ${vendors.filter((v) => !answeredBy.has(v)).join(", ")} — not caching a miss for them`);
    }
    probed.push(...vendors.filter((v) => answeredBy.has(v)));
  };
  await runWave(US_WAVE);
  // Second wave only when the first found nothing: a company already on Greenhouse isn't also on
  // Personio, so existing (mostly US) watchlists pay zero extra requests for the wider coverage.
  if (!byVendor.size) await runWave(EU_WAVE);
  return { boards: [...byVendor.values()], probed };
}

// hiring.cafe's own vendor label, mapped to ours. Confirmed live values this maps: "ashby", "lever",
// "smartrecruiters", "workable", "greenhouse" — plus "grnhse", hiring.cafe's own internal short name
// for Greenhouse, seen on every Greenhouse-sourced hit in production data. Vendors also seen live but
// deliberately NOT mapped, because we have no fetcher for them: dover, gem, hiringthing, sparkhire.
const HC_VENDOR_MAP: Partial<Record<string, AtsVendor>> = {
  ashby: "ashby", lever: "lever", greenhouse: "greenhouse", grnhse: "greenhouse",
  smartrecruiters: "smartrecruiters", workable: "workable", personio: "personio", recruitee: "recruitee",
};

/**
 * hiring.cafe already knows which ATS board a job lives on and its real board token — mapHit
 * (hiringcafe.ts) stamps every hit with `raw.ats = "<source>:<board_token>"` — and we were throwing
 * that away. It is ground truth, not a guess: candidateSlugs can only guess a domain's OWN stem
 * ("scale" for scale.com), and Scale AI's real Greenhouse tenant is "scaleai" — no guessing rule
 * derives that, but hiring.cafe getting a job back from that exact board already resolved it. Once
 * hiring.cafe has successfully returned a job for a domain, this turns a permanent per-run dependency
 * on it into a one-time bootstrap: discoverAndCacheAts can fetch that board directly from then on.
 *
 * Returns null for a job with no `raw.ats`, an unparseable one, or a vendor we have no fetcher for
 * (see HC_VENDOR_MAP) — all of which just means "no hint available," not an error.
 */
export function hcBoardHint(raw: unknown): { vendor: AtsVendor; slug: string } | null {
  const ats = (raw as { ats?: unknown } | null)?.ats;
  if (typeof ats !== "string") return null;
  const i = ats.indexOf(":");
  if (i < 0) return null;
  const vendor = HC_VENDOR_MAP[ats.slice(0, i).trim().toLowerCase()];
  const slug = ats.slice(i + 1).trim();
  return vendor && slug ? { vendor, slug } : null;
}

/** Cache-first discovery: returns the domain's live boards, probing (and caching pos+neg) on a miss. */
export async function discoverAndCacheAts(domain: string): Promise<Array<{ vendor: AtsVendor; slug: string }>> {
  const dom = normalizeOrgDomain(domain);
  if (!dom) return [];
  const cached = dbGetAtsBoards(dom); // rows within TTL (positive 24h, negative 7d)
  if (cached.length) return cached.filter((r) => r.found && r.slug && !dbIsBoardQuarantined(dom, r.vendor, r.slug))
    .map((r) => ({ vendor: r.vendor as AtsVendor, slug: r.slug! }));
  const { boards, probed } = await discoverAtsBoards(dom);
  dbSaveAtsProbe(dom, boards, probed);
  return boards;
}

/** Build `ats` source configs for a set of domains (cache-first discovery). Used by watchlists +
 *  account checks to pull each company's ATS board directly alongside the hiring.cafe /org/ scan. */
export async function atsSourcesForDomains(domains: string[], maxPages: number, interval: string,
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean): Promise<SourceConfig[]> {
  const uniq = [...new Set(domains.map((d) => normalizeOrgDomain(d)).filter(Boolean))];
  // Discovery runs BEFORE the ingest source-pool, so a plain Promise.all here would fan out every domain
  // at once — each doing up to 6 probe fetches on a cold cache. A large watchlist would fire thousands of
  // concurrent requests at the ATS hosts. Bound it with a small worker pool (each domain's cached result
  // returns instantly, so only cold-cache domains actually hit the network).
  const POOL = Math.max(1, Number(process.env.ATS_DISCOVERY_CONCURRENCY) || 6);
  const out: SourceConfig[] = [];
  let next = 0;
  // Report as it goes. On a cold cache this loop is the longest part of a watchlist run — measured at
  // ~4 domains a second, so 7,470 companies is around half an hour before a single job is fetched —
  // and every counter the dock shows is still legitimately zero throughout it. Without this the only
  // honest reading available on screen is "0 new jobs found", which is indistinguishable from hung.
  let done = 0;
  const worker = async () => {
    for (let i = next++; i < uniq.length; i = next++) {
      // Graceful stop: quit claiming domains once a stop is requested. Discovery is the longest
      // phase of a big watchlist run, so honoring the request here is what makes "Stop" feel instant.
      if (shouldStop?.()) break;
      const dom = uniq[i]!;
      try {
        const boards = await discoverAndCacheAts(dom);
        for (const b of boards) out.push({ type: "ats", interval, vendor: b.vendor, slug: b.slug, domain: dom, maxPages } as SourceConfig);
      } catch { /* one domain's discovery failing never blocks the rest */ }
      // Throttled to whole percent: a 7,470-domain run would otherwise broadcast 7,470 SSE frames to
      // every open tab for a bar that only has 100 distinguishable positions.
      done++;
      if (onProgress && (done === uniq.length || Math.floor((done - 1) * 100 / uniq.length) !== Math.floor(done * 100 / uniq.length))) {
        onProgress(done, uniq.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, uniq.length) }, worker));
  return out;
}

// ───────────────────────── adapter ─────────────────────────

/** "blue-engine.org" → "Blue Engine". Always about the right company, because it IS the company's
 *  own domain — the weakest name available and the only one that cannot be about someone else. */
function prettyStem(domain: string): string {
  return domain.split(".")[0]!.split(/[-_]/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Is this resolved string actually THIS company's name, or is it the homepage's marketing copy?
 *
 * resolveCompanyName falls back to the homepage <title>, and a <title> is written for search engines,
 * not for us. Run live against all 58 real name-less boards in the install, 12 came back unusable:
 *
 *   blueengine.org   -> "403 - Forbidden"                          an error page, stored as a company
 *   almabase.com     -> "Grow Your Donor Base"                     a tagline, no company in it at all
 *   unlearn.ai       -> "Streamline Clinical Trials with AI and…"  the same
 *   stedi.org        -> "Home - STEDI.org, Substitute Teaching…"   page furniture cleanTitle missed
 *   heartworksvt.com -> "Heartworks Early Education: VT&#039;s…"   entity-encoded, hence decodeEntities
 *
 * Writing those into `company` would be bad on its own, and there is a second-order reason it would
 * be much worse than it looks: resolveCompanyName's FIRST and most-trusted source is the most-seen
 * company string in our own raw_jobs for that domain. So a tagline written here comes back as the
 * authoritative name on the next call, forever, without the homepage ever being consulted again. A
 * bad name would cement itself.
 *
 * The test is the one this codebase already uses to decide whether a board belongs to a company
 * (verifyBoard): the name and the domain stem must be about the same thing. Anything else is
 * discarded in favour of the stem — a weaker name, but one that cannot be about a different company.
 * "Caseware AI Platform" keeps its resolved form (it contains the stem); "403 - Forbidden" becomes
 * "Blueengine"; "Grow Your Donor Base" becomes "Almabase".
 *
 * Returns null when nothing about the resolved string ties it to this domain.
 */
export function attributableName(resolved: string, domain: string): string | null {
  const name = (resolved ?? "").trim();
  if (!name) return null;
  const fold = (s: string) => foldDiacritics(stripLegalSuffix(s.toLowerCase())).replace(/[^a-z0-9]+/g, "");
  const stem = fold(domain.split(".")[0] ?? "");
  const n = fold(name);
  if (!stem || !n) return null;
  // A 1-3 character stem ("ey.com", "g2.com") is not distinctive enough to attribute anything with —
  // the same length floor companyEntityMatches applies, for the same reason.
  if (stem.length < 4) return null;
  return n.includes(stem) || stem.includes(n) ? name : null;
}

/**
 * Give the employer a NAME on boards whose vendor does not supply one.
 *
 * Lever and Ashby return no company name at all, and Personio only sometimes does (its `subcompany`
 * field is usually empty). Greenhouse, SmartRecruiters, Workable and Recruitee all do. So a third of
 * the vendors leave every row with a blank employer — 105 of them in the live database, 99 of those
 * matched to a client and on screen right now with an empty column.
 *
 * That blank is not cosmetic. Company is the identity every NAME-keyed producer matches on: EDGAR,
 * Companies House, WARN, news and app listings take a name, never a domain. A nameless row
 * contributes to none of them.
 *
 * We already know the answer. A board is DISCOVERED for a specific domain, so `cfg.domain` is the
 * company whose careers page this is, and resolveCompanyName is the same function every signal
 * producer already uses to turn that domain into a name. Using anything else here would let the
 * dashboard and the producers disagree about what one company is called.
 *
 * It is cheap. resolveCompanyName tries our OWN jobs table first — the most-seen company string on
 * that domain — so whenever hiring.cafe has already named this employer the answer costs nothing at
 * all. Only a domain we have never named falls through to one 6s homepage fetch, memoised per
 * process, and this runs once per BOARD rather than once per job (16 boards in the live install).
 *
 * FILL, NEVER CORRECT, matching the two learn-on-resight statements in db.ts: a job the vendor DID
 * name keeps that name. The resolver is only consulted when at least one job lacks one, so a
 * fully-named board costs nothing.
 */
// Exported for tests only: the vendor asymmetry it corrects is invisible from atsAdapter, which needs
// a live board to reach it.
export async function nameTheEmployer(jobs: RawJob[], domain: string | null, vendor: string, slug: string): Promise<RawJob[]> {
  // Both of these are COST guards, not correctness guards, and a mutation test is what established
  // the difference — removing either leaves every assertion in this file green. Without them the
  // resolver still returns nothing usable (a null domain throws inside it and is caught; a
  // fully-named board has no blank job to write to), so the observable result is identical. What
  // they buy is not making the call: one homepage fetch per board per fetch cycle, for the four
  // vendors that never needed naming and for boards configured by slug with no domain to resolve
  // from. Stated as cost rather than left looking like safety, so nobody "simplifies" them away
  // expecting a test to object.
  if (!domain || !jobs.length) return jobs;
  const blank = jobs.filter((j) => !j.company || !j.company.trim());
  if (!blank.length) return jobs;
  let resolved = "";
  // Fail-soft, like every other step in this file: a homepage that will not load costs the NAME, not
  // the jobs. Returning them unnamed is what happens today and is strictly better than dropping them.
  try { resolved = decodeEntities(await resolveCompanyName(domain)) ?? ""; }
  catch (e) { console.warn(`[ats] ${vendor}:${slug} could not name ${domain}: ${(e as Error).message}`); return jobs; }
  const name = attributableName(resolved, domain) ?? prettyStem(domain);
  if (!name) return jobs;
  for (const j of blank) j.company = name;
  console.log(`[ats] ${vendor}:${slug} named ${blank.length} job(s) "${name}" from ${domain}`);
  return jobs;
}

/** type: ats — { vendor, slug, domain?, enabled? }. Pulls one company's live jobs from one ATS board. */
export async function atsAdapter(cfg: SourceConfig): Promise<RawJob[]> {
  if (cfg.enabled === false) return [];
  const vendor = String(cfg.vendor ?? "") as AtsVendor;
  const slug = String(cfg.slug ?? "");
  const fetcher = FETCHERS[vendor];
  if (!fetcher || !slug) return [];
  const domain = cfg.domain != null ? normalizeOrgDomain(String(cfg.domain)) : null;
  if (domain && dbIsBoardQuarantined(domain, vendor, slug)) {
    console.log(`[ats] ${vendor}:${slug} is quarantined for ${domain} — not fetched`);
    return [];
  }
  try {
    const jobs = await fetcher(slug, domain, { maxPages: Number(cfg.maxPages) || undefined });
    console.log(`[ats] ${vendor}:${slug} → ${jobs.length} jobs`);
    return await nameTheEmployer(jobs, domain, vendor, slug);
  } catch (e) {
    // The board answered on discovery and now does not. Returning [] here is what made a broken
    // ATS lane indistinguishable from a company that stopped hiring — and dbSweepClosed(14) then
    // closes that source's whole open inventory two weeks later.
    const m = `${vendor}:${slug} failed: ${(e as Error).message}`;
    console.warn(`[ats] ${m}`); reportDegraded(m);
    return [];
  }
}
