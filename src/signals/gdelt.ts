// Global funding news via GDELT DOC 2.0 (free, no key) — catches funding coverage in regional and
// non-English press (German/French/Japanese trade media…) that the Google News English editions miss.
// Recall comes from funding-intent terms in the API query; PRECISION comes from our own two-part
// filter: the title must (a) mention the company as a whole word and (b) match a funding-keyword /
// currency-amount pattern. Same baseline-diff contract as the news producer.
import { createHash } from "node:crypto";
import { dbGetDomainState, dbReplaceDomainState } from "../db.ts";
import { companyNameMatches } from "./company.ts";
import { normTitleKey } from "./news.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0)";
const MAX_SIGNALS = 5;
const STATE_CAP = 400;   // bounds the carried-forward article memory (see the `_v` note below)
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// GDELT allows ONE request per ~5s per IP (a 200 text page otherwise). Serialize all calls through a
// promise chain with a 5.2s gap so bulk checks across many domains queue instead of getting limited.
// PACE_MS is what this producer declares about itself, and it is a constant on purpose: it is what
// routes GDELT into the background queue instead of the scan's critical path (see types.ts `paceMs`).
// GAP_MS is only how long we actually sleep, and it is overridable ONLY so the test suite doesn't pay
// a real 5.2s per stubbed call (four calls = 21s asleep for nothing).
//
// These were one value until a test caught it: with GDELT_GAP_MS=0 the declared pace also became 0,
// which is falsy, which would have put GDELT back inline in the serial scan — the exact bug this
// whole queue exists to fix, silently reintroduced by an env var meant for tests.
// Never lower the real gap against the live API: GDELT answers with a 200 HTML limiter page, not a
// 429, so over-calling looks like success and quietly returns no articles.
const PACE_MS = 5200;
const GAP_MS = Number(process.env.GDELT_GAP_MS ?? PACE_MS);
let gdeltQueue: Promise<unknown> = Promise.resolve();
let gdeltLastCall = 0;
function gdeltSerial<T>(task: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = gdeltLastCall + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gdeltLastCall = Date.now();
    return task();
  };
  const r = gdeltQueue.then(run, run);
  gdeltQueue = r.then(() => {}, () => {});
  return r as Promise<T>;
}

// The API query is JUST the quoted company name: long OR-joined intent queries trip GDELT's
// "larger query" throttle, and English-only intent terms would exclude the non-English articles this
// producer exists to catch. All funding filtering happens client-side (FUNDING_RE below).
// Multilingual-lite precision filter applied to titles after the fact.
// Word-boundary alternation for scripts that have word boundaries, plus a separate no-boundary
// alternation for the ones that don't (CJK/Arabic/Hebrew write 資金調達 with no spaces around it, so
// \b would never fire), plus any currency amount. Widened well past the original 4 languages —
// GDELT's whole reason for existing here is the non-English press.
const FUNDING_RE = new RegExp([
  String.raw`\b(raises?|raised|funding|investment|invests?|series\s+[a-e]\b|seed\s+(round|funding)|valuation`,
  String.raw`|levée de fonds|lève des fonds|financement|finanzierung(srunde)?|kapitalerhöhung|finanzspritze`,
  String.raw`|financiación|ronda de inversión|capta|raccolta fondi|round di finanziamento|finanziamento`,
  String.raw`|financieringsronde|investeringsronde|kapitalrunda|emisjonen|rahoituskierros|runda finansowania`,
  String.raw`|rodada de investimento|captação|yatırım turu|sermaye artırımı)\b`,
  String.raw`|(資金調達|億円|調達|投資ラウンド|시리즈|투자 유치|융자|融资|轮融资|募資|جولة تمويل|تمويل|استثمار|גיוס)`,
  String.raw`|[€£$¥₹₪₺]\s?\d|\d+\s?(million|billion|mn|bn|m€|crore|lakh|億円?|万円)`,
].join(""), "i");
/** Does this headline look like a funding story, in any of the languages GDELT indexes? Exported for
 *  the classify-table test — this regex is the entire precision half of the producer. */
export const looksLikeFunding = (title: string): boolean => FUNDING_RE.test(title);

interface GdeltArticle { url?: string; title?: string; seendate?: string; sourcecountry?: string; language?: string; domain?: string }

