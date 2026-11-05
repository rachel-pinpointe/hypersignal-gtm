// App presence — does the company ship a mobile app, and is it alive?
//   • iOS via Apple's official FREE iTunes Search API (no key): app + seller match, last-update date.
//   • Android via a public Google Play search-page probe (best-effort; fail-soft).
// Facts = current apps + freshness; diffs → app-published (a new app appearing after baseline) and
// app-stale (>18 months without an update — a dying app is a signal too, month-bucketed dedup).
import { dbGetDomainState, dbReplaceDomainState, dbDomainCountries } from "../db.ts";
import { companyEntityMatches } from "./company.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const STALE_MONTHS = 18;
const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0)";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Play's no-JS payload mixes app titles and developer names into the same aria-labels, so unlike
 *  the App Store there is no seller field to test. Word-bounded containment is the most this
 *  evidence supports — it is weaker than the iOS check and deliberately so. */
const labelNamesCompany = (label: string, company: string): boolean => {
  const c = norm(company);
  if (c.length < 4) return false;                       // same floor the name matchers use
  return new RegExp(`(^| )${c.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}( |$)`).test(norm(label));
};

/**
 * WHICH Android app the "has an Android app" verdict was standing on.
 *
 * The Android arm used to store the string "1" and nothing else, so the claim had nothing behind it:
 * no package, no name, no link. The iOS arm stores the id, title and URL, which is the only reason a
 * later pass could re-check 65 iOS attributions against Apple and find 20 of them wrong — a freight
 * forwarder credited with a church app, a basketball app, a Target retail app, an undead-defense
 * game. The 46 Android attributions could not be checked at all; the repair script had to report the
 * number and move on. A verdict whose evidence was discarded cannot be audited, only believed.
 *
 * The package id is the right thing to keep, and the live page says why: searching "C.H. Robinson"
 * returns com.chrobinson.navispherecarrier 57 characters from the label "Navisphere Carrier". The id
 * names the company itself, it is stable, and it addresses a details page a later check can fetch.
 *
 * Prefer an id whose dotted segments name the company, using the same word-bounded, length-floored
 * test the label match uses. Otherwise fall back to the first result — which is what the hit was
 * already resting on — and SAY SO in `basis`, because "the package names the company" and "it was
 * top of the search page" are not equally good evidence and must not become indistinguishable once
 * they are both just a row in the database.
 *
 * Exported so the test exercises this rule rather than a copy of it, as pickCompanyApp is below.
 */
export interface AndroidPick { id: string; url: string; label?: string; basis: string }
export function pickAndroidPackage(company: string, html: string, labels: string[]): AndroidPick | null {
  const ids = [...new Set([...html.matchAll(/\/store\/apps\/details\?id=([A-Za-z0-9_.]+)/g)].map((m) => m[1]!))];
  const named = ids.find((id) => id.split(".").some((seg) => labelNamesCompany(seg, company)));
  const id = named ?? ids[0];
  if (!id) return null;
  const label = labels.find((l) => labelNamesCompany(l, company));
  return { id, url: `https://play.google.com/store/apps/details?id=${id}`, ...(label ? { label } : {}),
    basis: named ? "package names the company" : "first result on the search page" };
}

/** Shape of an iTunes Search result, narrowed to the fields ownership is decided on. */
export interface StoreApp { trackName: string; sellerName: string }

/**
 * Which search result, if any, is THIS company's app.
 *
 * Exported and called from check() rather than written inline, so a test exercises the real rule.
 * The first version of the test reproduced this logic instead of importing it, and gutting the
 * matcher in the source to `filter(() => true)` left all 213 tests green — a test that mirrors the
 * code it is meant to guard is not a guard.
 *
 * OWNERSHIP IS A PROPERTY OF THE SELLER, NOT OF THE APP'S TITLE. The rule used to accept a result on
 * any of three arms — seller contains the company, company contains the seller, or the app NAME
 * starts with the company — none word-bounded and none with a length floor. Of the 14 app-stale
 * signals on the live feed, 10 were about an unrelated app (verified against the live API):
 *
 *   Airgroup (freight)         -> "Airgroup: All In One Gym"  by HOTSOFT TECHNOLOGY
 *   Fcbf (customs brokers)     -> "FCBF Church"               by CHRISTIAN FREEDOM BIBLE FELLOWSHIP
 *   Compass Forwarding         -> "Compass & Altimeter"       by an individual
 *   Counselor                  -> "ASCA School Counselor"     by American School Counselor Association
 *
 * The app-name arm is gone: anyone may call an app anything, so its title is not evidence of who
 * published it. Only the seller is, and that is a name-vs-name question — companyEntityMatches, the
 * same test EDGAR and Companies House use, bringing a length floor, legal-suffix stripping and
 * word-bounded prefix semantics.
 *
 * Then take the CLOSEST seller, not the first that matches. The prefix rule holds in both directions,
 * so a shorter related entity also qualifies: "NTT DATA Business Solutions" matched "NTT DATA Inc",
 * which the API returns first, over "NTT DATA Business Solutions AG", the actual publisher.
 */
