// Signal-producer registry + the continuous-monitoring runner (Mode B).
// Mode A (one-off checks on an uploaded list) lives in src/signalCheck.ts and uses the same registry.
import { normalizeOrgDomain, isDomainShaped } from "../normalize.ts";
import { withTimeout } from "../sources/browser.ts";
import { dbInsertSignal, dbSetDomainFlag, dbEnqueueSlow } from "../db.ts";
import { velocityProducer } from "./velocity.ts";
import { dnsProducer } from "./dns.ts";
import { atsSwitchProducer } from "./atsSwitch.ts";
import { edgarProducer } from "./edgar.ts";
import { companiesHouseProducer } from "./companiesHouse.ts";
import { gdeltProducer } from "./gdelt.ts";
import { appPresenceProducer } from "./appPresence.ts";
import { techStackProducer } from "./techStack.ts";
import { subdomainsProducer } from "./subdomains.ts";
import { newsProducer } from "./news.ts";
import { warnProducer } from "./warn.ts";
import { launchesProducer } from "./launches.ts";
import { adActivityProducer } from "./adActivity.ts";
import { resolveCompanyIdentity } from "./company.ts";
import type { SignalProducer, ProducerResult } from "./types.ts";
import type { ClientConfig } from "../types.ts";

/** Every available producer, in UI display order. Keys are stored in client configs — never rename. */
export const SIGNAL_PRODUCERS: SignalProducer[] = [
  velocityProducer,
  dnsProducer,
  atsSwitchProducer,
  techStackProducer,
  subdomainsProducer,
  edgarProducer,
  companiesHouseProducer,
  appPresenceProducer,
  newsProducer,
  gdeltProducer,
  warnProducer,
  launchesProducer,
  adActivityProducer,
];

export const producerByKey = (key: string): SignalProducer | undefined => SIGNAL_PRODUCERS.find((p) => p.key === key);

/** Run a watchlist's enabled producers over its domains, recording NEW signals attributed to the
 *  client. Serial per domain with an event-loop yield between domains (producers are DB/CPU work;
 *  the fetch-heavy ones bound their own network concurrency internally). Returns new-signal count. */
// One signal scan per watchlist at a time.
//
// This function is reachable from three places at once — the scheduler tick, the "Check signals now"
// button, and the save-config path — and it had no claim of any kind. Two overlapping scans of the
// same watchlist walk the same domains and hit the same diff producers, and a diff producer commits
// its new baseline INSIDE its own check() while the caller records the resulting signals separately.
// Interleave two of those over one domain and the second scan consumes a baseline the first had
// already advanced: the change is not delayed, it is gone. The same class the per-scan cap fix above
// deals with, arriving through concurrency instead of a ceiling.
//
// A Set of client names, not a mutex library: the guard is a claim taken before the first await and
// released in a finally, which is the same shape runClientSources already uses for fetches.
const scanning = new Set<string>();

// A producer that hangs (never resolves, never rejects) must fail like any other producer error, not
// take down the whole scan. Found live 2026-09-18: the scheduled cron crashed 3 times running the real
// watchlist with Node's "unsettled top-level await" (exit code 13) -- some await inside a producer (or
// resolveCompanyIdentity) never settled, and the existing try/catch around each call cannot catch a
// promise that never rejects. A timeout turns that into an ordinary caught rejection. 45s is generous
// against the slowest producer measured live (WARN, ~31s for one domain against a government API).
const PRODUCER_TIMEOUT_MS = 45_000;
const COMPANY_RESOLVE_TIMEOUT_MS = 15_000;

export async function runClientSignals(client: ClientConfig): Promise<number> {
  if (scanning.has(client.name)) {
    console.log(`[signals] ${client.name}: a scan is already running — skipping this trigger`);
    return 0;
  }
  scanning.add(client.name);
  try {
    return await runClientSignalsInner(client);
  } finally {
    scanning.delete(client.name);
  }
}

