// Posting dates: the normalizer at the write boundary, and the SQL that compares them.
//
// Every date comparison in this app is a SQLite comparison against `datetime('now', ?)`. There is no
// index on posted_at, so both sides used to be compared as plain TEXT. That silently requires every
// stored value to have the same shape and the same timezone, and nothing enforced it. Production had
// two consequences, both measured before this was written:
//
//   • 282 WeWorkRemotely rows stored an RFC-2822 pubDate ("Fri, 05 Dec 2025 10:37:40 +0000"). It
//     starts with a letter, letters sort above digits, so every one of them compared as newer than
//     any timestamp the app can generate. They appeared in "posted in the last 7 days" permanently,
//     and the 3am retention purge could never delete one — 282 of 282 were immortal.
//   • `datetime('now','-7 days')` renders "2026-07-22 09:00:00" with a SPACE, while stored values use
//     "2026-07-22T14:00:00.000Z" with a T. 'T' (0x54) sorts above ' ' (0x20), so every row on the
//     cutoff day compared as after the cutoff no matter its actual time. 704 rows on production.
//
// Together the 7-day filter reported 2,805 jobs when the true answer was 1,819.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { toIsoInstant, makeJob } from "./normalize.ts";

test("RFC-2822 (WeWorkRemotely RSS) becomes comparable UTC", () => {
  assert.equal(toIsoInstant("Fri, 05 Dec 2025 10:37:40 +0000"), "2025-12-05T10:37:40.000Z");
});

test("a local offset is converted to the actual instant, not kept as wall-clock", () => {
  // Greenhouse and Ashby send these. Compared as text against a UTC cutoff, 13:27-05:00 would be
  // judged as if it were 13:27 UTC — five hours earlier than it happened.
  assert.equal(toIsoInstant("2026-02-10T13:27:12-05:00"), "2026-02-10T18:27:12.000Z");
  assert.equal(toIsoInstant("2024-08-14T21:29:21.209+00:00"), "2024-08-14T21:29:21.209Z");
});

test("SmartRecruiters' space-and-UTC form parses", () => {
  assert.equal(toIsoInstant("2026-06-11 12:23:24 UTC"), "2026-06-11T12:23:24.000Z");
});

test("an already-correct value is returned unchanged", () => {
  assert.equal(toIsoInstant("2026-04-01T00:00:00.000Z"), "2026-04-01T00:00:00.000Z");
});

test("a date-only value keeps its date and does not gain an invented time", () => {
  assert.equal(toIsoInstant("2026-04-01"), "2026-04-01");
});

test("junk becomes null, because null means 'unknown' and every caller handles it", () => {
  // A junk string does not merely fail to sort — it outranks every real timestamp and makes the row
  // permanently recent and permanently unpurgeable. Dropping it is the safe outcome.
  for (const v of ["", "   ", "n/a", "Posted 3 days ago", "not a date", null, undefined])
    assert.equal(toIsoInstant(v as string), null, `${JSON.stringify(v)} must not be stored`);
});

test("makeJob normalizes on the way in — the only write path for posted_at", () => {
  const j = makeJob({
    source: "weworkremotely", externalId: "wwr:x", title: "Engineer",
    url: "https://example.com/x", postedAt: "Fri, 05 Dec 2025 10:37:40 +0000",
  });
  assert.equal(j.postedAt, "2025-12-05T10:37:40.000Z");
  assert.equal(makeJob({ source: "s", externalId: "e", title: "t", url: "https://e.com/1", postedAt: "garbage" }).postedAt, null);
});

// ---- The SQL half. An in-memory database, so this asserts on SQLite's real comparison semantics
// rather than on a re-implementation of them in JavaScript.

const fixture = () => {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE raw_jobs (id TEXT PRIMARY KEY, posted_at TEXT, seen_at TEXT)");
  const ins = d.prepare("INSERT INTO raw_jobs (id, posted_at, seen_at) VALUES (?, ?, datetime('now'))");
  ins.run("boundary", new Date(Date.now() - 7 * 86_400_000 + 3_600_000).toISOString()); // inside 7d by an hour
  ins.run("old", "2020-01-01T00:00:00.000Z");
  ins.run("rfc2822", "Fri, 05 Dec 2025 10:37:40 +0000");                                 // the unnormalized form
  return d;
};
const count = (d: DatabaseSync, where: string, ...p: string[]) =>
  (d.prepare(`SELECT COUNT(*) c FROM raw_jobs WHERE ${where}`).get(...p) as { c: number }).c;

test("text comparison mis-sorts an RFC-2822 date above every real timestamp", () => {
  // Not a test of our code — a demonstration that the premise is real, so the fix below is not
  // cargo-culted. If SQLite ever stopped behaving this way, this test tells us.
  const d = fixture();
  assert.equal(count(d, "posted_at > ?", "9999-01-01T00:00:00.000Z"), 1,
    "a weekday-name date must sort above the year 9999 — this is why it was never purged");
});

test("julianday comparison ignores format and compares actual instants", () => {
  const d = fixture();
  // The shipped purge predicate, as db.ts now writes it.
  assert.equal(count(d, "julianday(COALESCE(posted_at, seen_at)) < julianday(datetime('now', ?))", "-30 days"), 1,
    "only the 2020 row is older than 30 days");
  // Only the boundary row. The 2020 row is genuinely outside the window, and the RFC-2822 row —
  // which text comparison ranked above the year 9999 — now yields NULL and drops out instead of
  // occupying "posted this week" forever.
  assert.equal(count(d, "julianday(posted_at) >= julianday(datetime('now', ?))", "-7 days"), 1,
    "only the genuinely-recent row belongs in a 7-day window");
});

test("an unparseable date can never be hard-deleted by the purge", () => {
  // julianday(junk) is NULL and `NULL < x` is NULL, which is falsy — so the row is SKIPPED, not
  // deleted. For the only unattended destructive operation in the app, failing closed is correct:
  // keeping a row too long is recoverable, deleting the wrong one is not.
  const d = fixture();
  const ids = d.prepare(
    "SELECT id FROM raw_jobs WHERE julianday(COALESCE(posted_at, seen_at)) < julianday(datetime('now', ?))",
  ).all("-30 days") as { id: string }[];
  assert.deepEqual(ids.map((r) => r.id), ["old"]);
});
