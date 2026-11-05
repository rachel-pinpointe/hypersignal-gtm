// Website tech-stack detection — fetch a domain's homepage ONCE (polite, ats.ts-style) and run the
// cached webappanalyzer fingerprints over the static HTML + response headers: script srcs, HTML
// patterns, meta tags, headers. No JS execution (a JS-rendered tool can hide; what we DO detect is
// solid). The classic "they just installed X" play:
//   facts  = the current detected stack;
//   diffs  = tech-added / tech-removed vs domain_state (first scan is baseline-only).
// A fetch failure NEVER touches stored state — an outage can't fabricate "tech removed" churn.
import { readFileSync, existsSync } from "node:fs";
import { dbGetDomainState, dbReplaceDomainState } from "../db.ts";
import { safeFetch } from "../safeFetch.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const FP_PATH = process.env.WAPP_FP ?? "data/webappanalyzer-fingerprints.json";
const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0)";
const HTML_CAP = 500_000;   // enough for any homepage's <head> + body markers
const MAX_REMOVED_SIGNALS = 5; // a redesign can drop dozens of libs — don't flood

interface Fp { name: string; category: string | null; scriptSrc: string[]; html: string[]; meta: Record<string, string>; headers: Record<string, string> }
interface CompiledFp { name: string; category: string | null; scriptSrc: RegExp[]; html: RegExp[]; meta: Array<[string, RegExp | null]>; headers: Array<[string, RegExp | null]> }

let compiled: CompiledFp[] | null = null;
function fingerprints(): CompiledFp[] {
  if (compiled) return compiled;
  compiled = [];
  if (!existsSync(FP_PATH)) {
    console.warn(`[techstack] no fingerprint cache at ${FP_PATH} — run: npm run cache:webappanalyzer`);
    return compiled;
  }
  const rows = JSON.parse(readFileSync(FP_PATH, "utf8")) as Fp[];
  const rx = (p: string): RegExp | null => { try { return new RegExp(p, "i"); } catch { return null; } };
  for (const r of rows) {
    const c: CompiledFp = {
      name: r.name, category: r.category,
      scriptSrc: r.scriptSrc.map(rx).filter((x): x is RegExp => !!x),
      html: r.html.map(rx).filter((x): x is RegExp => !!x),
      meta: Object.entries(r.meta).map(([k, v]) => [k, v ? rx(v) : null] as [string, RegExp | null]),
      headers: Object.entries(r.headers).map(([k, v]) => [k, v ? rx(v) : null] as [string, RegExp | null]),
    };
    if (c.scriptSrc.length || c.html.length || c.meta.length || c.headers.length) compiled.push(c);
  }
  console.log(`[techstack] compiled ${compiled.length} fingerprints`);
  return compiled;
}

/** Run every fingerprint over one page's statics. Exported for reuse (and testability). */
export function detectFromPage(html: string, headers: Record<string, string>): Array<{ name: string; category: string | null }> {
  const fps = fingerprints();
  if (!fps.length) return [];
  const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]!);
  const metas = new Map<string, string>();
  for (const m of html.matchAll(/<meta[^>]+name=["']([^"']+)["'][^>]+content=["']([^"']*)["']/gi)) metas.set(m[1]!.toLowerCase(), m[2]!);
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']([^"']+)["']/gi)) metas.set(m[2]!.toLowerCase(), m[1]!);
  const found: Array<{ name: string; category: string | null }> = [];
  for (const fp of fps) {
    let hit = false;
    for (const rx of fp.scriptSrc) { if (scriptSrcs.some((s) => rx.test(s))) { hit = true; break; } }
    if (!hit) for (const rx of fp.html) { if (rx.test(html)) { hit = true; break; } }
    if (!hit) for (const [k, rx] of fp.meta) { const v = metas.get(k); if (v != null && (!rx || rx.test(v))) { hit = true; break; } }
    if (!hit) for (const [k, rx] of fp.headers) { const v = headers[k]; if (v != null && (!rx || rx.test(v))) { hit = true; break; } }
    if (hit) found.push({ name: fp.name, category: fp.category });
  }
  return found;
}

