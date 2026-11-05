// WARN layoff notices — the advance layoff filings large US employers must file with their state.
//
// PRIMARY SOURCE: Big Local News' consolidated `integrated.csv` (free, no key) — a normalized
// aggregate of ~43 states + DC (~88k notices, refreshed every day or two) with the fields we need:
// company, # jobs affected, closure-vs-layoff type, temporary flag, notice + effective dates, city,
// state, and a stable hash_id for dedup. One fetch replaces ~40 brittle per-state parsers.
// SUPPLEMENT: a live scrape of NY's page, because NY lags ~7 weeks in the aggregate (NY rows carry
// less detail — company + date only). Both are cached ~12h and shared across every domain in a run.
//
// The "what it's about" summary is built from jobs + closure/temporary flags (the aggregate has no
// free-text reason field). Recent notices only (or future-dated — WARN is advance notice); the
// matched listing name is always shown so a fuzzy name match is visible, never silent.
import { companyEntityMatches } from "./company.ts";
import { contactUserAgent } from "./contact.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const CACHE_MS = 12 * 3600e3;
const RECENT_DAYS = 200;                 // ignore notices older than this (WARN effective dates are often future)
const AGG_URL = "https://raw.githubusercontent.com/biglocalnews/warn-github-flow/transformer/data/warn-transformer/processed/integrated.csv";
const NY_URL = "https://dol.ny.gov/warn-notices";

export interface WarnRow {
  id: string; company: string; state: string; city: string;
  jobs: number | null; isClosure: boolean; isTemporary: boolean;
  date: string;        // sort/display anchor: notice date, else effective date
  notice: string;      // the notice date ALONE — "" when the filing didn't carry one
  effective: string;   // effective date (may be future)
  source: "aggregate" | "NY";
}

