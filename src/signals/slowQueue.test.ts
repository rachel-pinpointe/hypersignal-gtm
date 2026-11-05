// The queue that keeps a 5-second-per-call producer from setting the pace of the whole scan.
//
// The properties tested here are the ones whose failure is silent rather than loud:
//   - re-queuing must not duplicate, or a watchlist scanned hourly grows the queue without bound
//     and the oldest domains are never reached
//   - a failure must not drop the item, or coverage quietly shrinks every time a site is down
//   - a failure must not leave it immediately due either, or one dead domain eats the whole drip
//   - success must delete, or "queued" stops meaning "still owed" and the depth readout is a lie
// Run: npx tsx --test src/signals/slowQueue.test.ts   (via scripts/test.mjs, which isolates SIGNAL_DB)
import { test } from "node:test";
import assert from "node:assert/strict";
import { dbEnqueueSlow, dbTakeSlow, dbDoneSlow, dbDeferSlow, dbSlowQueueStats, dbClearSlow, dbGetDomainFlags } from "../db.ts";
import { gdeltProducer } from "./gdelt.ts";
import { SIGNAL_PRODUCERS } from "./index.ts";
import { drainOne } from "./slowQueue.ts";
import type { ProducerResult, SignalProducer } from "./types.ts";

const P = "testproducer";

test("re-queuing the same domain updates it instead of duplicating", () => {
  dbClearSlow(P);
  dbEnqueueSlow(P, "acme.test", "Client A", null);
  dbEnqueueSlow(P, "acme.test", "Client A", "Acme Inc");
  dbEnqueueSlow(P, "acme.test", "Client A", null);   // a later scan that hadn't resolved the name
  const stats = dbSlowQueueStats().find((s) => s.producer === P);
  assert.equal(stats?.queued, 1, "an hourly scan must not grow the queue by one row per run");
  const item = dbTakeSlow(P);
  assert.equal(item?.company, "Acme Inc", "a known name must not be overwritten with null by a later enqueue");
});

test("items come out oldest-first, so nothing starves at the back", () => {
  dbClearSlow(P);
  for (const d of ["one.test", "two.test", "three.test"]) dbEnqueueSlow(P, d, "Client A", null);
  assert.equal(dbTakeSlow(P)?.domain, "one.test");
  dbDoneSlow(P, "one.test");
  assert.equal(dbTakeSlow(P)?.domain, "two.test");
});

test("success removes the item; the next scan is what re-adds it", () => {
  dbClearSlow(P);
  dbEnqueueSlow(P, "acme.test", "Client A", null);
  dbDoneSlow(P, "acme.test");
  assert.equal(dbTakeSlow(P), null);
  assert.equal(dbSlowQueueStats().find((s) => s.producer === P), undefined);
});

test("a failure keeps the item but pushes it out of the way", () => {
  dbClearSlow(P);
  dbEnqueueSlow(P, "down.test", "Client A", null);
  dbEnqueueSlow(P, "up.test", "Client A", null);
  dbDeferSlow(P, "down.test", "feed unavailable");

  const next = dbTakeSlow(P);
  assert.equal(next?.domain, "up.test", "a deferred domain must not keep winning the queue head");

  const stats = dbSlowQueueStats().find((s) => s.producer === P);
  assert.equal(stats?.queued, 2, "a failure must not drop the item — that would silently shrink coverage");
  assert.equal(stats?.ready, 1, "the deferred one is not ready yet");
  assert.equal(stats?.failing, 1);
});

test("backoff grows with repeated failures", () => {
  dbClearSlow(P);
  dbEnqueueSlow(P, "down.test", "Client A", null);
  for (let i = 0; i < 3; i++) dbDeferSlow(P, "down.test", "still down");
  const stats = dbSlowQueueStats().find((s) => s.producer === P);
  assert.equal(stats?.queued, 1);
  assert.equal(stats?.ready, 0, "still backed off after three failures");
  dbClearSlow(P);
});

// A soft failure must not consume the slot. This is the bug the first live run produced: GDELT's
// fetch failed, the producer reported it as a fact and returned normally (producers fail soft by
// design), and the worker deleted the item as if it had been checked — so that company would not be
// looked at again until the next full scan. Silent coverage loss, no error anywhere.
const fake = (result: ProducerResult): SignalProducer => ({
  key: "faketest", label: "Fake", description: "test only", paceMs: 1000,
  check: async () => result,
});
const withFake = async (result: ProducerResult, fn: () => Promise<void>) => {
  SIGNAL_PRODUCERS.push(fake(result));
  try { await fn(); } finally { SIGNAL_PRODUCERS.pop(); dbClearSlow("faketest"); }
};

test("an inconclusive check keeps the item queued instead of dropping it", async () => {
  // flag undefined = types.ts's documented "could not determine" — unreachable site, rate limit, no name.
  await withFake({ facts: { Status: "feed unavailable" }, signals: [] }, async () => {
    dbEnqueueSlow("faketest", "down.test", "Client A", "Down Inc");
    assert.equal(await drainOne("faketest"), true, "it had an item to work on");
    const stats = dbSlowQueueStats().find((s) => s.producer === "faketest");
    assert.equal(stats?.queued, 1, "a soft failure must NOT delete the item — that is silent coverage loss");
    assert.equal(stats?.failing, 1, "it is recorded as a retry, not a success");
    assert.equal(stats?.ready, 0, "and it backs off rather than spinning on the same dead domain");
  });
});

test("a completed check — even one that found nothing — clears the item", async () => {
  await withFake({ facts: { Status: "checked" }, signals: [], flag: { hit: false, summary: "nothing found" } }, async () => {
    dbEnqueueSlow("faketest", "quiet.test", "Client A", "Quiet Inc");
    assert.equal(await drainOne("faketest"), true);
    assert.equal(dbSlowQueueStats().find((s) => s.producer === "faketest"), undefined,
      "'checked, found nothing' is a success and must free the slot");
    assert.equal(dbGetDomainFlags("quiet.test").find((f) => f.producer === "faketest")?.hit, 0);
  });
});

test("drainOne reports an empty queue rather than spinning", async () => {
  await withFake({ facts: {}, signals: [], flag: { hit: false } }, async () => {
    assert.equal(await drainOne("faketest"), false);
  });
});

test("GDELT declares a pace, which is what routes it to the queue", () => {
  // If this ever becomes undefined, runClientSignals silently goes back to awaiting GDELT inline and
  // the whole serial scan drops to one domain per 5.2s again — with no error anywhere.
  assert.ok(gdeltProducer.paceMs && gdeltProducer.paceMs > 0,
    "gdeltProducer.paceMs is what moves it off the scan's critical path");
});
