// The incremental early stop skipped exactly the pages it needed to read.
//
// An /org/<domain> scan is the only source that knows an employer's domain for certain — it asked for
// that domain by name — and learnDomain fills a blank domain on any row it re-sights. The early stop
// then guaranteed that never happened: it halts at the first page whose jobs are all already stored,
// and a job stored WITHOUT a domain is "already stored". The pages holding the rows that needed
// teaching were precisely the pages the scan refused to read.
//
// Measured in production: 7,189 hcorg rows — 40% of everything that source has collected, across 351
// employers including iHeartMedia (631) and Nexstar (600) — carry no domain, and 6,976 of them belong
// to a company with no domain on any other row either, so nothing stored can recover them.
// dbBackfillDomains cannot either: it revisits domain IS NULL, and these are empty string, which
// means "computed, the URL yielded nothing" — true, and permanent.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbJobKnown, dbJobKnownAndAttributed, upsertJob } from "./db.ts";
import { makeJob } from "./normalize.ts";

const mk = (extId: string, domain: string | null) => makeJob({
  source: "hcorg", externalId: extId, title: "Producer", company: "iHeartMedia",
  url: `https://iheartmedia.wd5.myworkdayjobs.com/job/${extId}`, domain,
});

test("a job stored without a domain does not count as learned", () => {
  const j = mk("attr-blank", "");
  upsertJob(j);
  assert.equal(dbJobKnown(j.id), true, "it is stored");
  assert.equal(dbJobKnownAndAttributed(j.id), false, "but it has not been taught its employer");
});

test("a job stored WITH its domain counts as learned, so the early stop still works", () => {
  const j = mk("attr-filled", "iheartmedia.com");
  upsertJob(j);
  assert.equal(dbJobKnownAndAttributed(j.id), true);
});

test("a NULL domain is unattributed too, not just an empty string", () => {
  // Both states exist in production and mean different things to dbBackfillDomains — NULL is "never
  // computed", empty is "computed, nothing derivable". Neither is an employer, so neither is learned.
  const j = mk("attr-null", null);
  upsertJob(j);
  db.prepare("UPDATE raw_jobs SET domain = NULL WHERE id = ?").run(j.id);
  assert.equal(dbJobKnownAndAttributed(j.id), false);
});

test("a job that was never stored is not attributed", () => {
  assert.equal(dbJobKnownAndAttributed("no-such-job-id"), false);
});

test("once the blank row is taught, the scan can stop early again", () => {
  // The cost of this fix is one deeper scan per affected company, ONCE. If teaching a row did not
  // flip it to attributed, every scheduled scan would re-crawl that company forever.
  const j = mk("attr-heals", "");
  upsertJob(j);
  assert.equal(dbJobKnownAndAttributed(j.id), false);
  db.prepare("UPDATE raw_jobs SET domain = 'iheartmedia.com' WHERE id = ?").run(j.id);
  assert.equal(dbJobKnownAndAttributed(j.id), true, "the deeper scan must not repeat next time");
});