async function runClientSignalsInner(client: ClientConfig): Promise<number> {
  const enabled = (client.signals ?? []).filter((k) => producerByKey(k));
  // isDomainShaped, not just truthy: normalizeOrgDomain reduces without validating, so a watchlist
  // entry of "www." or ".com" survives as "www" / "com" and every producer would then write an answer
  // into domain_flags under that key, indistinguishable from a real company's.
  const domains = (client.search?.orgDomains ?? []).map((d) => normalizeOrgDomain(String(d ?? ""))).filter(isDomainShaped);
  if (!enabled.length || !domains.length) return 0;
  // Rate-limited producers (those declaring paceMs) are QUEUED, not awaited. This loop is serial per
  // domain, so awaiting a producer that must sleep 5.2s between calls does not slow that producer down
  // — it slows the entire scan down to that producer's pace, for every other producer too. See
  // src/signals/slowQueue.ts. The queue is drained by a background worker at the declared pace.
  const keys = enabled.filter((k) => !producerByKey(k)!.paceMs);
  const paced = enabled.filter((k) => producerByKey(k)!.paceMs);
  let fresh = 0;
  const needsCompany = enabled.some((k) => producerByKey(k)!.needsCompany);
  if (!keys.length && !paced.length) return 0;
  // Progress heartbeat, not behavior. Added 2026-09-18 alongside the per-producer timeouts above:
  // those turned a silent hang into a loud failure, but the loud failure still arrived as one summary
  // after 25+ minutes with no way to tell whether it died at domain 2 or domain 1,400, or whether it
  // was uniformly slow throughout vs. falling off a cliff partway through. Every 25th domain (and the
  // first and last) logs elapsed time and a running timeout tally so the next occurrence is
  // diagnosable straight from the run's own stdout instead of needing a fresh live-fire to observe.
  const scanStart = Date.now();
  let timeoutTally = 0;
  for (const [domainIndex, domain] of domains.entries()) {
    if (domainIndex === 0 || domainIndex === domains.length - 1 || domainIndex % 25 === 0) {
      console.log(`[signals] ${client.name}: domain ${domainIndex + 1}/${domains.length} (${domain}) — ${Math.round((Date.now() - scanStart) / 1000)}s elapsed, ${timeoutTally} timeout(s) so far`);
    }
    // Resolve the company name once per domain, only when a name-keyed producer is enabled.
    let company: string | null = null;
    // KEYABLE name, not the display name. resolveCompanyIdentity says whether the resolved string is
    // safe to key a registry lookup or a headline match on; when it is not, the producers must see NO
    // company and say so, rather than go looking for events belonging to a bare common word.
    // Timeout-wrapped, not just try/catch: resolveCompanyIdentity does its own network fetch with an
    // AbortSignal timeout, but a hang ANYWHERE in that chain (a connection that never completes, an
    // AbortSignal edge case) would otherwise block this whole per-domain loop forever with nothing to
    // catch it -- exactly the class of bug found live 2026-09-18 (see PRODUCER_TIMEOUT_MS below).
    if (needsCompany) { try { const id = await withTimeout(resolveCompanyIdentity(domain), COMPANY_RESOLVE_TIMEOUT_MS, `resolveCompanyIdentity@${domain}`); company = id.keyable ? id.name : null; } catch { /* stem fallback inside */ } }
    // Producers run CONCURRENTLY for a domain, exactly as checkDomainNow does — this scheduled path
    // used to await them one after another, so it paid the SUM of their network latencies where the
    // interactive path pays the MAX. The declared per-producer timeouts add up to ~176s per domain
    // plus a Playwright page, which a 50-domain watchlist cannot fit into an hourly schedule. Each
    // producer already bounds its own network concurrency, which is the invariant checkDomainNow
    // relies on.
    //
    // Results are applied AS EACH PRODUCER RESOLVES, not after the whole fan-out. A diff producer
    // commits its new baseline inside its own check() (dbReplaceDomainState — 11 of them do), while
    // the caller records the resulting signals separately. Anything that ends the process between
    // those two writes consumes the diff without emitting its event, and the next scan sees no
    // difference: the change is gone, not delayed. Applying after `await Promise.all(...)` held that
    // window open for the whole fan-out — the declared timeouts sum to ~176s — so a fast producer's
    // baseline sat unrecorded for minutes while the slowest one finished. Now it closes as soon as
    // that producer returns.
    //
    // The writes are still serial and ordered: dbInsertSignal is synchronous, and these callbacks run
    // one at a time on the single JS thread.
    //
    // This SHRINKS the window, it does not remove it — true atomicity needs the baseline write moved
    // out of the producers and into the same transaction as the insert, which is a change across all
    // 11 of them. The other half of that exposure, auto-quit firing mid-scan, is fixed in server.ts.
    const apply = (key: string, out: ProducerResult) => {
      if (out.flag) dbSetDomainFlag(domain, key, out.flag.hit, out.flag.summary); // current-state flag for filtering
      for (const s of out.signals) {
        if (dbInsertSignal({
          dedupKey: s.dedupKey, domain, company: s.company ?? null, type: s.type, title: s.title,
          detail: s.detail, url: s.url ?? null, client: client.name, observedAt: s.observedAt ?? null,
        })) fresh++;
      }
    };
    // Queue the paced ones and move on. The name resolved above rides along so the worker doesn't
    // have to re-fetch the homepage hours later just to learn what the company is called.
    for (const key of paced) {
      dbEnqueueSlow(key, domain, client.name, company, producerByKey(key)?.recheckDays ?? 0);
    }
    await Promise.all(keys.map(async (key) => {
      try { apply(key, await withTimeout(producerByKey(key)!.check(domain, { company }), PRODUCER_TIMEOUT_MS, `${key}@${domain}`)); }
      catch (e) {
        if ((e as Error).message.includes("timed out after")) timeoutTally++;
        console.warn(`[signals] ${key}@${domain} failed: ${(e as Error).message}`); // fail-soft
      }
    }));
    await new Promise((r) => setImmediate(r)); // don't starve the dashboard between domains
  }
  if (fresh) console.log(`[signals] ${client.name}: ${fresh} new signal(s) across ${domains.length} domain(s)`);
  if (paced.length) console.log(`[signals] ${client.name}: queued ${domains.length} domain(s) for ${paced.join(", ")} — the background worker drips through them at each producer's allowed rate`);
  return fresh;
}