// ── RFC-4180 CSV parser (fields may be quoted, quotes doubled, commas/newlines inside quotes) ──
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const truthy = (s: string) => /^(true|1|yes)$/i.test(s.trim());
// Normalize a date string to ISO YYYY-MM-DD so NY's scraped M/D/YYYY sorts + compares correctly against
// the aggregate's already-ISO dates (a raw "07/01/2026" string-sorts before "2026-01-05" — wrong order,
// and it also corrupts the observed_at day-range history filter). Formats via LOCAL getters, never
// toISOString(), so a date-only input like "7/1/2026" can't drift a day under a negative UTC offset.
function toIsoDate(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (mdy) {
    const y = mdy[3]!.length === 2 ? String(2000 + Number(mdy[3])) : mdy[3]!;
    return `${y}-${mdy[1]!.padStart(2, "0")}-${mdy[2]!.padStart(2, "0")}`;
  }
  const d = new Date(t);
  if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return t; // unparseable → leave as-is (still shown in facts, never silently dropped)
}
const squash = (s: string) => s.toLowerCase().replace(/\b(inc|llc|llp|ltd|corp|co|company|the|dba|d\/b\/a)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function fetchAggregate(): Promise<WarnRow[]> {
  const res = await fetch(AGG_URL, { headers: { "User-Agent": contactUserAgent() }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`aggregate HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  const header = rows[0] ?? [];
  const col = (name: string): number => header.indexOf(name);
  const ci = col("hash_id"), cn = col("notice_date"), ce = col("effective_date"), cp = col("postal_code"),
    cc = col("company"), cl = col("location"), cj = col("jobs"), ccl = col("is_closure"),
    ct = col("is_temporary"), cs = col("is_superseded");
  const at = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "") : "").trim();
  const now = Date.now();
  const out: WarnRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (cs >= 0 && truthy(at(row, cs))) continue; // skip superseded/amended duplicates
    const company = at(row, cc); if (!company) continue;
    const notice = at(row, cn), effective = at(row, ce);
    const date = notice || effective; if (!date) continue;
    const t = new Date(date).getTime();
    if (isFinite(t) && now - t > RECENT_DAYS * 86400e3) continue; // too old (future dates pass)
    const jobs = Number(at(row, cj));
    out.push({
      id: at(row, ci).slice(0, 24) || `${squash(company)}:${date}`,
      company, state: at(row, cp), city: at(row, cl),
      jobs: isFinite(jobs) && jobs > 0 ? jobs : null,
      isClosure: truthy(at(row, ccl)), isTemporary: truthy(at(row, ct)),
      date, notice, effective, source: "aggregate",
    });
  }
  return out;
}

async function fetchNY(): Promise<WarnRow[]> {
  const res = await fetch(NY_URL, { headers: { "User-Agent": contactUserAgent() }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`NY HTTP ${res.status}`);
  const html = await res.text();
  const out: WarnRow[] = [];
  const now = Date.now();
  for (const tr of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (cells.length < 3 || !cells[0]) continue;
    const date = toIsoDate(cells[2] ?? ""); // NY renders M/D/YYYY → normalize so it sorts/compares as ISO
    const t = new Date(date).getTime();
    if (isFinite(t) && now - t > RECENT_DAYS * 86400e3) continue;
    out.push({ id: `ny:${squash(cells[0]!)}:${date}`, company: cells[0]!, state: "NY", city: cells[1] ?? "", jobs: null, isClosure: false, isTemporary: false, date, notice: date, effective: "", source: "NY" });
  }
  return out;
}

let cache: { at: number; rows: WarnRow[] } | null = null;
let inflight: Promise<WarnRow[]> | null = null;
async function warnRows(): Promise<WarnRow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  if (inflight) return inflight;
  inflight = (async () => {
    const [agg, ny] = await Promise.allSettled([fetchAggregate(), fetchNY()]);
    const rows: WarnRow[] = [];
    if (agg.status === "fulfilled") rows.push(...agg.value);
    if (ny.status === "fulfilled") { // NY supplement: only add NY notices the aggregate doesn't already have
      const seen = new Set(rows.filter((r) => r.state === "NY").map((r) => `${squash(r.company)}|${r.date}`));
      for (const r of ny.value) if (!seen.has(`${squash(r.company)}|${r.date}`)) rows.push(r);
    }
    if (rows.length) cache = { at: Date.now(), rows }; // an all-fail never caches emptiness
    inflight = null;
    return rows;
  })();
  return inflight;
}

/** Plain-English "what it's about" from the structured flags. */
function summarize(r: WarnRow): string {
  const kind = r.isClosure ? "Facility closure" : "Layoff";
  const n = r.jobs != null ? `${r.jobs} job${r.jobs === 1 ? "" : "s"}` : "count not disclosed";
  const temp = r.isTemporary ? " (temporary)" : "";
  return `${kind} — ${n}${temp}`;
}

// A displayed date must say which date it is: an undated filing shows its effective date,
// which is usually in the future, and printing it bare reads as "this already happened".
const dateLabel = (h: WarnRow) => (h.notice ? h.date : `effective ${h.date}`);

export const warnProducer: SignalProducer = {
  key: "warn",
  label: "WARN layoff notices",
  description: "State-filed advance layoff notices (43 states + DC via Big Local News, plus a live NY feed), matched by company name with employee counts + closure/layoff type.",
  needsCompany: true,
  flagged: true,
  async check(_domain, ctx): Promise<ProducerResult> {
    const company = (ctx.company ?? "").trim();
    if (!company) return { facts: { WARN: "no company name resolved" }, signals: [] };
    let rows: WarnRow[];
    try { rows = await warnRows(); } catch { return { facts: { WARN: "notice lists unavailable — will retry next scan" }, signals: [] }; }
    if (!rows.length) return { facts: { WARN: "notice lists unavailable — will retry next scan" }, signals: [] };
    const cq = squash(company);
    // no-flag: below the distinctiveness floor the match was never RUN, so this is "we couldn't
    // look", not "there are no notices". Saying no here would clear a real layoff notice for a
    // company whose resolved name happens to be three letters. 24 domains on the live watchlist.
    if (cq.length < 4) return { facts: { WARN: "name too short to match safely" }, signals: [] };
    // A WARN filer name is a registered employer name, so this is entity-to-entity: exact squashed
    // equality (handles punctuation/suffix noise), else a word-bounded prefix match. The free-text
    // matcher accepted any employer name that merely CONTAINED the brand as a word, so an unrelated
    // "<Something> Notion <Something>" filing could be filed under notion.so. "meta" not hitting
    // "Metabolic Labs" and "apple" not hitting "Applebee's" still hold — a prefix is stricter.
    const hits = rows.filter((r) => squash(r.company) === cq || companyEntityMatches(company, r.company))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const facts: Record<string, string> = {
      WARN: hits.length
        ? `${hits.length} notice${hits.length === 1 ? "" : "s"} — latest: ${summarize(hits[0]!)} (${hits[0]!.state}, ${dateLabel(hits[0]!)})`
        : "no notices on the current lists (43 states + DC)",
    };
    const signals: SignalDraft[] = hits.slice(0, 3).map((h) => ({
      dedupKey: `warn-layoff:${_domain}:${h.id}`, type: "warn-layoff",
      title: `WARN notice — ${summarize(h)}: ${h.company} (${h.state}${h.city ? `, ${h.city}` : ""}, ${dateLabel(h)})`,
      // The event date is the date the notice was FILED. `h.date` falls back to the effective date
      // when a filing carries no notice date, and an effective date is routinely in the future — two
      // production signals claimed to have been observed 11 and 35 days from now, which sorts a
      // layoff that has not happened above everything that has. When the filing date is unknown, say
      // so with null; detail.effectiveDate still carries the real value.
      company, observedAt: h.notice || null,
      // Source link: NY notices have an official state listing; everything else links the public
      // aggregate dataset the notice came from (per-notice URLs aren't in the feeds).
      url: h.state === "NY" ? "https://dol.ny.gov/warn-notices" : "https://layoffdata.com/data/",
      detail: {
        listedAs: h.company, summary: summarize(h), jobsAffected: h.jobs, type: h.isClosure ? "closure" : "layoff",
        // noticeDate is the filing date or nothing — never the effective date wearing its label.
        temporary: h.isTemporary, state: h.state, city: h.city, noticeDate: h.notice || null, effectiveDate: h.effective || null, source: h.source,
      },
    }));
    return { facts, signals,
      flag: { hit: hits.length > 0, summary: hits.length ? `WARN: ${summarize(hits[0]!)} (${hits[0]!.state}, ${dateLabel(hits[0]!)})` : "No recent WARN notices" } };
  },
};
