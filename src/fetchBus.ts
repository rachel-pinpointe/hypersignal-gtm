// In-memory pub/sub for fetch activity. EVERY fetch — Client Monitoring search, Account Monitoring
// watchlist, or an Account Check — reports start/progress/done here, and the dashboard's /api/activity
// SSE feed renders it live (the in-view progress bar + the top-right "active fetches" dock). A tab that
// opens mid-fetch gets the current state from the snapshot, so it never misses an in-flight run.

export type FetchKind = "search" | "watchlist" | "account-check" | "signal-check";

export interface FetchActivity {
  key: string;          // unique id: clientKey(name) for monitoring, accountKey(id) for account checks
  client: string;       // display label (client/watchlist/check name)
  kind: FetchKind;      // drives the dock's type chip + which view shows it prominently
  phase: "running" | "done" | "error";
  total: number;        // units of work (keyword sources count 1 each; a watchlist counts each domain; a check counts each domain)
  completed: number;    // units finished
  fetched: number;      // postings seen (cumulative)
  fresh: number;        // NEW postings / hits found (cumulative) — the headline counter
  matched: number;      // matched against this client (cumulative)
  startedAt: number;    // epoch ms
  error?: string;
  /**
   * WHAT IT IS DOING WHEN THE COUNTERS CANNOT MOVE.
   *
   * A watchlist run probes every watched domain for a job board BEFORE it fetches anything, and on a
   * cold cache that is the longest part of the run by far. Measured on the live app: a 7,470-company
   * watchlist with an emptied cache had 5,967 domains left to probe at ~4 a second — 25 minutes
   * during which the dock read "0 new jobs found · 0 matched" and the bar did not move, because
   * fetched/fresh/matched are all genuinely zero and the unit total is not known yet.
   *
   * There was no way to tell that from a hung process, and it does not look like progress; it looks
   * broken. The counters were honest and the screen still misinformed, which is the same failure the
   * System cards keep turning up: a real state with nothing on screen naming it.
   */
  note?: string;
  /** Set on the "done" payload when the run ended because the user asked it to stop (not an error
   *  and not a natural finish). Lets the dashboard say "Stopped" instead of "Done — 0 new". */
  stopped?: boolean;
}

// Stable key builders so producers and the overlap guard agree on the map key.
export const clientKey = (name: string) => "client:" + name;
export const accountKey = (id: string) => "ac:" + id;

type Listener = (event: string, data: FetchActivity) => void;
const listeners = new Set<Listener>();
const active = new Map<string, FetchActivity>(); // keyed by FetchActivity.key
// Keys whose run has been asked to stop. A producer polls isStopRequested(key) at its own safe
// points — between sources, and between domains during ATS discovery — so in-flight network work
// finishes and everything already scraped is kept; only queued units are skipped.
const stopRequested = new Set<string>();

export function subscribeFetch(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
/** Snapshot of in-flight fetches — sent to a newly-connected feed so it can catch up. */
export function activeFetches(): FetchActivity[] { return [...active.values()]; }

function broadcast(event: string, data: FetchActivity): void { for (const l of [...listeners]) { try { l(event, data); } catch { /* a dead listener must not break the run */ } } }

export function fetchStarted(key: string, info: { client: string; kind: FetchKind; total: number }): void {
  stopRequested.delete(key); // clear any stale request left by a prior run of this key
  active.set(key, { key, client: info.client, kind: info.kind, phase: "running", total: info.total, completed: 0, fetched: 0, fresh: 0, matched: 0, startedAt: Date.now() });
  broadcast("start", active.get(key)!);
}
/** Correct the unit total after the run has already claimed its key. Needed because the overlap
 *  guard must claim the key synchronously (see runClientSources), but the real unit count is only
 *  known after an awaited ATS-discovery step. */
export function fetchSetTotal(key: string, total: number): void {
  const a = active.get(key);
  if (!a) return;
  a.total = total;
  broadcast("progress", a);
}
/** Say what a phase that cannot move the counters is doing. Pass null to clear it once real work
 *  starts — a stale note is worse than none, because it describes a step that already finished. */
export function fetchNote(key: string, note: string | null): void {
  const a = active.get(key);
  if (!a) return;
  if (note) a.note = note; else delete a.note;
  broadcast("progress", a);
}
export function fetchProgress(key: string, p: { completed: number; fetched: number; fresh: number; matched: number }): void {
  const a = active.get(key);
  if (!a) return;
  a.completed = p.completed; a.fetched = p.fetched; a.fresh = p.fresh; a.matched = p.matched;
  broadcast("progress", a);
}
export function fetchDone(key: string, totals: { fetched: number; fresh: number; matched: number }, error?: string, stopped?: boolean): void {
  const a = active.get(key);
  const done: FetchActivity = {
    key, client: a?.client ?? key, kind: a?.kind ?? "search",
    phase: error ? "error" : "done",
    total: a?.total ?? 0, completed: a?.total ?? 0,
    fetched: totals.fetched, fresh: totals.fresh, matched: totals.matched,
    startedAt: a?.startedAt ?? Date.now(), error,
    stopped: stopped || undefined,
  };
  active.delete(key);
  stopRequested.delete(key); // the run is over — never carry a request into its next run
  broadcast("done", done);
}
/** Ask the fetch running under `key` to stop gracefully. In-flight work finishes and everything
 *  already scraped is kept; queued units are skipped. Returns whether a fetch was actually live to
 *  receive the request (false = nothing running, so the button should just re-sync). */
export function requestFetchStop(key: string): boolean {
  const a = active.get(key);
  if (!a) return false;
  stopRequested.add(key);
  a.note = "Stopping — finishing the current step, then wrapping up";
  broadcast("progress", a);
  return true;
}
/** Has a graceful stop been requested for this key? Producers poll this at their safe points. */
export function isStopRequested(key: string): boolean { return stopRequested.has(key); }
/** Is a fetch currently running for this key? (Used to prevent overlapping manual + scheduled runs.) */
export function isFetching(key: string): boolean { return active.has(key); }
/** Is ANY fetch running? Used by auto-quit so closing the window can't kill work in flight. */
export function isAnyFetching(): boolean { return active.size > 0; }
