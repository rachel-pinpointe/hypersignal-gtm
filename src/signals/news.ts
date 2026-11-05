// Company news via Google News RSS (free, no key): headlines for "<company>", keyword-classified
// into GTM-relevant classes — leadership change, expansion, layoffs, partnership, launch, funding.
// Facts = the recent news picture; signals = NEW post-baseline items of a classified type (the
// "other" bucket stays in facts but never signals — headline noise isn't a sales trigger).
import { createHash } from "node:crypto";
import { dbGetDomainState, dbReplaceDomainState, dbDomainCountries } from "../db.ts";
import { companyNameMatches } from "./company.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0)";
const WINDOW_DAYS = 45;
const MAX_SIGNALS = 5; // per scan — a press blitz shouldn't flood the feed

// Regional Google News editions queried in parallel — surfaces region-exclusive stories (a UK company's
// funding often only makes the UK edition). English editions only, so the CLASSES regexes stay valid.
const EDITIONS = [
  { gl: "US", hl: "en-US", ceid: "US:en" },
  { gl: "GB", hl: "en-GB", ceid: "GB:en" },
  { gl: "IN", hl: "en-IN", ceid: "IN:en" },
  { gl: "AU", hl: "en-AU", ceid: "AU:en" },
];
// Local-language editions, added only for the countries a company actually operates in (never all of
// them — that would be 20+ requests per company). A German company's funding round is usually reported
// first, and sometimes only, in German. The CLASSES table below carries the matching vocabularies.
const LOCAL_EDITIONS: Record<string, { gl: string; hl: string; ceid: string }> = {
  DE: { gl: "DE", hl: "de", ceid: "DE:de" }, AT: { gl: "AT", hl: "de", ceid: "AT:de" }, CH: { gl: "CH", hl: "de", ceid: "CH:de" },
  FR: { gl: "FR", hl: "fr", ceid: "FR:fr" }, BE: { gl: "BE", hl: "fr", ceid: "BE:fr" },
  ES: { gl: "ES", hl: "es", ceid: "ES:es" }, MX: { gl: "MX", hl: "es-419", ceid: "MX:es-419" },
  AR: { gl: "AR", hl: "es-419", ceid: "AR:es-419" }, CL: { gl: "CL", hl: "es-419", ceid: "CL:es-419" }, CO: { gl: "CO", hl: "es-419", ceid: "CO:es-419" },
  IT: { gl: "IT", hl: "it", ceid: "IT:it" }, NL: { gl: "NL", hl: "nl", ceid: "NL:nl" },
  PT: { gl: "PT", hl: "pt-PT", ceid: "PT:pt-150" }, BR: { gl: "BR", hl: "pt-BR", ceid: "BR:pt-419" },
  SE: { gl: "SE", hl: "sv", ceid: "SE:sv" }, NO: { gl: "NO", hl: "no", ceid: "NO:no" },
  DK: { gl: "DK", hl: "da", ceid: "DK:da" }, FI: { gl: "FI", hl: "fi", ceid: "FI:fi" },
  PL: { gl: "PL", hl: "pl", ceid: "PL:pl" }, TR: { gl: "TR", hl: "tr", ceid: "TR:tr" },
  JP: { gl: "JP", hl: "ja", ceid: "JP:ja" }, KR: { gl: "KR", hl: "ko", ceid: "KR:ko" },
  TW: { gl: "TW", hl: "zh-TW", ceid: "TW:zh-Hant" }, HK: { gl: "HK", hl: "zh-HK", ceid: "HK:zh-Hant" },
  AE: { gl: "AE", hl: "ar", ceid: "AE:ar" }, SA: { gl: "SA", hl: "ar", ceid: "SA:ar" }, EG: { gl: "EG", hl: "ar", ceid: "EG:ar" },
  IL: { gl: "IL", hl: "he", ceid: "IL:he" }, GR: { gl: "GR", hl: "el", ceid: "GR:el" },
  CZ: { gl: "CZ", hl: "cs", ceid: "CZ:cs" }, RO: { gl: "RO", hl: "ro", ceid: "RO:ro" }, HU: { gl: "HU", hl: "hu", ceid: "HU:hu" },
};
const MAX_LOCAL_EDITIONS = 3;
// Ceiling on stored baseline keys per domain, so carrying prior keys through a partial edition
// failure can't grow the row indefinitely. Each edition returns ~100 items × 2 keys, so 7 editions
// fit comfortably; the excess is old stories that have already aged out of the feed.
const NEWS_STATE_CAP = 2000;
// Cross-edition story key: the same story carries a DIFFERENT Google link per edition, so dedupe by
// normalized title too — lowercase, drop the trailing " - Source" suffix, strip non-alphanumerics.
export const normTitleKey = (title: string): string =>
  title.toLowerCase().replace(/\s+-\s+[^-]{2,60}$/, "").replace(/[^a-z0-9]+/g, " ").trim();