export const techStackProducer: SignalProducer = {
  key: "tech",
  label: "Website tech stack",
  description: "Fingerprints the homepage (webappanalyzer patterns) — detects the tools a site runs and alerts on adds/removals.",
  flagged: true,
  filterable: false,   // 100% of checked domains hit — see SignalProducer.filterable
  async check(domain, ctx): Promise<ProducerResult> {
    if (ctx.stop?.()) return { facts: {}, signals: [] };
    let html = "", headers: Record<string, string> = {};
    try {
      // safeFetch, not fetch: `domain` reaches here from scraped job data, uploaded check lists and
      // watchlist config, and a site we do not control can 30x us onto localhost or the LAN — whose
      // response body would then be fingerprinted and shown back in the dashboard as "Detected".
      const res = await safeFetch(`https://${domain}`, {
        headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(10000),
      });
      // fetch only rejects on a network error, NOT on a non-2xx. A 403/429/5xx (WAF challenge,
      // rate-limit, transient outage) serves an error/parking body, not the real homepage — detecting
      // "nothing" from it would fabricate tech-removed diffs and wipe state. Treat it like unreachable.
      if (!res.ok) return { facts: { Website: `returned HTTP ${res.status}` }, signals: [] };
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      html = (await res.text()).slice(0, HTML_CAP);
    } catch {
      // Unreachable site: report + leave stored state UNTOUCHED (no fake removals).
      return { facts: { Website: "unreachable" }, signals: [] };
    }
    const found = detectFromPage(html, headers);
    const facts: Record<string, string> = {
      "Detected": found.length ? found.slice(0, 12).map((f) => f.name).join(", ") + (found.length > 12 ? ` +${found.length - 12}` : "") : "nothing detectable",
      "Tech count": String(found.length),
    };
    const state: Record<string, string> = {};
    for (const f of found) state[`tech:${f.name}`] = f.category ?? "1";

    // A 200 that yields ZERO detections is not evidence that the site dropped its whole stack — it is
    // a cookie wall, an empty SPA shell, a geo-block page, or a missing fingerprint file (data/ is
    // gitignored, and an absent cache memoizes to "no patterns" for the whole process). Treating it
    // as real fired up to MAX_REMOVED_SIGNALS false "possible churn" signals AND wiped the baseline,
    // because dbReplaceDomainState deletes every key when handed an empty object. The !res.ok branch
    // above already reasons this way for a non-2xx; the three sibling producers all guard it too
    // (appPresence "Object.keys(state).length", atsSwitch "if (haveNow)", dns's wipe comment).
    // ...and no-flag: for the same reason, zero detections is not a measurement of "no tech",
    // so it must leave whatever the last real scan concluded rather than overwrite it with a no.
    if (!found.length) return { facts, signals: [] };

    const prior = dbGetDomainState(domain, "tech");
    const signals: SignalDraft[] = [];
    if (prior.size > 0) {
      for (const f of found) {
        if (!prior.has(`tech:${f.name}`)) {
          signals.push({
            // The month is what lets a RE-ADOPTION fire. Keyed on (domain, tool) alone, a company
            // that drops a tool and later comes back to it is silent forever, because
            // ON CONFLICT(dedup_key) DO NOTHING drops the second add as a duplicate of the first and
            // signals are never purged. atsSwitch.ts:41 documents this exact trap and fixed it there;
            // the sibling producers were left on the old shape, and the asymmetry is visible in the
            // pair below — `tech-removed` already carries a month, `tech-added` did not.
            // Safe against flooding: the real gate is the state diff above (this only fires when the
            // tool is ABSENT from the stored baseline), so a tool that stays put cannot re-fire.
            dedupKey: `tech-added:${domain}:${f.name}:${new Date().toISOString().slice(0, 7)}`, type: "tech-added",
            title: `Added to their site: ${f.name}${f.category ? ` (${f.category})` : ""}`,
            detail: { technology: f.name, category: f.category },
          });
        }
      }
      // The MIRROR of the cap problem the list producers had, arriving from the other direction.
      // `state` is built from `found`, so any prior `tech:` key missing from it counts as removed —
      // but this loop stops after MAX_REMOVED_SIGNALS, and every un-emitted key was then simply
      // ABSENT from `state`, which means dbReplaceDomainState deleted it. On a redesign that dropped
      // eight tools, five fired and the other three were erased from the baseline without ever being
      // reported, on that scan or any later one: the next scan has no memory that the tool was ever
      // there, so it can never notice it is gone.
      //
      // Keeping the un-emitted ones means the next scan sees them as still-removed and reports them,
      // which is the drip this cap was always meant to be.
      let removed = 0;
      const deferred: string[] = [];
      for (const key of prior.keys()) {
        if (!key.startsWith("tech:") || key in state) continue;
        const name = key.slice(5);
        if (++removed > MAX_REMOVED_SIGNALS) { deferred.push(key); continue; } // site redesign — don't flood
        signals.push({
          dedupKey: `tech-removed:${domain}:${name}:${new Date().toISOString().slice(0, 7)}`, type: "tech-removed",
          title: `Removed from their site: ${name} — possible churn`, detail: { technology: name },
        });
      }
      for (const key of deferred) state[key] = prior.get(key) ?? "1";
    }
    if (!ctx.readonly) dbReplaceDomainState(domain, "tech", state); // readonly probe: don't consume the diff baseline
    // This producer returned no `flag` from any of its five exits, so dbSetDomainFlag was never called
    // for "tech" (index.ts:77 and :118 both write only `if (out.flag)`). Measured: 912 domains had a
    // tech baseline and ZERO had a tech flag. That made two surfaces permanently blank —
    // PRODUCER_LABELS.tech ("Website tech") in the Companies "Why now" chips and in the current-signals
    // fallback feed. The label existed, promising a chip that could not physically render.
    //
    // Honest caveat, stated rather than buried: `hit` is true for essentially any reachable site, so
    // this flag is weak as a FILTER — it is carried for its summary, which is the useful part
    // ("Website tech: Cloudflare, HubSpot, Segment" beside a company). The producers whose hit rate is
    // discriminating (ats 25/1324, ads 629/1283) are the ones worth filtering on.
    return { facts, signals,
      flag: { hit: found.length > 0,
        summary: `${found.slice(0, 3).map((f) => f.name).join(", ")}${found.length > 3 ? ` +${found.length - 3} more` : ""}` } };
  },
};
