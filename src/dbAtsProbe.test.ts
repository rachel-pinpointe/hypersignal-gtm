// The ATS board cache records, per (domain, vendor), whether that company publishes a board there.
//
// Discovery probes in two waves: three US vendors first, and the four with heavy non-US usage only if
// those find nothing. So when a domain hits Greenhouse, Workable/Personio/Recruitee/SmartRecruiters
// are never contacted — but all four were being written as found=0 anyway. The cache asserted the
// result of four requests that were never sent.
//
// Verified on production before this was written: sourcelogistics.com has a Greenhouse board and all
// four EU vendors stored as "checked, nothing found", with the identical timestamp.
//
// Two harms. The cache answers "not on Workable" about a company nobody asked Workable about. And
// because the marker is rewritten on every probe, a REAL negative has its timestamp refreshed to
// "just now" each time an unrelated vendor hits — so it never ages past its TTL into a real re-probe,
// and the miss becomes permanent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbSaveAtsProbe, dbGetAtsBoards } from "./db.ts";

const US = ["greenhouse", "lever", "ashby"];
const EU = ["smartrecruiters", "personio", "workable", "recruitee"];
const DOM = "ats-probe-test.example";

const rows = () => db.prepare("SELECT vendor, slug, found FROM ats_boards WHERE domain = ? ORDER BY vendor")
  .all(DOM) as Array<{ vendor: string; slug: string | null; found: number }>;
const reset = () => db.prepare("DELETE FROM ats_boards WHERE domain LIKE 'ats-probe-test%'").run();

test("a vendor that was never contacted gets no row at all", () => {
  reset();
  // The US wave hit, so the EU wave never ran — exactly the production shape.
  dbSaveAtsProbe(DOM, [{ vendor: "greenhouse", slug: "acme" }], US);
  const got = rows();
  assert.deepEqual(got.map((r) => r.vendor), ["ashby", "greenhouse", "lever"],
    "only the three vendors actually probed may appear");
  for (const v of EU)
    assert.equal(got.some((r) => r.vendor === v), false,
      `${v} was never contacted — recording found=0 claims the result of a request that was never sent`);
  reset();
});

test("vendors that WERE contacted and missed are still recorded", () => {
  // The negative markers are the point of the cache — without them every probe re-runs. Only the
  // unasked ones are dropped.
  reset();
  dbSaveAtsProbe(DOM, [], [...US, ...EU]);
  const got = rows();
  assert.equal(got.length, 7, "a full two-wave probe records all seven");
  assert.ok(got.every((r) => r.found === 0 && r.slug === null));
  reset();
});

test("a hit and its wave-mates are recorded together", () => {
  reset();
  dbSaveAtsProbe(DOM, [{ vendor: "lever", slug: "acme" }], US);
  const got = rows();
  assert.equal(got.find((r) => r.vendor === "lever")?.slug, "acme");
  assert.equal(got.find((r) => r.vendor === "lever")?.found, 1);
  assert.equal(got.filter((r) => r.found === 0).length, 2, "greenhouse and ashby missed and are recorded as misses");
  reset();
});

test("a real negative is not laundered into a fresh one by an unrelated hit", () => {
  // The self-perpetuating half of the bug. Probe 1 contacts everything and genuinely misses on
  // Workable. Probe 2 hits Greenhouse, so the EU wave is skipped. If probe 2 rewrote Workable's row,
  // its timestamp would restart and the negative could never age out into a real re-check.
  reset();
  dbSaveAtsProbe(DOM, [], [...US, ...EU]);
  db.prepare("UPDATE ats_boards SET checked_at = datetime('now','-6 days') WHERE domain = ?").run(DOM);
  const before = db.prepare("SELECT checked_at FROM ats_boards WHERE domain = ? AND vendor = 'workable'").get(DOM) as { checked_at: string };

  dbSaveAtsProbe(DOM, [{ vendor: "greenhouse", slug: "acme" }], US);

  const after = db.prepare("SELECT checked_at FROM ats_boards WHERE domain = ? AND vendor = 'workable'").get(DOM) as { checked_at: string };
  assert.equal(after.checked_at, before.checked_at,
    "an untouched vendor's timestamp must not move, or its negative never expires into a real probe");
  reset();
});

test("the domain still reads as freshly checked, so the wave optimisation is preserved", () => {
  // dbGetAtsBoards judges freshness per DOMAIN. Writing fewer rows must not make a just-probed domain
  // look unprobed, or every fetch would re-run discovery and the two-wave saving would be undone.
  reset();
  dbSaveAtsProbe(DOM, [{ vendor: "greenhouse", slug: "acme" }], US);
  const cached = dbGetAtsBoards(DOM);
  assert.ok(cached.length > 0, "a domain probed a moment ago must read as cached");
  assert.deepEqual(cached.filter((r) => r.found && r.slug).map((r) => r.slug), ["acme"]);
  reset();
});
