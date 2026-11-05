// Behaviour tests for webhook delivery.
//
// Everything in this file leaves the machine and lands in a customer's system, and until now none of
// it was exercised: channelParity.test.ts reads delivery.ts as TEXT and regexes it, which proves a
// string is present and nothing about what the code does.
//
// Two things are worth pinning. Routing decides WHOSE endpoint a signal reaches — send it to the
// wrong one and a client sees another client's funding alerts. And toSignal decides what a CRM
// records as fact, where an invented currency or an asserted "yearly" on an hourly wage is a wrong
// number in a field nobody re-checks.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSignalRoute, toSignal } from "./delivery.ts";

const FAMILY = "https://hook.test/funding-family";
const EXACT = "https://hook.test/exact-type";
const CATEGORY = "https://hook.test/category";
const DEFAULT = "https://hook.test/default";

test("routing prefers the legacy family, so an old config never silently reroutes", () => {
  // The whole point of the order: categories were added later. A client who had routed "funding"
  // must keep getting funding there even though the signal now also carries a category.
  assert.equal(resolveSignalRoute("funding-form-d",
    { funding: FAMILY, "funding-form-d": EXACT }, DEFAULT), FAMILY);
});

test("an exact type beats the category", () => {
  assert.equal(resolveSignalRoute("funding-form-d", { "funding-form-d": EXACT }, DEFAULT), EXACT);
});

test("the category is used when nothing more specific matches", () => {
  assert.equal(resolveSignalRoute("news-funding", { funding: CATEGORY }, DEFAULT), CATEGORY);
});

test("the client default is the last resort, and no sink means dashboard-only", () => {
  assert.equal(resolveSignalRoute("warn-layoff", {}, DEFAULT), DEFAULT);
  assert.equal(resolveSignalRoute("warn-layoff", {}, ""), "",
    "no route and no default is not an error — the signal is dashboard-only");
  assert.equal(resolveSignalRoute("warn-layoff", {}, "   "), "", "whitespace is not a webhook");
});

test("a route key inherited from Object.prototype is not a webhook", () => {
  // `routes` is parsed from the client's YAML. Without an own-property check, a lookup that misses
  // finds Object.prototype.constructor / .toString instead, and String(fn).trim() yields the
  // function's SOURCE TEXT as the target URL — every signal in the batch then fails to deliver.
  const routes = {} as Record<string, string>;
  assert.equal(resolveSignalRoute("constructor", routes, DEFAULT), DEFAULT);
  assert.equal(resolveSignalRoute("toString", routes, DEFAULT), DEFAULT);
  assert.equal(resolveSignalRoute("valueOf", routes, ""), "");
});

test("an explicitly blank route means dashboard-only, not 'fall through to the default'", () => {
  // Setting a family to "" is how you mute it. `??` (not `||`) is what makes that work — with `||`
  // the empty string would fall through and the muted family would go to the default hook anyway.
  assert.equal(resolveSignalRoute("funding-form-d", { funding: "" }, DEFAULT), "");
});

// ---------------------------------------------------------------------------------------------
// toSignal — what a CRM stores as fact.
// ---------------------------------------------------------------------------------------------

const row = (raw: Record<string, unknown>) => toSignal({
  id: 1, title: "Driver", company: "Acme", domain: "acme.com", location: "TX", state: "TX",
  remote: 0, status: "open", url: "https://acme.com/j/1", source: "hcorg",
  posted_at: "2026-07-01T00:00:00.000Z", seen_at: "2026-07-02 10:00:00", matched_at: null,
  matchReason: "corporate · org", raw: JSON.stringify(raw),
});

test("a figure too small to be an annual salary does not claim to be one", () => {
  // 27 USD is an hourly wage; 24 INR is lakhs per annum. The app cannot tell which, so it reports
  // the figure and leaves the period unknown rather than telling a CRM a driver earns $27 a year.
  assert.equal(row({ comp_min: 27, comp_max: 27, currency: "USD" }).compensation!.period, null);
  assert.equal(row({ comp_min: 24, comp_max: 30, currency: "INR" }).compensation!.period, null);
  assert.equal(row({ comp_min: 27, comp_max: 27, currency: "USD" }).compensation!.max, 27,
    "the figure itself is still reported — only the period is withheld");
});

