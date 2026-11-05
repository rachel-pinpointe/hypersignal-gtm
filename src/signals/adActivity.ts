// Meta ad activity — is the company running ads right now? Source: the PUBLIC Ad Library page
// (facebook.com/ads/library — viewable without any account; the technique OSS scrapers use).
// A plain HTTP fetch gets a 403, so this rides the app's existing fingerprinted Playwright stack
// (src/sources/browser.ts) exactly like the hiring.cafe browser lane: real fingerprint, own
// residential IP, strictly serial, fail-soft — any failure reports "unavailable" and never breaks
// a run or touches stored state. Diffs → ads-started / ads-stopped.
//
// The measurement is PAGE-SCOPED, and that is the whole design. This producer first proves which
// Meta advertiser page belongs to the domain (see ./metaPage.ts — the brand's own site names its
// Facebook handle, and Meta's typeahead names each page's handle, so the two can be matched by
// identity) and only then counts that page's ads. It used to run a keyword search for the company
// name and report the hit count, which answers "how many ads mention this phrase" — a question with
// a very different answer. On the live data that read 49% of every watched domain as an active
// advertiser and pinned 43 of them at the Ad Library's 50,000-result ceiling.
//
// When the page cannot be proved, this producer says so and returns no flag. It never falls back to
// the keyword count. A quiet "we don't know" is worth more than a confident wrong number.
import { runPage } from "../sources/browser.ts";
import { dbGetDomainState, dbReplaceDomainState, dbGetSettings } from "../db.ts";
import { resolveAdvertiserPage, type SiteHandles } from "./metaPage.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const TTL_HOURS = 12;        // a browser session per domain is heavy — don't re-check within the window
const PAGE_TIMEOUT = 30000;
// How the stored reading was taken. Part of the comparison basis alongside the region: a keyword
// count and a page-scoped count are not the same measurement, so a row written by the old method is
// re-baselined rather than diffed against. Bump this whenever the measurement itself changes.
const METHOD = "page";
// The Ad Library stops counting at 50,000 and renders "~50,000 results" for anything above it. That
// number is a CEILING, not a measurement, and it means the keyword search matched so much of the
// library that nothing about this company can be read from it. Measured on the live data: 43 domains
// held exactly 50000 — among them a2a-logistics.com, aacb.com and americanbearlogistics.com, none of
// which is running fifty thousand adverts. Each was flagged "running ads" on the Companies view and
// showed "50000 active Meta ads" as though it were a fact.
const RESULT_CAP = 50000;

// Strictly serial: one Ad Library browser session at a time (politeness + the pool is shared
// with hiring.cafe fallbacks).
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const r = queue.then(task, task);
  queue = r.then(() => {}, () => {});
  return r as Promise<T>;
};

// The Ad Library region we search. "ALL" = worldwide, which is the default: the old hardcoded US
// scope recorded a real "no ads" verdict for every company advertising only in its own market (a
// German advertiser looked like a non-advertiser, and could never fire ads-started). Probed live:
// country=ALL is accepted and returns the worldwide count (Zalando ~5,100 vs ~84 under US).

/** The regions offered in the UI. ONE list, served to the browser via /api/signals/ad-regions, so
 *  the Settings default and the per-check picker can never drift apart. */
export const AD_REGIONS: Array<{ code: string; label: string }> = [
  { code: "ALL", label: "Worldwide (recommended)" },
  { code: "US", label: "United States only" }, { code: "GB", label: "United Kingdom only" },
  { code: "CA", label: "Canada only" }, { code: "AU", label: "Australia only" },
  { code: "DE", label: "Germany only" }, { code: "FR", label: "France only" },
  { code: "NL", label: "Netherlands only" }, { code: "ES", label: "Spain only" },
  { code: "IT", label: "Italy only" }, { code: "SE", label: "Sweden only" },
  { code: "PL", label: "Poland only" }, { code: "IE", label: "Ireland only" },
  { code: "IN", label: "India only" }, { code: "SG", label: "Singapore only" },
  { code: "AE", label: "United Arab Emirates only" }, { code: "BR", label: "Brazil only" },
  { code: "MX", label: "Mexico only" }, { code: "JP", label: "Japan only" },
  { code: "ZA", label: "South Africa only" },
];
/** A region code we're willing to send to the Ad Library, or null. Anything unrecognised is dropped
 *  rather than passed through — a bad code would silently narrow the search to nothing. */
