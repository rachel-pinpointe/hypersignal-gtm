// Regression tests for the SEC EDGAR producer.
//
// The producer used to read its filings straight out of EDGAR's full-text-search hit list. Measured
// against the live API, that list is ranked by RELEVANCE and capped at 100: "Cargill" matches 2,989
// filings and the 100 returned were dated 2004-2013, so a company that filed an 8-K last month was
// reported as "none of interest in 12mo". Worse, relevance ties reorder between requests, so a
// filing could vanish from one scan's page and reappear in the next — and since domain_state stores
// accession numbers as the diff baseline, reappearing read as brand new and fabricated a "raised
// capital" signal for a filing from years ago.
//
// Both failures are reproduced here against a stubbed EDGAR, so neither can come back quietly.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgarProducer } from "./edgar.ts";
import { dbGetDomainState, dbReplaceDomainState } from "../db.ts";

// The producer skips entirely without a contact email (SEC requires one); these tests exercise the
// lookup itself, so give it one. The unset case is covered in contact.test.ts.
process.env.CONTACT_EMAIL = "tests@example.com";

const CIK = "0000123456";
const NAME = "Northwind Logistics, Inc.";
const COMPANY = "Northwind Logistics";
const today = new Date().toISOString().slice(0, 10);
const old = "2009-06-03";

/** An FTS page shaped like the real one: the entity is identifiable, and the hits are OLD. */
const ftsPage = (hits: Array<{ date: string; form: string; acc: string }>) => ({
  hits: { total: { value: 2989 }, hits: hits.map((h) => ({ _source: {
    display_names: [`${NAME}  (CIK ${CIK})`], root_forms: [h.form], file_date: h.date, adsh: h.acc,
  } })) },
});

/** The submissions endpoint: complete and date-ordered, newest first. */
const submissions = (rows: Array<{ date: string; form: string; acc: string }>, name = NAME) => ({
  name, cik: CIK,
  filings: { recent: {
    form: rows.map((r) => r.form), filingDate: rows.map((r) => r.date), accessionNumber: rows.map((r) => r.acc),
  } },
});

/** Stub global fetch, routing by host. Returns the calls made so the test can assert on them. */
function stubEdgar(opts: { fts: unknown; sub: unknown }): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("efts.sec.gov") ? opts.fts : opts.sub;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const reset = (domain: string) => dbReplaceDomainState(domain, "edgar", { _v: "1", cik: CIK });

test("a recent filing is reported even when the FTS page holds only old ones", async () => {
  // THE BUG. FTS returns nothing but 2009; submissions holds an 8-K filed today. Reading FTS, the
  // producer said "none of interest in 12mo" for a company that filed this morning.
  const domain = "edgar-recent.test";
  dbReplaceDomainState(domain, "edgar", {});
  const s = stubEdgar({
    fts: ftsPage([{ date: old, form: "8-K", acc: "0000123456-09-000001" }]),
    sub: submissions([
      { date: today, form: "8-K", acc: "0000123456-26-000009" },
      { date: old, form: "8-K", acc: "0000123456-09-000001" },
    ]),
  });
  try {
    const r = await edgarProducer.check(domain, { company: COMPANY });
    assert.match(r.facts["Recent filings"]!, /8-K/, "the filing made today must appear in the facts");
    assert.equal(r.flag?.hit, true, "a filing inside the window is a current-state hit");
    assert.match(r.facts["SEC filer"]!, /Northwind/);
  } finally { s.restore(); }
});

test("the filing list comes from submissions, not from the FTS hit page", async () => {
  // Guards the instrument. If a refactor pointed the filing list back at FTS this test would still
  // pass on the one above (both mention 8-K), so assert the endpoint was actually called.
  const domain = "edgar-endpoint.test";
  dbReplaceDomainState(domain, "edgar", {});
  const s = stubEdgar({
    fts: ftsPage([{ date: old, form: "8-K", acc: "0000123456-09-000001" }]),
    sub: submissions([{ date: today, form: "D", acc: "0000123456-26-000010" }]),
  });
  try {
    await edgarProducer.check(domain, { company: COMPANY });
    assert.ok(s.calls.some((u) => u.includes("data.sec.gov/submissions/CIK0000123456.json")),
      `submissions was never fetched; calls were:\n${s.calls.join("\n")}`);
  } finally { s.restore(); }
});

