// UK Companies House filings — the UK equivalent of the EDGAR producer. An SH01 "statement of capital
// following an allotment of shares" means the company just issued new shares: the strongest free,
// official fundraise proxy for UK companies. Free API, basic-auth key the user registers for
// (developer.company-information.service.gov.uk). FAIL CLOSED: no key → the producer is inert
// (a plain fact, no error), exactly like the app's other keyed integrations.
import { dbGetDomainState, dbReplaceDomainState, dbGetSettings } from "../db.ts";
import { companyEntityMatches } from "./company.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const API = "https://api.company-information.service.gov.uk";
const RESEARCH_DAYS = 7;  // re-try a failed name→number resolution after this long
const FLAG_MONTHS = 12;   // "recently raised" window for the current-state flag
const MAX_SIGNALS = 5;

const authHeaders = (key: string) => ({
  Authorization: "Basic " + Buffer.from(key + ":").toString("base64"),
  Accept: "application/json",
  "User-Agent": "HyperSignal/1.0",
});

/** GET an API path. 200 → parsed JSON; 404 → null; 401 → throws "bad-key"; else throws the status. */
async function chGet(path: string, key: string): Promise<unknown | null> {
  const res = await fetch(API + path, { headers: authHeaders(key), signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error("bad-key");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// CH titles are ALL-CAPS legal names ("MONZO BANK LIMITED") — companyNameMatches lowercases both
// sides, so only the legal suffix needs stripping before comparing.
const stripSuffix = (s: string) => s.replace(/[,.]?\s+(LTD|LIMITED|PLC|LLP|LP)\.?$/i, "").trim();

interface ChFiling { transaction_id: string; date: string; type: string; description?: string }

/** One cheap live probe of the saved key — powers the Settings "Test key" button so a rejected key
 *  gets a precise diagnosis instead of a per-row error in the check grid. */
/** Obvious not-an-API-key values, caught before we ever call the API. An email getting in here is
 *  not hypothetical: a browser autofilled one into the old password-type field. */
export function companiesHouseKeyProblem(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (k.includes("@")) return "That looks like an email address, not an API key (your browser may have autofilled it). Paste the key from your Companies House application.";
  if (/\s/.test(k)) return "That value contains spaces — an API key has none. Copy just the key.";
  if (k.length < 20) return `That looks too short for a Companies House key (${k.length} characters; keys are ~36). Copy the whole key.`;
  return null;
}

export async function testCompaniesHouseKey(): Promise<{ ok: boolean; message: string }> {
  const key = dbGetSettings().companiesHouseKey.trim();
  if (!key) return { ok: false, message: "No API key saved yet." };
  const shape = companiesHouseKeyProblem(key);
  if (shape) return { ok: false, message: shape };
  try {
    const res = await fetch(`${API}/search/companies?q=stripe&items_per_page=1`, { headers: authHeaders(key), signal: AbortSignal.timeout(10000) });
    if (res.status === 401) return { ok: false, message: "Key rejected (401). Most common causes: the application was created in the SANDBOX environment (it must be Live), or it's a Stream key (it must be a REST key). Create a Live REST application and copy its key." };
    if (res.status === 429) return { ok: false, message: "Rate limited (429) — the key works but you've hit the 600-requests-per-5-minutes limit. Try again shortly." };
    if (!res.ok) return { ok: false, message: `Companies House replied HTTP ${res.status} — the key may be fine; try again shortly.` };
    return { ok: true, message: "Key works — the UK filings signal is live." };
  } catch { return { ok: false, message: "Couldn't reach Companies House — check your connection and try again." }; }
}

async function resolveCompanyNumber(company: string, key: string): Promise<{ number: string; title: string } | null> {
  const data = (await chGet(`/search/companies?q=${encodeURIComponent(company)}&items_per_page=10`, key)) as
    { items?: Array<{ company_number?: string; title?: string; company_status?: string }> } | null;
  for (const item of data?.items ?? []) {
    if (!item.company_number || !item.title) continue;
    if (item.company_status && item.company_status !== "active") continue;
    const t = stripSuffix(item.title);
    // Entity-to-entity: a CH title is a registered legal name, so the brand is a PREFIX of it
    // ("MONZO BANK LIMITED"), never buried mid-string. The free-text matcher used to accept any
    // registered name that merely contained the brand as a word.
    if (companyEntityMatches(company, t)) {
      return { number: item.company_number, title: item.title };
    }
  }
  return null;
}

export const companiesHouseProducer: SignalProducer = {
  key: "companieshouse",
  label: "UK filings (Companies House)",
  description: "New share-issue filings (SH01) at UK Companies House — the official UK fundraise proxy. Needs a free API key (Settings).",
  needsCompany: true,
  flagged: true,
  async check(domain, ctx): Promise<ProducerResult> {
    const key = dbGetSettings().companiesHouseKey.trim();
    if (!key) return { facts: { "Companies House": "no API key — add one in Settings" }, signals: [] }; // inert, fail closed
    if (companiesHouseKeyProblem(key)) return { facts: { "Companies House": "the saved API key looks wrong — re-check it in Settings" }, signals: [] };
    const company = (ctx.company ?? "").trim();
    if (!company) return { facts: { "Companies House": "no company name resolved" }, signals: [] };
    if (ctx.stop?.()) return { facts: {}, signals: [] };

    const prior = dbGetDomainState(domain, "companieshouse");

    // Cached resolution: number if we found one; a 7-day negative cache if we didn't (don't re-search
    // a non-UK company on every scan).
    let number = prior.get("companyNumber") ?? "";
    let chTitle = prior.get("companyTitle") ?? "";
    if (!number) {
      const noMatchAt = prior.get("noMatch");
      if (noMatchAt && Date.now() - new Date(noMatchAt).getTime() < RESEARCH_DAYS * 86400e3) {
        // Same answer as the live no-match exit below, so it says the same thing. Staying silent here
        // meant the flag was only ever written on the one scan in seven that actually re-searched.
        return { facts: { "Companies House": "no UK company match (re-checks weekly)" }, signals: [],
          flag: { hit: false, summary: "No UK company match" } };
      }
      let hit: { number: string; title: string } | null;
      try { hit = await resolveCompanyNumber(company, key); }
      catch (e) {
        if ((e as Error).message === "bad-key") return { facts: { "Companies House": "API key rejected — check it in Settings" }, signals: [] };
        return { facts: { "Companies House": "unavailable — will retry next scan" }, signals: [] }; // state untouched
      }
      if (!hit) {
        if (!ctx.readonly) dbReplaceDomainState(domain, "companieshouse", { noMatch: new Date().toISOString() });
        return { facts: { "Companies House": "no UK company match" }, signals: [], flag: { hit: false, summary: "No UK company match" } };
      }
      number = hit.number; chTitle = hit.title;
    }

    // Capital-category filing history; SH01 (share allotment) is the only signal-worthy form — other
    // capital filings still enter the baseline so they can never later fire as false "new" items.
    let items: ChFiling[] = [];
    try {
      const data = (await chGet(`/company/${encodeURIComponent(number)}/filing-history?category=capital&items_per_page=25`, key)) as
        { items?: ChFiling[] } | null;
      items = (data?.items ?? []).filter((f) => f.transaction_id);
    } catch (e) {
      if ((e as Error).message === "bad-key") return { facts: { "Companies House": "API key rejected — check it in Settings" }, signals: [] };
      return { facts: { "Companies House": "unavailable — will retry next scan" }, signals: [] }; // state untouched
    }

    const allotments = items.filter((f) => /^SH01/i.test(f.type ?? "")).sort((a, b) => (a.date < b.date ? 1 : -1));
    const facts: Record<string, string> = {
      "CH company": `${chTitle || company} (${number})`,
      "Share allotments": allotments.length ? `latest ${allotments[0]!.date}` : "none in filing history",
    };


    // Diff only against a baseline for the SAME company number — if the resolution ever changes,
    // re-baseline silently rather than emitting the new company's whole history.
    const sameCompanyBaseline = prior.size > 0 && prior.get("companyNumber") === number;
    const signals: SignalDraft[] = [];
    if (sameCompanyBaseline) {
      let n = 0;
      for (const f of allotments) {
        if (prior.has(`filed:${f.transaction_id}`)) continue;
        if (++n > MAX_SIGNALS) break;
        signals.push({
          dedupKey: `ch-share-allotment:${domain}:${f.transaction_id}`, type: "ch-share-allotment",
          title: `Share allotment (SH01) filed at Companies House — ${f.date}`,
          company: chTitle || company, observedAt: f.date || null,
          url: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(number)}/filing-history`,
          detail: { form: f.type, date: f.date, companyNumber: number, description: f.description ?? null },
        });
      }
    }
    // Built from what was EMITTED, not from every filing read — see the long note in news.ts. The
    // emit loop is capped at MAX_SIGNALS and the allotments are sorted NEWEST FIRST, so recording all
    // of them meant the sixth-newest new filing was marked seen without ever firing, and the OLDEST
    // new one was the one dropped. Not deferred: lost.
    const state: Record<string, string> = { companyNumber: number, companyTitle: chTitle };
    if (!sameCompanyBaseline) {
      // First scan for this company number (or the resolution changed): baseline everything and emit
      // nothing, rather than dumping a company's whole filing history into the feed.
      for (const f of items) state[`filed:${f.transaction_id}`] = f.type ?? "?";
    } else {
      // Everything already known stays known…
      for (const [k, v] of prior) if (k.startsWith("filed:")) state[k] = v;
      // …plus exactly the filings that went out this scan. A non-allotment filing is never emitted
      // and is remembered as soon as it is seen — only the capped allotment stream defers.
      for (const f of items) if (!/^SH01/i.test(f.type ?? "")) state[`filed:${f.transaction_id}`] = f.type ?? "?";
      for (const sig of signals) {
        const id = String(sig.dedupKey).split(":").pop();
        const f = allotments.find((x) => String(x.transaction_id) === id);
        if (f) state[`filed:${f.transaction_id}`] = f.type ?? "?";
      }
    }
    if (!ctx.readonly) dbReplaceDomainState(domain, "companieshouse", state); // readonly probe: don't consume the diff baseline

    const recentRaise = allotments.find((f) => Date.now() - new Date(f.date).getTime() < FLAG_MONTHS * 30 * 86400e3);
    return { facts, signals,
      flag: { hit: !!recentRaise, summary: recentRaise ? `UK share allotment ${recentRaise.date}` : "No recent UK share allotments" } };
  },
};
