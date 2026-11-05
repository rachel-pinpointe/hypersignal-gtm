// Work that is found but never handed on.
//
// Delivery retires anything with no destination — a signal whose type routes nowhere is marked
// delivered the moment a pass runs, because the dashboard is then the only sink. So a row still
// sitting undelivered does NOT mean "no webhook is configured". It means NO PASS HAS EVER RUN OVER
// IT, which is a fault, and it had no way to reach the screen: every other view reads the signals and
// matches tables directly and never looks at the delivered flag.
//
// Measured on the live database: 350 signals for a realtime client, produced by the paced worker over
// the four and a half hours after the last run finished — a path with no delivery call in it at all —
// plus 110 from two one-off checks, stuck permanently because the call that would have retired them
// was guarded on a webhook being configured.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbDeliveryBacklog, dbInsertSignal } from "./db.ts";

const C = "backlog-test-client";
const CHK = "backlog-test-check";
const reset = () => {
  db.prepare("DELETE FROM signals WHERE client = ? OR check_id = ?").run(C, CHK);
};
const find = (owner: string, kind: string) =>
  dbDeliveryBacklog().owners.find((r) => r.owner === owner && r.kind === kind);

test("an undelivered signal is reported against its client", () => {
  reset();
  dbInsertSignal({ dedupKey: `${C}:1`, domain: "acme.test", company: "Acme", type: "funding",
    title: "raised", detail: null, url: null, client: C, observedAt: null });
  const row = find(C, "signals");
  assert.ok(row, "the client's undelivered signal must appear in the backlog");
  assert.equal(row!.n, 1);
  assert.ok(row!.oldest, "the backlog must say how long it has been waiting");
  reset();
});

test("a check's signals are reported under the check, not lost for having no client", () => {
  reset();
  dbInsertSignal({ dedupKey: `${CHK}:1`, domain: "beta.test", company: "Beta", type: "funding",
    title: "raised", detail: null, url: null, checkId: CHK, observedAt: null });
  // client is NULL on a check's signals — the exact reason they were invisible. They must still be
  // attributed to something an operator can act on.
  const rows = dbDeliveryBacklog().owners.filter((r) => r.owner.startsWith("check ") && r.kind === "signals");
  assert.ok(rows.some((r) => r.n >= 1), "a check's undelivered signals must be attributed to that check");
  reset();
});

test("once delivered, a signal leaves the backlog", () => {
  reset();
  dbInsertSignal({ dedupKey: `${C}:2`, domain: "gamma.test", company: "Gamma", type: "funding",
    title: "raised", detail: null, url: null, client: C, observedAt: null });
  assert.equal(find(C, "signals")?.n, 1);
  db.prepare("UPDATE signals SET delivered = 1 WHERE client = ?").run(C);
  assert.equal(find(C, "signals"), undefined, "a delivered signal must not still read as waiting");
  reset();
});

// The headline number the System card shows must be COUNTED, not summed from the owner list.
// The list is capped at 20 per kind so the card stays readable, and owners are not few — every
// one-off check with undelivered signals is its own owner. Summing the shown rows would quietly
// undercount from the 21st owner onward: the card would report a smaller backlog than exists,
// which is the same class of defect this whole function was written to expose.
test("the headline total counts every waiting row, not just the 20 owners shown", () => {
  const capReset = () => db.prepare("DELETE FROM signals WHERE check_id LIKE 'btcap%'").run();
  capReset();
  const before = dbDeliveryBacklog();
  for (let i = 0; i < 25; i++)
    dbInsertSignal({ dedupKey: `btcap${i}:1`, domain: `d${i}.test`, company: `C${i}`, type: "funding",
      title: "raised", detail: null, url: null, checkId: `btcap${String(i).padStart(2, "0")}`, observedAt: null });

  const after = dbDeliveryBacklog();
  assert.equal(after.total, before.total + 25, "all 25 waiting rows must be counted");

  const newOwners = after.owners.filter((r) => r.owner.startsWith("check btcap"));
  assert.ok(newOwners.length <= 20, "the owner list is capped, which is what makes summing it wrong");
  assert.ok(newOwners.length < 25, "25 owners were created but the list cannot show them all");
  capReset();
});

test("nothing queued reports nothing — an empty backlog is not an error state", () => {
  reset();
  assert.equal(find(C, "signals"), undefined);
  assert.equal(find(C, "matches"), undefined);
});
