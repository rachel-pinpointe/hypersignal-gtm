// The two pieces of the shared browser manager that are pure logic — and the two whose failure is
// silent rather than loud.
//
// `Semaphore` is what lets the account-check run several browser sessions at once while the scrapers
// keep their serial queue. Exceed its ceiling and nothing throws: you simply open more real browsers
// than the machine was sized for, and the symptom is a slow, memory-starved box, not an error. Leak a
// permit and the opposite happens — the queue quietly stops admitting anyone.
//
// `looksBlocked` decides whether a page is real content or a bot wall. Get it wrong in one direction
// and we parse a Cloudflare interstitial as a job board, storing zero jobs and reporting success. Get
// it wrong in the other and we throw away good pages. Neither raises anything.
//
// Playwright is a type-only import in browser.ts and every real launch is lazy, so importing this
// module starts no browser.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore, looksBlocked, withTimeout } from "./browser.ts";

/** Drain the microtask queue and let timers fire. */
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a semaphore never lets more than `max` run at once", async () => {
  const sem = new Semaphore(2);
  let live = 0, peak = 0;
  let open!: () => void;
  const barrier = new Promise<void>((r) => { open = r; });
  const all = Promise.all([1, 2, 3, 4, 5, 6].map((i) => sem.run(async () => {
    live++; peak = Math.max(peak, live);
    await barrier;
    live--;
    return i;
  })));
  await tick();
  assert.equal(peak, 2, `six tasks, ceiling 2 — ${peak} were admitted at once`);
  open();
  assert.deepEqual(await all, [1, 2, 3, 4, 5, 6], "every task still runs, and results keep their order");
  assert.equal(live, 0, "and every permit comes back");
});

test("a freed permit goes to the queue, not to whoever asks next", async () => {
  // The invariant the code comments call out: count the permit at the ADMISSION point, so a slot
  // released while someone is queued cannot be taken by both the woken waiter and a fresh caller.
  // Written to fail against the obvious-looking alternative (decrement on every release), which
  // transiently runs max+1 — and, being transient, is invisible in production until the machine
  // runs out of memory under a burst.
  const sem = new Semaphore(1);
  let live = 0, peak = 0;
  const holds: Array<() => void> = [];
  const task = () => sem.run(async () => {
    live++; peak = Math.max(peak, live);
    await new Promise<void>((r) => holds.push(r));
    live--;
  });

  const a = task();
  await tick();
  const b = task();                 // queued behind a
  await tick();
  holds[0]!();                      // a finishes → its permit is handed straight to b
  await tick(); await tick();       // ...and b is running before the next caller appears
  const c = task();                 // a fresh caller, arriving after the handover
  await tick();
  assert.equal(peak, 1, `ceiling 1 — ${peak} ran at once, so the freed permit was issued twice`);

  holds.forEach((h) => h());        // b (and then c, once it is admitted) can finish
  await tick();
  holds.forEach((h) => h());
  await Promise.all([a, b, c]);
  assert.equal(live, 0);
});

test("a permit is returned even when the task throws", async () => {
  // Without the `finally`, one failed page would burn a permit for the life of the process and the
  // pool would shrink silently, one crash at a time, until nothing could be admitted at all.
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error("page crashed"); }), /page crashed/);
  assert.equal(await sem.run(async () => "still open"), "still open", "the permit was leaked by the failure");
});

test("a 403 or 429 is a wall no matter what the body says", async () => {
  // These arrive with real-looking HTML often enough that judging by body alone reads them as content.
  assert.equal(looksBlocked("<html><body>jobs jobs jobs</body></html>", 403), true);
  assert.equal(looksBlocked("<html><body>jobs jobs jobs</body></html>", 429), true);
  assert.equal(looksBlocked("<html><body>jobs jobs jobs</body></html>", 200), false);
  assert.equal(looksBlocked("<html><body>jobs jobs jobs</body></html>"), false, "no status → judge the body");
});

test("the challenge pages every one of these sources actually hits are recognised", async () => {
  // Named individually rather than as one blob: each is a different vendor, and losing one of them
  // means that vendor's interstitial starts being stored as a page of zero jobs.
  for (const wall of [
    "<title>Just a moment...</title>",                     // Cloudflare
    "<div id=cf-challenge></div>",                          // Cloudflare, older
    "<h1>Attention Required!</h1>",                         // Cloudflare block page
    "Verify you are human by completing the action below",  // Turnstile
    "Enable JavaScript and cookies to continue",            // Cloudflare JS check
    "<script src='//captcha-delivery.com/x.js'></script>",  // DataDome (SimplyHired)
  ]) {
    assert.equal(looksBlocked(wall, 200), true, `missed: ${wall.slice(0, 40)}`);
  }
  for (const wall of ["px-captcha", "perimeterx", "datadome", "unusual traffic"]) {
    assert.equal(looksBlocked(`<html>${wall}</html>`, 200), true, `missed: ${wall}`);
  }
  assert.equal(looksBlocked("<HTML><TITLE>JUST A MOMENT...</TITLE>", 200), true, "matching must be case-insensitive");
});

test("a page of real jobs is not mistaken for a wall", async () => {
  // The expensive direction of a false positive: we throw away a good page and report finding nothing.
  const real = `<html><body>${Array(50).fill("<li class=job>Senior Engineer — Remote — Apply now</li>").join("")}</body></html>`;
  assert.equal(looksBlocked(real, 200), false);
});

test("only the first 6000 characters are searched — deliberately", async () => {
  // A bot wall is a small page and says so immediately; real job pages are megabytes. Scanning the
  // whole body would mean running this regex over every page we ever fetch, and would also let the
  // word "captcha" appearing in a job description condemn a perfectly good page. Pinned so the cap is
  // a decision someone changed on purpose rather than a limit that quietly stops matching.
  assert.equal(looksBlocked("just a moment".padStart(500, "x"), 200), true, "near the top → caught");
  assert.equal(looksBlocked("just a moment".padStart(7000, "x"), 200), false, "past the window → deliberately not caught");
});

test("withTimeout resolves normally when the promise settles in time", async () => {
  const result = await withTimeout(Promise.resolve("ok"), 1000, "test op");
  assert.equal(result, "ok");
});

test("withTimeout rejects a promise that never settles, instead of hanging forever", async () => {
  // Regression test for the 2026-09-18 finding: chromium.launch() hung indefinitely (no resolve, no
  // reject) when the environment was missing a shared library the headless binary needs. Nothing
  // upstream could catch that -- it just hung the whole process until Node killed it as an
  // "unsettled top-level await". A never-settling promise here must become an ordinary rejection.
  const neverSettles = new Promise<string>(() => {});
  await assert.rejects(withTimeout(neverSettles, 20, "stuck launch"), /stuck launch timed out after 20ms/);
});

test("withTimeout propagates a real rejection unchanged, not the timeout error", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error("real failure")), 1000, "test op"),
    /real failure/,
  );
});
