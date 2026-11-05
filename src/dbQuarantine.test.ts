// Phase 21: board quarantine and the manual allow-list.
//
// A quarantined (domain, vendor, slug) is a CONFIRMED wrong-company board for that domain. It must
// never be probed, fetched, accepted or relearned, and its jobs must not reach raw_jobs through ANY
// lane — clasp.com showed hiring.cafe delivering exactly the wrong board's jobs the ATS lane had.
// A hand-confirmed board (ats_board_overrides) must survive strict re-verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbQuarantineBoard, dbAddBoardOverride, dbIsBoardQuarantined, dbIsBoardOverridden,
  dbCloseQuarantinedJobs, dbSaveAtsProbe, upsertJob } from "./db.ts";
import { discoverAtsBoards, discoverAndCacheAts, atsAdapter, dropQuarantinedJobs } from "./sources/ats.ts";
import { makeJob } from "./normalize.ts";
import type { RawJob } from "./types.ts";

async function withAshby<T>(boards: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    calls.push(url);
    for (const [slug, body] of Object.entries(boards))
      if (url.includes(`/posting-api/job-board/${slug}?`) || url.endsWith(`/posting-api/job-board/${slug}`))
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const ashbyBoard = (desc: string) => ({ jobs: [{ id: "1", title: "Engineer", jobUrl: "https://jobs.ashbyhq.com/x/1", descriptionPlain: desc }] });

test("quarantine is case-insensitive and keyed by domain + vendor + slug", () => {
  dbQuarantineBoard("Onyx.Security", "ashby", "Onyx", "test: onyx.app's board");
  assert.equal(dbIsBoardQuarantined("onyx.security", "ashby", "onyx"), true);
  assert.equal(dbIsBoardQuarantined("onyx.security", "ashby", "ONYX"), true);
  assert.equal(dbIsBoardQuarantined("onyx.security", "lever", "onyx"), false);
  assert.equal(dbIsBoardQuarantined("other.com", "ashby", "onyx"), false);
});

test("discovery never accepts a quarantined board, even one that would pass verifyBoard", async () => {
  dbQuarantineBoard("quarco.com", "ashby", "quarco", "test");
  const { boards } = await withAshby({ quarco: ashbyBoard("We are quarco.com") }, () => discoverAtsBoards("quarco.com"));
  assert.deepEqual(boards, []);
});

test("a hand-confirmed override survives strict re-verification", async () => {
  // hightouch.com → ashby:hightouch: postings cite hightouch.io (its old domain), which the strict rule
  // reads as a namesake. Without the override it is rejected; with it, kept.
  const board = ashbyBoard("Questions? hello@hightouch.io");
  const before = await withAshby({ hightouch: board }, () => discoverAtsBoards("hightouch.com"));
  assert.deepEqual(before.boards, []);
  dbAddBoardOverride("hightouch.com", "ashby", "hightouch", "test: confirmed same company");
  assert.equal(dbIsBoardOverridden("hightouch.com", "ashby", "hightouch"), true);
  const after = await withAshby({ hightouch: board }, () => discoverAtsBoards("hightouch.com"));
  assert.deepEqual(after.boards, [{ vendor: "ashby", slug: "hightouch" }]);
});

test("an override whose slug is not a guessable candidate is still probed", async () => {
  dbAddBoardOverride("harmonic.ai", "ashby", "harmonic-ai", "test");
  const { boards } = await withAshby({ "harmonic-ai": ashbyBoard("anything") }, () => discoverAtsBoards("harmonic.ai"));
  assert.deepEqual(boards, [{ vendor: "ashby", slug: "harmonic-ai" }]);
});

test("quarantine wins over an override", async () => {
  dbAddBoardOverride("both.com", "ashby", "both", "test");
  dbQuarantineBoard("both.com", "ashby", "both", "test");
  const { boards } = await withAshby({ both: ashbyBoard("both.com") }, () => discoverAtsBoards("both.com"));
  assert.deepEqual(boards, []);
});

test("quarantining withdraws a cached positive, and the cache read skips quarantined rows", async () => {
  dbSaveAtsProbe("cachedco.com", [{ vendor: "ashby", slug: "cachedco" }], ["greenhouse", "lever", "ashby"]);
  assert.deepEqual(await discoverAndCacheAts("cachedco.com"), [{ vendor: "ashby", slug: "cachedco" }]);
  dbQuarantineBoard("cachedco.com", "ashby", "cachedco", "test");
  const row = db.prepare("SELECT found, slug FROM ats_boards WHERE domain = 'cachedco.com' AND vendor = 'ashby'").get() as { found: number; slug: string | null };
  assert.equal(row.found, 0);
  assert.deepEqual(await discoverAndCacheAts("cachedco.com"), []);
});

test("the ATS adapter does not fetch a quarantined board", async () => {
  dbQuarantineBoard("adapterco.com", "ashby", "adapterco", "test");
  let fetched = false;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { fetched = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
  try {
    const jobs = await atsAdapter({ type: "ats", vendor: "ashby", slug: "adapterco", domain: "adapterco.com" } as never);
    assert.deepEqual(jobs, []);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = real; }
});

test("ingest drops quarantined jobs from the hiring.cafe lane too, and keeps the domain's real board", () => {
  dbQuarantineBoard("clasp.com", "ashby", "clasp", "test: health-benefits Clasp, not clasp.com");
  const hc = (title: string, url: string, ats: string) => makeJob({
    source: "hcorg", externalId: url, title, company: "Clasp", location: "New York", url, domain: "clasp.com", raw: { ats },
  });
  const jobs = [
    hc("Product Engineer", "https://jobs.ashbyhq.com/clasp/335428b3", "ashby"),
    hc("Senior Product Manager", "https://jobs.ashbyhq.com/clasp-group/dcd10131", "ashby:clasp-group"),
    hc("Account Executive", "https://jobs.ashbyhq.com/clasp/02480ac9", "ashby"),
  ];
  assert.deepEqual(dropQuarantinedJobs(jobs).map((j) => j.title), ["Senior Product Manager"]);
});

test("dbCloseQuarantinedJobs closes only open rows and records every one it touched", () => {
  const j = makeJob({ source: "ats:ashby:closeco", externalId: "c1", title: "Role", company: null, location: null,
    url: "https://jobs.ashbyhq.com/closeco/1", domain: "closeco.com", raw: {} }) as RawJob;
  upsertJob(j);
  const row = db.prepare("SELECT id, status FROM raw_jobs WHERE url = ?").get(j.url) as { id: string; status: string };
  assert.equal(row.status, "open");
  assert.equal(dbCloseQuarantinedJobs([row], { domain: "closeco.com", vendor: "ashby", slug: "closeco" }), 1);
  const after = db.prepare("SELECT status FROM raw_jobs WHERE id = ?").get(row.id) as { status: string };
  assert.equal(after.status, "closed");
  const logged = db.prepare("SELECT prior_status FROM ats_quarantine_closed WHERE job_id = ?").get(row.id) as { prior_status: string };
  assert.equal(logged.prior_status, "open");
  assert.equal(dbCloseQuarantinedJobs([row], { domain: "closeco.com", vendor: "ashby", slug: "closeco" }), 0);
});
