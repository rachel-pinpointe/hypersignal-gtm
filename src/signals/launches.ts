// Product Hunt launches — via the public tokenless Atom feed (their GraphQL API needs a token, the
// feed doesn't). The feed is GLOBAL (roughly the last day's posts), fetched once per half-hour and
// shared across every domain in a run; a watched company appearing in it = launch/growth mode.
// Continuous watchlists polled hourly catch the window reliably; a one-off check only sees the
// current window (stated in the facts, never implied otherwise). Velocity-style emission: a launch
// IS a recent event — dedup_key (entry id) prevents refires, no baseline needed.
import { companyNameMatches } from "./company.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0)";
const CACHE_MS = 30 * 60e3;

interface PhEntry { id: string; title: string; url: string; published: string; text: string }
let cache: { at: number; entries: PhEntry[] } | null = null;
let inflight: Promise<PhEntry[]> | null = null;
async function phEntries(): Promise<PhEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.entries;
  if (inflight) return inflight;
  inflight = (async () => {
    const out: PhEntry[] = [];
    try {
      const res = await fetch("https://www.producthunt.com/feed", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const xml = await res.text();
        for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
          const block = m[1]!;
          const id = (/<id>([\s\S]*?)<\/id>/.exec(block)?.[1] ?? "").trim();
          const title = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
          const url = /<link[^>]*href="([^"]+)"/.exec(block)?.[1] ?? "";
          const published = (/<published>([\s\S]*?)<\/published>/.exec(block)?.[1] ?? "").trim();
          const content = (/<content[^>]*>([\s\S]*?)<\/content>/.exec(block)?.[1] ?? "");
          const text = (title + " " + content.replace(/&lt;[^&]*&gt;|<[^>]+>/g, " ")).toLowerCase();
          if (id && title) out.push({ id, title, url, published, text });
        }
      }
    } catch { /* feed down — empty, retry after TTL */ }
    if (out.length) cache = { at: Date.now(), entries: out };
    inflight = null;
    return out;
  })();
  return inflight;
}

export const launchesProducer: SignalProducer = {
  key: "ph",
  label: "Product Hunt launches",
  description: "A watched company appearing in the Product Hunt feed = launch / growth mode. Tokenless public feed (current window only).",
  needsCompany: true,
  async check(domain, ctx): Promise<ProducerResult> {
    const company = (ctx.company ?? "").trim();
    const entries = await phEntries();
    if (!entries.length) return { facts: { "Product Hunt": "feed unavailable — will retry next scan" }, signals: [] };
    const stem = domain.split(".")[0]!;
    // Match on the exact domain (precise) OR the company/stem as a WHOLE WORD in the title — never a
    // bare substring, so "Box" doesn't match "Dropbox launches…" and a 3-char name can't cross-hit.
    const hits = entries.filter((e) =>
      e.text.includes(domain) || companyNameMatches(company, e.title) || companyNameMatches(stem, e.title));
    const facts: Record<string, string> = {
      "Product Hunt": hits.length ? `launching now: ${hits[0]!.title.slice(0, 60)}` : "not in the current feed window",
    };
    const signals: SignalDraft[] = hits.slice(0, 2).map((h) => ({
      dedupKey: `ph-launch:${domain}:${h.id}`, type: "ph-launch",
      title: `Launched on Product Hunt: ${h.title.slice(0, 100)}`,
      company: ctx.company ?? null, url: h.url || null, observedAt: h.published || null,
      detail: { entry: h.title },
    }));
    // No current-state flag: PH is a one-day-window EVENT, not a lasting state. A "hit" could never
    // transition back to false (the company drops out of the window next day), so a domain_flags entry
    // would be permanently stale. PH stays a diff-signal (ph-launch) only, not a filterable flag.
    return { facts, signals };
  },
};
