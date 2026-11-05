// verifyBoard — the gate that decides whether a discovered ATS board really belongs to a domain.
//
// Every case below is a REAL board this install discovered and probed live; the expectations are the
// verdicts checked against what those boards actually publish. An ATS slug is guessed from the domain
// name ("tcm.llc" → "tcm") and ATS tenants are a first-come global namespace, so without this gate a
// stranger's board gets fetched and every posting on it is stamped with the watched company's domain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyBoard, hcBoardHint } from "./ats.ts";
import type { RawJob } from "../types.ts";

const job = (company: string | null, url: string): RawJob => ({
  id: url, source: "ats:test:x", externalId: url, title: "Role", company,
  location: null, state: null, remote: false, url, postedAt: null, domain: null, raw: null, description: null,
});

test("verifyBoard accepts a board hosted on the company's own domain, whatever it calls itself", () => {
  // trlm.com's Greenhouse tenant is "trillium" and every posting is filed under "Open Roles", so no
  // name comparison can ever confirm it. The apply URLs are on www.trlm.com, and that is proof.
  assert.equal(verifyBoard("trlm.com", "trillium",
    [job("Open Roles", "https://www.trlm.com/apply/5178986007?gh_jid=5178986007")]), true);
});

test("verifyBoard accepts a multi-word company name against the spaceless domain stem", () => {
  // The first cut of this gate compared "1021 Creative" to "1021creative" verbatim and rejected 15
  // correct boards on the space alone.
  assert.equal(verifyBoard("1021creative.com", "1021creative",
    [job("1021 Creative", "https://job-boards.greenhouse.io/1021creative/jobs/1")]), true);
  assert.equal(verifyBoard("ginkgobioworks.com", "ginkgobioworks",
    [job("Ginkgo Bioworks Inc.", "https://job-boards.greenhouse.io/ginkgobioworks/jobs/1")]), true);
  assert.equal(verifyBoard("springfieldprep.org", "springfieldprep",
    [job("Springfield Prep Charter School", "https://job-boards.greenhouse.io/springfieldprep/jobs/1")]), true);
});

test("verifyBoard rejects a short slug that resolves to a stranger's board", () => {
  // The whole collision class, as found live. Each of these was being attributed to the watched domain.
  assert.equal(verifyBoard("us.com", "us",
    [job("itel - United States", "https://itelinternational.com/careers/?gh_jid=49")]), false);
  assert.equal(verifyBoard("abc.edu", "abc",
    [job("ThoughtWorks_new", "https://job-boards.greenhouse.io/abc/jobs/1")]), false);
  assert.equal(verifyBoard("ohio.edu", "ohio",
    [job("OH.io", "https://job-boards.greenhouse.io/ohio/jobs/4278005009")]), false);
});

test("verifyBoard rejects a short slug even when the board names nobody", () => {
  // Lever and Ashby return no company at all, so there is nothing to disconfirm — which is exactly
  // why a 3-letter tenant cannot be trusted on its own.
  assert.equal(verifyBoard("eli.edu", "eli", [job(null, "https://jobs.ashbyhq.com/eli/1")]), false);
  assert.equal(verifyBoard("cic.edu", "cic", [job(null, "https://jobs.lever.co/cic/1")]), false);
});

test("verifyBoard accepts an unnamed board whose slug is EXACTLY the domain's own stem, one character below the ordinary floor", () => {
  // Phase 15, found live 2026-09-19: ramp.com's real Ashby tenant is "ramp" — the correctly-guessed
  // domain stem — but was rejected as "too short to attribute" for the same reason eli/cic are
  // rejected above: Ashby names no company, and the slug alone was 1 character under the floor.
  // The difference is that "ramp" isn't merely short, it's IDENTICAL to the domain stem, which is
  // stronger evidence than the ordinary "some short slug happens to exist" case.
  assert.equal(verifyBoard("ramp.com", "ramp", [job(null, "https://jobs.ashbyhq.com/ramp/1")]), true);
});

test("verifyBoard still rejects an unnamed EXACT-stem slug shorter than the exact-match floor", () => {
  // eli/cic (3 characters) are ALSO exact matches to their own domain stem, and are real collisions
  // found live — proof that "the guess matched itself" isn't automatically safe at every length.
  assert.equal(verifyBoard("eli.edu", "eli", [job(null, "https://jobs.ashbyhq.com/eli/1")]), false);
  assert.equal(verifyBoard("cic.edu", "cic", [job(null, "https://jobs.lever.co/cic/1")]), false);
});

