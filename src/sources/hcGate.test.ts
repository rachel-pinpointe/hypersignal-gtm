// The adaptive gate that paces ALL hiring.cafe access, and had no tests at all.
//
// This file governs 96% of the app's data — 16,357 hcorg + 7,546 hiringcafe rows of 24,945 on the
// live install — and its failure mode is the quietest one there is. Ramp too eagerly and hiring.cafe
// starts refusing us, so a fetch returns nothing and the dashboard shows a run that "found 0 jobs".
// Back off and never recover, and the same thing happens slowly. Neither raises an error.
//
// Every invariant here is stated in hcGate.ts's own comments, which is exactly why they are worth
// pinning: they are the reasoning that is easiest to undo by accident while tidying an if-statement.
//
// Driven through the REAL entry point. fetchViaHttp uses global fetch, so stubbing that exercises
// acquire → result → AIMD → admit as it actually runs, with no test-only export to keep in sync.
// Run: npm test
process.env.HC_TRANSPORT = "http";        // no Playwright fallback — this file is about the HTTP lane
process.env.HC_HTTP_CONCURRENCY = "4";    // small ceiling so ramping is observable in a few calls
process.env.HC_RAMP_AFTER = "3";          // +1 concurrency per 3 clean requests
process.env.HC_COOLDOWN_MS = "80";        // short enough to await, long enough to observe

import { test } from "node:test";
import assert from "node:assert/strict";

const { hcFetchHtml, hcGateStats, setGateProfile, gateWave } = await import("./hcGate.ts");

const OK_HTML = "<html><body>jobs</body></html>";
type Mode = "ok" | "block" | "fail";
let mode: Mode = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  if (mode === "fail") throw new Error("connect ETIMEDOUT");      // network trouble, NOT a challenge
  if (mode === "block") return new Response("nope", { status: 403 }); // transports.ts → "hiringcafe-blocked"
  return new Response(OK_HTML, { status: 200 });
}) as typeof fetch;

/**
 * Bound every wait in this file.
 *
 * The gate's failure mode when starved is not an error — it is silence. Mutation-testing proved it:
 * deleting the cooldown wake-up timer, or letting the halving reach 0, does not fail these tests, it
 * HANGS the whole suite forever, because `waiters` fills up and nothing can ever admit again. A test
 * that wedges CI on a real regression is a worse signal than no test, since the one thing a reader
 * cannot tell from a hung run is WHICH invariant broke.
 *
 * So every await goes through here and a stall becomes a named failure.
 */
async function bounded<T>(what: string, p: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const stall = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`GATE STALLED: ${what} never completed in ${ms}ms — a request is stuck in the waiter queue with nothing left to wake it`)), ms);
  });
  try { return await Promise.race([p, stall]); } finally { clearTimeout(timer!); }
}

/** Drive n requests through the gate, swallowing the expected rejections. */
async function drive(n: number, m: Mode): Promise<void> {
  mode = m;
  for (let i = 0; i < n; i++) {
    try { await bounded(`request ${i} (${m})`, hcFetchHtml(`https://hiring.cafe/x${i}`)); }
    catch (e) {
      // A stall is a REAL failure and must propagate; a block/fail rejection is what we asked for.
      if (/GATE STALLED/.test((e as Error).message)) throw e;
    }
  }
}
const limit = () => hcGateStats().httpLimit;
/** Put the lane back at its ceiling with a clean streak, so each test starts from a known state. */
async function reset(): Promise<void> {
  setGateProfile("normal");
  await new Promise((r) => setTimeout(r, 120));           // let any cooldown expire
  await drive(60, "ok");                                  // 4 ceiling ÷ 3-per-step needs far fewer, but be sure
  assert.equal(limit(), hcGateStats().httpCeiling, "reset should leave the lane at its ceiling");
}

test("the stub really drives the gate, before anything is concluded from it", async () => {
  // Guard the instrument. If fetch were not being intercepted, every assertion below would be about
  // a gate that never saw a request — and a gate at its default ceiling looks exactly like a healthy
  // one that ramped there.
  await drive(1, "ok");
  assert.equal(hcGateStats().httpCeiling, 4, "HC_HTTP_CONCURRENCY must have been read from env");
  assert.equal(await hcFetchHtml("https://hiring.cafe/ok"), OK_HTML, "the stubbed body must come back");
});