// Each class carries its English pattern followed by a local-language one, in the same priority slot,
// so a German or Japanese headline classifies exactly like its English equivalent. Without these the
// local editions above would fetch stories and then file every one of them under "other" (= no signal).
const CLASSES: Array<[string, RegExp]> = [
  ["news-leadership", /\b(appoints?|names?( \w+)? as|hires?|joins as|new (ceo|cfo|cmo|cro|coo|cto|chief \w+|vp |president)|promotes?|steps? down|departs?|resigns?)\b/i],
  ["news-leadership", /(ernennt|neuer? (ceo|cfo|geschäftsführer|vorstand)|tritt zurück|nomme|nouveau (ceo|directeur)|démissionne|nombra|nuevo (consejero|director)|dimite|nomina|nuovo amministratore|benoemt|nieuwe (ceo|directeur)|utser|udnævner|nimittää|powołuje|atar|就任|新社長|退任|사임|선임|يعين|رئيس تنفيذي جديد)/i],
  // "lays off" / "laid off" were missing — only "lay off"/"layoffs" matched, so the most common
  // headline phrasing ("Acme lays off 200 staff") fell through to "other" and never signalled.
  ["news-layoffs", /\b(lays? ?offs?|laid off|job cuts?|cuts \d+|restructur\w+|downsiz\w+|workforce reduction)\b/i],
  ["news-layoffs", /(entlass\w+|stellenabbau|kurzarbeit|licenci\w+|suppression de postes|despid\w+|recorte de empleo|licenzia\w+|esuberi|ontslag\w+|banenverlies|varsl\w+|uppsäg\w+|afskedig\w+|irtisano\w+|zwolnien\w+|işten çıkar\w+|人員削減|リストラ|解雇|정리해고|감원|تسريح)/i],
  ["news-funding", /\b(raises? \$|raises? \d+|series [a-e]\b|seed round|funding round|secures? \$|valuation)\b/i],
  ["news-funding", /(finanzierungsrunde|sammelt .{0,12}(millionen|mio)|kapitalerhöhung|lève .{0,20}fonds|lève .{0,12}(millions|m€)|levée de fonds|financement de|ronda de financiación|capta .{0,12}millones|round di finanziamento|raccoglie .{0,12}milioni|financieringsronde|haalt .{0,12}miljoen op|kapitalrunda|reser .{0,12}miljoner|rahoituskierros|runda finansowania|yatırım turu|資金調達|億円を調達|시리즈 [a-e]|투자 유치|جولة تمويل)/i],
  // Two regexes, not one: everything here is case-INSENSITIVE except "launches in <Country>", whose
  // capital letter is the whole heuristic (it separates "launches in Germany" from "launches in beta").
  // They used to share one case-sensitive class, so "Expands" at the start of a headline never matched.
  ["news-expansion", /\b(expands?|expansion|opens? (a )?(new )?(office|hq|headquarters|facility|plant)|enters? the \w+ market)\b/i],
  ["news-expansion", /\blaunches? in [A-Z]/],
  ["news-expansion", /(expandiert|eröffnet .{0,15}(büro|standort|werk)|neuer standort|s'implante|ouvre .{0,12}bureau|se expande|abre .{0,12}oficina|si espande|apre .{0,12}sede|opent .{0,12}kantoor|expanderar|laajentaa|ekspansja|genişliyor|進出|拠点を開設|해외 진출|توسع)/i],
  ["news-partnership", /\b(partners? with|partnership|teams? up with|collaborat\w+|integrat(es|ion) with|joint venture)\b/i],
  ["news-partnership", /(partnerschaft|kooperiert|zusammenarbeit mit|partenariat|s'associe à|alianza con|se asocia con|partnership con|collabora con|samenwerking met|samarbet\w+|kumppanuus|współpraca z|ortaklık|業務提携|パートナーシップ|협력|제휴|شراكة)/i],
  // `releases?` and `debuts?` are the two verbs here that are ALSO extremely common nouns, and both
  // were producing false launches in the live feed:
  //   "Webster Financial Corporation Announces Q2 2026 Earnings Release"  -> "product launch"
  //   "Beau Webster Debut and last played matches in Tests, ODIs, T20Is"  -> "product launch"
  // The second is a cricketer; the company is a bank. A GTM user acting on either wastes an outreach.
  // Lookbehinds exclude the financial/press collocations of "release"; the lookahead excludes the
  // sports/entertainment senses of "debut". Everything else in the group is verb-only and unambiguous.
  // "debut" is matched only where it is a VERB. A word list of non-product debuts was tried first and
  // is not enough — the real headline is "Beau Webster Debut and last played matches in Tests, ODIs",
  // where the noun is followed by "and", so no list of trailing nouns catches it. The verb forms are
  // "X debuts Y" and "X to/will/is set to debut Y"; a bare capitalised "Debut" is the noun and is out.
  ["news-launch", /\b(launches?|unveils?|introduces?|(?<!earnings )(?<!press )(?<!news )(?<!media )(?<!results )(?<!quarterly )(?<!annual )releases?|debuts(?! (album|single|novel|book|film|movie|match|season|series|tour|EP)\b)|(?:to|will|set to) debut|announces? (its |the )?(new )?\w+ (product|platform|feature|app|tool))\b/i],
  ["news-launch", /(stellt .{0,15}vor|bringt .{0,15}auf den markt|lanciert|lance .{0,15}(produit|plateforme|application)|dévoile|lanza .{0,15}(producto|plataforma)|presenta .{0,15}nuev|lancia|lanceert|lanserar|lancerer|julkaisee|wprowadza|tanıttı|を発表|新製品|출시|신제품|تطلق)/i],
];
/** Headline → signal type, or "news-other". Exported for the classify-table test. */
export const classify = (title: string): string => {
  for (const [type, re] of CLASSES) if (re.test(title)) return type;
  return "news-other";
};
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const unescapeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

interface NewsItem { title: string; link: string; date: string; source: string }
function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    const title = unescapeXml((/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block)?.[1] ?? "").trim());
    const link = (/<link>([\s\S]*?)<\/link>/.exec(block)?.[1] ?? "").trim();
    const date = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? "").trim();
    const source = unescapeXml((/<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1] ?? "").trim());
    if (title && link) items.push({ title, link, date, source });
  }
  return items;
}

