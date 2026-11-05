// Background drip worker for rate-limited producers (any producer declaring `paceMs`).
//
// THE PROBLEM IT SOLVES. runClientSignals walks a watchlist's domains SERIALLY, awaiting all of that
// domain's producers before moving to the next. GDELT permits about one lookup every 5.2 seconds and
// serialises its own calls to respect that. Put those together and the gate is not GDELT's alone: the
// whole scan advances at one domain per 5.2s, so a 1,300-domain watchlist needs ~1.9 hours before it
// finishes — and every other producer sits idle waiting its turn. Runs ended long before that, which
// is why GDELT had covered 24 domains while its siblings had covered 1,283.
//
// THE SHAPE OF THE FIX. The scan no longer waits. It writes the domain into `slow_queue` and returns
// at full speed. This worker owns the pacing, independently of whether a scan is running: one item,
// then the producer's own gap, then the next. Nothing gets faster — GDELT's limit is GDELT's — but
// nothing else is stuck behind it, and coverage now accumulates continuously instead of restarting
// from the top of the list every scan.
//
// WHY A TABLE AND NOT AN IN-MEMORY QUEUE. Work owed must outlive the process. This app quits itself
// when the dashboard closes (autoShutdown), so an in-memory queue would throw away hours of pending
// coverage on every close, and a 1,300-item queue would never drain in one sitting. Rows persist,
// the worker resumes where it stopped, and a failing domain carries its own backoff across restarts.
import { dbTakeSlow, dbDoneSlow, dbDeferSlow, dbInsertSignal, dbSetDomainFlag } from "../db.ts";
import { SIGNAL_PRODUCERS, producerByKey } from "./index.ts";
import { resolveCompanyIdentity } from "./company.ts";

/** Producers that declare a pace — these run in the queue, not inline in a scheduled scan. */
export const pacedProducers = (): string[] => SIGNAL_PRODUCERS.filter((p) => p.paceMs).map((p) => p.key);
export const isPaced = (key: string): boolean => !!producerByKey(key)?.paceMs;

// In-flight count, exported so server.ts's auto-quit can see it. The IDLE worker must never hold the
// process open (see start()), but killing it mid-item is a different matter: a producer commits its
// new diff baseline inside check() while the caller inserts the resulting signals afterwards, so a
// process death between those two writes consumes the diff without ever emitting its event — the
// change is gone, not delayed. One item is at most a few seconds; wait for it.
let inFlight = 0;
export const slowWorkInFlight = (): boolean => inFlight > 0;

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Who to tell when this worker has produced signals for a client, and the queue has gone quiet.
 *
 * The worker INSERTS signals; it never delivered them. Delivery runs from exactly three places — a
 * scheduled run, an on-demand scan, and the boot backlog flush — and this worker is none of them. So
 * everything it found sat queued until the app was next restarted or the client was next scanned.
 * For a realtime client, whose contract is "send it as soon as we have it", that is the whole promise
 * broken: measured on the live database, 350 signals for one realtime client, produced by this worker
 * over the four and a half hours after the last run finished, none of them delivered.
 *
 * Injected rather than imported so this module keeps knowing nothing about delivery or client config
 * (index.ts wires it at boot). Undefined = nobody wired it, which is what the tests run with.
 */
let onSignals: ((clients: string[]) => Promise<void>) | null = null;
export function setSlowQueueDelivery(fn: (clients: string[]) => Promise<void>): void { onSignals = fn; }
/** Clients this worker has produced signals for since the last flush. */
const pendingClients = new Set<string>();

/** Process exactly one queued item for `producer`. Returns false when the queue had nothing due.
 *  Exported for the tests — the soft-failure path below is the part worth pinning down. */