test("a filing dropping out of the FTS page and returning does not fabricate a signal", async () => {
  // The instability. Scan 1 establishes the baseline; scan 2's FTS page is reordered and shorter,
  // which under the old code emptied the baseline for that filing; scan 3 sees it again and — since
  // the accession was no longer in domain_state — reported a years-old Form D as a fresh raise.
  const domain = "edgar-stable.test";
  const rows = [
    { date: today, form: "D", acc: "0000123456-26-000011" },
    { date: old, form: "8-K", acc: "0000123456-09-000002" },
  ];
  dbReplaceDomainState(domain, "edgar", {});
  let s = stubEdgar({ fts: ftsPage(rows), sub: submissions(rows) });
  try { await edgarProducer.check(domain, { company: COMPANY }); } finally { s.restore(); }
  assert.ok(dbGetDomainState(domain, "edgar").has("filed:0000123456-26-000011"),
    "scan 1 must have written the accession into the baseline");

  // Scan 2: FTS returns a completely different, empty-ish page. submissions is unchanged, because
  // the filer's history did not change — which is the entire point of asking the right endpoint.
  s = stubEdgar({ fts: ftsPage([]), sub: submissions(rows) });
  let r2;
  try { r2 = await edgarProducer.check(domain, { company: COMPANY }); } finally { s.restore(); }
  assert.deepEqual(r2.signals, [], "an unchanged filing history must produce no signals");
  assert.ok(dbGetDomainState(domain, "edgar").has("filed:0000123456-26-000011"),
    "the baseline must survive an unhelpful FTS page");
});

test("a genuinely new filing does still signal", async () => {
  // The other half: the stability fix must not silence the producer.
  const domain = "edgar-new.test";
  const before = [{ date: old, form: "8-K", acc: "0000123456-09-000003" }];
  dbReplaceDomainState(domain, "edgar", {});
  let s = stubEdgar({ fts: ftsPage(before), sub: submissions(before) });
  try { await edgarProducer.check(domain, { company: COMPANY }); } finally { s.restore(); }

  const after = [{ date: today, form: "D", acc: "0000123456-26-000012" }, ...before];
  s = stubEdgar({ fts: ftsPage(after), sub: submissions(after) });
  let r;
  try { r = await edgarProducer.check(domain, { company: COMPANY }); } finally { s.restore(); }
  assert.equal(r.signals.length, 1, "the new Form D must signal");
  assert.equal(r.signals[0]!.type, "funding-form-d");
  assert.match(r.signals[0]!.url!, /Archives\/edgar\/data\/123456\//);
});

test("a cached CIK whose SEC name no longer matches the company is refused", async () => {
  // The CIK is reused across scans, so one bad match would otherwise be permanent. submissions
  // reports the SEC's own name for that CIK and it is re-checked every time.
  const domain = "edgar-wrongcik.test";
  reset(domain);
  const s = stubEdgar({
    fts: { hits: { hits: [] } },   // and no other filer matches either
    sub: submissions([{ date: today, form: "D", acc: "0000123456-26-000013" }], "Pantera Opportunities Fund SP"),
  });
  try {
    const r = await edgarProducer.check(domain, { company: COMPANY });
    assert.match(r.facts["EDGAR"]!, /no SEC filer matches/);
    assert.deepEqual(r.signals, []);
  } finally { s.restore(); }
});

test("a rate-limited lookup is reported as unavailable, not as 'no filings'", async () => {
  // Pre-existing behaviour, pinned: the two must never collapse into each other again.
  const domain = "edgar-429.test";
  dbReplaceDomainState(domain, "edgar", {});
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 429 })) as typeof fetch;
  try {
    const r = await edgarProducer.check(domain, { company: COMPANY });
    assert.match(r.facts["EDGAR"]!, /unavailable/);
    assert.equal(r.flag, undefined, "a failed lookup must not clear a known flag");
  } finally { globalThis.fetch = real; }
});