test("verifyBoard does NOT extend the exact-match exemption to a NAMED board, even when the name folds to the same string as the stem", () => {
  // ohio.edu's Greenhouse tenant names itself "OH.io" — a real company punning the .io TLD, not Ohio
  // University — and nameKey folds "OH.io" to "ohio", identical to the domain stem "ohio" once the
  // dot is stripped. The exact-match exemption above is gated on names.length === 0 specifically so
  // this stays rejected: a present (if coincidentally-folding) name is not the same situation as no
  // name being available to check at all.
  assert.equal(verifyBoard("ohio.edu", "ohio",
    [job("OH.io", "https://job-boards.greenhouse.io/ohio/jobs/4278005009")]), false);
});

test("verifyBoard keeps a distinctive slug whose board is branded as a product", () => {
  // pingcap.com posts under "TiDB" — its own product. A name mismatch is deliberately NOT fatal:
  // killing these would lose more real postings than the collisions it would prevent. The mismatch is
  // logged instead. Same for an unnamed board on a long slug.
  assert.equal(verifyBoard("pingcap.com", "pingcap",
    [job("TiDB", "https://job-boards.greenhouse.io/pingcap/jobs/1")]), true);
  assert.equal(verifyBoard("heartworksvt.com", "heartworksvt",
    [job(null, "https://jobs.lever.co/heartworksvt/1")]), true);
});

test("verifyBoard refuses a domain it cannot normalize", () => {
  assert.equal(verifyBoard("", "anything", [job("Anything", "https://example.com/1")]), false);
});

// ── Which vendors a discovery run reports as actually contacted ───────────────────────────────
//
// Discovery runs two waves: the three US vendors, and the four non-US ones ONLY if the first wave
// found nothing. The caller records a negative marker for every vendor it is told was probed, so
// over-reporting writes "we checked and it wasn't there" about requests that were never sent.
//
// fetch is stubbed here rather than calling dbSaveAtsProbe directly, because the defect being pinned
// is in how `probed` is ACCUMULATED across the conditional second wave — a test that hands the list
// in by hand cannot see it. (One did not, and a mutation that under-reported the second wave passed.)
import { discoverAtsBoards, fetchSmartRecruiters } from "./ats.ts";

