// "Chronic repost" was the loudest signal in the product — 876 of 1,255 feed rows, 70% — and it was
// INVERTED. It counted rows sharing a title, on any date, in any city. For a logistics employer that
// is simply the job board:
//   "Reposted 7×: CDL-A Driver — likely struggling to fill"
//   = 7 seats, 4 different cities, all still open, all posted on ONE day.
// A company opening seven driver seats across four cities in a day is expanding. The signal told the
// user the opposite, and aimed it hardest at exactly the multi-site employers the watchlist is made of.
// Run: npx tsx --test src/signals/velocity.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { velocityProducer } from "./velocity.ts";

const ins = db.prepare(
  `INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, location, url, domain, status, posted_at, seen_at)
   VALUES (?, ?, 'test', ?, 'Test Co', ?, ?, ?, 'open', ?, ?)`);
let n = 0;
const post = (domain: string, title: string, location: string, isoDay: string) => {
  const id = `v${++n}`;
  ins.run(id, id, title, location, `https://x.test/${id}`, domain, `${isoDay}T00:00:00Z`, `${isoDay} 00:00:00`);
};
const reposts = async (domain: string) =>
  (await velocityProducer.check(domain, {})).signals.filter((s) => s.type === "velocity-repost");

beforeEach(() => { db.prepare("DELETE FROM raw_jobs WHERE source = 'test'").run(); });

test("seats opened across several cities on ONE day is not a repost", async () => {
  // The exact real-world shape that produced 876 wrong signals.
  for (const city of ["Dallas, TX", "Houston, TX", "Austin, TX", "El Paso, TX"]) {
    post("fleet.test", "CDL-A Driver", city, "2026-06-01");
    post("fleet.test", "CDL-A Driver", city, "2026-06-01");
  }
  assert.deepEqual(await reposts("fleet.test"), [], "parallel hiring across cities must not read as struggling to fill");
});

test("the same role at the same place, re-advertised over months, IS a repost", async () => {
  for (const day of ["2026-03-01", "2026-04-05", "2026-05-10"]) post("slow.test", "Analyst", "Irvine, CA", day);
  const out = await reposts("slow.test");
  assert.equal(out.length, 1);
  assert.match(out[0]!.title, /Reposted 3× over \d+ days/);
  assert.match(out[0]!.title, /Irvine/, "the location is named, so the claim is checkable");
});

test("a burst inside three weeks is a batch, not a chronic problem", async () => {
  for (const day of ["2026-06-01", "2026-06-04", "2026-06-09"]) post("burst.test", "Analyst", "Irvine, CA", day);
  assert.deepEqual(await reposts("burst.test"), [], "three postings in nine days is not chronic");
});

test("two postings, however far apart, is not chronic either", async () => {
  for (const day of ["2026-01-01", "2026-06-01"]) post("twice.test", "Analyst", "Irvine, CA", day);
  assert.deepEqual(await reposts("twice.test"), []);
});

test("location spelling variants collapse onto one role", async () => {
  // Real data carries both "Nuevo Laredo, Tamaulipas, Mexico" and "Nuevo Laredo, TAMAULIPAS, Mexico".
  // Without normalisation these split into two groups and NEITHER reaches the threshold — the fix
  // would have silently under-reported instead of over-reporting.
  post("mx.test", "Brokerage Agent", "Nuevo Laredo, Tamaulipas, Mexico", "2026-03-01");
  post("mx.test", "Brokerage Agent", "Nuevo Laredo, TAMAULIPAS, Mexico", "2026-04-05");
  post("mx.test", "Brokerage Agent", "nuevo laredo, tamaulipas, Mexico", "2026-05-10");
  assert.equal((await reposts("mx.test")).length, 1, "one role, not three near-misses");
});

test("the same title at two sites is two separate findings, not one merged claim", async () => {
  for (const day of ["2026-03-01", "2026-04-05", "2026-05-10"]) {
    post("multi.test", "Analyst", "Irvine, CA", day);
    post("multi.test", "Analyst", "Denver, CO", day);
  }
  const out = await reposts("multi.test");
  assert.equal(out.length, 2, "each site is its own hiring problem");
  assert.notEqual(out[0]!.dedupKey, out[1]!.dedupKey, "and must not dedup each other away");
});

// ── The signal must open the posting it is about ────────────────────────────────────────────────
//
// All 54 stored repost signals carried no link at all. "Reposted 9× over 156 days" is the claim an
// operator would actually open a conversation with, and it was the one they could not check without
// going and hunting for the role themselves. The posting's URL was sitting in the same table the
// signal is computed from; the query simply never selected it.
test("a repost signal links to the posting it is about", async () => {
  for (const day of ["2026-04-01", "2026-05-01", "2026-06-01"]) post("linky.test", "Analyst", "Irvine, CA", day);
  const out = await reposts("linky.test");
  assert.equal(out.length, 1);
  assert.match(String(out[0]!.url), /^https:\/\/x\.test\//, "the reader must be able to open the role");
});

test("it links the NEWEST posting, not the first one seen", async () => {
  // The earliest posting of a chronic repost is the one most likely to be closed and delisted by now.
  // A signal that says "they are still trying to fill this" must not open a dead page — that reads as
  // the opposite of the claim it is making.
  const before = n;
  for (const day of ["2026-04-01", "2026-05-01", "2026-06-01"]) post("newest.test", "Dispatcher", "Reno, NV", day);
  const out = await reposts("newest.test");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url, `https://x.test/v${before + 3}`, "the third posting is the most recent one");
});

test("a posting with no URL yields no link rather than a broken one", async () => {
  for (const day of ["2026-04-01", "2026-05-01", "2026-06-01"]) {
    const id = `nu${++n}`;
    db.prepare(`INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, location, url, domain, status, posted_at, seen_at)
                VALUES (?, ?, 'test', 'Loader', 'Test Co', 'Ogden, UT', NULL, 'nourl.test', 'open', ?, ?)`)
      .run(id, id, `${day}T00:00:00Z`, `${day} 00:00:00`);
  }
  const out = await reposts("nourl.test");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url ?? null, null, "absent is honest; a fabricated link is not");
});
