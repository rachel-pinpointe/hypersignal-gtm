// The GDELT baseline contract. This producer is diff-based: it reports a funding story only when the
// story is ABSENT from the baseline it stored on the previous scan. That makes the baseline the whole
// feature — and it is invisible, so when it broke, nothing failed loudly. It simply never produced a
// signal for any company, for the life of the install.
//
// What broke: the state object was built purely from the articles that matched. Funding news is rare,
// so almost every scan matches nothing, so state was `{}` — and dbReplaceDomainState deletes every key
// for the (domain, producer) when handed an empty object. The baseline was therefore erased on nearly
// every scan, `prior.size > 0` was never true on the next one, and the diff branch never ran.
// Measured on a real 953-domain watchlist: the news producer held a baseline for 953 domains, GDELT
// for exactly 1 — the single company that happened to have funding coverage during that one scan.
//
// So these tests assert the one property that is easy to lose again and impossible to notice:
// AFTER A SCAN THAT MATCHED NOTHING, THE BASELINE STILL EXISTS.
// Run: npx tsx --test src/signals/gdelt.test.ts   (via scripts/test.mjs, which isolates SIGNAL_DB)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { gdeltProducer } from "./gdelt.ts";
import { dbGetDomainState } from "../db.ts";

const realFetch = globalThis.fetch;
/** Serve one canned GDELT article list to the next check() call. */
const serve = (articles: unknown[]) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ articles }), { status: 200, headers: { "content-type": "application/json" } })
  ) as typeof fetch;
};

before(() => { /* fetch is stubbed per test */ });
after(() => { globalThis.fetch = realFetch; });

// A headline that mentions the company but is not about funding — the overwhelmingly common case.
const BORING = [{ url: "https://example.com/a", title: "Northwind Logistics opens a new depot", seendate: "20260701T120000Z" }];
const FUNDING = [{ url: "https://example.com/b", title: "Northwind Logistics raises $40 million Series B", seendate: "20260702T120000Z" }];

test("a scan that matches nothing still leaves a baseline behind", async () => {
  serve(BORING);
  const out = await gdeltProducer.check("northwind-nomatch.test", { company: "Northwind Logistics" });
  assert.equal(out.signals.length, 0, "a first scan is baseline-only");
  const state = dbGetDomainState("northwind-nomatch.test", "gdelt");
  assert.ok(state.size > 0, "zero matches must NOT erase the baseline — this is the bug that silenced GDELT");
});

test("the first funding story is baseline-only, the SECOND scan reports the new one", async () => {
  const domain = "northwind-diff.test";
  serve(BORING);
  await gdeltProducer.check(domain, { company: "Northwind Logistics" });   // scan 1: nothing matched

  serve(FUNDING);
  const out = await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  // Before the fix this returned 0: scan 1 wiped the baseline, so scan 2 saw prior.size === 0 and
  // treated a real funding round as "first scan, stay quiet" — forever, on every scan.
  assert.equal(out.signals.length, 1, "a new funding story after an established baseline must emit");
  assert.equal(out.signals[0]!.type, "gdelt-funding");
  assert.match(out.signals[0]!.title, /raises \$40 million/);
});

test("an article already in the baseline does not re-fire", async () => {
  const domain = "northwind-repeat.test";
  serve(BORING);
  await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  serve(FUNDING);
  await gdeltProducer.check(domain, { company: "Northwind Logistics" });   // emits once
  serve(FUNDING);
  const third = await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  assert.equal(third.signals.length, 0, "the same story must not be re-reported on every subsequent scan");
});

test("a fetch failure leaves the stored baseline untouched", async () => {
  const domain = "northwind-outage.test";
  serve(FUNDING);
  await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  const before = dbGetDomainState(domain, "gdelt").size;
  assert.ok(before > 0);

  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  const out = await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  assert.equal(out.signals.length, 0);
  assert.equal(out.flag, undefined, "an outage must not write a 'no funding coverage' flag over a real one");
  assert.equal(dbGetDomainState(domain, "gdelt").size, before, "an outage must never consume or erase the baseline");
});

// THE CAP MUST DEFER, NEVER DISCARD.
//
// The emit loop stops at MAX_SIGNALS (5). The baseline used to be built from the FULL matched set
// before that loop ran, so on a scan with nine new funding stories, five went out and the other four
// were written into the baseline as "seen" — which means the next scan's `prior.has(seen:…)` test
// skipped them. Not deferred: lost, permanently and silently, and the surplus is largest exactly on
// the accounts with the most news.
//
// Every list producer shared this shape (news, GDELT, subdomains, Companies House) and techStack had
// its mirror: it DELETED the baseline keys of removed tools it had not got around to reporting.
test("stories past the per-scan cap are reported on the NEXT scan, not dropped", async () => {
  const domain = "northwind-cap.test";
  const story = (n: number) => ({
    url: `https://example.com/cap${n}`,
    title: `Northwind Logistics raises $${n}0 million Series B`,
    seendate: "20260703T120000Z",
  });

  // Scan 1 — first sighting, so baseline-only by design (no historical flood).
  serve([story(1)]);
  const first = await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  assert.equal(first.signals.length, 0, "a first scan is baseline-only");

  // Scan 2 — nine NEW stories against a cap of five.
  const nine = Array.from({ length: 9 }, (_, i) => story(i + 10));
  serve(nine);
  const second = await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  assert.equal(second.signals.length, 5, "the cap must still hold — this is a drip, not a flood");

  // Scan 3 — the same nine stories, nothing new upstream. The four that never went out must fire now.
  serve(nine);
  const third = await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  assert.equal(third.signals.length, 4, "the four over the cap were marked seen and lost");
  const urls = new Set([...second.signals, ...third.signals].map((s) => s.url));
  assert.equal(urls.size, 9, "every story must be reported exactly once across the two scans");

  // Scan 4 — everything has now been reported, so the feed goes quiet.
  serve(nine);
  const fourth = await gdeltProducer.check(domain, { company: "Northwind Logistics" });
  assert.equal(fourth.signals.length, 0, "…and nothing re-fires once it has gone out");
});
