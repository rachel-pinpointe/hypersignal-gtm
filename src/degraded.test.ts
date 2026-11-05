// A BROKEN SCRAPER MUST NOT LOOK LIKE A QUIET MARKET.
//
// Every adapter catches its own failures and returns an empty or partial array — deliberately, so one
// dead board cannot take down a whole run. The cost was that SourceStats.error became structurally
// unreachable for all four of them: ingest.ts fills that field only from an exception that ESCAPES the
// adapter. So a Craigslist 403, a DataDome wall, a dead WeWorkRemotely feed or a rate-limited ATS host
// was recorded and displayed as a successful run that found zero jobs, with a console.warn as the only
// trace — and on a desktop app with a dashboard, the console has no reader.
//
// The consequence is worse than a blank screen. dbSweepClosed(14) closes any posting not re-seen for
// 14 days and runs every reconcile, so two weeks of a silently-broken adapter auto-closes that
// source's entire open inventory and the dashboard attributes the collapse to the market.
//
// This is the server-side half of the standard src/uiHonesty.test.ts already enforces on the client
// ("a failed request must never be rendered as a fact about the data") — that guard only reads
// web/app.js, so this side was unprotected.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectDegraded, reportDegraded } from "./sources/degraded.ts";

test("a report reaches the run it belongs to", async () => {
  const { result, warnings } = await collectDegraded(async () => {
    reportDegraded("craigslist/austin: HTTP 403");
    return ["job"];
  });
  assert.deepEqual(result, ["job"], "the adapter's own return value must pass through untouched");
  assert.deepEqual(warnings, ["craigslist/austin: HTTP 403"]);
});

test("a report survives any depth of awaits", async () => {
  // The real call sites are several async frames down inside an adapter, past fetches and page loops.
  const deep = async () => { await new Promise((r) => setImmediate(r)); reportDegraded("wwr/design: timeout"); };
  const { warnings } = await collectDegraded(async () => { await deep(); return 1; });
  assert.deepEqual(warnings, ["wwr/design: timeout"]);
});

test("concurrent sources do not steal each other's warnings", async () => {
  // THE reason this is AsyncLocalStorage and not a module-level array: FETCH_SOURCE_CONCURRENCY
  // defaults to 8, so eight adapters are in flight at once. A shared bucket would file one source's
  // failure under another's name, which is a worse lie than silence.
  const run = (label: string, delay: number) => collectDegraded(async () => {
    await new Promise((r) => setTimeout(r, delay));
    reportDegraded(`${label}: failed`);
    await new Promise((r) => setTimeout(r, delay));
    return label;
  });
  const [a, b, c] = await Promise.all([run("alpha", 5), run("beta", 1), run("gamma", 3)]);
  assert.deepEqual(a.warnings, ["alpha: failed"]);
  assert.deepEqual(b.warnings, ["beta: failed"]);
  assert.deepEqual(c.warnings, ["gamma: failed"]);
});

test("a report outside a run is dropped, not thrown", () => {
  // Scripts and tests call adapter internals directly. Reporting there must be a no-op.
  assert.doesNotThrow(() => reportDegraded("no run in progress"));
});

test("a runaway adapter cannot fill the run record", async () => {
  const { warnings } = await collectDegraded(async () => {
    for (let i = 0; i < 500; i++) reportDegraded(`page ${i} failed`);
    return null;
  });
  assert.equal(warnings.length, 20, "bounded — a per-page failure loop must not write 500 rows of text");
});

// The adapters themselves must actually USE the channel. A static check, in the same shape as
// uiHonesty/channelParity: the failure sites are inside network paths a unit test cannot reach
// without hitting live sites, but "did anyone remember to wire it" is decidable from the source.
test("every adapter that swallows a failure reports it", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["ats.ts", "craigslist.ts", "remoteBoards.ts", "simplyhired.ts"]) {
    const src = readFileSync(new URL(`./sources/${f}`, import.meta.url), "utf8");
    assert.match(src, /reportDegraded\(/, `${f} swallows failures and must report them`);
  }
});
