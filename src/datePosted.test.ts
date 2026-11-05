// "Posted within N days" must mean the PUBLISH date, on every path.
//
// The date check used to sit inside the localRefine branch, so it was skipped for a hiring.cafe row
// fetched by this client's own search — those were trusted entirely to the server parameter,
// dateFetchedPastNDays, which is hiring.cafe's INDEXING recency rather than the employer's publish
// date. The two agree closely: on the live database, rows that went through a searchState stop dead
// at 120.9 days of publish age against the 121-day default (zero over), while /org/ rows, which take
// no filter, run to 4,644 days with 3,653 past 121. Close is not the same as exact, and the control
// names the publish date.
//
// Checking locally on every source can only TIGHTEN: a posting published within N days cannot have
// been indexed before it existed, so the N-day server window already contains everything that
// qualifies. Nothing valid is lost by asking again.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./matcher.ts";
import type { ClientConfig, RawJob } from "./types.ts";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400e3).toISOString();
const job = (source: string, postedAt: string | null): RawJob => ({
  id: "j", source, externalId: "x", title: "Engineer", company: "Acme", location: "London",
  state: null, remote: false, url: "https://acme.com/1", postedAt, domain: "acme.com",
  status: "open", raw: {},
} as unknown as RawJob);
const search = (): ClientConfig => ({
  name: "s", active: true, search: { keywords: [], datePostedDays: 7, orgDomains: ["acme.com"] },
} as unknown as ClientConfig);

test("a stale posting is rejected even on the path hiring.cafe filtered for us", () => {
  // serverFiltered: this row came back from THIS client's own searchState — the case that used to be
  // trusted wholesale and skipped the check.
  assert.equal(evaluate(job("hiringcafe", daysAgo(40)), search(), { serverFiltered: true }), null);
});

test("a fresh posting still matches on that same path", () => {
  assert.ok(evaluate(job("hiringcafe", daysAgo(2)), search(), { serverFiltered: true }));
});

test("the same rule applies to org rows and direct ATS boards", () => {
  assert.equal(evaluate(job("hcorg", daysAgo(40)), search(), { orgScoped: false }), null);
  assert.equal(evaluate(job("ats:greenhouse:acme", daysAgo(40)), search(), { orgScoped: false }), null);
  assert.ok(evaluate(job("hcorg", daysAgo(1)), search(), { orgScoped: false }));
});

test("a posting with no publish date is kept, not dropped", () => {
  // Unknown is not a failed test — the same rule orgFacets.ts follows. Dropping it would report an
  // absent measurement as a fact about the job.
  assert.ok(evaluate(job("hiringcafe", null), search(), { serverFiltered: true }));
});

test("with no date filter set, age is irrelevant", () => {
  const anyTime = { name: "s", active: true,
    search: { keywords: [], datePostedDays: 0, orgDomains: ["acme.com"] } } as unknown as ClientConfig;
  assert.ok(evaluate(job("hiringcafe", daysAgo(4000)), anyTime, { serverFiltered: true }));
});

// ── Narrowing a facet must clear what no longer qualifies ──────────────────────────────────────
//
// backfillMatches re-evaluates stored matches with serverFiltered:true whenever a config changes.
// The facet checks used to sit behind that trust gate, so narrowing "Workplace" to Remote left every
// previously-matched onsite job sitting on the dashboard — those rows were fetched under the old
// searchState and nothing re-checked them.
//
// The facets can be applied where the keyword and geo checks cannot, because they are EXACT: they
// compare the job's own stated value rather than approximating hiring.cafe's semantics. Search rows
// carry those values on 100% of stored rows, and a live cross-check found 0 false rejections across
// 987 jobs and 8 filters.
const facetJob = (raw: Record<string, unknown>): RawJob => ({
  id: "j", source: "hiringcafe", externalId: "x", title: "Engineer", company: "Acme",
  location: "London", state: null, remote: false, url: "https://acme.com/1",
  postedAt: new Date().toISOString(), domain: "acme.com", status: "open", raw,
} as unknown as RawJob);
const facetClient = (spec: Record<string, unknown>): ClientConfig =>
  ({ name: "s", active: true, search: { keywords: [], ...spec } }) as unknown as ClientConfig;

test("a tightened facet prunes a stored search match that no longer qualifies", () => {
  const onsite = facetJob({ workplace_type: "Onsite", seniority: "Entry Level" });
  // serverFiltered is exactly what the prune passes.
  assert.ok(evaluate(onsite, facetClient({}), { serverFiltered: true }), "no filter set → still matches");
  assert.equal(evaluate(onsite, facetClient({ workplaceTypes: ["Remote"] }), { serverFiltered: true }), null);
  assert.equal(evaluate(onsite, facetClient({ seniorityLevels: ["Senior Level"] }), { serverFiltered: true }), null);
});

test("a search row that still qualifies is NOT pruned", () => {
  const remote = facetJob({ workplace_type: "Remote", seniority: "Senior Level" });
  assert.ok(evaluate(remote, facetClient({ workplaceTypes: ["Remote"] }), { serverFiltered: true }));
  assert.ok(evaluate(remote, facetClient({ seniorityLevels: ["Senior Level"] }), { serverFiltered: true }));
});

test("keyword and location stay behind the trust gate, deliberately", () => {
  // Both are approximations of hiring.cafe's own semantics, so re-running them against a row it
  // filtered would drop legitimate matches. The prune contract in ingest.ts documents this.
  const j = facetJob({ workplace_type: "Remote" });
  assert.ok(evaluate(j, facetClient({ keywords: ["somethingtheJDneversays"] }), { serverFiltered: true }),
    "a keyword the stored row does not contain must not prune a server-filtered match");
  assert.ok(evaluate(j, facetClient({ locations: [{ formatted_address: "Tokyo, Japan",
    address_components: [{ types: ["country"], short_name: "JP", long_name: "Japan" }] }] }), { serverFiltered: true }),
    "a narrowed location must not prune a server-filtered match");
});