export async function drainOne(producerKey: string): Promise<boolean> {
  const item = dbTakeSlow(producerKey);
  if (!item) return false;
  const producer = producerByKey(producerKey);
  if (!producer) { dbDoneSlow(producerKey, item.domain); return true; }   // producer removed from the build

  inFlight++;
  try {
    // The scan usually resolved the name already and stored it with the item; only pay for a lookup
    // when it didn't (a domain queued before the name was known).
    let company = item.company;
    if (!company && producer.needsCompany) {
      // Keyable name only — see resolveCompanyIdentity.
      try { const id = await resolveCompanyIdentity(item.domain); company = id.keyable ? id.name : null; } catch { /* stem fallback inside */ }
    }
    const out = await producer.check(item.domain, { company });

    // Producers FAIL SOFT: an unreachable site or a rate-limit page is reported as a fact and a normal
    // return, not a throw. So "it returned" is not "it did the work" — and treating it as such
    // silently burned the queue slot. Caught live: GDELT's fetch failed, and the domain was deleted
    // from the queue as if it had been checked. The domain would then not be looked at again until
    // the next full scan, which is exactly the coverage loss this queue exists to prevent.
    //
    // The signal is already in the contract: types.ts defines `flag: undefined` as "the producer could
    // not determine state (no name, unreachable)". Undetermined means the work is still owed, so the
    // item stays queued and backs off. A paced producer must therefore return a flag when it succeeds
    // — GDELT does, on both the "found funding" and "found none" paths.
    if (out.flag === undefined) {
      const why = Object.values(out.facts)[0] ?? "producer could not determine state";
      const kept = dbDeferSlow(producerKey, item.domain, String(why));
      console.warn(`[slowqueue] ${producerKey}@${item.domain} inconclusive, `
        + `${kept ? "staying queued" : "giving up for now, will re-queue on the next scan"}: ${why}`);
      return true;
    }

    dbSetDomainFlag(item.domain, producerKey, out.flag.hit, out.flag.summary);
    if (out.signals.length && item.client) pendingClients.add(item.client);
    for (const s of out.signals) {
      dbInsertSignal({
        dedupKey: s.dedupKey, domain: item.domain, company: s.company ?? null, type: s.type,
        title: s.title, detail: s.detail, url: s.url ?? null,
        client: item.client, observedAt: s.observedAt ?? null,
      });
    }
    dbDoneSlow(producerKey, item.domain);
  } catch (e) {
    // Producers are meant to fail soft and return facts rather than throw; if one throws anyway, the
    // item stays queued with a growing backoff instead of being silently dropped.
    const msg = (e as Error).message;
    const kept = dbDeferSlow(producerKey, item.domain, msg);
    console.warn(`[slowqueue] ${producerKey}@${item.domain} failed`
      + `${kept ? "" : " too many times, dropping until the next scan"}: ${msg}`);
  } finally {
    inFlight--;
  }
  return true;
}

/** Start the drip. Idempotent — calling it twice does not create a second worker. */
export function startSlowQueue(): void {
  if (timer || stopped) return;
  const paced = SIGNAL_PRODUCERS.filter((p) => p.paceMs);
  if (!paced.length) return;
  // One shared cadence: the fastest declared pace. Each producer's own client-side gate still applies
  // (gdeltSerial sleeps to its 5.2s), so this only decides how often we LOOK for work, never how hard
  // we hit an API. When the queue is empty we idle at 60s — a scan that enqueues work will be picked
  // up within a minute, which is nothing against a queue measured in hours.
  const tickMs = Math.min(...paced.map((p) => p.paceMs!));
  const IDLE_MS = 60_000;

  const tick = async () => {
    timer = null;
    if (stopped) return;
    let worked = false;
    for (const p of paced) {
      if (stopped) break;
      try { worked = (await drainOne(p.key)) || worked; }
      catch (e) { console.warn(`[slowqueue] ${p.key} tick failed: ${(e as Error).message}`); }
    }
    if (stopped) return;
    // Flush when the queue goes QUIET, not after every item. A paced producer emits one signal every
    // few seconds; delivering per item would fire a webhook POST per signal. Waiting for idle batches
    // a drain into one delivery, and "idle" here is at most tickMs away — seconds, not the hours the
    // backlog used to wait for the next boot.
    if (!worked && pendingClients.size && onSignals) {
      const names = [...pendingClients];
      pendingClients.clear();
      // Never let a delivery failure kill the worker: the rows stay queued and the next flush (or the
      // boot backlog sweep) retries them, exactly as the fetch path already behaves.
      try { await onSignals(names); }
      catch (e) { console.warn(`[slowqueue] delivery flush failed, still queued: ${(e as Error).message}`); }
    }
    arm(worked ? tickMs : IDLE_MS);
  };
  const arm = (ms: number) => {
    timer = setTimeout(() => { void tick(); }, ms);
    // unref: an idle worker must NOT be the reason the process stays alive. Auto-shutdown exists so
    // the app closes with the dashboard; a queue with hours of work left would otherwise pin it open
    // forever. The queue is on disk — whatever is unfinished resumes on the next boot.
    timer.unref?.();
  };
  arm(1000);
  console.log(`[slowqueue] worker started for: ${paced.map((p) => `${p.key} (1 per ${Math.round(p.paceMs! / 1000)}s)`).join(", ")}`);
}

/** Stop the drip (graceful shutdown). Any item mid-flight is awaited by the caller via slowWorkInFlight. */
export function stopSlowQueue(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}
