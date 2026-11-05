// Shared shapes for the multi-signal engine (sales signals beyond job posts).
//
// Every producer answers one question about ONE domain, in BOTH modes:
//   • One-off check on an uploaded list → `facts` (current state, enrichment-style).
//   • Continuous watchlist monitoring   → `signals` (DIFFS vs the stored domain_state snapshot).
// A producer's first-ever scan of a domain is baseline-only: it writes the snapshot and emits no
// signals (same "no historical flood" principle as the job-backfill webhook rule). dedup_key makes
// every emission idempotent — a re-scan can never double-fire.

/** A signal a producer wants to emit — attribution (client / check id) is added by the runner. */
export interface SignalDraft {
  dedupKey: string;          // globally unique per real-world event, e.g. "dns-tool-added:acme.com:outreach.io"
  type: string;              // e.g. "velocity-spike" | "tech-added" | "dns-mx-changed"
  title: string;             // human-readable one-liner shown in the feed
  detail?: unknown;          // JSON facts backing the signal
  url?: string | null;
  company?: string | null;
  observedAt?: string | null; // ISO — when the underlying event happened, best-known
}

/** Current-state flag for the job-finder filters + per-company panel: "does this company show this
 * producer's signal RIGHT NOW?" (e.g. running ads, raised recently, uses an ATS). Distinct from the
 * diff `signals`. Omit it (undefined) when the producer couldn't determine state (no name / unreachable)
 * so a transient failure never clears a known flag. */
export interface DomainFlag { hit: boolean; summary?: string | null }

export interface ProducerResult {
  facts: Record<string, string>; // current state for the check grid ("Open roles" → "12")
  signals: SignalDraft[];
  flag?: DomainFlag;             // present-state hit for filtering (undefined = not determined this scan)
}

export interface ProducerCtx {
  stop?: () => boolean;          // cooperative cancellation (signal checks)
  company?: string | null;       // resolved company name, for name-keyed producers
  // Read-only probe: an ad-hoc "check this domain now" that must NOT advance the diff baseline. When
  // set, producers still return facts + the current-state flag but skip dbReplaceDomainState — otherwise
  // the probe consumes the diff and a watchlist monitoring the same domain later would miss that signal.
  readonly?: boolean;
  // One-off CHECK semantics: a check is a snapshot of what's true NOW, so list-producers (news/GDELT)
  // emit their current interesting items as signals even with no baseline — under a check-scoped
  // dedupKey so they can never ON CONFLICT-block a later watchlist diff of the same story.
  snapshot?: boolean;
  // Per-run Meta Ad Library region ("ALL" = worldwide, or one ISO country), chosen on the check
  // screen. Overrides the Settings default for THIS run only. Safe because every path that sets it
  // is also `readonly` — a one-off run under a different region can never rewrite the stored
  // baseline that continuous monitoring diffs against.
  adCountry?: string;
}

export interface SignalProducer {
  key: string;                   // stable id stored in configs, e.g. "velocity"
  label: string;                 // UI checkbox label
  description: string;           // UI hint
  needsCompany?: boolean;        // name-keyed producer (EDGAR/news/WARN/apps) — runner resolves ctx.company
  // Minimum spacing this producer's API forces between calls, in ms. Set it and the producer stops
  // running inline in the scheduled scan: runClientSignals queues its domains instead and a background
  // worker drips through them at this pace (see src/signals/slowQueue.ts). Without this, one 5-second
  // API gate makes every OTHER producer for every OTHER domain wait behind it, because the scan walks
  // domains serially — that is what left GDELT reaching 24 domains where its siblings reached 1,283.
  // Interactive paths (the one-company check, a saved check with its own progress UI) still run it
  // inline: the user is watching, the cost is bounded, and they asked for it now.
  //
  // CONTRACT for a paced producer: return a `flag` whenever the check actually completed — including
  // when the answer is "nothing found". The queue worker uses `flag === undefined` (this file's
  // documented "could not determine" case) to decide the work is still owed and keep the item queued.
  // A paced producer that succeeds without a flag would be retried forever.
  paceMs?: number;
  /**
   * How many days an answer from this producer stays good enough not to ask again.
   *
   * Only meaningful alongside paceMs, and it is what makes the queue converge: without it every
   * scan re-enqueues every domain, the worker drains one per paceMs, and a watchlist bigger than
   * (scan interval / paceMs) never catches up. GDELT was at 26 domains covered of 1,313, with 947
   * queued and growing.
   */
  recheckDays?: number;
  /**
   * Is this flag worth OFFERING as a filter?
   *
   * Separate from `flagged`, which only says the producer writes a domain_flags row. Both tech and
   * dns do — and both are true for almost everything, so as filter options they exclude nothing.
   * Measured across the whole flags table:
   *
   *   tech  198/198 = 100.0%      ats            1.9%
   *   dns   215/238 =  90.3%      warn           2.2%
   *                               news           2.0%
   *                               velocity       4.7%
   *
   * That is not a coincidence, it is the predicate: "this site uses any detectable technology" and
   * "this domain has any DNS-visible tool" are true by construction. Offering them beside genuinely
   * selective producers meant selecting one returned the unfiltered list — which the user then reads
   * as evidence rather than as a filter that did nothing.
   *
   * The flag itself is kept: it still powers the per-company "Why now" chip, where "uses Klaviyo and
   * HubSpot" is genuinely useful. Only the FILTER is withdrawn. Defaults to `flagged`.
   */
  filterable?: boolean;
  /**
   * Does this producer answer a CURRENT-STATE question — one whose answer can flip back to false —
   * and therefore write a `domain_flags` row you can filter accounts by?
   *
   * Declared here because the UI had its own hand-written list of six (`FILTERABLE_SIGNALS` in
   * web/app.js) and the two drifted, in both directions at once. "Running Meta ads" was offered as a
   * filter while adActivity returned no flag from any exit, so selecting it matched nothing, ever.
   * Meanwhile dns, tech stack, subdomains, news, GDELT and Companies House all wrote flags that
   * nothing in the UI would let you filter on. One list, owned by the producers, cannot drift.
   *
   * Product Hunt is the one producer that deliberately opts out: a launch is a one-day event, so a
   * `hit` could never transition back to false and the row would be permanently stale. It stays a
   * feed signal only. See the comment at the end of launches.ts.
   */
  flagged?: boolean;
  check(domain: string, ctx: ProducerCtx): Promise<ProducerResult>;
}
