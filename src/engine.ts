// Central controller: holds the active client set and re-applies schedules when
// config changes (so UI edits take effect without a restart).
import { createHash } from "node:crypto";
import { loadClients, seedFromYaml } from "./config.ts";
import { startSchedules, stopSchedules } from "./scheduler.ts";
import { backfillMatchesSteps } from "./ingest.ts";
import { dbPurgeOrphans, dbBackfillDomains, dbSweepClosed, dbGetSettings, dbGetSetting, dbSetSetting } from "./db.ts";
import { setGateProfile } from "./sources/hcGate.ts";
import type { ClientConfig } from "./types.ts";

let clients: ClientConfig[] = [];

export function getClients(): ClientConfig[] {
  return clients;
}

// The full match reconcile (backfillMatches) walks every stored job × every client — cheap per call but
// O(jobs) overall, so on a big pool it's wasted work when nothing that affects matching has changed.
// Fingerprint ONLY the match-relevant config (name/active/kind/search — NOT delivery/cadence) so a plain
// restart, or a webhook/schedule-only edit, skips the reconcile entirely, while adding or editing a
// search/watchlist (which genuinely needs a backfill against historical jobs) still triggers it.
const FP_KEY = "matchBackfillFingerprint";
function matchFingerprint(cs: ClientConfig[]): string {
  const rel = cs
    .map((c) => ({ name: c.name, active: c.active !== false, kind: c.kind ?? "search", search: c.search ?? null }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash("sha1").update(JSON.stringify(rel)).digest("hex");
}

/** Reload configs and reconcile the DB to them: restart all schedules, and (when the match config
 *  changed) backfill matches. `opts.force` runs the reconcile regardless of the fingerprint;
 *  `opts.backfill:false` skips it entirely.
 *
 *  SYNCHRONOUS — every step blocks the event loop for
 *  its whole duration, and because node:sqlite is synchronous that is the whole server, not one
 *  route. Use it at boot (nothing is being served yet); everywhere else prefer reloadAsync. */
export function reload(opts: { backfill?: boolean; force?: boolean } = {}): ClientConfig[] {
  clients = loadClients();
  for (const [, step] of reconcileSteps(opts)) {
    const sub = step();
    if (sub) while (!sub.next().done) { /* drain: no yielding at boot, nothing is being served yet */ }
  }
  return clients;
}

/** Same reconcile, yielding to the event loop between steps — AND, for the long ones, between chunks
 *  inside a step — so a config save does not freeze the dashboard.
 *
 *  A step may return a generator; each `yield` is a point where all its work so far is committed and
 *  the loop can be handed back, so a long step costs one chunk instead of the whole run.
 *
 *  Measured end to end on a copy of the 16,275-job production DB, polling the server throughout a
 *  real config save: the worst request stall was 722ms before (the match backfill alone logged a
 *  516ms block) and 23ms after — below this machine's 34ms idle jitter. Two changes got there:
 *  chunking the match backfill, which took it to 129ms, and then indexing dbSweepClosed's two
 *  full-table scans, which had quietly become the longest remaining block. Anything over 250ms is
 *  still logged BY NAME, so a regression shows up in the log rather than only being felt. */
export async function reloadAsync(opts: { backfill?: boolean; force?: boolean } = {}): Promise<ClientConfig[]> {
  clients = loadClients();
  // Anything blocking longer than this gets named in the log, so a regression is visible rather than
  // just felt. Lower it via RECONCILE_LOG_MS when hunting a stall.
  const limit = Number(process.env.RECONCILE_LOG_MS ?? 250);
  let worst = 0, worstName = "";
  const note = (name: string, ms: number, kind: string) => {
    if (ms > worst) { worst = ms; worstName = name; }
    if (ms > limit) console.log(`[engine] reconcile ${kind} "${name}" blocked the loop for ${ms}ms`);
  };
  for (const [name, step] of reconcileSteps(opts)) {
    await new Promise((r) => setImmediate(r));
    const t = Date.now();
    const sub = step(); // a generator function returns without running its body — no work happens here
    if (!sub) { note(name, Date.now() - t, "step"); continue; }
    // A chunked step: run one chunk, breathe, repeat. Each next() is one uninterrupted block of the
    // loop, so that — not the step as a whole — is what we time.
    for (;;) {
      const t0 = Date.now();
      const done = sub.next().done;
      note(name, Date.now() - t0, "chunk of");
      if (done) break;
      await new Promise((res) => setImmediate(res));
    }
  }
  if (worst > limit) console.log(`[engine] reconcile done — worst single block ${worst}ms ("${worstName}")`);
  return clients;
}

/** The reconcile, as discrete steps so both entry points run exactly the same work in the same order
 *  — the async one just breathes between them. A step that returns a generator is asking to be run in
 *  chunks, with a breath allowed at every yield. */
function reconcileSteps(opts: { backfill?: boolean; force?: boolean }): Array<[string, () => Generator<void> | void]> {
  return [
    ["purge-orphans", () => {
      const purged = dbPurgeOrphans(); // drop matches for clients that no longer exist
      if (purged) console.log(`[engine] purged ${purged} orphaned match(es) from deleted client(s)`);
    }],
    ["backfill-domains", () => {
      const filled = dbBackfillDomains(); // compute employer domain for any rows missing it
      if (filled) console.log(`[engine] backfilled domain on ${filled} job(s)`);
    }],
    ["sweep-closed", () => {
      const swept = dbSweepClosed(); // close expired / long-unseen jobs
      if (swept.expired || swept.stale) console.log(`[engine] closed ${swept.expired} expired + ${swept.stale} stale job(s)`);
    }],
    ["restart-schedules", () => { stopSchedules(); startSchedules(clients); }],
    ["match-backfill", () => reconcileMatches(opts)],
  ];
}

/** The match backfill, chunked. The fingerprint is written only AFTER the backfill completes, which is
 *  exactly what makes committing in chunks safe: if the process dies (or a chunk throws) partway
 *  through, the stored fingerprint still refers to the old config, so the next reload runs the whole
 *  reconcile again over an idempotent operation. */
function* reconcileMatches(opts: { backfill?: boolean; force?: boolean }): Generator<void> {
  if (opts.backfill === false) return;
  const fp = matchFingerprint(clients);
  if (!opts.force && fp === dbGetSetting(FP_KEY)) {
    console.log("[engine] match config unchanged — skipping match backfill (nothing to reconcile)");
    return;
  }
  yield* backfillMatchesSteps(clients);
  dbSetSetting(FP_KEY, fp);
}

/** First boot: seed YAML → DB (for new clients), then reload. */
export function init(): ClientConfig[] {
  seedFromYaml();
  setGateProfile(dbGetSettings().fetchSpeed); // apply the saved speed dial before schedules start
  return reload();
}
