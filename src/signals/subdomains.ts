// New-subdomain detection via certificate transparency (crt.sh — free public JSON, no key).
// Every TLS cert ever issued for *.domain is public record; a NEW subdomain appearing
// (app./shop./docs./api.) = a new product surface or tool rollout.
// crt.sh is slow and rate-limits hard → strictly SERIAL (module-level gate), one retry, and a
// 24h re-check TTL per domain (the _checked meta row). Diffs → subdomain-new (capped per scan).
import { dbGetDomainState, dbReplaceDomainState } from "../db.ts";
import { contactUserAgent } from "./contact.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

const TTL_HOURS = 24;
const MAX_STORED = 400;      // infra-heavy domains can have thousands — keep the useful head
const MAX_NEW_SIGNALS = 8;   // don't flood on a cert-batch day
// Threshold for the current-state flag. Almost every live domain has a certificate, so "has any
// subdomain" is true nearly everywhere and would be worthless as a filter; a handful of distinct
// hostnames is what actually separates a real web estate from a parked or single-page site.
const NOTABLE_SUBDOMAINS = 5;

// Module-level serial gate: crt.sh tolerates one polite query at a time from one IP.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const r = queue.then(task, task);
  queue = r.then(() => {}, () => {});
  return r as Promise<T>;
};

// Normalize + filter one candidate DNS name into the sub set.
function addName(subs: Set<string>, raw: string, domain: string): void {
  const s = raw.trim().toLowerCase();
  if (!s || s.startsWith("*") || s === domain || s === `www.${domain}`) return;
  if (!s.endsWith(`.${domain}`)) return; // certs can carry unrelated SANs — keep only ours
  subs.add(s); // collect ALL here; truncation to MAX_STORED happens deterministically after sorting
}

