// Boot-time reconciliation of work that was in flight when the process died.
//
// Three tables record "this is happening right now": account_searches.status, signal_checks.status,
// and fetch_runs (which has no status column — a run is open while finished_at is NULL). All three
// mean the same thing, and all three can only be true of a process that is still alive. A restart
// makes every such row a lie.
//
// Two of the three were reconciled at boot; fetch_runs was missed. Production had 5 of 11 runs stuck
// open, three started exactly on a scheduled half-hour, and the System panel rendered each as
// "running…" with a duration of now-minus-started_at that had been climbing for days.
//
// The test asserts the invariant across ALL THREE tables rather than just the one that was broken —
// this defect was a table being left out of a list, so a test covering only fetch_runs would let the
// next addition repeat it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, reconcileOrphanedRuns } from "./db.ts";

const one = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { c: number }).c;
const reset = () => {
  db.prepare("DELETE FROM fetch_runs WHERE client LIKE 'orph-%'").run();
  db.prepare("DELETE FROM account_searches WHERE id LIKE 'orph-%'").run();
  db.prepare("DELETE FROM signal_checks WHERE id LIKE 'orph-%'").run();
};

test("a fetch run left open by a dead process is closed at boot", () => {
  reset();
  db.prepare(`INSERT INTO fetch_runs (fetch_key, client, kind, started_at, fetched, fresh, matched)
              VALUES ('orph:k', 'orph-dead', 'search', datetime('now','-3 days'), 7, 5, 2)`).run();
  assert.equal(one("SELECT COUNT(*) c FROM fetch_runs WHERE client='orph-dead' AND finished_at IS NULL"), 1,
    "fixture must actually be an open run, or this proves nothing");

  reconcileOrphanedRuns();

  const r = db.prepare("SELECT started_at, finished_at, error, fetched, fresh, matched FROM fetch_runs WHERE client='orph-dead'")
    .get() as { started_at: string; finished_at: string | null; error: string | null; fetched: number; fresh: number; matched: number };
  assert.ok(r.finished_at, "an orphaned run must not stay open — the panel shows it as 'running…' forever");
  assert.equal(r.finished_at, r.started_at,
    "dating it 'now' would report a duration that includes however long the app was switched off");
  assert.match(String(r.error), /interrupted/i, "the row must say why it has no real end time");
  assert.deepEqual([r.fetched, r.fresh, r.matched], [7, 5, 2], "partial results are kept, not zeroed");
  reset();
});

test("a run that finished normally is left completely alone", () => {
  reset();
  db.prepare(`INSERT INTO fetch_runs (fetch_key, client, kind, started_at, finished_at, fetched, error)
              VALUES ('orph:k2', 'orph-ok', 'search', datetime('now','-2 hours'), datetime('now','-1 hours'), 99, NULL)`).run();
  reconcileOrphanedRuns();
  const r = db.prepare("SELECT finished_at, error FROM fetch_runs WHERE client='orph-ok'")
    .get() as { finished_at: string; error: string | null };
  assert.equal(r.error, null, "a completed run must not be relabelled as interrupted");
  assert.ok(r.finished_at.includes(":"), "its real finish time must survive");
  reset();
});

test("reconciling twice does not rewrite the first result", () => {
  // It runs on every boot, so it has to be idempotent — otherwise a second restart would overwrite
  // finished_at again and the recorded duration would drift.
  reset();
  db.prepare(`INSERT INTO fetch_runs (fetch_key, client, kind, started_at)
              VALUES ('orph:k3', 'orph-twice', 'search', datetime('now','-5 days'))`).run();
  reconcileOrphanedRuns();
  const first = db.prepare("SELECT finished_at, error FROM fetch_runs WHERE client='orph-twice'").get();
  reconcileOrphanedRuns();
  assert.deepEqual(db.prepare("SELECT finished_at, error FROM fetch_runs WHERE client='orph-twice'").get(), first);
  reset();
});

test("no table that records in-flight work is left out of the reconcile", () => {
  // The defect was an omission from a list, so this asserts the whole list rather than the one entry
  // that was missing. A fourth table with the same shape must be added here and to the function.
  reset();
  db.prepare(`INSERT INTO account_searches (id, name, params, status, created_at, updated_at)
              VALUES ('orph-as', 'orph', '{}', 'running', datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT INTO signal_checks (id, name, params, status, created_at, updated_at)
              VALUES ('orph-sc', 'orph', '{}', 'running', datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT INTO fetch_runs (fetch_key, client, kind) VALUES ('orph:k4', 'orph-fr', 'search')`).run();

  reconcileOrphanedRuns();

  assert.equal(one("SELECT COUNT(*) c FROM account_searches WHERE id='orph-as' AND status='running'"), 0, "account_searches");
  assert.equal(one("SELECT COUNT(*) c FROM signal_checks WHERE id='orph-sc' AND status='running'"), 0, "signal_checks");
  assert.equal(one("SELECT COUNT(*) c FROM fetch_runs WHERE client='orph-fr' AND finished_at IS NULL"), 0, "fetch_runs");
  reset();
});