export const newsProducer: SignalProducer = {
  key: "news",
  label: "Company news",
  description: "Google News headlines classified into leadership, funding, layoffs, expansion, partnership, launch.",
  needsCompany: true,
  flagged: true,
  async check(domain, ctx): Promise<ProducerResult> {
    const company = (ctx.company ?? "").trim();
    if (!company) return { facts: { News: "no company name resolved" }, signals: [] };
    // The four English editions, plus up to three local-language ones for the countries this company
    // actually operates in (its ccTLD + where it posts jobs).
    const local = dbDomainCountries(domain, company)
      .map((cc) => LOCAL_EDITIONS[cc]).filter((e): e is NonNullable<typeof e> => !!e).slice(0, MAX_LOCAL_EDITIONS);
    const editions = [...EDITIONS, ...local];
    // All editions in parallel; tolerate individual failures — only bail when EVERY edition fails.
    const fetchEdition = async (ed: (typeof EDITIONS)[number]): Promise<NewsItem[]> => {
      const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(`"${company}"`)}&hl=${ed.hl}&gl=${ed.gl}&ceid=${ed.ceid}`, {
        headers: { "User-Agent": UA }, signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseRss(await res.text());
    };
    const settled = await Promise.allSettled(editions.map(fetchEdition));
    const okBatches = settled.filter((s): s is PromiseFulfilledResult<NewsItem[]> => s.status === "fulfilled");
    if (!okBatches.length) {
      return { facts: { News: "feed unavailable — will retry next scan" }, signals: [] }; // state untouched
    }
    // Merge + dedupe across editions (link hash primary, normalized title secondary). Edition order is
    // preserved by allSettled, so the US variant of a syndicated story is the canonical survivor.
    const seenLink = new Set<string>(), seenTitle = new Set<string>();
    const items: NewsItem[] = [];
    for (const batch of okBatches) for (const i of batch.value) {
      const lk = hash(i.link), tk = hash(normTitleKey(i.title));
      if (seenLink.has(lk) || seenTitle.has(tk)) continue;
      seenLink.add(lk); seenTitle.add(tk); items.push(i);
    }
    const now = Date.now();
    // Window + relevance: the headline must mention the company as a WHOLE WORD/PHRASE, not a bare
    // substring — a short/stem name like "Box" or "Ramp" must not match "Dropbox" or "on-ramp".
    const recent = items.filter((i) => {
      const t = new Date(i.date).getTime();
      return (!i.date || (isFinite(t) && now - t <= WINDOW_DAYS * 86400e3)) && companyNameMatches(company, i.title);
    });
    const classed = recent.map((i) => ({ ...i, type: classify(i.title) }));
    const interesting = classed.filter((i) => i.type !== "news-other");

    // Facts LIST the actual classified headlines (title + link — the UI linkifies), not just a count.
    const facts: Record<string, string> = { [`News (${WINDOW_DAYS}d)`]: String(recent.length) };
    interesting.slice(0, 5).forEach((i, n) => {
      const cls = i.type.replace(/^news-/, "");
      facts[`${n + 1}. ${cls[0]!.toUpperCase() + cls.slice(1)}`] = `${i.title.slice(0, 110)} ${i.link}`;
    });

    // The edition set this scan actually read. It is no longer a constant: the local-language ones
    // come from dbDomainCountries, so it CHANGES mid-life the first time a company starts posting
    // jobs in a new country. _v alone only covered the one-time format bump.
    const edKey = editions.map((e) => e.ceid).sort().join(",");
    const prior = dbGetDomainState(domain, "news");
    // Baseline-format upgrade (v1→v2 added the GB/IN/AU editions, v2→v3 the local-language ones), OR
    // a change in which editions apply to this company: either way the stored baseline cannot contain
    // the new editions' items, so every one would read as "new" and flood the feed. Re-baseline
    // silently for one scan (same cost as any first scan).
    const upgrading = prior.size > 0 && (prior.get("_v") !== "3" || prior.get("_ed") !== edKey);
    const signals: SignalDraft[] = [];
    const draft = (i: (typeof interesting)[number], dedupKey: string): SignalDraft => {
      const t = new Date(i.date).getTime();
      return { dedupKey, type: i.type, title: i.title.slice(0, 140), company, url: i.link,
        observedAt: isFinite(t) ? new Date(t).toISOString() : null,
        detail: { source: i.source || null, class: i.type } };
    };
    if (ctx.snapshot) {
      // One-off CHECK: a snapshot of what's true now — emit the current classified items themselves
      // (check-scoped "newsnap:" keys so a later watchlist diff of the same story is never blocked).
      for (const i of interesting.slice(0, MAX_SIGNALS)) signals.push(draft(i, `newsnap:${domain}:${hash(i.link)}`));
    } else if (prior.size > 0 && !upgrading) {
      let n = 0;
      for (const i of interesting) {
        if (prior.has(`seen:${hash(i.link)}`) || prior.has(`t:${hash(normTitleKey(i.title))}`)) continue;
        if (++n > MAX_SIGNALS) break;
        signals.push(draft(i, `news:${domain}:${hash(i.link)}`));
      }
    }
    // THE BASELINE IS BUILT FROM WHAT WAS EMITTED, not from everything that was read.
    //
    // It used to be built from the full `classed` set BEFORE the capped emit loop ran. So on a scan
    // that classified nine interesting stories, five were emitted and all nine were written into the
    // baseline — and the other four could never fire, on that scan or any later one, because the next
    // scan's `prior.has(seen:…)` test skipped them. Not deferred: lost, permanently and silently.
    //
    // The exposure is concentrated exactly where the product is most useful: expeditors.com currently
    // holds 13 classified stories in its 45-day window against a per-scan ceiling of 5, and fedex.com
    // and gatewaycustomsbroker.com are similar. The longer the gap between scans, the more is dropped.
    //
    // Now: a first scan (or a format upgrade) still baselines EVERYTHING, which is the no-historical-
    // flood rule and is why a new domain does not dump a month of news into the feed. After that, the
    // baseline carries forward what it already knew and adds only what actually went out, so the
    // surplus stays unseen and drips out over the following scans.
    const state: Record<string, string> = { _v: "3", _ed: edKey };
    const remember = (i: (typeof classed)[number]) => {
      state[`seen:${hash(i.link)}`] = i.type;
      state[`t:${hash(normTitleKey(i.title))}`] = i.type;
    };
    if (prior.size === 0 || upgrading) {
      for (const i of classed) remember(i);   // baseline scan: everything, emit nothing
    } else {
      for (const s of signals) { const i = classed.find((c) => c.link === s.url); if (i) remember(i); }
      // Carry forward what was already known. This also subsumes the partial-edition case it used to
      // handle on its own: when an edition fails its stories are missing from `classed`, and replacing
      // the baseline wholesale would forget them and re-emit each one as "new" the moment that edition
      // recovers. Capped so repeated failures cannot grow the row without bound — this scan's keys go
      // in first, so the newest survive and the oldest drop, by which time they have aged out anyway.
      for (const [k, v] of prior) {
        if (Object.keys(state).length >= NEWS_STATE_CAP) break;
        if ((k.startsWith("seen:") || k.startsWith("t:")) && !(k in state)) state[k] = v;
      }
    }
    if (!ctx.readonly) dbReplaceDomainState(domain, "news", state); // readonly probe: don't consume the diff baseline
    // No `flag` from any exit, so dbSetDomainFlag was never called for "news" — 953 domains held a
    // news baseline and none held a news flag, while the UI's PRODUCER_LABELS promised a "News" chip
    // that could never render. (dns and subdomains had the identical defect; all three are fixed
    // together, and techStack.ts carried it before them.)
    //
    // `hit` counts only the CLASSIFIED headlines, never `recent.length`. Google News returns
    // something for almost any company name, so "has coverage" is true nearly everywhere; a story
    // that classified as funding / launch / expansion / leadership / partnership / layoffs is the
    // part a seller can act on, and it is what news-other exists to exclude.
    return { facts, signals,
      flag: { hit: interesting.length > 0,
        summary: interesting.length
          ? `${interesting.length} story${interesting.length === 1 ? "" : "s"} in ${WINDOW_DAYS}d — ${interesting[0]!.title.slice(0, 80)}`
          : `no notable stories in ${WINDOW_DAYS}d` } };
  },
};