test("a plausible annual figure is still labelled yearly", () => {
  const c = row({ comp_min: 90000, comp_max: 120000, currency: "USD" }).compensation!;
  assert.equal(c.period, "yearly");
  assert.equal(c.max, 120000);
  // The floor is on the headline (max, else min), not on both ends.
  assert.equal(row({ comp_min: 0, comp_max: 55000, currency: "USD" }).compensation!.period, "yearly");
});

test("a currency the source never stated is never invented", () => {
  // A defaulted "USD" writes a wrong number into a CRM and nobody catches it.
  assert.equal(row({ comp_min: 50000, comp_max: 60000 }).compensation!.currency, null);
  assert.equal(row({ comp_min: 50000, comp_max: 60000, currency: "   " }).compensation!.currency, null);
  assert.equal(row({ comp_min: 50000, comp_max: 60000, currency: " eur " }).compensation!.currency, "eur");
});

test("no compensation at all is null, not a zeroed object", () => {
  assert.equal(row({}).compensation, null);
  // But a single-sided range is real data and must survive.
  assert.deepEqual(row({ comp_max: 120000, currency: "USD" }).compensation,
    { min: null, max: 120000, currency: "USD", period: "yearly" });
});

test("a row whose raw blob is unparseable still produces a valid payload", () => {
  // raw comes from a scraper. A truncated or non-JSON blob must degrade to "no enrichment", never
  // throw mid-batch and abort a delivery that had already partially succeeded.
  const s = toSignal({ id: 9, title: "T", company: "C", url: "u", raw: "{not json", seen_at: null });
  assert.equal(s.compensation, null);
  assert.equal(s.seniority, null);
  assert.equal(s.title, "T");
  assert.equal(s.status, "open", "status falls back to open rather than undefined");
});

test("dates are emitted as ISO instants, whatever SQLite handed us", () => {
  const s = row({});
  assert.match(String(s.first_seen_at), /^\d{4}-\d{2}-\d{2}T.*Z$/,
    "SQLite's 'YYYY-MM-DD HH:MM:SS' must not reach a consumer as-is");
  assert.equal(s.posted_at, "2026-07-01T00:00:00.000Z");
  assert.equal(s.matched_at, null, "a null date stays null — never coerced to the epoch");
});

// ── flushPendingDeliveries: the backlog an interrupted run leaves behind ──────────────────────────
//
// These use the real DB module (tests run against a throwaway SIGNAL_DB), because the whole point of
// the function is which ROWS it picks up, and a mocked counter would prove nothing about that.
import { flushPendingDeliveries } from "./delivery.ts";
import { db, upsertJob } from "./db.ts";

/** A match that a fetch persisted and never delivered — what an interrupted run leaves behind. */
function pendingMatch(client: string, id: string): void {
  upsertJob({ id, source: "test", externalId: id, title: "Engineer", company: "Acme",
    location: "Austin, TX", state: "TX", remote: false, url: `https://x.test/${id}`, postedAt: null, raw: {} });
  db.prepare("INSERT OR REPLACE INTO matches (job_id, client, match_reason, delivered) VALUES (?, ?, 'test', 0)").run(id, client);
}
const undelivered = (client: string): number =>
  Number((db.prepare("SELECT COUNT(*) c FROM matches WHERE client = ? AND delivered = 0").get(client) as { c: number }).c);
/** Remove BOTH the matches and the jobs they point at.
 *
 *  Test files run in separate processes against ONE shared SIGNAL_DB, and matches.job_id is a foreign
 *  key onto raw_jobs. Leaving a row behind here made velocity.test.ts fail with "FOREIGN KEY
 *  constraint failed" when it cleared raw_jobs — a failure in a file that had nothing to do with the
 *  change. Deliberately not a hidden global hook: these tests create the rows, so they remove them. */
