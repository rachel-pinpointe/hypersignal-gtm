// A re-sighting must be able to teach a stored job its EMPLOYER DOMAIN.
//
// upsertJob had `upgradeDesc` — a row re-seen with a richer payload learns the description it
// lacked — and no equivalent for `domain`, so touchJob refreshed last_seen_at/status and threw the
// incoming domain away. That matters because the two paths know different things about the same
// posting: an /org/<domain> scan knows the domain by construction (it IS the thing being scraped),
// while the same job first seen through a keyword search usually does not, since its apply URL is an
// ATS host that extractDomain deliberately refuses to treat as an employer.
//
// The live consequence, measured: 12,708 rows hold an empty domain, 6,162 of them from /org/ scans
// — rows that were stamped correctly at INSERT and later blanked by the destructive re-derive that
// db.ts's backfill comment describes. That re-derive is fixed, but a fix does not restore data, the
// safe backfill rule now skips a stored "", and touchJob ignored the domain. So every future scrape
// of those exact jobs would carry the right domain and discard it, forever. A job with no domain
// matches no watchlist, counts toward no company's velocity and appears under no account.
//
// The rule being pinned is FILL, NEVER CORRECT: only NULL/'' is written to, so a domain we already
// believe can never be replaced by a weaker later reading.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, upsertJob } from "./db.ts";
import type { RawJob } from "./types.ts";

const ID = "learn-domain-fixture";
const job = (domain: string | null): RawJob => ({
  id: ID, source: "hiringcafe", externalId: ID, title: "Driver", company: "Acme Freight",
  location: "Austin, TX", state: "TX", remote: false,
  url: "https://acme.wd5.myworkdayjobs.com/external/job/1", postedAt: null, domain, raw: {},
} as RawJob);

const stored = (): string | null =>
  (db.prepare("SELECT domain FROM raw_jobs WHERE id = ?").get(ID) as { domain: string | null } | undefined)?.domain ?? null;
const reset = (): void => { db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(ID); };

test("a job stored with no domain learns one when it is re-seen with it", () => {
  // The /org/ scan case: same posting, second sighting, and this time we know whose it is.
  reset();
  upsertJob(job(null));
  assert.equal(stored(), "", "a job with no derivable domain stores '' — computed, and there is none");
  upsertJob(job("acmefreight.com"));
  assert.equal(stored(), "acmefreight.com");
  reset();
});

test("a job blanked by the old re-derive is repaired by its next scrape", () => {
  // Exactly the 6,162 rows in production: inserted WITH a domain, blanked afterwards. Before this
  // change nothing could put it back — the backfill skips '' and touchJob ignored the field.
  reset();
  upsertJob(job("acmefreight.com"));
  db.prepare("UPDATE raw_jobs SET domain = '' WHERE id = ?").run(ID);
  assert.equal(stored(), "");
  upsertJob(job("acmefreight.com"));
  assert.equal(stored(), "acmefreight.com", "the next scrape of the same job must heal it");
  reset();
});

test("a known domain is NEVER overwritten by a later sighting", () => {
  // The whole safety of the change. hiring.cafe prefers the employer's HOMEPAGE, so ups.com and
  // fedex.com are stored correctly while their apply links point at an ATS. A later sighting that
  // resolved only the ATS host must not be allowed to win — that is the mistake dbBackfillDomains
  // documents having made on 1,111 FedEx rows.
  reset();
  upsertJob(job("fedex.com"));
  upsertJob(job("paradox.ai"));
  assert.equal(stored(), "fedex.com");
  reset();
});

test("a sighting with no domain cannot blank one we already have", () => {
  // The empty-string guard. Without it, `domain = ?` with '' would clear a good value on any
  // re-sight from a source that could not resolve one — turning a repair into the original bug.
  reset();
  upsertJob(job("acmefreight.com"));
  upsertJob(job(null));
  assert.equal(stored(), "acmefreight.com");
  reset();
});