export function pickCompanyApp<T extends StoreApp>(company: string, results: T[]): T | undefined {
  const cn = norm(company);
  return results
    .filter((r) => companyEntityMatches(company, r.sellerName ?? ""))
    .sort((a, b) => Math.abs(norm(a.sellerName ?? "").length - cn.length)
                  - Math.abs(norm(b.sellerName ?? "").length - cn.length))[0];
}

/** Storefronts to search for one company: its own countries (ccTLD + job locations) first, then US.
 *  Both stores are per-country catalogues — a German-only app is simply absent from the US
 *  storefront, and searching only US recorded that as "no app". Capped at 3 so a check stays cheap. */
function storefronts(domain: string, company: string): { fronts: string[]; hinted: boolean } {
  const hints = dbDomainCountries(domain, company);
  const fronts = [...new Set([...hints, "US"])].slice(0, 3);
  return { fronts, hinted: hints.length > 0 };
}

export const appPresenceProducer: SignalProducer = {
  key: "apps",
  label: "Mobile app presence",
  description: "Ships an iOS/Android app? Last updated when? Official free Apple API + a public Play probe.",
  needsCompany: true,
  flagged: true,
  async check(domain, ctx): Promise<ProducerResult> {
    const company = (ctx.company ?? "").trim();
    if (!company) return { facts: { Apps: "no company name resolved" }, signals: [] };
    const facts: Record<string, string> = {};
    const state: Record<string, string> = {};
    const measured = { ios: false, android: false }; // did we get a DEFINITIVE answer this scan?
    const { fronts, hinted } = storefronts(domain, company);

    // iOS — iTunes Search API, across the company's own storefronts (match seller or app name)
    try {
      type ItunesApp = { trackId: number; trackName: string; sellerName: string; currentVersionReleaseDate?: string; trackViewUrl?: string };
      let hit: ItunesApp | undefined;
      let anyOk = false;
      for (const cc of fronts) {
        const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(company)}&entity=software&country=${cc}&limit=10`, {
          headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        anyOk = true;
        const data = await res.json() as { results?: ItunesApp[] };
        // OWNERSHIP IS A PROPERTY OF THE SELLER, NOT OF THE APP'S TITLE.
        //
        // This used to accept a result on any of three tests — seller contains the company, company
        // contains the seller, or the app's NAME starts with the company — none word-bounded and none
        // with a length floor. Of the 14 app-stale signals inspected on the live feed, 10 were about
        // an unrelated app:
        //
        //   airgroup.com (freight)   -> "Airgroup All In One Gym"
        //   fcbf.com (customs)       -> "FCBF Church"
        //   djpowers.com (freight)   -> a Chinese DJ turntable app
        //   nttdata-solutions.com    -> "makira"
        //   compassfwd.com AND compasslogisticsmarine.com -> both "Compass Altimeter"
        //
        // The app-name arm is gone entirely: anyone may call an app anything, so its title is not
        // evidence that this company published it. Only the seller is, and the right question there
        // is name-vs-name — companyEntityMatches, the same test EDGAR and Companies House use, which
        // brings a length floor, legal-suffix stripping and word-bounded prefix semantics with it.
        // "Compass Forwarding" is not a prefix of "Compass Altimeter" in either direction.
        hit = pickCompanyApp(company, data.results ?? []);
        if (hit) break; // found in one storefront — no need to try the rest
      }
      if (anyOk) {
        // Definitive only if we FOUND one, or we actually searched a storefront this company belongs
        // to. Otherwise "not in the US store" says nothing about a company we can't place — leaving
        // measured.ios false keeps the prior state and reports nothing (the indeterminate contract).
        measured.ios = !!hit || hinted;
        if (hit) {
          const updated = hit.currentVersionReleaseDate ? hit.currentVersionReleaseDate.slice(0, 10) : null;
          facts["iOS app"] = hit.trackName + (updated ? ` (updated ${updated})` : "");
          state["ios"] = String(hit.trackId);
          // WHICH app was matched, recorded on the signal so a wrong attribution is visible without
          // opening the store link. The old detail carried only { lastUpdated }, so "iOS app hasn't
          // been updated since 2024-02" gave no way to notice it was about someone else's app.
          state["iosName"] = hit.trackName ?? "";
          state["iosSeller"] = hit.sellerName ?? "";
          if (updated) state["iosUpdated"] = updated;
          if (hit.trackViewUrl) state["iosUrl"] = hit.trackViewUrl;
        } else facts["iOS app"] = hinted ? `none in the ${fronts.join("/")} App Store` : "none in the US App Store — this company's region is unknown, so other stores weren't checked";
      }
    } catch { facts["iOS app"] = "lookup failed"; }

    // Android — public Play search page; a result linking an /store/apps/details page that mentions
    // the company name counts. Pure best-effort: any failure is silence, never an error.
    try {
      // gl = the storefront to search, same reasoning as the App Store above.
      const res = await fetch(`https://play.google.com/store/search?q=${encodeURIComponent(company)}&c=apps&hl=en&gl=${fronts[0]}`, {
        headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const html = await res.text();
        // The search page echoes the query back (input value, title), so "name appears in HTML" is
        // meaningless. Require the company name inside an app-card aria-label — Play renders result
        // cards with the app/developer name in aria-label even in the no-JS payload. No labels at
        // all → the page shape changed → report nothing rather than guess.
        const labels = [...html.matchAll(/aria-label="([^"]{2,120})"/g)].map((m) => m[1]!.toLowerCase());
        if (labels.length) { // no labels at all = page shape changed → NOT a definitive answer
          // `l.includes(cq)` was a raw substring test with no length floor and no word boundary —
          // the same looseness the iOS arm had above, so "Compass" matched "Compass Altimeter" and a
          // two-letter company matched almost everything.
          const hit = /\/store\/apps\/details\?id=/.test(html) && labels.some((l) => labelNamesCompany(l, company));
          measured.android = hit || hinted; // same rule as iOS: a miss in a store they may not use proves nothing
          if (hit) {
            facts["Android app"] = "found on Google Play";
            state["android"] = "1";
            // Keep the evidence, not just the verdict — see pickAndroidPackage for why and how.
            const pick = pickAndroidPackage(company, html, labels);
            if (pick) {
              state["androidId"] = pick.id;
              state["androidUrl"] = pick.url;
              if (pick.label) state["androidLabel"] = pick.label;
              state["androidBasis"] = pick.basis;
            }
          }
          else facts["Android app"] = hinted ? `none on Google Play (${fronts[0]})` : "none on Google Play (US) — this company's region is unknown, so other stores weren't checked";
        }
      }
    } catch { /* Play is scrape-hostile at times — silence, iOS still stands */ }

    const prior = dbGetDomainState(domain, "apps");
    // Which storefronts this scan actually looked in. This USED to be US-only; widening it to the
    // company's own countries means an app that was always there, just invisible to the US store,
    // suddenly appears — and "appeared since last time" is exactly what app-published fires on. So
    // a baseline measured under a different storefront set is not comparable: record the scope and
    // suppress the transition for one scan while the new basis is established. (adActivity got this
    // guard in the same commit that widened the ads search; app presence did not.)
    const scope = fronts.join(",");
    const sameScope = prior.get("_fronts") === scope;
    // Carry a platform's PRIOR state forward when we couldn't measure it this scan — otherwise a failed
    // lookup wipes the row and the next successful scan false-fires "app-published". Only a definitive
    // measurement is allowed to change (or clear) a platform's stored state. The per-platform "checked"
    // marker (_ck:<plat>) is carried too, so we remember we'd definitively measured that platform.
    if (!measured.ios) for (const k of ["ios", "iosUpdated", "iosUrl", "iosName", "iosSeller", "_ck:ios"]) { const v = prior.get(k); if (v != null) state[k] = v; }
    // The evidence keys ride along with the verdict they justify. Carrying "android" forward without
    // androidId/Url/Label/Basis would restore the bare claim and drop what backs it, recreating by
    // omission the exact hole this producer just closed — and it would do it on every scan where
    // Play was unreachable, which is the common case (Play is scrape-hostile).
    if (!measured.android) for (const k of ["android", "androidId", "androidUrl", "androidLabel", "androidBasis", "_ck:android"]) { const v = prior.get(k); if (v != null) state[k] = v; }
    // The scan-level markers are only re-written when something WAS measured, so a scan that measured
    // nothing must carry them or dbReplaceDomainState drops them — losing _fronts would then look
    // like a scope change and re-baseline for no reason, and losing _checked would forget we had ever
    // established a real "they had no apps".
    if (!measured.ios && !measured.android) {
      for (const k of ["_checked", "_fronts"]) { const v = prior.get(k); if (v != null) state[k] = v; }
    }
    const signals: SignalDraft[] = [];
    if (prior.size > 0) {
      for (const plat of ["ios", "android"] as const) {
        // Fire "published" only if THIS platform was definitively measured before (so its prior absence
        // was real). A global baseline marker would false-fire when a platform's first-ever successful
        // read lands after an earlier scan where only the OTHER platform was measurable.
        if (state[plat] && prior.has(`_ck:${plat}`) && !prior.has(plat) && sameScope) {
          signals.push({
            // Month suffix: an app that is delisted and later republished is a real event, and keyed
            // on (domain, platform) alone it could only ever fire once in the app's lifetime (dedup is
            // permanent, signals are never purged). Same trap atsSwitch.ts:41 documents; `app-stale`
            // below already carried a month. Gated by the presence diff above, so a listed app that
            // stays listed cannot re-fire.
            dedupKey: `app-published:${domain}:${plat}:${new Date().toISOString().slice(0, 7)}`, type: "app-published",
            // THE LINK MUST POINT AT THE APP THE SIGNAL IS ABOUT.
            //
            // Both platforms used state["iosUrl"], so an ANDROID app-published signal opened the
            // company's iOS listing — or, when there was no iOS app, nothing at all. Clicking through
            // to a different app than the one the headline names is worse than no link: it looks like
            // corroboration. The Android arm had no URL to offer until it started recording which
            // package it found, which is why this could not be fixed before.
            title: plat === "ios"
              ? `Published an iOS app${facts["iOS app"] ? `: ${facts["iOS app"]}` : ""}`
              : `Published an Android app${state["androidLabel"] ? `: ${state["androidLabel"]}` : ""}`,
            company,
            url: (plat === "ios" ? state["iosUrl"] : state["androidUrl"]) ?? null,
            // Name the package and say what the attribution rested on, so the signal carries its own
            // evidence rather than asking the reader to trust it.
            detail: plat === "ios" ? { platform: plat }
              : { platform: plat, app: state["androidId"] ?? null, basis: state["androidBasis"] ?? null },
          });
        }
      }
    }
    // Staleness fires regardless of baseline (it's computed state, like velocity) — month-bucketed.
    if (state["iosUpdated"]) {
      const ageMo = (Date.now() - new Date(state["iosUpdated"]).getTime()) / (30 * 86400e3);
      if (ageMo > STALE_MONTHS) {
        signals.push({
          dedupKey: `app-stale:${domain}:${new Date().toISOString().slice(0, 7)}`, type: "app-stale",
          title: `iOS app hasn't been updated since ${state["iosUpdated"]} (${Math.round(ageMo)}mo)`,
          company, url: state["iosUrl"] ?? null,
          detail: { lastUpdated: state["iosUpdated"], app: state["iosName"] ?? null, publisher: state["iosSeller"] ?? null },
        });
      }
    }
    // Record a baseline marker whenever we got a definitive answer (even "no apps"), so a LATER
    // publish can diff against a real "they had none" — without it, first-ever app = silent forever.
    // Per-platform markers gate app-published so a platform only signals once WE'VE actually measured it.
    if (measured.ios || measured.android) state["_checked"] = new Date().toISOString().slice(0, 10);
    if (measured.ios) state["_ck:ios"] = "1";
    if (measured.android) state["_ck:android"] = "1";
    if (measured.ios || measured.android) state["_fronts"] = scope; // the basis this baseline was measured on
    if (!ctx.readonly && Object.keys(state).length) dbReplaceDomainState(domain, "apps", state); // readonly probe: don't consume the diff baseline
    // Flag only when we definitively measured at least one platform this scan (else leave the prior).
    const flag = (measured.ios || measured.android)
      ? (() => { const p = [state["ios"] ? "iOS" : "", state["android"] ? "Android" : ""].filter(Boolean);
                 return { hit: p.length > 0, summary: p.length ? `Has ${p.join(" + ")} app` : "No mobile app found" }; })()
      : undefined;
    return { facts, signals, flag };
  },
};
