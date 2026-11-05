// dbBackfillDomains is the only function in the app that can mass-rewrite a column, and its own
// comment invites you to trigger it ("Bump when extractDomain's rules change"). That combination
// is why it gets a test: the failure mode is silent, wholesale, and instruction-driven.
//
// History, both caught by running it against the real 24,957-row snapshot rather than by reading it:
//   1. The original `extractDomain(url) ?? ""` assumed the domain always came from the posting URL.
//      It does not — sources/hiringcafe.ts prefers the company's HOMEPAGE. Bumping the version would
//      have blanked 6,105 correct employer domains (ups.com, fedex.com, expeditors.com…) whose apply
//      links point at an ATS that extractDomain deliberately returns null for.
//   2. The first fix, "a fresh derivation always wins", was wrong the same way: 1,111 FedEx postings
//      apply via fedex.paradox.ai, so it relabelled them all as the vendor "paradox.ai".
// Hence the rule under test: replace ONLY what is provably wrong.
// Run: npx tsx --test src/domainBackfill.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbBackfillDomains } from "./db.ts";

const ins = db.prepare("INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, url, domain, status, seen_at) VALUES (?, ?, 'test', 'Engineer', 'Test Co', ?, ?, 'open', datetime('now'))");
const seed = (id: string, url: string, domain: string | null) => { ins.run(id, id, url, domain); };
const domainOf = (id: string) => (db.prepare("SELECT domain FROM raw_jobs WHERE id = ?").get(id) as { domain: string | null }).domain;

test("a homepage-derived domain survives a re-derive its URL cannot reproduce", () => {
  db.exec("DELETE FROM meta WHERE k='backfill:domain-rules'");
  // The real shape: correct employer domain, apply URL on a third-party platform.
  seed("t-ups", "https://ups.wd5.myworkdayjobs.com/en-US/ups/job/123", "ups.com");
  seed("t-fedex", "https://fedex.paradox.ai/co/FederalExpress/Job?job_id=1", "fedex.com");
  dbBackfillDomains();
  assert.equal(domainOf("t-ups"), "ups.com", "a workday apply link is not evidence UPS has no domain");
  assert.equal(domainOf("t-fedex"), "fedex.com", "a Paradox apply link must not relabel FedEx as paradox.ai");
});

test("a provably-wrong stored domain IS corrected", () => {
  db.exec("DELETE FROM meta WHERE k='backfill:domain-rules'");
  seed("t-ats", "https://www.comeet.com/jobs/algosec/99", "comeet.com");        // shared ATS host
  seed("t-suffix", "https://foo.us.com/careers", "us.com");                      // bare public suffix
  seed("t-null", "https://realemployer.com/jobs/1", null);                       // never computed
  dbBackfillDomains();
  assert.equal(domainOf("t-ats"), "", "an ATS host is not an employer domain and must be cleared");
  assert.equal(domainOf("t-suffix"), "foo.us.com", "the suffix-aware parser recovers the real domain");
  assert.equal(domainOf("t-null"), "realemployer.com", "a never-computed row is still filled in");
});

test("the backfill converges — a second run changes nothing", () => {
  db.exec("DELETE FROM meta WHERE k='backfill:domain-rules'");
  seed("t-conv", "https://acme.co.uk/jobs/1", null);
  dbBackfillDomains();
  assert.equal(domainOf("t-conv"), "acme.co.uk");
  assert.equal(dbBackfillDomains(), 0, "a re-run must be a no-op, not a rewrite of every row");
});
