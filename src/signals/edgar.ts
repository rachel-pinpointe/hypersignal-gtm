// SEC EDGAR filings — the funding signal, from the official FREE API (no key; SEC asks only for an
// identifying User-Agent). Two steps per domain:
//   1. company name → CIK via the stable browse-edgar company search (Atom XML)
//   2. CIK → recent filings via data.sec.gov/submissions/CIK##########.json
// Form D = they raised money (filed even when there's no press release). 8-K = material event.
// S-1/S-1/A = IPO prep. US filers only; the matched CIK + name land in the facts so a wrong
// name-match is visible, never silent. New filings (vs domain_state) → signals; first scan baseline.
import { dbGetDomainState, dbReplaceDomainState } from "../db.ts";
import { companyEntityMatches } from "./company.ts";
import { contactEmail, contactUserAgent } from "./contact.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const SIGNAL_FORMS: Record<string, { type: string; label: string }> = {
  "D": { type: "funding-form-d", label: "Form D — raised capital" },
  "D/A": { type: "funding-form-d", label: "Form D/A — amended raise" },
  "8-K": { type: "filing-8k", label: "8-K — material event" },
  "S-1": { type: "filing-s1", label: "S-1 — IPO registration" },
  "S-1/A": { type: "filing-s1", label: "S-1/A — amended IPO registration" },
};
const RECENT_DAYS = 365; // facts window; signals additionally require post-baseline newness

interface FtsFiling { name: string; cik: string; form: string; date: string; accession: string }