export function normalizeAdRegion(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase();
  return AD_REGIONS.some((r) => r.code === s) ? s : null;
}
/** Region for THIS run: the per-check override when given, else the saved Settings default. */
const adScope = (override?: string): string =>
  normalizeAdRegion(override) ?? (dbGetSettings().adCountry || "ALL").toUpperCase();
const scopeLabel = (cc: string) => (cc === "ALL" ? "worldwide" : cc);

/**
 * The Ad Library URL for ONE advertiser's own ads — also emitted as each signal's source link, so
 * the link a user clicks shows exactly what was counted.
 *
 * search_type=page + view_all_page_id is the whole fix. The old URL was a keyword search
 * (q="<company>", search_type=keyword_unordered), which returns every advertiser whose ad copy
 * contains the phrase. That is a different question from "is this company advertising", and the
 * stored answers showed it: 43 domains at the 50,000-result ceiling and 49% of everything watched
 * flagged as an active advertiser.
 */
export const adLibraryPageUrl = (pageId: string, cc = "ALL") =>
  `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${encodeURIComponent(cc)}&view_all_page_id=${encodeURIComponent(pageId)}&search_type=page&media_type=all`;

export const CEILING_NOTE = `too many matches to count — the search hit the Ad Library's ${RESULT_CAP.toLocaleString("en-US")}-result ceiling, so this name is too common a phrase to measure this way`;

/**
 * Turn the Ad Library page's rendered text into a reading. Pure and exported because this is where
 * the number the whole producer rests on is actually decided, and welded inside a Playwright
 * callback there was no way to test it — which is how 43 domains came to hold "50000 active ads".
 *
 * `count: null` means UNMEASURABLE, and every caller must treat it as such: no flag, no state write,
 * no transition. It is not the same as 0.
 */
export function parseAdReading(text: string): { count: number | null; note: string } {
  // "~1,234 results" / "1,234 results" — the count header. "0 results" renders as "No ads match".
  const m = /[~≈]?\s*([\d,.]+)\s+results?/i.exec(text);
  if (m) {
    const n = Number(m[1]!.replace(/[,.]/g, ""));
    // The ceiling is not a count. Meta stops counting at 50,000 and renders "~50,000 results" for
    // anything at or above it, which means the keyword search matched a large slice of the entire
    // library and nothing in it is evidence about this company. Reading it as a measurement put
    // a2a-logistics.com and americanbearlogistics.com on the Companies view as heavy advertisers.
    if (n >= RESULT_CAP) return { count: null, note: CEILING_NOTE };
    return { count: n, note: "result header" };
  }
  if (/no ads match|no results found/i.test(text)) return { count: 0, note: "explicit empty" };
  // Fallback: count ad cards via Library-ID markers in the DOM text.
  const ids = (text.match(/Library ID:?\s*\d+/gi) ?? []).length;
  if (ids > 0) return { count: ids, note: "card count (page 1 — lower bound)" };
  if (/log in|create new account/i.test(text) && text.length < 2000) return { count: null, note: "login wall" };
  return { count: null, note: "unrecognized page" };
}

/** Load ONE advertiser's Ad Library page and read the active-ad picture from the rendered DOM. */
async function adLibraryCount(pageId: string, cc: string): Promise<{ count: number | null; note: string }> {
  const url = adLibraryPageUrl(pageId, cc);
  return runPage({ site: "metaads", timeoutMs: PAGE_TIMEOUT }, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(4500); // results hydrate client-side
    return parseAdReading(await page.evaluate(() => document.body?.innerText ?? ""));
  });
}