/** Serve every ATS endpoint a 404, except any host substring listed in `serve`. */
async function withStubbedAts<T>(serve: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    for (const [needle, body] of Object.entries(serve))
      if (url.includes(needle)) return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("when nothing is found, BOTH waves ran and all seven vendors are reported as probed", async () => {
  const { boards, probed } = await withStubbedAts({}, () => discoverAtsBoards("nowhere-ats.example"));
  assert.equal(boards.length, 0);
  assert.deepEqual([...probed].sort(),
    ["ashby", "greenhouse", "lever", "personio", "recruitee", "smartrecruiters", "workable"],
    "every vendor was contacted, so every miss is a real, recordable negative");
});

test("when the first wave hits, ONLY the first wave is reported as probed", async () => {
  // A Greenhouse board whose apply URL is on the domain itself, so verifyBoard accepts it.
  const gh = { jobs: [{ id: 1, title: "Engineer", absolute_url: "https://boards.greenhouse.io/x/jobs/1", company_name: "Hitco", location: { name: "NY" } }] };
  const { boards, probed } = await withStubbedAts({ "boards-api.greenhouse.io": gh }, () => discoverAtsBoards("hitco.example"));
  assert.deepEqual(boards.map((b) => b.vendor), ["greenhouse"]);
  assert.deepEqual([...probed].sort(), ["ashby", "greenhouse", "lever"],
    "the EU wave never ran — naming it here would record four requests that were never sent");
  for (const v of ["workable", "personio", "recruitee", "smartrecruiters"])
    assert.equal(probed.includes(v as never), false, `${v} must not be reported as probed`);
});

test("a domain with no usable slug reports nothing probed", async () => {
  const { boards, probed } = await withStubbedAts({}, () => discoverAtsBoards(""));
  assert.deepEqual(boards, []);
  assert.deepEqual(probed, [], "no request was made, so no negative may be recorded");
});

/** Serve every ATS endpoint the given status/behaviour, except hosts listed in `serve` (200 JSON).
 *  `fail` lets one vendor's host throw or return a non-answer status. */
async function withAtsResponses<T>(
  serve: Record<string, unknown>, fail: Record<string, number | "throw">, fn: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    for (const [needle, mode] of Object.entries(fail)) {
      if (!url.includes(needle)) continue;
      if (mode === "throw") throw new Error("The operation was aborted due to timeout");
      return new Response("nope", { status: mode });
    }
    for (const [needle, body] of Object.entries(serve))
      if (url.includes(needle)) return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// A rate-limited or timed-out probe is NOT a company with no ATS. Every miss reported in `probed`
// gets written as a negative and cached for seven days (ATS_NEG_TTL_DAYS), so recording one from a
// request that never got an answer stops us re-asking for a week. Discovery fires a burst of
// concurrent probes per domain across every vendor, which is precisely the shape that earns a 429.
// Same defect edgar.ts had one layer up: a failed lookup is not a negative result.

test("a rate-limited vendor is not reported as probed, so no negative is cached", async () => {
  const { boards, probed } = await withAtsResponses({}, { "boards-api.greenhouse.io": 429 },
    () => discoverAtsBoards("ratelimited.example"));
  assert.equal(boards.length, 0);
  assert.equal(probed.includes("greenhouse" as never), false,
    "a 429 told us nothing — recording it as a miss would suppress re-probing for 7 days");
  assert.ok(probed.includes("lever" as never), "vendors that DID answer still record their negative");
});

test("a timed-out vendor is not reported as probed either", async () => {
  const { probed } = await withAtsResponses({}, { "api.ashbyhq.com": "throw" },
    () => discoverAtsBoards("timedout.example"));
  assert.equal(probed.includes("ashby" as never), false);
  assert.ok(probed.includes("greenhouse" as never));
});

test("a 5xx is a non-answer; a 404 is a real negative", async () => {
  const down = await withAtsResponses({}, { "api.lever.co": 503 }, () => discoverAtsBoards("leverdown.example"));
  assert.equal(down.probed.includes("lever" as never), false, "503 = the vendor is broken, not the board absent");

  // The control: with everything cleanly 404ing, all seven are real negatives. This is what proves
  // the guard is discriminating rather than just dropping vendors.
  const clean = await withAtsResponses({}, {}, () => discoverAtsBoards("cleanmiss.example"));
  assert.deepEqual([...clean.probed].sort(),
    ["ashby", "greenhouse", "lever", "personio", "recruitee", "smartrecruiters", "workable"]);
});

test("one slug timing out does not excuse a vendor that cleanly 404d the other", async () => {
  // acme-corp.example yields two candidate slugs ("acme-corp" and "acmecorp"). Only a vendor where
  // EVERY slug went unanswered is dropped — otherwise a single flaky request would suppress a
  // negative we genuinely established under the other name.
  const { probed } = await withAtsResponses({}, { "boards-api.greenhouse.io/v1/boards/acme-corp/": "throw" },
    () => discoverAtsBoards("acme-corp.example"));
  assert.ok(probed.includes("greenhouse" as never),
    "the second slug answered 404, so greenhouse's miss is still real");
});

// ---------------------------------------------------------------------------------------------
// SmartRecruiters job text.
//
// Found by measuring the stored table, not by reading the fetcher: every other ATS vendor sat at
// 100% description coverage and SmartRecruiters at 0 of 464. Its LIST response carries no jobAd key
// at all — the text is on /postings/<id> under jobAd.sections. matcher.ts folds the description into
// the keyword haystack, so every SmartRecruiters posting was matching on its title alone, and the
// webhook and CSV shipped an empty body.
// ---------------------------------------------------------------------------------------------

const SR_LIST = {
  content: [{
    id: "111", name: "Trade Compliance Coordinator",
    company: { name: "Expeditors", identifier: "Expeditors" },
    location: { city: "Seattle", region: "WA", country: "us" }, releasedDate: "2026-07-01T00:00:00.000Z",
  }],
};
const SR_DETAIL = {
  id: "111", name: "Trade Compliance Coordinator",
  jobAd: { sections: {
    jobDescription: { text: "<p>Summary: coordinate <b>customs</b> filings.</p>" },
    qualifications: { text: "<p>Bachelor's degree required.</p>" },
    additionalInformation: { text: "<p>52 hours training per year.</p>" },
    companyDescription: { text: "<p>Expeditors is a global logistics company.</p>" },
  } },
};

/** Serve the SmartRecruiters list and detail endpoints separately, counting detail hits. */
async function withSmartRecruiters<T>(fn: () => Promise<T>): Promise<{ result: T; detailCalls: number }> {
  const real = globalThis.fetch;
  let detailCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    if (/\/postings\/\d+/.test(url)) { detailCalls++; return Response.json(SR_DETAIL); }
    if (url.includes("/postings?")) return Response.json(SR_LIST);
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  try { return { result: await fn(), detailCalls }; } finally { globalThis.fetch = real; }
}

test("a SmartRecruiters posting gets its job text from the detail endpoint", async () => {
  const { result, detailCalls } = await withSmartRecruiters(() => fetchSmartRecruiters("Expeditors", "expeditors.com", { maxPages: 1 }));
  assert.equal(result.length, 1);
  assert.equal(detailCalls, 1, "the list alone has no text, so the detail must be fetched");
  const d = result[0]!.description ?? "";
  assert.match(d, /coordinate customs filings/, "HTML is flattened to readable text");
  assert.match(d, /Bachelor's degree/, "qualifications are included too");
  assert.doesNotMatch(d, /<p>|<b>/, "no markup reaches the stored description");
});

test("the company boilerplate goes last, not first", async () => {
  // It is repeated verbatim on every posting. Leading with it would make the keyword haystack and
  // the webhook preview open with marketing copy instead of the actual role.
  const { result } = await withSmartRecruiters(() => fetchSmartRecruiters("Expeditors", null, { maxPages: 1 }));
  const d = result[0]!.description ?? "";
  assert.ok(d.indexOf("Summary") < d.indexOf("global logistics company"), d.slice(0, 80));
});

test("a discovery probe does NOT fetch descriptions", async () => {
  // Discovery only asks whether the board exists. Paying one request per posting for that would
  // make the EU wave's wall time explode, and every one of those jobs is thrown away.
  const { result, detailCalls } = await withSmartRecruiters(() => fetchSmartRecruiters("Expeditors", null, { existenceOnly: true }));
  assert.equal(result.length, 1, "the board is still detected");
  assert.equal(detailCalls, 0);
  assert.equal(result[0]!.description ?? null, null);
});

test("a failed detail fetch leaves that job's description null rather than failing the board", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    if (/\/postings\/\d+/.test(url)) return new Response("boom", { status: 500 });
    if (url.includes("/postings?")) return Response.json(SR_LIST);
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  try {
    const jobs = await fetchSmartRecruiters("Expeditors", null, { maxPages: 1 });
    assert.equal(jobs.length, 1, "the posting itself still comes through");
    assert.equal(jobs[0]!.description ?? null, null);
  } finally { globalThis.fetch = real; }
});

// ── nameTheEmployer: giving Lever/Ashby/Personio rows the employer they never carry ──────────────
//
// Three of the seven vendors return no company name (Lever and Ashby never, Personio usually), while
// Greenhouse, SmartRecruiters, Workable and Recruitee do. That asymmetry left 105 rows in the live
// database with a blank employer, 99 of them matched to a client and on screen. It is not cosmetic:
// company is the identity every NAME-keyed producer matches on — EDGAR, Companies House, WARN, news,
// app listings all take a name, never a domain — so a nameless row feeds none of them.
//
// The answer was already known. A board is DISCOVERED for a domain, and resolveCompanyName is the
// same function every producer uses to turn that domain into a name; using anything else would let
// the dashboard and the producers disagree about what one company is called.
import { nameTheEmployer, atsAdapter, attributableName } from "./ats.ts";
import { db as atsDb } from "../db.ts";
import type { RawJob as AtsRawJob } from "../types.ts";

const mk = (id: string, company: string | null): AtsRawJob => ({
  id, source: "ats:ashby:x", externalId: id, title: "Driver", company,
  location: null, state: null, remote: false, url: `https://jobs.ashbyhq.com/x/${id}`,
  postedAt: null, domain: null, raw: {},
} as AtsRawJob);

/** Seed our OWN jobs table so resolveCompanyName answers from step 1 and never touches the network.
 *  That is also the realistic path: whenever hiring.cafe has already named this employer, naming an
 *  ATS board costs nothing at all. */
function seedName(domain: string, company: string): void {
  atsDb.prepare(`INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, url, domain, status, seen_at)
    VALUES (?, ?, 'hiringcafe', 'Seed', ?, ?, ?, 'open', datetime('now'))`)
    .run(`seed-${domain}`, `seed-${domain}`, company, `https://seed.test/${domain}`, domain);
}
const unseed = (domain: string): void => { atsDb.prepare("DELETE FROM raw_jobs WHERE id = ?").run(`seed-${domain}`); };

test("a nameless board gets the employer's real name, from the domain it was discovered for", async () => {
  seedName("acmefreight.test", "Acme Freight Ltd");
  const out = await nameTheEmployer([mk("a", null), mk("b", null)], "acmefreight.test", "ashby", "acme");
  assert.deepEqual(out.map((j) => j.company), ["Acme Freight Ltd", "Acme Freight Ltd"]);
  unseed("acmefreight.test");
});

test("a name the vendor DID supply is never replaced", async () => {
  // Fill, never correct — the same rule as the learn-on-resight statements in db.ts. Greenhouse and
  // SmartRecruiters name their jobs, and their name is the authoritative one for that posting.
  seedName("mixedco.test", "Mixedco Holdings");
  const out = await nameTheEmployer([mk("a", "Vendor Name"), mk("b", null)], "mixedco.test", "greenhouse", "mixed");
  assert.deepEqual(out.map((j) => j.company), ["Vendor Name", "Mixedco Holdings"]);
  unseed("mixedco.test");
});

test("a fully-named board keeps its names", async () => {
  // Note what this does NOT prove. The early return beside this case is a COST guard: removing it
  // changes no assertion here, because with no blank job there is nothing to write either way. It
  // saves a homepage fetch per board per cycle for the four vendors that never needed naming, and
  // the comment in ats.ts says so rather than implying a test is watching it.
  const out = await nameTheEmployer([mk("a", "Known Co")], "never-resolved.test", "greenhouse", "k");
  assert.deepEqual(out.map((j) => j.company), ["Known Co"]);
});

test("no domain means no name", async () => {
  // A board configured by slug alone (extraBoards) has nothing to resolve FROM, and inventing one
  // from the slug is the wrong-employer attribution verifyBoard exists to prevent. Same honesty as
  // above: the `!domain` guard is a cost guard — without it the resolver throws internally on a
  // null and is caught, so the outcome is the same and only the wasted call differs.
  const out = await nameTheEmployer([mk("a", null)], null, "lever", "somebody");
  assert.equal(out[0]!.company, null);
});

test("the jobs survive even when naming fails", async () => {
  // Fail-soft, like every other step in this file. Returning them unnamed is what happens today and
  // is strictly better than dropping a board's postings because a homepage would not load.
  const out = await nameTheEmployer([mk("a", null)], "", "lever", "x");
  assert.equal(out.length, 1, "an unnamed job is still a job");
});

test("atsAdapter actually applies it — the whole feature is the wiring", async () => {
  // The helper being correct proves nothing if nobody calls it, and a mutation that simply returned
  // the unnamed jobs from atsAdapter left the suite green. This drives the real adapter against a
  // stubbed Lever board — Lever being one of the three vendors that never names an employer.
  seedName("wiredco.test", "Wired Co Logistics");
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u);
    if (!url.includes("api.lever.co")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify([
      { id: "L1", text: "Class A Driver", hostedUrl: "https://jobs.lever.co/wiredco/L1", categories: {} },
    ]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const jobs = await atsAdapter({ type: "ats", interval: "", vendor: "lever", slug: "wiredco", domain: "wiredco.test" } as never);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.company, "Wired Co Logistics", "the adapter must name it, not just the helper");
  } finally { globalThis.fetch = real; unseed("wiredco.test"); }
});

// ── attributableName: the gate that stops a homepage <title> becoming a company ──────────────────
//
// Added after running the naming step against all 58 REAL name-less boards in the install, where 12
// resolved to something that is not a company name. Shipping without this would have written those
// into raw_jobs.company — and because resolveCompanyName's most-trusted source is the most-seen
// company string in raw_jobs for that domain, each bad name would have come straight back as the
// authoritative answer on the next call, permanently, without the homepage being consulted again.

test("a homepage title that is not about this company is refused", async () => {
  // Every one of these is a real observed value from the live run, not an invented example.
  for (const [domain, title] of [
    ["blueengine.org", "403 - Forbidden"],                                    // an error page
    ["almabase.com", "Grow Your Donor Base"],                                 // a tagline
    ["unlearn.ai", "Streamline Clinical Trials with AI and Digital Twins"],   // a tagline
  ] as const) {
    assert.equal(attributableName(title, domain), null, `${domain}: ${title}`);
  }
});

test("a title that IS about this company is kept, furniture and all", async () => {
  // The bar is attribution, not beauty. "Caseware AI Platform" names the right company and is what
  // every signal producer already uses for that domain — rewriting it here would make the dashboard
  // and the producers disagree about what one company is called.
  assert.equal(attributableName("Caseware AI Platform", "caseware.com"), "Caseware AI Platform");
  assert.equal(attributableName("Home - Transmodal", "transmodal.net"), "Home - Transmodal");
  assert.equal(attributableName("Shepherd University", "shepherd.edu"), "Shepherd University");
  assert.equal(attributableName("AutoFi", "autofi.com"), "AutoFi");
});

test("a refused title falls back to the domain, never to nothing and never to a guess", async () => {
  // The stem is the weakest name available and the only one that CANNOT be about another company,
  // because it is the company's own domain.
  seedName("blueengine.test", "403 - Forbidden");
  const out = await nameTheEmployer([mk("a", null)], "blueengine.test", "lever", "blueengine");
  assert.equal(out[0]!.company, "Blueengine", "an error page must not become an employer");
  unseed("blueengine.test");
});

test("a stem too short to attribute anything refuses rather than guesses", async () => {
  // "ey.com", "g2.com" — the same 4-character distinctiveness floor companyEntityMatches applies.
  //
  // The example has to be one that WOULD pass containment, or the test proves nothing about the
  // floor: "Ernst & Young Global" happens not to contain "ey" as a substring, so it is refused with
  // or without it. A mutation test is what exposed that first attempt as vacuous. "Big 2 Media"
  // folds to "big2media", which really does contain "g2" — so only the floor stops g2.com from
  // being handed a completely unrelated company's name.
  assert.equal(attributableName("Big 2 Media", "g2.com"), null, "two characters attribute nothing");
  assert.equal(attributableName("Ernst & Young Global", "ey.com"), null);
  assert.equal(attributableName("Almabase Inc", "almabase.com"), "Almabase Inc", "...but a real stem still works");
});

test("entity-encoded titles are decoded before anything looks at them", async () => {
  // Observed live: heartworksvt.com resolves to "Heartworks Early Education: VT&#039;s Choice…".
  // Without decoding, the raw entity would be stored and shown — the same defect the stored-jobs
  // repair fixed for titles and companies coming from feeds.
  // The domain must be one the decoded name is ATTRIBUTABLE to, or the gate falls back to the stem
  // and the assertion passes whether or not anything was decoded — which is exactly how the first
  // version of this test managed to be vacuous.
  seedName("heartworks.test", "Heartworks &amp; Co");
  const out = await nameTheEmployer([mk("a", null)], "heartworks.test", "lever", "hw");
  assert.equal(out[0]!.company, "Heartworks & Co", "the entity must be decoded, not stored raw");
  unseed("heartworks.test");
});

// A board that NAMES A DIFFERENT EMPLOYER is rejected. This used to be kept with a warning, on the
// theory that a company's board is often branded as its product ("pingcap.com" posting under
// "TiDB") and that rejecting those would cost more real postings than the collisions it prevented.
//
// That trade was made without a count. Across all 119 cached boards on the live install there were
// exactly two name mismatches, and neither was the product-brand case being protected:
//   nationalaircargo.com -> personio:nationalaircargo, serving Kolhorn AG's German driver vacancies
//     (6 jobs, 7 matches, one into a live watchlist — and the board re-verified and passed the day
//     before this was written)
//   trillium.ag -> greenhouse:trillium, whose "company name" is the string "Open Roles"
//
// The second is the discriminator: "Open Roles" is furniture, so it is no evidence either way and
// the board keeps its benefit of the doubt. "Kolhorn AG" is a real, distinctive employer name with
// no relation to the domain — positive evidence the namespace belongs to somebody else.
test("a board that names a different employer is not this domain's board", () => {
  const kolhorn = ["Kolhorn AG", "Kolhorn Produktions GmbH", "Kolhorn Service GmbH"].map((c, i) =>
    job(c, `https://nationalaircargo.jobs.personio.de/job/${i}`));
  assert.equal(verifyBoard("nationalaircargo.com", "nationalaircargo", kolhorn), false);
});

test("…but a furniture label is no evidence, so the board survives", () => {
  const openRoles = [0, 1, 2].map((i) => job("Open Roles", `https://boards.greenhouse.io/trillium/jobs/${i}`));
  assert.equal(verifyBoard("trillium.ag", "trillium", openRoles), true);
});

test("the rejection cannot fire on a board that matches, or on one with no name", () => {
  // Name matches the stem — unaffected.
  assert.equal(verifyBoard("expeditors.com", "expeditors",
    [job("Expeditors International", "https://jobs.smartrecruiters.com/expeditors/1")]), true);
  // Lever and Ashby state no company at all; a long slug still carries it.
  assert.equal(verifyBoard("caseware.com", "caseware",
    [job(null, "https://jobs.lever.co/caseware/1")]), true);
  // A self-hosted apply URL is proof and wins over any name.
  assert.equal(verifyBoard("trlm.com", "trillium",
    [job("Some Other Co Inc", "https://www.trlm.com/careers/1")]), true);
});

// The rejection's name test is LOOSER than the acceptance test above it, deliberately. Re-probing all
// 119 live boards with a strict prefix rule called two same-company boards a mismatch:
//   galapagoscharter.org -> "Galapagos Rockford Charter School"   (the school's own fuller name)
//   viantinc.com         -> "Viant Technology - PERM"             (the same Viant)
// Neither is a prefix of its stem in either direction. Sharing one distinctive WORD is enough.
test("a differently-worded name for the SAME company is not a squat", () => {
  assert.equal(verifyBoard("galapagoscharter.org", "galapagoscharter",
    [job("Galapagos Rockford Charter School", "https://boards.greenhouse.io/galapagoscharter/jobs/1")]), true);
  assert.equal(verifyBoard("viantinc.com", "viantinc",
    [job("Viant Technology - PERM", "https://boards.greenhouse.io/viantinc/jobs/1")]), true);
  // The product-brand case the original permissive rule existed to protect. "TiDB" is below the
  // distinctiveness floor, so it can never be grounds for rejection.
  assert.equal(verifyBoard("pingcap.com", "pingcap",
    [job("TiDB", "https://boards.greenhouse.io/pingcap/jobs/1")]), true);
  // …and the squat still goes, because "kolhorn" appears nowhere in "nationalaircargo".
  assert.equal(verifyBoard("nationalaircargo.com", "nationalaircargo",
    [job("Kolhorn AG", "https://nationalaircargo.jobs.personio.de/job/1")]), false);
});

// ── hcBoardHint — learning a real ATS slug from hiring.cafe's own scrape ───────────────────────
//
// mapHit (hiringcafe.ts) stamps every hiring.cafe hit with raw.ats = "<source>:<board_token>" when
// it has both. That is ground truth about which board a job actually lives on — Phase 15, found live
// 2026-09-19: scale.com's real Greenhouse tenant is "scaleai", which no slug-guessing rule derives
// from "scale.com", but hiring.cafe already resolved it correctly (raw.ats: "grnhse:scaleai").

test("hcBoardHint reads a real vendor:slug pair off a hiring.cafe hit", () => {
  assert.deepEqual(hcBoardHint({ ats: "ashby:ramp" }), { vendor: "ashby", slug: "ramp" });
  // "grnhse" is hiring.cafe's own internal short name for Greenhouse, seen on every Greenhouse hit
  // in production data — it does not spell our vendor name and still has to map to it.
  assert.deepEqual(hcBoardHint({ ats: "grnhse:scaleai" }), { vendor: "greenhouse", slug: "scaleai" });
  assert.deepEqual(hcBoardHint({ ats: "grnhse:betterment" }), { vendor: "greenhouse", slug: "betterment" });
});

test("hcBoardHint ignores vendors we have no fetcher for", () => {
  // All four seen live in production raw.ats values, none of them wired to a FETCHERS entry.
  assert.equal(hcBoardHint({ ats: "dover:31921d69-5edc-41cb-b45d-b481d4d3ccb6" }), null);
  assert.equal(hcBoardHint({ ats: "gem:augustdigital" }), null);
  assert.equal(hcBoardHint({ ats: "hiringthing:castellumai" }), null);
  assert.equal(hcBoardHint({ ats: "sparkhire:chargeflow/29.001" }), null);
});

test("hcBoardHint is null on anything that isn't a real vendor:slug pair", () => {
  assert.equal(hcBoardHint(null), null);
  assert.equal(hcBoardHint({}), null);
  assert.equal(hcBoardHint({ ats: null }), null);
  // Seen live for a subset of rows written before board_token was captured — no slug to learn from.
  assert.equal(hcBoardHint({ ats: "greenhouse" }), null);
  assert.equal(hcBoardHint({ ats: "greenhouse:" }), null);
});

// ── Phase 21: the strict rule ───────────────────────────────────────────────────────────────────
//
// The 2026-10-02 pilot accepted five boards and three were the wrong company, every one of them on a
// shared name word with a slug that was NOT the domain stem. These are those boards, as measured.
import { explainBoard, jobBoardOf } from "./ats.ts";

const posting = (company: string | null, url: string, description: string | null = null): RawJob =>
  ({ ...job(company, url), description });

test("Phase 21: a shared name word no longer accepts a board whose slug is not the domain stem", () => {
  assert.equal(verifyBoard("sunsethq.com", "sunset",
    [posting("Sunset Magazine", "https://job-boards.greenhouse.io/sunset/jobs/1", "Editor, Content innovation")]), false);
  assert.equal(verifyBoard("useparallel.com", "parallel",
    [posting("Parallel Systems", "https://boards.greenhouse.io/parallel/jobs/1", "Electrical Engineer, Vehicle Systems")]), false);
  assert.equal(verifyBoard("tryprofound.com", "profound",
    [posting("ProFound", "https://www.profoundtx.com/careers/1", "Women's Health and Preeclampsia")]), false);
});

test("Phase 21: an unnamed board is no longer accepted on slug length alone", () => {
  // getsequence.io → ashby:sequence is sequencehq.com's board (pilot); long slug, no name, not the stem.
  assert.equal(verifyBoard("getsequence.io", "sequence",
    [posting(null, "https://jobs.ashbyhq.com/sequence/1", "Join us at sequencehq.com")]), false);
  assert.equal(verifyBoard("neviswealth.com", "nevis", [posting(null, "https://jobs.ashbyhq.com/nevis/1")]), false);
});

test("Phase 21: the company's own domain in a posting accepts a board whose slug is not the stem", () => {
  assert.equal(verifyBoard("icapital.com", "icapitalnetwork",
    [posting("iCapital", "https://job-boards.greenhouse.io/icapitalnetwork/jobs/1", "Learn more at www.icapital.com.")]), true);
  // …but not a longer domain that merely contains it.
  assert.equal(verifyBoard("icapital.com", "icapitalnetwork",
    [posting("iCapital", "https://job-boards.greenhouse.io/icapitalnetwork/jobs/1", "see icapital.com.au")]), false);
});

test("Phase 21: a board linked from the company's own site is accepted on that evidence", () => {
  const nevis = [posting(null, "https://jobs.ashbyhq.com/nevis/1")];
  assert.equal(verifyBoard("neviswealth.com", "nevis", nevis, { linkedFromSite: true }), true);
  assert.equal(verifyBoard("neviswealth.com", "nevis", nevis), false);
});

test("Phase 21: slug == stem is rejected when the postings name a different same-stem domain", () => {
  // ashby:onyx is onyx.app's open-source search company, probed for onyx.security.
  const onyx = [posting(null, "https://jobs.ashbyhq.com/onyx/1", "Onyx is open source. Try it at www.onyx.app today.")];
  assert.equal(verifyBoard("onyx.security", "onyx", onyx), false);
  assert.match(explainBoard("onyx.security", "onyx", onyx).why, /onyx\.app/);
  // The same postings ALSO naming the company's own domain are its board after all.
  assert.equal(verifyBoard("onyx.security", "onyx",
    [posting(null, "https://jobs.ashbyhq.com/onyx/1", "onyx.app was our old name; we are onyx.security now")]), true);
});

test("Phase 21: a platform subdomain of the stem is not a rival domain", () => {
  assert.equal(verifyBoard("neurahealth.co", "neurahealth",
    [posting("Neura Health", "https://job-boards.greenhouse.io/neurahealth/jobs/1", "Read our handbook at neurahealth.notion.site/handbook")]), true);
  assert.equal(verifyBoard("numeric.io", "numeric",
    [posting(null, "https://jobs.ashbyhq.com/numeric/1", "Our blog: numeric.substack.com")]), true);
});

test("Phase 21: explainBoard says why", () => {
  assert.equal(explainBoard("ramp.com", "ramp", [posting(null, "https://jobs.ashbyhq.com/ramp/1")]).why,
    "unnamed board, slug is the domain stem");
  assert.match(explainBoard("sunsethq.com", "sunset",
    [posting("Sunset Magazine", "https://job-boards.greenhouse.io/sunset/jobs/1")]).why, /not the domain stem/);
});

test("jobBoardOf ties a job to its board from the source tag, the hiring.cafe hint, or the apply URL", () => {
  assert.deepEqual(jobBoardOf({ source: "ats:ashby:Clasp-Group" }), { vendor: "ashby", slug: "clasp-group" });
  assert.deepEqual(jobBoardOf({ source: "hcorg", raw: { ats: "grnhse:scaleai" } }), { vendor: "greenhouse", slug: "scaleai" });
  // hiring.cafe stamps clasp.com's wrong-company rows with a bare "ashby" — the URL still names the board.
  assert.deepEqual(jobBoardOf({ source: "hcorg", raw: { ats: "ashby" }, url: "https://jobs.ashbyhq.com/clasp/8582f75d" }),
    { vendor: "ashby", slug: "clasp" });
  assert.deepEqual(jobBoardOf({ url: "https://jobs.ashbyhq.com/Riven%20Systems/abc" }), { vendor: "ashby", slug: "riven systems" });
  assert.deepEqual(jobBoardOf({ url: "https://job-boards.greenhouse.io/icapitalnetwork/jobs/1" }), { vendor: "greenhouse", slug: "icapitalnetwork" });
  assert.deepEqual(jobBoardOf({ url: "https://jobs.lever.co/basis/1" }), { vendor: "lever", slug: "basis" });
  assert.deepEqual(jobBoardOf({ url: "https://apply.workable.com/mitti-labs/j/1" }), { vendor: "workable", slug: "mitti-labs" });
  assert.deepEqual(jobBoardOf({ url: "https://jobs.smartrecruiters.com/spacebar/1" }), { vendor: "smartrecruiters", slug: "spacebar" });
  assert.equal(jobBoardOf({ source: "hcorg", url: "https://www.clasp.com/careers/1" }), null);
});