const jsonGet = async (url: string, ms = 10000): Promise<unknown> => {
  const res = await fetch(url, { headers: { "User-Agent": contactUserAgent(), Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  // THROW, don't return []. Collapsing a 429/5xx into an empty array made "SEC rate-limited us"
  // indistinguishable from "this company has never filed" — and EDGAR rate-limits aggressively.
  if (!res.ok) throw new Error(`EDGAR HTTP ${res.status}`);
  return res.json();
};

/** Company name → the SEC entity that IS this company, via EDGAR's full-text-search JSON API
 *  (efts.sec.gov — the same backend the EDGAR search UI uses; free, no key). Identity only: the hit
 *  list is used to find a matching filer and its CIK, never to enumerate its filings. (The older
 *  browse-edgar Atom output is broken for multi-company results — conformed names come back as Perl
 *  "ARRAY(0x…)" garbage, which is why FTS is the entry point at all.) */
async function findFiler(company: string): Promise<{ cik: string; name: string } | null> {
  const data = await jsonGet(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${company}"`)}&forms=D,8-K,S-1`) as
    { hits?: { hits?: Array<{ _source?: Record<string, unknown> }> } };
  for (const h of data.hits?.hits ?? []) {
    const display = (Array.isArray(h._source?.display_names) ? h._source!.display_names : []).map(String);
    // display_names look like "Notion Labs, Inc.  (CIK 0001781814)". The filer name and the company
    // name are both ENTITY names, so this is companyEntityMatches (prefix-anchored), NOT the free-text
    // whole-word matcher: that one accepted the filer "Pantera Opportunities Fund SP Stripe" for the
    // company "Stripe", and the feed reported a Pantera fund's Form D as Stripe raising money.
    const mine = display.find((d) => companyEntityMatches(company, d.replace(/\s*\(cik.*$/i, "").trim()));
    if (!mine) continue;
    const cik = /\(cik\s+(\d+)\)/i.exec(mine)?.[1] ?? "";
    if (cik) return { cik, name: mine.replace(/\s*\(cik.*$/i, "").trim() };
  }
  return null;
}

/**
 * CIK → that filer's actual filing history, from data.sec.gov/submissions — the authoritative,
 * complete, date-ordered list. This is step 2, and until now it did not exist: the producer read
 * its filings straight out of the full-text-search hit list, which is the wrong instrument for the
 * job in two ways that were both measured against the live API.
 *
 *   1. FTS ranks by RELEVANCE and returns 100 of them. "Cargill" matches 2,989 filings; the 100 that
 *      come back are dated 2004-2013 and not one falls inside the 365-day window the producer then
 *      filters to. So a company that filed an 8-K last month was reported as "none of interest in
 *      12mo". Deere, similarly, holds 182 filings of interest and the FTS page surfaced none of the
 *      recent ones. For any company with a filing history this was a blanket false negative.
 *
 *   2. Worse, that 100 is not stable. Relevance ties reorder between requests, so a filing present
 *      in one scan can be absent from the next — and the accession numbers in domain_state are the
 *      baseline. Drop out, come back, and it diffs as brand new: a fabricated "raised capital"
 *      signal for a filing from years ago. This is the same trap subdomains.ts documents and guards
 *      with a deterministic sort; here there was nothing deterministic to sort.
 *
 * The submissions endpoint answers the question actually being asked — "what has THIS filer filed?"
 * — with no ranking, no text matching and no truncation inside any window that matters. `recent`
 * carries the last 1000 filings; older pages under `.files` are not fetched, so a Form D older than
 * a filer's last 1000 filings is not reported. That bound is real but never wrong: it can only
 * omit an old raise, never invent one.
 */
async function submissionFilings(cik: string, company: string): Promise<{ name: string; rows: FtsFiling[] } | null> {
  const s = await jsonGet(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, 12000) as {
    name?: string; filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[] } };
  };
  const name = String(s.name ?? "").trim();
  // Re-verify the identity here rather than trusting the CIK alone. The CIK is cached in
  // domain_state across scans, so one bad match would otherwise be permanent — and this costs a
  // string comparison against the name the SEC itself holds for that CIK.
  if (!name || !companyEntityMatches(company, name)) return null;
  const r = s.filings?.recent ?? {};
  const forms = r.form ?? [], dates = r.filingDate ?? [], accs = r.accessionNumber ?? [];
  const rows: FtsFiling[] = [];
  for (let i = 0; i < forms.length; i++) {
    const form = String(forms[i] ?? ""), date = String(dates[i] ?? ""), accession = String(accs[i] ?? "");
    if (form && date && accession) rows.push({ name, cik, form, date, accession });
  }
  return { name, rows };
}

// The two determinate NEGATIVES this producer can reach before its main exit. They are named here,
// beside each other, because the distinction that matters in this file is not negative-vs-positive
// but MEASURED-vs-UNKNOWN: "the SEC has no such filer" is an answer and belongs in the flag, while
// "EDGAR returned a 503" is not and must leave the previous answer alone. Every exit below is
// commented with which of the two it is.
let warnedNoContact = false;   // log the missing-contact skip once per process, not once per domain
const NOT_A_FILER = { hit: false, summary: "Not an SEC filer" } as const;
const NO_RECENT_FILINGS = { hit: false, summary: "No recent SEC filings of interest" } as const;

export const edgarProducer: SignalProducer = {
  key: "edgar",
  label: "SEC filings (funding)",
  description: "Form D raises, 8-K events, S-1 IPO prep — from the official free SEC EDGAR API. US companies.",
  needsCompany: true,
  flagged: true,
  async check(domain, ctx): Promise<ProducerResult> {
    // SEC's fair-access policy requires a contact email in the User-Agent, so without one EDGAR is
    // not called at all.
    if (!contactEmail()) {
      if (!warnedNoContact) {
        warnedNoContact = true;
        console.warn("[edgar] CONTACT_EMAIL is not set; skipping SEC EDGAR lookups (SEC requires a contact email in the User-Agent). Set it in .env.");
      }
      // no-flag: nothing was measured, so the last real answer stays standing.
      return { facts: { EDGAR: "skipped: set CONTACT_EMAIL (SEC requires a contact email)" }, signals: [] };
    }
    const company = (ctx.company ?? "").trim();
    // No flag: without a name nothing was measured, so leave the last real answer standing.
    if (!company) return { facts: { EDGAR: "no company name resolved" }, signals: [] };
    // A lookup that FAILED is not a company with no filings. Every other producer distinguishes
    // these two ("unavailable — will retry next scan" vs a real measurement); EDGAR reported both
    // as the definitive `no filings found`, so a rate-limited scan silently told the user a filer
    // had never raised. It also wrote that non-answer into the baseline, so the real filings would
    // later diff as brand new.
    const prior = dbGetDomainState(domain, "edgar");
    let filings: FtsFiling[], filerName: string, filerCik: string;
    try {
      // A CIK already established for this domain is reused, so the identity search runs once per
      // company rather than once per scan. It is not taken on trust: submissionFilings re-checks the
      // SEC's own name for that CIK against the company and returns null if it no longer matches.
      const cached = prior.get("cik");
      let sub = cached ? await submissionFilings(cached, company) : null;
      if (!sub) {
        const found = await findFiler(company);
        if (!found) return { facts: { EDGAR: `no SEC filer matches "${company}"` }, signals: [], flag: NOT_A_FILER };
        sub = await submissionFilings(found.cik, company);
        if (!sub) return { facts: { EDGAR: `no SEC filer matches "${company}"` }, signals: [], flag: NOT_A_FILER };
        filerCik = found.cik;
      } else filerCik = cached!;
      filings = sub.rows;
      filerName = sub.name;
    }
    // NO flag here, deliberately, and this is the whole point of the distinction: a lookup that
    // FAILED must leave whatever the last real measurement said, not overwrite it with "no".
    catch (e) { return { facts: { EDGAR: `lookup unavailable (${(e as Error).message}) — will retry next scan` }, signals: [] }; }
    // A filer we found, holding zero filings, is the same conclusion the success path reaches when
    // none of its filings are recent — so it says the same thing rather than saying nothing.
    if (!filings.length) return { facts: { EDGAR: `no filings found for "${company}"` }, signals: [], flag: NO_RECENT_FILINGS };

    const now = Date.now();
    const interesting = filings
      .filter((f) => SIGNAL_FORMS[f.form])
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const recent = interesting.filter((f) => now - new Date(f.date).getTime() <= RECENT_DAYS * 86400e3);

    const facts: Record<string, string> = {
      "SEC filer": `${filerName} (CIK ${filerCik})`,
      "Recent filings": recent.length ? recent.slice(0, 4).map((f) => `${f.form} ${f.date}`).join(", ") : "none of interest in 12mo",
    };
    const lastD = interesting.find((f) => f.form.startsWith("D"));
    if (lastD) facts["Last raise (Form D)"] = lastD.date;

    // State = the accession numbers we've seen; NEW recent ones (post-baseline) become signals.
    //
    // `_v` is a SENTINEL and it is load-bearing, for the same reason it is in news.ts and gdelt.ts:
    // dbReplaceDomainState DELETES every key for the (domain, producer) when handed an empty object.
    // This state was `{cik?} + filed:<accession> for RECENT filings only`, so it is empty whenever a
    // company has no filing of interest inside the 365-day window AND the CIK regex at :44 missed —
    // and cik is parsed out of a display string with `?? ""`, so a format change makes it miss.
    // An empty write wipes the baseline; the next scan then sees prior.size === 0, treats itself as a
    // first scan, and silently swallows the company's next real filing. It would keep doing that on
    // every subsequent scan, because the conditions that emptied the state do not change.
    //
    // Measured on the audit snapshot: 31 of 45 EDGAR-covered companies (69%) currently hold a
    // cik-ONLY baseline — nothing but that regex standing between them and a permanently silent
    // producer. CIK parses for all 45 today, so this is latent, not firing. The sentinel removes the
    // dependency entirely rather than leaving it to a regex.
    const state: Record<string, string> = { _v: "1", cik: filerCik };
    for (const f of recent) state[`filed:${f.accession}`] = f.form;
    const signals: SignalDraft[] = [];
    if (prior.size > 0) {
      for (const f of recent) {
        if (prior.has(`filed:${f.accession}`)) continue;
        const meta = SIGNAL_FORMS[f.form]!;
        // Deep link straight to THIS filing's document index (cik as int, accession without dashes);
        // fall back to the filer's filing list when the accession is missing.
        const acc = (f.accession || "").replace(/[^0-9-]/g, "");
        const url = f.cik && acc
          ? `https://www.sec.gov/Archives/edgar/data/${Number(f.cik)}/${acc.replace(/-/g, "")}/${acc}-index.htm`
          : f.cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${f.cik}&type=${encodeURIComponent(f.form)}&dateb=&owner=include&count=10` : null;
        signals.push({
          dedupKey: `${meta.type}:${domain}:${f.accession}`, type: meta.type,
          title: `${meta.label} — filed ${f.date}`, company: f.name, observedAt: f.date,
          url,
          detail: { form: f.form, date: f.date, accession: f.accession, cik: f.cik || null },
        });
      }
    }
    if (!ctx.readonly) dbReplaceDomainState(domain, "edgar", state); // readonly probe: don't consume the diff baseline
    return { facts, signals,
      flag: recent.length ? { hit: true, summary: `Recent SEC filing: ${recent[0]!.form} ${recent[0]!.date}` } : NO_RECENT_FILINGS };
  },
};