test("a TIMEOUT is neutral — it must never be scored as a clean request", async () => {
  // The invariant hcGate.ts calls out by name: "an outage where every request times out would
  // otherwise score as a clean streak and push the lane toward HTTP_MAX at the worst possible
  // moment". A failing network is the moment to hold still, not to open the throttle.
  await reset();
  await drive(2, "block");                    // 4 → 2 → 1
  const backedOff = limit();
  assert.ok(backedOff < 4, `a block must reduce the limit, got ${backedOff}`);
  await new Promise((r) => setTimeout(r, 120));
  await drive(30, "fail");                    // ten times the ramp threshold, all failures
  assert.equal(limit(), backedOff, "failures must not ramp the lane");
});

test("a timeout does not halve the lane either — it is not a challenge", async () => {
  // The other half of neutral, and the reason "fail" is a third outcome rather than folded into
  // "block": a flaky request is not hiring.cafe telling us to back off.
  await reset();
  await drive(20, "fail");
  assert.equal(limit(), 4, "a flaky network must not be read as a block");
});

test("a block HALVES the lane and stops at 1, never 0", async () => {
  // Multiplicative decrease. Reaching 0 would wedge the lane permanently: admit() requires
  // inflight < limit, so nothing could ever be admitted again and every fetch would hang.
  await reset();
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) { await drive(1, "block"); seen.push(limit()); await new Promise((r) => setTimeout(r, 100)); }
  assert.deepEqual(seen, [2, 1, 1, 1, 1, 1], `halving then flooring at 1, got ${seen.join(",")}`);
});

test("clean requests ramp one step per threshold, and stop at the ceiling", async () => {
  // Additive increase. The threshold matters as much as the direction: ramping per REQUEST rather
  // than per N requests is how a gate walks straight back into the block it just backed off from.
  await reset();
  await drive(2, "block");
  await new Promise((r) => setTimeout(r, 120));
  const from = limit();
  await drive(2, "ok");                       // one short of HC_RAMP_AFTER=3
  assert.equal(limit(), from, "must not ramp before the threshold");
  await drive(1, "ok");
  assert.equal(limit(), from + 1, "the third clean request ramps");
  await drive(60, "ok");
  assert.equal(limit(), 4, "and it never exceeds the ceiling");
});

test("a block cools the gate down, and the queue is not stranded when it expires", async () => {
  // The starvation risk in a waiter-queue gate: requests that arrive DURING a cooldown park in
  // `waiters`, and nothing but a timer can wake them — inflight is 0, so no release will. If that
  // timer is ever dropped, every subsequent fetch hangs forever with no error anywhere.
  await reset();
  await drive(1, "block");
  assert.ok(hcGateStats().cooldownMs > 0, "a block must open a cooldown");
  mode = "ok";
  const inFlight = Promise.all([1, 2, 3, 4, 5, 6].map((i) => hcFetchHtml(`https://hiring.cafe/q${i}`)));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(hcGateStats().waiting > 0, "requests during a cooldown must queue, not stampede");
  // Bounded: without the wake-up timer this await never returns, and the run would hang rather than
  // tell anyone which invariant broke. Mutation-tested — deleting that timer fails HERE, by name.
  const bodies = await bounded("the queue draining after a cooldown", inFlight);
  assert.deepEqual(bodies, Array(6).fill(OK_HTML));
  assert.equal(hcGateStats().httpInflight, 0, "every slot is handed back");
});

test("pagination waves shrink while the gate is struggling", async () => {
  // Firing a full wave at a site that is already refusing us just queues stalled pages. Tested
  // through gateWave because that is what the scrapers actually call.
  await reset();
  assert.equal(gateWave(), 4, "normal profile, healthy lane");
  await drive(1, "block");
  assert.equal(gateWave(), 2, "cooling down → smaller waves");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(gateWave(), 2, "still small: the lane is at 2 after the halving");
});

test("changing the speed profile clamps into the new ceiling but never RAISES what was learned", async () => {
  // The speed dial raises the CEILING, not the current concurrency. Resetting the learned limit
  // upward on a profile change would discard the backoff AIMD just paid for — the user would flip a
  // setting and immediately re-trigger the block they were backing off from.
  await reset();
  await drive(2, "block");                    // learned limit is now 1
  await new Promise((r) => setTimeout(r, 120));
  const learned = limit();
  setGateProfile("aggressive");
  assert.equal(hcGateStats().httpCeiling, 8, "aggressive doubles the ceiling");
  assert.equal(limit(), learned, "...and leaves the learned limit alone");
  setGateProfile("gentle");
  assert.equal(hcGateStats().httpCeiling, 2, "gentle halves it");
  assert.ok(limit() <= 2, "a lowered ceiling must clamp the limit down into it");
  setGateProfile("normal");
});

test("teardown restores the real fetch", () => {
  globalThis.fetch = realFetch;
  assert.equal(globalThis.fetch, realFetch);
});