async function crtsh(domain: string): Promise<string[] | null> {
  const res = await fetch(`https://crt.sh/?q=${encodeURIComponent("%." + domain)}&output=json`, {
    headers: { "User-Agent": contactUserAgent(), Accept: "application/json" }, signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json() as Array<{ name_value?: string }>;
  const subs = new Set<string>();
  for (const r of rows) for (const line of String(r.name_value ?? "").split("\n")) addName(subs, line, domain);
  return [...subs];
}

// Fallback CT source: Cert Spotter's free unauthenticated API (rate-limited but reliable) —
// crt.sh is chronically overloaded and can time out for hours at a stretch.
async function certspotter(domain: string): Promise<string[] | null> {
  const res = await fetch(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`, {
    headers: { "User-Agent": contactUserAgent(), Accept: "application/json" }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json() as Array<{ dns_names?: string[] }>;
  const subs = new Set<string>();
  for (const r of rows) for (const n of r.dns_names ?? []) addName(subs, n, domain);
  return [...subs];
}

/** crt.sh first (fullest history), Cert Spotter fallback; null only when BOTH fail. */
async function fetchSubdomains(domain: string): Promise<string[] | null> {
  try { return await crtsh(domain); } catch { /* overloaded — try the fallback */ }
  try { return await certspotter(domain); } catch { /* both down */ }
  return null;
}

export const subdomainsProducer: SignalProducer = {
  key: "subdomains",
  label: "New subdomains",
  description: "Certificate-transparency watch (crt.sh) — a new app./shop./docs. subdomain = a new product surface.",
  flagged: true,
  async check(domain, ctx): Promise<ProducerResult> {
    if (ctx.stop?.()) return { facts: {}, signals: [] };
    const prior = dbGetDomainState(domain, "subdomains");
    // 24h TTL: crt.sh is slow — within the window, answer from stored state without re-querying.
    const checkedAt = prior.get("_checked");
    if (checkedAt && Date.now() - new Date(checkedAt).getTime() < TTL_HOURS * 3600e3) {
      const n = [...prior.keys()].filter((k) => k.startsWith("sub:")).length;
      // The cache HAS the answer, so it says it. Returning no flag here made the flag depend on the
      // TTL happening to be expired at the moment of the scan: a domain re-checked inside 24h — which
      // is every domain during a busy day — kept whatever flag it had, or kept none at all if it had
      // never been given one. Same conclusion as the live exit below, from the same stored subdomains.
      return { facts: { "Subdomains": `${n} known (checked <${TTL_HOURS}h ago)` }, signals: [],
        flag: { hit: n >= NOTABLE_SUBDOMAINS, summary: n ? `${n} subdomain${n === 1 ? "" : "s"}` : "no subdomains in certificate transparency logs" } };
    }
    const all = await serial(() => fetchSubdomains(domain));
    if (all == null) {
      // both CT sources down/rate-limited: report + leave state untouched (no fake diffs, TTL not refreshed).
      return { facts: { "Subdomains": "CT logs unavailable — will retry next scan" }, signals: [] };
    }
    // Deterministic truncation: sort (shortest/closest-to-root first, then lexicographic) THEN cap, so
    // the stored MAX_STORED set is identical across scans regardless of crt.sh's unstable row order —
    // otherwise a different subset each scan makes long-present subdomains diff as "new".
    const subs = [...new Set(all)].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, MAX_STORED);
    const facts: Record<string, string> = {
      "Subdomains": String(subs.length),
      ...(subs.length ? { "Sample": subs.slice(0, 5).map((s) => s.replace(`.${domain}`, "")).join(", ") } : {}),
    };
    const signals: SignalDraft[] = [];
    const hadBaseline = [...prior.keys()].some((k) => k.startsWith("sub:") || k === "_checked");
    if (hadBaseline) {
      let fresh = 0;
      for (const s of subs) {
        if (prior.has(`sub:${s}`)) continue;
        if (++fresh > MAX_NEW_SIGNALS) break;
        signals.push({
          dedupKey: `subdomain-new:${s}`, type: "subdomain-new",
          title: `New subdomain: ${s}`, url: `https://${s}`, detail: { subdomain: s },
        });
      }
    }
    // Built from what was EMITTED, not from every subdomain seen — see the long note in news.ts. The
    // emit loop stops at MAX_NEW_SIGNALS, so on a scan that found nine new hostnames, eight were
    // reported and the ninth was recorded as seen without ever firing. `_checked` is only a re-fetch
    // TTL and never cleared a `sub:` key, so nothing else could recover it.
    const state: Record<string, string> = { _checked: new Date().toISOString() };
    if (!hadBaseline) {
      for (const s of subs) state[`sub:${s}`] = "1";   // baseline scan: everything, emit nothing
    } else {
      // Keep every hostname already known — including ones missing from this scan, since CT logs are
      // eventually consistent and a hostname that disappears for one scan must not re-fire as new.
      for (const k of prior.keys()) if (k.startsWith("sub:")) state[k] = "1";
      const emitted = new Set(signals.map((sig) => String(sig.detail && (sig.detail as { subdomain?: string }).subdomain)));
      for (const s of subs) if (emitted.has(s)) state[`sub:${s}`] = "1";
      // Cap for the same reason MAX_STORED exists — carrying the prior forward can only grow the row.
      const keys = Object.keys(state).filter((k) => k.startsWith("sub:"));
      for (const k of keys.slice(MAX_STORED)) delete state[k];
    }
    if (!ctx.readonly) dbReplaceDomainState(domain, "subdomains", state); // readonly probe: don't consume the diff baseline
    // No `flag` from any exit, so dbSetDomainFlag was never called for "subdomains" — 273 domains
    // held a baseline and none held a flag, while the UI's PRODUCER_LABELS promised a "Web presence"
    // chip that could never render. (Three producers shared this: dns, subdomains and news.)
    //
    // `hit` is keyed to a MEANINGFUL estate rather than "has any subdomain", because a certificate
    // exists for essentially every live domain and a flag that is true everywhere filters nothing.
    return { facts, signals,
      flag: { hit: subs.length >= NOTABLE_SUBDOMAINS,
        summary: subs.length
          ? `${subs.length} subdomain${subs.length === 1 ? "" : "s"}${facts["Sample"] ? ` — ${facts["Sample"]}` : ""}`
          : "no subdomains in certificate transparency logs" } };
  },
};