function wipe(client: string, ...ids: string[]): void {
  db.prepare("DELETE FROM matches WHERE client = ?").run(client);
  for (const id of ids) db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(id);
}

test("a realtime client's stranded backlog is delivered at boot", async () => {
  // The bug: deliver() is called from ONE place, the end of a successful fetch. An interrupted run
  // therefore leaves its matches queued until that client fetches again — on the live database, 933
  // of them for five days, with the dashboard showing them the whole time so nothing looked wrong.
  const c = { name: "flush-realtime", active: true, delivery: { mode: "realtime", webhook_url: "" } } as never;
  wipe("flush-realtime", "flush-rt-1", "flush-rt-2");
  pendingMatch("flush-realtime", "flush-rt-1");
  pendingMatch("flush-realtime", "flush-rt-2");
  assert.equal(undelivered("flush-realtime"), 2);
  await flushPendingDeliveries([c]);
  assert.equal(undelivered("flush-realtime"), 0, "the backlog must be retired at boot, not at the next fetch");
  wipe("flush-realtime", "flush-rt-1", "flush-rt-2");
});

test("a SCHEDULED client is left alone — its digest owns the timing", async () => {
  // Not an oversight, the point of the rule. "Send at 09:00" is a promise; flushing at boot breaks
  // it rather than keeping it. Only "send it as soon as we have it" is violated by a queued match.
  const c = { name: "flush-sched", active: true, delivery: { mode: "scheduled", webhook_url: "", schedule: "0 9 * * *" } } as never;
  wipe("flush-sched", "flush-sc-1");
  pendingMatch("flush-sched", "flush-sc-1");
  await flushPendingDeliveries([c]);
  assert.equal(undelivered("flush-sched"), 1, "a digest client's backlog belongs to its digest cron");
  wipe("flush-sched", "flush-sc-1");
});

test("an inactive client is left alone", async () => {
  // A paused client should not start POSTing again just because the app restarted.
  const c = { name: "flush-off", active: false, delivery: { mode: "realtime", webhook_url: "" } } as never;
  wipe("flush-off", "flush-off-1");
  pendingMatch("flush-off", "flush-off-1");
  await flushPendingDeliveries([c]);
  assert.equal(undelivered("flush-off"), 1);
  wipe("flush-off", "flush-off-1");
});

test("one client's dead webhook does not strand the next client's backlog", async () => {
  // The flush is sequential, so an unreachable endpoint on client A must not cost client B its
  // delivery. Note what this does and does not prove: deliver() absorbs webhook failures itself, so
  // this passes because of THAT, not because of the try/catch in flushPendingDeliveries — removing
  // that catch leaves the suite green, which is how the catch came to be documented as a backstop
  // for non-network failures rather than as the thing protecting this case.
  const bad = { name: "flush-bad", active: true, delivery: { mode: "realtime", webhook_url: "https://127.0.0.1:9/none" } } as never;
  const ok = { name: "flush-ok", active: true, delivery: { mode: "realtime", webhook_url: "" } } as never;
  wipe("flush-bad", "flush-bad-1"); wipe("flush-ok", "flush-ok-1");
  pendingMatch("flush-bad", "flush-bad-1");
  pendingMatch("flush-ok", "flush-ok-1");
  await flushPendingDeliveries([bad, ok]);          // must not reject
  assert.equal(undelivered("flush-bad"), 1, "the unreachable one stays queued for the next retry");
  assert.equal(undelivered("flush-ok"), 0, "...and the healthy one still went out");
  wipe("flush-bad", "flush-bad-1"); wipe("flush-ok", "flush-ok-1");
});

test("a client with nothing pending is a no-op", async () => {
  const c = { name: "flush-empty", active: true, delivery: { mode: "realtime", webhook_url: "" } } as never;
  wipe("flush-empty");
  await flushPendingDeliveries([c]);
  assert.equal(undelivered("flush-empty"), 0);
});