test("the DEDUP branch fills it too, not just the same-id re-sight", () => {
  // upsertJob has two re-sight paths and they are easy to fix by halves. The second is app-wide
  // dedup: the same posting arriving under a DIFFERENT (source, external_id) but the same canonical
  // dedup_key is treated as a re-sight of the stored row. That is precisely the /org/ scan finding a
  // job the keyword search already stored — the exact case where the domain is newly known — so a
  // fill on only the id path would miss the population it was written for.
  const A = "learn-domain-dupe-a", B = "learn-domain-dupe-b";
  const url = "https://acme.wd5.myworkdayjobs.com/external/job/dupe";
  for (const id of [A, B]) db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(id);
  // The shared dedupKey is the whole point: makeJob derives it from the apply URL, so the same role
  // cross-posted to two sources collapses onto one row. Passing raw objects here skips makeJob, and
  // without this the fallback key is `source:externalId` — different for each — so the second call
  // inserts a second row and the dedup branch is never entered. (Learned by writing it wrong first:
  // the test failed on "must be recognised as a dupe" rather than on the behaviour under test.)
  const DK = "url:" + url;
  upsertJob({ id: A, source: "hiringcafe", externalId: "a", title: "Driver", company: "Acme Freight",
    location: null, state: null, remote: false, url, postedAt: null, domain: null, dedupKey: DK, raw: {} } as RawJob);
  assert.equal((db.prepare("SELECT domain FROM raw_jobs WHERE id = ?").get(A) as { domain: string }).domain, "");
  // Same url → same dedup_key → recognised as the same posting, under a different source.
  const inserted = upsertJob({ id: B, source: "hcorg", externalId: "b", title: "Driver", company: "Acme Freight",
    location: null, state: null, remote: false, url, postedAt: null, domain: "acmefreight.com", dedupKey: DK, raw: {} } as RawJob);
  assert.equal(inserted, false, "must be recognised as a dupe, or this test proves nothing about that branch");
  assert.equal((db.prepare("SELECT domain FROM raw_jobs WHERE id = ?").get(A) as { domain: string }).domain,
    "acmefreight.com", "the ORIGINAL row learns the domain the dupe arrived with");
  for (const id of [A, B]) db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(id);
});

test("a domain-less sighting cannot turn NULL into '' either", () => {
  // What the `? <> ''` guard is actually for, stated precisely — the overwrite guard alone does not
  // cover it, and a mutation test is what showed that. NULL and '' are not the same thing to
  // dbBackfillDomains: NULL means "never computed" and is eligible for re-derivation, '' means
  // "computed, and there is none" and is deliberately left alone. Writing '' over NULL is therefore
  // not a harmless no-op — it quietly removes the row from the backfill's reach forever.
  reset();
  upsertJob(job(null));
  db.prepare("UPDATE raw_jobs SET domain = NULL WHERE id = ?").run(ID);
  assert.equal(stored(), null);
  upsertJob(job(null));
  assert.equal(stored(), null, "still NULL — still eligible for a future re-derive");
  reset();
});

// ── the same rule for COMPANY, the third and last learnable field ────────────────────────────────
//
// Company is the identity every NAME-keyed producer matches on — EDGAR, Companies House, WARN, news
// and app listings all take a name, never a domain. 105 stored rows have none, all of them from
// Lever, Ashby or Personio boards whose APIs genuinely do not return one, while Greenhouse,
// SmartRecruiters and hiring.cafe all do. Since 3,866 hiring.cafe rows point at ATS boards we also
// scrape directly, and both routes derive the same URL-based dedup key, the two sightings collapse
// onto one row — and whichever arrived first wins. When that is the ATS route, the naming sighting
// arrives, is read for its description, and has its company thrown away.

const CO = "learn-company-fixture";
const coJob = (company: string | null): RawJob => ({
  id: CO, source: "ats:ashby:acme", externalId: CO, title: "Driver", company,
  location: null, state: null, remote: false,
  url: "https://jobs.ashbyhq.com/acme/xyz", postedAt: null, domain: "acme.com", raw: {},
} as RawJob);
const storedCo = (): string | null =>
  (db.prepare("SELECT company FROM raw_jobs WHERE id = ?").get(CO) as { company: string | null } | undefined)?.company ?? null;

test("a job stored with no company learns one when a naming source re-sights it", () => {
  db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(CO);
  upsertJob(coJob(null));
  assert.equal(storedCo(), null, "Lever/Ashby return no company — the row starts blank");
  upsertJob(coJob("Acme Freight"));
  assert.equal(storedCo(), "Acme Freight");
  db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(CO);
});

