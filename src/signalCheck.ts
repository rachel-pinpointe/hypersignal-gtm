// Signal check (Mode A): "what's the current state of these SIGNALS for this LIST of domains?"
// Input is an uploaded/pasted domain list + a set of signal-producer keys. Each domain runs every
// selected producer; the per-domain FACTS build the results grid live (enrichment-style), and any
// emitted diff signals are recorded in the signals table attributed to this check (check_id).
// Mirrors runAccountCheck's harness: dedup+normalize → bounded concurrency → incremental progress →
// cooperative stop. Producers are individually fail-soft — one failing never sinks the run.
import { Semaphore } from "./sources/browser.ts";
import { normalizeOrgDomain, isDomainShaped } from "./normalize.ts";
import { dbInsertSignal, dbSetDomainFlag, dbSignalsForCheckDomain } from "./db.ts";
import { producerByKey } from "./signals/index.ts";
import { resolveCompanyIdentity } from "./signals/company.ts";
import type { SignalProducer } from "./signals/types.ts";

const CONCURRENCY = Math.max(1, Number(process.env.SIGNAL_CHECK_CONCURRENCY ?? 6));

export interface SignalCheckDomainResult {
  domain: string;
  facts: Record<string, Record<string, string>>; // producer key → facts
  signals: number;                                // signals recorded for this domain
  types: string[];                                // distinct signal types seen
  errors?: string[];                              // producers that failed (label + message)
}
export interface SignalCheckProgress {
  checked: number; total: number; found: number; totalHits: number;
  newResults: SignalCheckDomainResult[];
}
export interface SignalCheckOptions {
  checkId: string;
  control?: { stopped: boolean };
  onProgress?: (p: SignalCheckProgress) => void;
  /** Meta Ad Library region picked on the check screen ("ALL" or an ISO country). Overrides the
   *  Settings default for this run only; unset = use the default. */
  adCountry?: string;
}

export async function runSignalCheck(
  domains: string[], producerKeys: string[], opts: SignalCheckOptions,
): Promise<SignalCheckDomainResult[]> {
  const producers = producerKeys.map((k) => producerByKey(k)).filter((p): p is SignalProducer => !!p);
  const control = opts.control;

  // dedup + normalize the input list (same rules as account checks)
  //
  // A line that is not a domain is REPORTED, not silently dropped. normalizeOrgDomain does not
  // validate — "www." survives as "www", ".com" as "com", "a" as "a" — so the old `if (norm)` gate
  // accepted all three as companies and every producer then wrote its answer under that key. Junk in,
  // and the result was indistinguishable on screen from a real company with no signals. The user needs
  // to see that their line was rejected, so it comes back as a row carrying the reason.
  const seen = new Set<string>();
  const items: string[] = [];
  const rejected: SignalCheckDomainResult[] = [];
  for (const raw of domains) {
    const norm = normalizeOrgDomain(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (isDomainShaped(norm)) items.push(norm);
    else rejected.push({ domain: String(raw).trim().slice(0, 120), facts: {}, signals: 0, types: [], errors: ["not a domain — skipped"] });
  }
  const total = items.length + rejected.length;
  const results: SignalCheckDomainResult[] = [...rejected];
  let checked = 0, found = 0, totalHits = 0;
  // Report the rejected lines straight away. They are already decided, and `total` counts them — so
  // withholding them would leave the progress bar permanently short of its own total.
  for (const r of rejected) { checked++; opts.onProgress?.({ checked, total, found, totalHits, newResults: [r] }); }

  const needsCompany = producers.some((p) => p.needsCompany);
  const sem = new Semaphore(CONCURRENCY);
  await Promise.all(items.map((domain) => sem.run(async () => {
    if (control?.stopped) return;
    const r: SignalCheckDomainResult = { domain, facts: {}, signals: 0, types: [] };
    // One name resolution per domain, only when a name-keyed producer is selected.
    let company: string | null = null;
    // KEYABLE name, not the display name. resolveCompanyIdentity says whether the resolved string is
    // safe to key a registry lookup or a headline match on; when it is not, the producers must see NO
    // company and say so, rather than go looking for events belonging to a bare common word.
    let displayName: string | null = null;
    if (needsCompany) {
      try { const id = await resolveCompanyIdentity(domain); displayName = id.name; company = id.keyable ? id.name : null; }
      catch { /* stem fallback inside */ }
    }
    if (displayName) r.facts["company"] = { "Resolved name": displayName + (company ? "" : " (too generic to match on)") };
    for (const producer of producers) {
      if (control?.stopped) break;
      try {
        // readonly: an uploaded-list check reads current state (facts + flags) but must NOT advance the
        // shared domain_state baseline — that snapshot is owned by continuous monitoring, and consuming
        // it here would make a watchlist watching the same domain miss its next diff. (A first-ever probe
        // has no prior baseline to diff against anyway, so state-diff signals were never meaningful here.)
        const { facts, signals, flag } = await producer.check(domain, {
          stop: () => !!control?.stopped, company, readonly: true, snapshot: true, adCountry: opts.adCountry,
        });
        r.facts[producer.key] = facts;
        if (flag) dbSetDomainFlag(domain, producer.key, flag.hit, flag.summary); // populate the current-state filter flag

        for (const s of signals) {
          // Insert is idempotent by design (dedup_key is UNIQUE). Do NOT derive the counts from its
          // return value — see dbSignalsForCheckDomain: on a resume every re-found signal collides,
          // returns false, and the domain reports zero.
          dbInsertSignal({
            dedupKey: `${opts.checkId}:${s.dedupKey}`, // scoped per check: each check re-reports its own findings
            domain, company: s.company ?? null, type: s.type, title: s.title,
            detail: s.detail, url: s.url ?? null, checkId: opts.checkId, observedAt: s.observedAt ?? null,
          });
        }
      } catch (e) {
        (r.errors ??= []).push(`${producer.key}: ${(e as Error).message}`);
      }
      await new Promise((res) => setImmediate(res)); // producers can be sync-heavy (SQL) — let the dashboard breathe
    }
    // Counts come from the table, not from what this pass happened to insert — so a resumed run
    // re-reports the domains it already scanned instead of zeroing them.
    const stored = dbSignalsForCheckDomain(opts.checkId, domain);
    r.signals = stored.count;
    r.types = stored.types;
    totalHits += r.signals;
    if (r.signals > 0) found++;
    results.push(r);
    checked++;
    opts.onProgress?.({ checked, total, found, totalHits, newResults: [r] });
  })));
  return results;
}
