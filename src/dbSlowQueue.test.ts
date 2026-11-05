// The paced queue must CONVERGE. It was leaking instead.
//
// Every scheduled scan enqueued every watched domain for every paced producer. The worker drains one
// item per paceMs, so once the watchlist is larger than (scan interval / paceMs) the queue is refilled
// faster than it empties and coverage freezes at whatever the first few dozen items happened to be.
//
// Measured on the live database: GDELT had reached 26 domains out of 1,313, with 947 queued — and the
// queue GREW by 54 items during four hours of observation. 802 of those had never been attempted once,
// while 81 sat at attempts=7 cycling errors that do not clear on a retry ("HTTP 429" x39, "aborted due
// to timeout" x59, "fetch failed" x47), each holding a slot the worker could have spent on a domain it
// had never looked at.
//
// Two rules fix it, and both are tested here:
//   1. Don't re-ask a question whose answer is still good — recheckDays.
//   2. Don't retry forever — drop at the attempt cap and let the next scan re-queue.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbEnqueueSlow, dbDeferSlow, dbDoneSlow, SLOW_MAX_ATTEMPTS } from "./db.ts";

const P = "test-paced";
const D = "convergence-test.example";

const reset = () => {
  db.prepare("DELETE FROM slow_queue WHERE producer = ?").run(P);
  db.prepare("DELETE FROM domain_flags WHERE producer = ?").run(P);
};
const depth = () =>
  (db.prepare("SELECT COUNT(*) AS c FROM slow_queue WHERE producer = ?").get(P) as { c: number }).c;
const flagged = (agoDays: number) =>
  db.prepare(`INSERT OR REPLACE INTO domain_flags (domain, producer, hit, summary, checked_at)
              VALUES (?, ?, 0, 'seeded', datetime('now', ?))`).run(D, P, `-${agoDays} days`);

test("with no recheck window, every scan re-queues the domain (the old behaviour)", () => {
  reset();
  flagged(0);                                  // checked seconds ago…
  dbEnqueueSlow(P, D, "c", null);              // …and still queued, because nothing asks.
  assert.equal(depth(), 1);
  reset();
});

test("a domain checked inside the recheck window is not re-queued", () => {
  reset();
  flagged(2);                                  // answered 2 days ago
  dbEnqueueSlow(P, D, "c", null, 7);           // good for 7 — skip it
  assert.equal(depth(), 0, "a fresh answer must not occupy a queue slot");
  reset();
});

test("a domain checked before the window has gone stale and IS re-queued", () => {
  reset();
  flagged(9);                                  // answered 9 days ago
  dbEnqueueSlow(P, D, "c", null, 7);           // stale — ask again
  assert.equal(depth(), 1, "a stale answer must be re-asked");
  reset();
});

test("a domain never checked at all is always queued, window or not", () => {
  reset();
  dbEnqueueSlow(P, D, "c", null, 7);           // no flag row exists
  assert.equal(depth(), 1, "an unanswered domain must never be skipped");
  reset();
});

test("repeated failure drops the item at the cap instead of holding a slot forever", () => {
  reset();
  dbEnqueueSlow(P, D, "c", null, 7);
  // Fail it up to — but not past — the cap. It must survive every one of these.
  for (let i = 1; i < SLOW_MAX_ATTEMPTS; i++) {
    assert.equal(dbDeferSlow(P, D, "HTTP 429"), true, `attempt ${i} must stay queued`);
    assert.equal(depth(), 1);
  }
  // The cap: the queue gives up, and says so by returning false.
  assert.equal(dbDeferSlow(P, D, "HTTP 429"), false, "at the cap the item must be dropped");
  assert.equal(depth(), 0, "a permanently failing domain must not occupy a slot forever");

  // Dropping is not forgetting: the next scan re-queues it, because there is still no answer for it.
  dbEnqueueSlow(P, D, "c", null, 7);
  assert.equal(depth(), 1, "the next scan must be free to re-ask a dropped domain");
  reset();
});

test("a successful check both empties the slot and blocks the next enqueue", () => {
  reset();
  dbEnqueueSlow(P, D, "c", null, 7);
  dbDoneSlow(P, D);
  flagged(0);                                  // the worker writes the flag on success
  assert.equal(depth(), 0);
  dbEnqueueSlow(P, D, "c", null, 7);           // the very next scan
  assert.equal(depth(), 0, "a just-answered domain must not re-enter the queue");
  reset();
});