// seendate is YYYYMMDDTHHMMSSZ → ISO.
const seendateToIso = (d: string | undefined): string | null =>
  d && /^\d{8}T\d{6}Z$/.test(d)
    ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`
    : null;

export const gdeltProducer: SignalProducer = {
  key: "gdelt",
  label: "Global funding news (GDELT)",
  description: "Funding headlines from GDELT's worldwide news index — regional and non-English press the Google News editions miss. Free, no key.",
  needsCompany: true,
  paceMs: PACE_MS,   // scheduled scans queue this producer instead of waiting on it — see types.ts
  // Funding coverage does not change hour to hour, and at one lookup per 5.2s a 1,300-domain
  // watchlist is 82 minutes of continuous draining. Re-asking weekly is what lets the queue reach
  // the end of the list at all — see dbEnqueueSlow.
  recheckDays: 7,
  flagged: true,
  async check(domain, ctx): Promise<ProducerResult> {
    const company = (ctx.company ?? "").trim();
    if (!company) return { facts: { GDELT: "no company name resolved" }, signals: [] };
    if (ctx.stop?.()) return { facts: {}, signals: [] };

    let articles: GdeltArticle[] = [];
    try {
      articles = await gdeltSerial(async () => {
        const res = await fetch(
          `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${company}"`)}&mode=artlist&maxrecords=50&format=json&sort=datedesc&timespan=45d`,
          { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // GDELT returns its rate-limit/error pages WITH status 200 — never res.json() directly.
        const text = await res.text();
        let data: { articles?: GdeltArticle[] };
        try { data = JSON.parse(text); }
        catch {
          // Their limiter page: back the whole queue off a minute so a bulk check doesn't burn every
          // remaining domain into the same wall, and report the cause precisely.
          if (/limit requests|please limit/i.test(text)) { gdeltLastCall = Date.now() + 60000; throw new Error("rate-limited"); }
          throw new Error("non-JSON response");
        }
        return Array.isArray(data?.articles) ? data.articles : [];
      });
    } catch (e) {
      // This catch swallows EVERYTHING — HTTP errors, the 12s timeout, DNS failures, malformed JSON —
      // and returns normally, so the caller's own catch (index.ts / signalCheck.ts) never fires and
      // nothing reaches the log. A GDELT outage was therefore invisible from the server side: the only
      // trace was one cell in a check grid. Log it here, since nobody downstream can.
      const msg = (e as Error).message;
      const limited = msg === "rate-limited";
      console.warn(`[gdelt] ${domain} (${company}): ${msg}`);
      return { facts: { GDELT: limited ? "rate-limited by GDELT — backing off a minute, will retry" : `feed unavailable (${msg}) — will retry next scan` }, signals: [] }; // state untouched
    }

    // Precision filter + in-batch dedupe (GDELT is heavily syndicated — same wire story on 20 domains).
    const seenUrl = new Set<string>(), seenTitle = new Set<string>();
    const matched: GdeltArticle[] = [];
    for (const a of articles) {
      const title = String(a.title ?? ""), url = String(a.url ?? "");
      if (!title || !url) continue;
      if (!companyNameMatches(company, title) || !FUNDING_RE.test(title)) continue;
      const uk = hash(url), tk = hash(normTitleKey(title));
      if (seenUrl.has(uk) || seenTitle.has(tk)) continue;
      seenUrl.add(uk); seenTitle.add(tk); matched.push(a);
    }

    // Facts LIST the actual matched headlines (title + link — the UI linkifies), not just a count.
    const facts: Record<string, string> = { "GDELT funding (45d)": String(matched.length) };
    matched.slice(0, 5).forEach((a, n) => {
      const where = a.sourcecountry ? ` (${a.sourcecountry})` : "";
      facts[`${n + 1}. Funding${where}`] = `${String(a.title).slice(0, 110)} ${String(a.url)}`;
    });

    // `_v` is a SENTINEL, and it is what makes this producer work at all. Without it, a scan that
    // matched no funding story wrote an EMPTY state — and dbReplaceDomainState deletes every key for
    // the (domain, producer) when handed an empty object. Funding news is rare, so almost every scan
    // is a zero-match scan, so the baseline was wiped almost every time, so `prior.size > 0` below was
    // almost never true, so the diff branch never ran and GDELT emitted a feed signal for essentially
    // no domain ever. It was not "GDELT has no data": it was this producer erasing its own memory.
    // (Measured on a 953-domain watchlist: news held a baseline for 953 domains, GDELT for 1.)
    // news.ts already carries `_v`/`_ed` for the same reason; this is the same contract.
    const prior = dbGetDomainState(domain, "gdelt");
    const signals: SignalDraft[] = [];
    const draft = (a: GdeltArticle, dedupKey: string): SignalDraft => ({
      dedupKey, type: "gdelt-funding",
      title: String(a.title).slice(0, 140), company, url: String(a.url),
      observedAt: seendateToIso(a.seendate),
      detail: { sourceCountry: a.sourcecountry || null, language: a.language || null, source: a.domain || null },
    });
    if (ctx.snapshot) {
      // One-off CHECK snapshot: emit the current matched items (check-scoped keys — see news.ts).
      for (const a of matched.slice(0, MAX_SIGNALS)) signals.push(draft(a, `gdeltsnap:${domain}:${hash(String(a.url))}`));
    } else if (prior.size > 0) {
      let n = 0;
      for (const a of matched) {
        if (prior.has(`seen:${hash(String(a.url))}`) || prior.has(`t:${hash(normTitleKey(String(a.title)))}`)) continue;
        if (++n > MAX_SIGNALS) break;
        signals.push(draft(a, `gdelt-funding:${domain}:${hash(String(a.url))}`));
      }
    }
    // Built from what was EMITTED, not from everything read — see the long note in news.ts. The emit
    // loop is capped at MAX_SIGNALS, and marking the surplus as seen did not defer it, it lost it:
    // the next scan's `prior.has(seen:…)` test skips anything recorded here, forever.
    const state: Record<string, string> = { _v: "1" };
    const remember = (a: GdeltArticle) => {
      state[`seen:${hash(String(a.url))}`] = "1";
      state[`t:${hash(normTitleKey(String(a.title)))}`] = "1";
    };
    if (prior.size === 0) {
      for (const a of matched) remember(a);   // baseline scan: everything, emit nothing
    } else {
      for (const sig of signals) { const a = matched.find((m) => String(m.url) === sig.url); if (a) remember(a); }
      // Carry prior article keys forward (newest wins, capped). The API window is 45 days, so a story
      // already reported drops out of `matched` once it ages out — and would then re-fire as "new" if
      // GDELT re-indexed it, or if a syndicated copy surfaced later under a different URL.
      for (const [k, v] of prior) {
        if (Object.keys(state).length >= STATE_CAP) break;
        if ((k.startsWith("seen:") || k.startsWith("t:")) && !(k in state)) state[k] = v;
      }
    }
    if (!ctx.readonly) dbReplaceDomainState(domain, "gdelt", state); // readonly probe: don't consume the diff baseline

    return { facts, signals,
      flag: { hit: matched.length > 0, summary: matched.length ? `Funding coverage: ${String(matched[0]!.title).slice(0, 60)}` : "No recent funding coverage" } };
  },
};
