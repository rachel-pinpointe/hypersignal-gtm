// A job first seen by keyword search could never learn its real job description.
//
// `upgradeDesc` exists for exactly one scenario, and its own comment names it: a posting first seen
// through a keyword search, later re-seen by an /org/ scan or an account check whose payload carries
// the scraped prose. Its guard was `description IS NULL OR description = ''` — and under that guard it
// could never fire for that scenario, because the description is never empty.
//
// The reason is one step removed, which is why it survived. `rawDescription` does not just read the
// prose; when there is none it COMPOSES a description out of hiring.cafe's structured facets. Every
// keyword-search result carries a seniority, so every one of them composes at least
// "Requirements:\n• Mid Level" — 25 characters, non-empty, guard closed, forever.
//
// Measured on the live database before this fix:
//   7,552 rows hold a composed stub (avg 458 chars) where a real description averages 3,920
//   2,642 of them have already been re-seen at least once, each sighting refused
//   7,546 of the 7,552 are `hiringcafe`; 16,351 of the 16,925 real ones are `hcorg`
// The two halves of the intended upgrade are sitting right there in the data, never meeting.
//
// It is not a cosmetic column: `description` is what the FTS index is built from and what the
// technology tagger reads. Thirty per cent of the corpus was being searched and tech-tagged from a
// summary of itself.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, upsertJob, rawDescription } from "./db.ts";
import type { RawJob } from "./types.ts";

/** What a hiring.cafe keyword hit looks like: rich facets, no prose. */
const KEYWORD_PAYLOAD = { seniority: "Mid Level", yoe: 4, tools: ["Python"], comp_max: 180000, currency: "USD" };
/** What an /org/ scan of the same posting looks like: the scraped job description. */
const REAL_JD = "About the role\n\nYou will own the ingestion pipeline end to end. ".repeat(20);

const job = (id: string, source: string, raw: Record<string, unknown>): RawJob => ({
  id, source, externalId: id, title: "Data Engineer", company: "Acme",
  location: "Austin, TX", state: "TX", remote: false,
  url: `https://boards.greenhouse.io/acme/jobs/${id}`, postedAt: null, domain: "acme.test", raw,
} as unknown as RawJob);

const row = (id: string) => db.prepare(
  "SELECT description, comp_max, currency, json_extract(raw,'$.description') rawDesc FROM raw_jobs WHERE id = ?").get(id) as
  { description: string | null; comp_max: number | null; currency: string | null; rawDesc: string | null };

test("the composed stub is real — a keyword hit is never stored with an empty description", async () => {
  // Guard the instrument, and pin the mechanism the whole finding rests on. If rawDescription ever
  // stops composing, the guard below would start passing for the wrong reason and this file would
  // quietly stop testing anything.
  const composed = rawDescription(JSON.stringify(KEYWORD_PAYLOAD));
  assert.ok(composed && composed.length > 0, "a facets-only payload must still compose something");
  assert.ok(!composed!.includes("own the ingestion pipeline"), "...and it is a summary, not the real prose");
  assert.ok(composed!.length < 500, `the stub is short — ${composed!.length} chars against a real JD's thousands`);
});

test("a keyword-first posting learns the real description when the org scan re-sees it", async () => {
  // THE regression. Before the fix the second upsert changed nothing at all.
  upsertJob(job("du-1", "hiringcafe", KEYWORD_PAYLOAD));
  const first = row("du-1");
  assert.equal(first.rawDesc, null, "the keyword payload carries no prose");
  assert.ok(first.description && first.description.length < 500, "so the column holds a composed stub");

  upsertJob(job("du-1", "hcorg", { ...KEYWORD_PAYLOAD, description: REAL_JD }));
  const after = row("du-1");
  assert.equal(after.rawDesc, REAL_JD, "the re-sighting's prose is stored");
  assert.equal(after.description, REAL_JD, "and the column now holds it instead of the stub");
});

test("a real description is never replaced by a stub, whichever order the sightings arrive in", async () => {
  // The other direction, and the one that would be a data-loss bug rather than a missed upgrade.
  // Scans are scheduled independently; an org scan landing before a keyword hit is ordinary.
  upsertJob(job("du-2", "hcorg", { ...KEYWORD_PAYLOAD, description: REAL_JD }));
  assert.equal(row("du-2").description, REAL_JD);

  upsertJob(job("du-2", "hiringcafe", KEYWORD_PAYLOAD));
  assert.equal(row("du-2").description, REAL_JD, "the facets-only payload must not overwrite the prose");
  assert.equal(row("du-2").rawDesc, REAL_JD, "and the stored payload must still be the rich one");
});

test("one real description does not overwrite another", async () => {
  // Once the row holds prose it is done. Two org scans of the same posting must not churn the column
  // (and, through it, the FTS index and the technology tags) on every scheduled run.
  const OTHER = "A different scrape of the same page.".repeat(30);
  upsertJob(job("du-3", "hcorg", { description: REAL_JD }));
  upsertJob(job("du-3", "hcorg", { description: OTHER }));
  assert.equal(row("du-3").description, REAL_JD, "first prose wins — FILL, NEVER CORRECT");
});

test("an upgrade that carries no salary cannot erase the one already stored", async () => {
  // The risk the widened path introduces. Measured on the live data, 53% of real-JD payloads carry a
  // salary against 8% of stubs — so a straight overwrite would have blanked the figure on a large
  // share of exactly the rows this fix now touches.
  upsertJob(job("du-4", "hiringcafe", KEYWORD_PAYLOAD));               // salary 180000 USD, no prose
  assert.equal(row("du-4").comp_max, 180000);

  upsertJob(job("du-4", "hcorg", { seniority: "Mid Level", description: REAL_JD }));  // prose, no salary
  const after = row("du-4");
  assert.equal(after.description, REAL_JD, "the description still upgraded");
  assert.equal(after.comp_max, 180000, "and the salary survived the payload that lacked one");
  assert.equal(after.currency, "USD", "as did its currency");
});

test("an empty description is still filled, which is what the guard always did", async () => {
  // The original behaviour, kept. A source with neither prose nor facets composes nothing at all, and
  // that row must still be able to learn one later.
  upsertJob(job("du-5", "craigslist:sfbay", {}));
  assert.equal(row("du-5").description, null, "nothing to compose from → genuinely empty");
  upsertJob(job("du-5", "hcorg", { description: REAL_JD }));
  assert.equal(row("du-5").description, REAL_JD);
});