/** On-demand check of ONE domain across the given producers (default: all). Runs synchronously, returns
 *  per-producer facts + the current-state flag, and persists flags + any new signals — so a "Check
 *  signals" button from a job/company view both shows results now and populates the filters. */
export async function checkDomainNow(rawDomain: string, keys?: string[], opts: { adCountry?: string } = {}): Promise<{
  domain: string; company: string | null;
  results: Array<{ key: string; label: string; facts: Record<string, string>; hit: boolean | null; summary: string | null; error?: string }>;
}> {
  const domain = normalizeOrgDomain(String(rawDomain ?? ""));
  if (!isDomainShaped(domain)) throw new Error("no valid domain");
  const producers = (keys?.length ? keys.map((k) => producerByKey(k)).filter(Boolean) as SignalProducer[] : SIGNAL_PRODUCERS);
  // `company` is the KEYABLE name handed to the producers (null when the resolved string is too
  // generic to match on); `displayName` is what the drawer shows either way, so the user can see WHY
  // a name-keyed producer found nothing instead of concluding the company has no signals.
  let company: string | null = null;
  let displayName: string | null = null;
  if (producers.some((p) => p.needsCompany)) {
    try { const id = await resolveCompanyIdentity(domain); displayName = id.name; company = id.keyable ? id.name : null; }
    catch { /* stem fallback */ }
  }
  // Run producers concurrently (each bounds its own network internally) so an on-demand check is bounded
  // by the slowest single producer, not their sum. Order preserved by the map.
  const results = await Promise.all(producers.map(async (p) => {
    try {
      // Flags only — deliberately NOT persisting feed signals. An ad-hoc check has no client/check
      // attribution, so inserting its diffs (with the raw dedup_key) would create client=NULL rows that
      // ON CONFLICT-block a later watchlist delivery of the same event. The drawer surfaces the current
      // state via `facts`; monitoring + saved checks own the attributed feed.
      const { facts, flag } = await p.check(domain, { company, readonly: true, adCountry: opts.adCountry });
      if (flag) dbSetDomainFlag(domain, p.key, flag.hit, flag.summary);
      return { key: p.key, label: p.label, facts, hit: flag ? flag.hit : null as boolean | null, summary: flag?.summary ?? null as string | null };
    } catch (e) {
      return { key: p.key, label: p.label, facts: {} as Record<string, string>, hit: null as boolean | null, summary: null as string | null, error: (e as Error).message.slice(0, 80) };
    }
  }));
  return { domain, company: displayName, results };
}