export const adActivityProducer: SignalProducer = {
  key: "ads",
  label: "Meta ad activity",
  description: "Is the company running Facebook/Instagram ads right now? Public Ad Library page, no account. Slower (real browser).",
  needsCompany: true,
  flagged: true,
  async check(domain, ctx): Promise<ProducerResult> {
    const company = (ctx.company ?? "").trim();
    if (!company) return { facts: { "Meta ads": "no company name resolved" }, signals: [] };
    if (ctx.stop?.()) return { facts: {}, signals: [] };

    const cc = adScope(ctx.adCountry);
    const prior = dbGetDomainState(domain, "ads");
    // A reading only compares against a reading taken under the SAME region. If the scope changed
    // (default flipped US → worldwide, or the user picked a country), the stored history describes a
    // different question, so we re-baseline: measure, store, emit nothing this round.
    const priorScope = prior.get("scope") ?? "US"; // rows written before this setting existed were US
    // The METHOD is part of the basis too, exactly like the region. Everything stored before this
    // producer resolved an advertiser page came from a keyword search — "ads whose copy mentions
    // this name", not "ads by this company" — so it is not comparable to a page-scoped reading and
    // must not be diffed against one. Treating it as comparable would fire an ads-stopped for every
    // company whose old keyword count was inflated, which on this data was most of them.
    const sameScope = priorScope === cc && prior.get("method") === METHOD;
    const checkedAt = prior.get("_checked");
    const cachedActive = Number(prior.get("active") ?? 0);
    // The cap guard has to hold on the CACHED path too, not only on a fresh reading. Rows written
    // before that guard existed still hold 50000, and this branch would keep serving one as a fact
    // for another 12 hours and re-assert the flag from it.
    if (sameScope && checkedAt && cachedActive < RESULT_CAP
        && Date.now() - new Date(checkedAt).getTime() < TTL_HOURS * 3600e3) {
      const n = cachedActive;
      return { facts: { "Meta ads": `${n} active (${scopeLabel(cc)}, checked <${TTL_HOURS}h ago)` }, signals: [],
        flag: { hit: n > 0, summary: n > 0 ? `${n} active Meta ads` : "no active Meta ads" } };
    }

    // ---- Which advertiser are we measuring? ----
    // A cached page id is reused; the resolution costs a site fetch plus a typeahead call and a
    // company's Facebook page does not move. Nothing else is cached, so a wrong id is bounded by
    // the same identity check that produced it.
    let pageId = prior.get("pageId") ?? "";
    let pageName = prior.get("pageName") ?? "";
    let via = prior.get("pageVia") ?? "";
    let handles: SiteHandles | null = null;
    if (!pageId) {
      let r;
      try { r = await serial(() => resolveAdvertiserPage(domain, company, cc === "ALL" ? "US" : cc)); }
      catch (e) {
        // A MetaSignatureError means Meta renamed the typeahead query and NOTHING can be matched
        // until that is updated. It must read as broken, not as "this company has no page".
        return { facts: { "Meta ads": `advertiser matching unavailable — ${(e as Error).message.slice(0, 120)}` }, signals: [] };
      }
      handles = r.handles;
      if (!r.page) {
        // No provable page. This is the branch that replaces the old keyword count, and it returns
        // NO FLAG on purpose: "we could not identify their advertiser page" is not "they run no
        // ads". Roughly half of small B2B companies link no social profile at all, and guessing
        // from the name is precisely what produced 43 domains at the result ceiling.
        const why = !handles.fetched ? "their website could not be read"
          : (!handles.facebook && !handles.instagram) ? "their website links no Facebook or Instagram profile"
          : "no Ad Library advertiser page matches the profile their website links to";
        // no-flag: without an advertiser page nothing about their advertising was read at all, so
        // "no ads" would be an invention. This is the "could not determine" contract in ./types.ts.
        return { facts: { "Meta ads": `no advertiser page identified — ${why}` }, signals: [] };
      }
      pageId = r.page.pageId; pageName = r.page.name; via = r.via;
    }

    let result: { count: number | null; note: string };
    try { result = await serial(() => adLibraryCount(pageId, cc)); }
    catch (e) { return { facts: { "Meta ads": `unavailable (${(e as Error).message.split("\n")[0]!.slice(0, 40)})` }, signals: [] }; }
    if (result.count == null) {
      // Page shape changed / wall — report honestly, leave state untouched (no fake stop signals).
      return { facts: { "Meta ads": `unavailable (${result.note})` }, signals: [] };
    }

    // A zero under a COUNTRY-SCOPED search is not a verdict: the company may advertise heavily
    // elsewhere. no-flag: undetermined, per the indeterminate contract in ./types.ts — and
    // no baseline write, so a later worldwide reading can't look like "they just started".
    if (result.count === 0 && cc !== "ALL") {
      return { facts: { "Meta ads": `none active in ${cc} — other regions not checked` }, signals: [] };
    }

    // The current active-ad count is a real measurement — that's the reliable value, shown as a fact.
    const facts: Record<string, string> = {
      "Meta ads": result.count > 0 ? `${result.count} active (${scopeLabel(cc)})` : "none active (worldwide)",
      // Name the advertiser that was actually counted. The count is only as good as the page it
      // came from, so the page is shown beside it rather than left implicit.
      "Meta advertiser": `${pageName || pageId}${via ? ` (matched by their ${via === "fb" ? "Facebook" : "Instagram"} handle)` : ""}`,
    };

    // Transition signals only fire on a CONFIRMED change of on/off state — never on a single reading.
    // "off" only counts once we've seen 0 on two consecutive checks, so a flaky/partial "0 results"
    // render (or the very first scan) can never masquerade as "they had none, now they started". We
    // track the ESTABLISHED status and emit only when it genuinely flips.
    const curStatus = result.count > 0 ? "on" : "off";
    const priorStatus = sameScope ? prior.get("status") : undefined;
    const priorConfirm = sameScope ? Number(prior.get("confirm") ?? 0) : 0;
    // "" on a scope change: the old established verdict was measured under a different region, so it
    // must not be compared against this one (that is exactly what would fire a bogus ads-started).
    const priorEstablished = sameScope ? prior.get("established") : ""; // "on" | "off" | undefined (not yet established)
    const confirm = curStatus === priorStatus ? priorConfirm + 1 : 1;
    const established = confirm >= 2 ? curStatus : (priorEstablished ?? "");
    const state: Record<string, string> = {
      _checked: new Date().toISOString(), active: String(result.count), scope: cc, method: METHOD,
      status: curStatus, confirm: String(confirm), established,
      pageId, pageName, pageVia: via,
      ...(handles?.facebook ? { fb: handles.facebook } : {}),
      ...(handles?.instagram ? { ig: handles.instagram } : {}),
    };
    const signals: SignalDraft[] = [];
    if (priorEstablished && established && established !== priorEstablished) {
      const month = new Date().toISOString().slice(0, 7);
      if (established === "on") {
        signals.push({
          dedupKey: `ads-started:${domain}:${month}`, type: "ads-started",
          title: `Now running Meta ads (${result.count} active) — none at the previous checks`, company,
          url: adLibraryPageUrl(pageId, cc), detail: { active: result.count, advertiser: pageName, pageId },
        });
      } else {
        signals.push({
          dedupKey: `ads-stopped:${domain}:${month}`, type: "ads-stopped",
          title: `No active Meta ads — was running some at the previous checks`, company,
          url: adLibraryPageUrl(pageId, cc), detail: { active: 0, advertiser: pageName, pageId },
        });
      }
    }
    if (!ctx.readonly) dbReplaceDomainState(domain, "ads", state); // readonly probe: don't consume the diff baseline
    return { facts, signals,
      flag: { hit: result.count > 0, summary: result.count > 0 ? `${result.count} active Meta ads (${scopeLabel(cc)})` : "no active Meta ads worldwide" } };
  },
};