test("a known company is never overwritten, and a blank sighting never clears one", () => {
  // Fill, never correct — the same rule as its two siblings, and the reason this is safe to run on
  // every single re-sight.
  db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(CO);
  upsertJob(coJob("Acme Freight"));
  upsertJob(coJob("Ashby"));          // the ATS vendor's own name must not win
  assert.equal(storedCo(), "Acme Freight");
  upsertJob(coJob(null));
  assert.equal(storedCo(), "Acme Freight");
  upsertJob(coJob("   "));            // whitespace is not a name
  assert.equal(storedCo(), "Acme Freight");
  db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(CO);
});

test("a learned company is SEARCHABLE, not just stored", () => {
  // company is an indexed field. Learning one without resyncing FTS leaves the job invisible to a
  // search for the very name it just acquired — a half-fix that looks complete in the jobs table.
  db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(CO);
  upsertJob(coJob(null));
  upsertJob(coJob("Zzyzxcorp"));      // distinctive, so a hit can only be this fixture
  const found = db.prepare("SELECT COUNT(*) c FROM jobs_fts WHERE jobs_fts MATCH ?").get("Zzyzxcorp") as { c: number };
  assert.equal(Number(found.c), 1, "the search index must carry the learned name");
  db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(CO);
});

test("the DEDUP branch learns the company too, and reindexes it", () => {
  // Both re-sight paths again, and this is the one that matters most for company: the ATS route
  // inserts the row, then the hiring.cafe sighting of the SAME posting arrives under a different
  // source with the same URL-derived dedup key. That branch resyncs FTS only when something changed,
  // so a name learned there is easy to store and forget to index.
  const A = "learn-co-dupe-a", B = "learn-co-dupe-b";
  const url = "https://jobs.ashbyhq.com/acme/dupe-co";
  const DK = "url:" + url;
  for (const id of [A, B]) db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(id);
  upsertJob({ id: A, source: "ats:ashby:acme", externalId: "a", title: "Driver", company: null,
    location: null, state: null, remote: false, url, postedAt: null, domain: "acme.com", dedupKey: DK, raw: {} } as RawJob);
  const inserted = upsertJob({ id: B, source: "hiringcafe", externalId: "b", title: "Driver", company: "Qqxwtrucking",
    location: null, state: null, remote: false, url, postedAt: null, domain: "acme.com", dedupKey: DK, raw: {} } as RawJob);
  assert.equal(inserted, false, "must be recognised as a dupe, or this proves nothing about that branch");
  assert.equal((db.prepare("SELECT company FROM raw_jobs WHERE id = ?").get(A) as { company: string }).company,
    "Qqxwtrucking", "the ORIGINAL row learns the name the naming source arrived with");
  const found = db.prepare("SELECT COUNT(*) c FROM jobs_fts WHERE jobs_fts MATCH ?").get("Qqxwtrucking") as { c: number };
  assert.equal(Number(found.c), 1, "...and the search index is updated, not just the row");
  for (const id of [A, B]) db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(id);
});

test("a blank company sighting does not even issue a write", () => {
  // What the `? <> ''` guard earns on the COMPANY statement, stated for what it is rather than
  // overclaimed. Unlike the domain case, NULL and '' are not meaningfully different here — no
  // consumer distinguishes them and TRIM(company) = '' keeps the row learnable either way — so the
  // guard is not protecting correctness. It stops a pointless UPDATE on every re-sight of every
  // company-less row, which on a watchlist re-scan is thousands of writes that change nothing.
  db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(CO);
  upsertJob(coJob(null));
  const stmt = db.prepare("UPDATE raw_jobs SET company = ? WHERE id = ? AND ? <> '' AND (company IS NULL OR TRIM(company) = '')");
  assert.equal(Number(stmt.run("", CO, "").changes), 0, "an empty name must be a no-op, not a write");
  assert.equal(Number(stmt.run("Acme", CO, "Acme").changes), 1, "...while a real name still lands");
  db.prepare("DELETE FROM raw_jobs WHERE id = ?").run(CO);
});
