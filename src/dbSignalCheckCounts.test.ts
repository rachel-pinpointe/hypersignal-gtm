// A saved Signal Check must never advertise more signals than it has.
//
// signal_checks.found / total_hits were written while the check ran and never revisited, and they
// derive from signal_check_results.$.signals — a JSON snapshot, not from the `signals` table. So
// every path that deletes a signal afterwards (each of the six repair scripts, and any future one)
// left the header frozen at its original number while the feed beneath it shrank.
//
// Measured on the live database: the "Docxster Signal Check" showed 773 signals across 152 of 1,280
// domains where the truth was 107 across 48 — a 7.2x overstatement, and one the user cannot
// reconcile with what is on screen, because the list underneath is drawn from `signals`.
//
// account_searches never had this bug: db.ts re-derives its total from account_search_hits on every
// write. This one derived from a snapshot instead of from the rows, which is the whole difference.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbCreateSignalCheck, dbSignalCheckProgress, dbInsertSignal, dbListSignalChecks, dbGetSignalCheck, dbRederiveSignalCheckCounts } from "./db.ts";

const ID = "sc-count-test";

const seed = () => {
  db.prepare("DELETE FROM signals WHERE check_id = ?").run(ID);
  db.prepare("DELETE FROM signal_check_results WHERE check_id = ?").run(ID);
  db.prepare("DELETE FROM signal_checks WHERE id = ?").run(ID);
  dbCreateSignalCheck(ID, "counter test", {}, 3);
  // Two domains with signals, one without — the shape the counters describe.
  // The runner stores the whole per-domain result object; the declared parameter type only pins the
  // one field this function reads. Cast so the fixture can carry the `signals` count the grid shows.
  dbSignalCheckProgress(ID, {
    newResults: [{ domain: "a.com", signals: 2 }, { domain: "b.com", signals: 1 }, { domain: "c.com", signals: 0 }] as unknown as Array<{ domain: string }>,
  });
  for (const [d, n] of [["a.com", 2], ["b.com", 1]] as const) {
    for (let i = 0; i < n; i++) {
      dbInsertSignal({ dedupKey: `${ID}:${d}:${i}`, domain: d, company: "Test", type: "news-other", title: `t${i}`, checkId: ID });
    }
  }
};

test("the header counts the signals that exist, not the ones that once did", () => {
  seed();
  const before = dbListSignalChecks().find((c) => c.id === ID)!;
  assert.equal(before.totalHits, 3, "fixture must start at 3, or this proves nothing");
  assert.equal(before.found, 2);

  // What every repair script does: delete a signal directly. Nothing updates the stored columns.
  db.prepare("DELETE FROM signals WHERE check_id = ? AND domain = 'a.com'").run(ID);

  const after = dbListSignalChecks().find((c) => c.id === ID)!;
  assert.equal(after.totalHits, 1, "the list header must not still claim 3");
  assert.equal(after.found, 1, "…nor still claim two domains had signals");
  const detail = dbGetSignalCheck(ID)!;
  assert.equal(detail.totalHits, 1, "the detail header must agree with the list");
  assert.equal(detail.found, 1);
  // `checked` counts domains VISITED, which deleting a signal does not change.
  assert.equal(after.checked, 3);
});

test("the repair re-derives the stored columns and the per-domain grid", () => {
  seed();
  db.prepare("DELETE FROM signals WHERE check_id = ? AND domain = 'a.com'").run(ID);
  // The stored column and the per-row JSON are both still stale at this point — the read path masks
  // the first, but the results grid reads the second directly.
  const staleRow = db.prepare("SELECT total_hits AS t FROM signal_checks WHERE id = ?").get(ID) as { t: number };
  assert.equal(staleRow.t, 3, "the stored column is expected to be stale — that is what the repair is for");

  dbRederiveSignalCheckCounts(ID);

  const fixed = db.prepare("SELECT total_hits AS t, found AS f FROM signal_checks WHERE id = ?").get(ID) as { t: number; f: number };
  assert.equal(fixed.t, 1);
  assert.equal(fixed.f, 1);
  const perDomain = db.prepare(
    "SELECT domain, json_extract(result, '$.signals') AS n FROM signal_check_results WHERE check_id = ? ORDER BY domain",
  ).all(ID) as Array<{ domain: string; n: number }>;
  assert.deepEqual(perDomain.map((r) => [r.domain, r.n]), [["a.com", 0], ["b.com", 1], ["c.com", 0]],
    "each row of the grid must agree with the signals that exist for that domain");

  db.prepare("DELETE FROM signals WHERE check_id = ?").run(ID);
  db.prepare("DELETE FROM signal_check_results WHERE check_id = ?").run(ID);
  db.prepare("DELETE FROM signal_checks WHERE id = ?").run(ID);
});
