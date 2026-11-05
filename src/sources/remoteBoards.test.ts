// RemoteOK and WeWorkRemotely — two free public feeds, two completely different formats, one adapter,
// and no tests until now.
//
// These are the only sources that arrive UNFILTERED: neither feed knows anything about the client's
// keywords, so everything they return is handed to the matcher to sort out. That makes their failure
// mode the opposite of a crash. A field that stops being read — the salary, the tech tags, the company
// name — does not produce an error. It produces jobs that look fine in the list and quietly stop
// matching, or stop carrying the data the export is for.
//
// Driven through the REAL fetchers by stubbing global fetch, which is what both of them call.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRemoteOK, fetchWWR, remoteBoardsAdapter } from "./remoteBoards.ts";
import type { SourceConfig } from "../types.ts";

/** A source config with the two fields every adapter shares, plus whatever this test is about. */
const cfg = (o: Record<string, unknown>): SourceConfig => ({ type: "remoteboards", interval: "0 * * * *", ...o });

const realFetch = globalThis.fetch;
let asked: string[] = [];
const routes = new Map<string, { status?: number; body: string }>();

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  asked.push(url);
  for (const [frag, r] of routes) if (url.includes(frag)) return new Response(r.body, { status: r.status ?? 200 });
  return new Response("not stubbed", { status: 404 });
}) as typeof fetch;

function reset(): void { asked = []; routes.clear(); }

// RemoteOK's real response: element 0 is a legal notice, not a job.
const ROK = JSON.stringify([
  { legal: "Scraping this API is fine, but you must link back to remoteok.com" },
  {
    id: 1042, position: "Senior Rust Engineer", company: "Fly Systems", location: "Worldwide",
    url: "https://remoteok.com/remote-jobs/1042", date: "2026-07-14T09:00:00Z",
    tags: ["rust", "kubernetes"], salary_min: 140000, salary_max: 190000,
    description: "<p>Build   the   thing</p>",
  },
  { id: 1043, position: "Designer", company: "No Url Co" },                          // unreachable → dropped
  { id: 1044, position: "Support Lead", company: "Quiet Co", apply_url: "https://remoteok.com/remote-jobs/1044", epoch: 1752480000 },
  { id: 1045, company: "Untitled Co", url: "https://remoteok.com/remote-jobs/1045" },       // no title → dropped
  { position: "Ghost Role", company: "No Id Co", url: "https://remoteok.com/remote-jobs/x" }, // no id → dropped
]);

const wwrItem = (title: string, link: string, extra = "") => `<item>
  <title>${title}</title><link>${link}</link>
  <description>&lt;p&gt;Own   the   roadmap&lt;/p&gt;</description>
  <pubDate>Tue, 14 Jul 2026 09:00:00 +0000</pubDate>${extra}</item>`;
const wwrFeed = (...items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`;

test("the stub really drives the fetchers, before anything is concluded from it", async () => {
  // Guard the instrument: an empty result from a fetcher that never reached the network looks exactly
  // like an empty result from one whose parser stopped matching.
  reset();
  routes.set("remoteok.com/api", { body: ROK });
  const jobs = await fetchRemoteOK();
  assert.deepEqual(asked, ["https://remoteok.com/api"], "the real endpoint was requested");
  assert.ok(jobs.length > 0, "and rows came back through the real parser");
});

test("RemoteOK's legal notice is not stored as a job, and neither is a malformed posting", async () => {
  // Four different ways a row is not a job, because the feed is a raw dump with no schema: element 0
  // is a legal notice, one row has no link at all, one has no title, one has no id. Each is dropped by
  // a different check, so each is listed here separately — a fixture that only contained the legal
  // notice would leave three of those checks free to be deleted with the suite still green. What they
  // have in common is that none of them fails loudly: they become rows on the dashboard, titled
  // "undefined" or leading nowhere.
  reset();
  routes.set("remoteok.com/api", { body: ROK });
  const jobs = await fetchRemoteOK();
  assert.deepEqual(jobs.map((j) => j.externalId), ["rok:1042", "rok:1044"]);
  assert.equal(jobs[0]!.title, "Senior Rust Engineer");
  assert.equal(jobs[0]!.company, "Fly Systems");
  assert.equal(jobs[0]!.remote, true, "every posting on this board is remote by definition");
});

test("RemoteOK's salary, tech tags and description survive the mapping", async () => {
  // The three fields that are the reason to run this source at all rather than take the title alone.
  // Each is read from a differently-named key, so each can break on its own.
  reset();
  routes.set("remoteok.com/api", { body: ROK });
  const [paid, unpaid] = await fetchRemoteOK();
  const raw = paid!.raw as Record<string, unknown>;
  assert.equal(raw.comp_min, 140000);
  assert.equal(raw.comp_max, 190000);
  assert.equal(raw.currency, "USD", "RemoteOK quotes USD/yr and stores no currency of its own");
  assert.deepEqual(raw.tools, ["rust", "kubernetes"]);
  assert.equal(raw.description, "Build   the   thing", "the HTML is flattened to text, not stored as markup");

  const rawFree = unpaid!.raw as Record<string, unknown>;
  assert.equal(rawFree.currency, undefined, "no salary → no currency invented for it");
  assert.deepEqual(rawFree.tools, [], "a missing tags array becomes empty, never undefined");
});

test("RemoteOK's epoch date is read when the ISO one is absent", async () => {
  // Two different date keys for the same fact. Losing the fallback silently ages every one of these
  // postings to "unknown", which is what the date filter and the velocity signal both run on.
  reset();
  routes.set("remoteok.com/api", { body: ROK });
  const jobs = await fetchRemoteOK();
  assert.equal(jobs[0]!.postedAt, "2026-07-14T09:00:00.000Z");
  assert.equal(jobs[1]!.postedAt, new Date(1752480000 * 1000).toISOString());
});

test("WeWorkRemotely's 'Company: Role' title is split, and a role containing a colon survives it", async () => {
  // The company name exists ONLY inside the title string on this feed. Split it wrongly and every WWR
  // posting is filed under the wrong employer — which then feeds the company rollup and the watchlist
  // match, so the damage does not stay in one row.
  reset();
  routes.set("remote-programming-jobs.rss", {
    body: wwrFeed(
      wwrItem("Acme Corp: Senior Backend Engineer", "https://weworkremotely.com/remote-jobs/acme-backend", "<region>Europe</region>"),
      wwrItem("Engineering Manager", "https://weworkremotely.com/remote-jobs/lone-title"),
      wwrItem("Northwind: Engineer: Platform", "https://weworkremotely.com/remote-jobs/northwind-platform"),
    ),
  });
  const jobs = await fetchWWR(["programming"]);

  assert.equal(jobs.length, 3);
  assert.equal(jobs[0]!.company, "Acme Corp");
  assert.equal(jobs[0]!.title, "Senior Backend Engineer");
  assert.equal(jobs[0]!.location, "Europe", "the <region> element is the only location this feed carries");
  assert.equal(jobs[0]!.externalId, "wwr:acme-backend");
  assert.equal((jobs[0]!.raw as Record<string, unknown>).description, "Own the roadmap");

  assert.equal(jobs[1]!.company, null, "no colon → no company, rather than a guess");
  assert.equal(jobs[1]!.title, "Engineering Manager", "and the whole title is kept");

  assert.equal(jobs[2]!.company, "Northwind");
  assert.equal(jobs[2]!.title, "Engineer: Platform", "only the FIRST colon separates the company");

  assert.equal(jobs[1]!.location, "Remote", "no region → the feed's own default, not null");
});

test("WeWorkRemotely reads only the categories it has feeds for, and dedupes across them", async () => {
  // Categories come from client config, so a typo must cost nothing rather than fetch a 404 page and
  // parse it. And the same posting is cross-listed in several categories on this board — counting it
  // twice inflates both the job count and the company's hiring velocity.
  reset();
  const shared = wwrItem("Acme Corp: Growth Engineer", "https://weworkremotely.com/remote-jobs/acme-growth");
  routes.set("remote-programming-jobs.rss", { body: wwrFeed(shared) });
  routes.set("remote-marketing-jobs.rss", { body: wwrFeed(shared, wwrItem("Beta: Copywriter", "https://weworkremotely.com/remote-jobs/beta-copy")) });

  const jobs = await fetchWWR(["programming", "marketing", "not-a-category"]);
  assert.equal(asked.length, 2, "the unknown category is dropped before the request, not after");
  assert.deepEqual(jobs.map((j) => j.externalId), ["wwr:acme-growth", "wwr:beta-copy"]);
});

test("one dead feed does not take the others down with it", async () => {
  // These are free public endpoints with no uptime promise. A 500 on one category must cost that
  // category, not the whole source — the alternative is that one flaky feed empties a whole run.
  reset();
  routes.set("remote-programming-jobs.rss", { status: 503, body: "upstream is having a day" });
  routes.set("remote-design-jobs.rss", { body: wwrFeed(wwrItem("Acme Corp: Product Designer", "https://weworkremotely.com/remote-jobs/acme-design")) });
  const jobs = await fetchWWR(["programming", "design"]);
  assert.deepEqual(jobs.map((j) => j.company), ["Acme Corp"]);
});

test("the adapter fetches only the boards it was asked for", async () => {
  // `boards` is per-search client config. Fetching a board nobody enabled is a request we owe nobody
  // and jobs the matcher then has to reject.
  reset();
  routes.set("remoteok.com/api", { body: ROK });
  routes.set("remote-programming-jobs.rss", { body: wwrFeed(wwrItem("Acme Corp: Engineer", "https://weworkremotely.com/remote-jobs/acme-eng")) });

  const only = await remoteBoardsAdapter(cfg({ boards: ["wwr"], wwrCategories: ["programming"] }));
  assert.deepEqual(asked, ["https://weworkremotely.com/categories/remote-programming-jobs.rss"]);
  assert.deepEqual(only.map((j) => j.source), ["weworkremotely"]);

  asked = [];
  const both = await remoteBoardsAdapter(cfg({ boards: ["remoteok", "wwr"], wwrCategories: ["programming"] }));
  assert.equal(asked.length, 2);
  assert.deepEqual([...new Set(both.map((j) => j.source))].sort(), ["remoteok", "weworkremotely"]);
});

test("a board that fails outright still lets the other board's jobs land", async () => {
  // The same containment as within WWR, one level up. RemoteOK serving HTML instead of JSON throws
  // inside JSON.parse — a rejection that, unhandled, would discard the WWR jobs already fetched
  // alongside it.
  reset();
  routes.set("remoteok.com/api", { body: "<html>we are down for maintenance</html>" });
  routes.set("remote-programming-jobs.rss", { body: wwrFeed(wwrItem("Acme Corp: Engineer", "https://weworkremotely.com/remote-jobs/acme-eng")) });
  const jobs = await remoteBoardsAdapter(cfg({ boards: ["remoteok", "wwr"], wwrCategories: ["programming"] }));
  assert.deepEqual(jobs.map((j) => j.source), ["weworkremotely"]);
});

test("a disabled source makes no requests at all", async () => {
  reset();
  routes.set("remoteok.com/api", { body: ROK });
  const jobs = await remoteBoardsAdapter(cfg({ boards: ["remoteok"], enabled: false }));
  assert.deepEqual(jobs, []);
  assert.deepEqual(asked, [], "disabled must mean nothing goes out, not that the result is thrown away");
});

test("teardown restores the real fetch", () => {
  globalThis.fetch = realFetch;
  assert.equal(globalThis.fetch, realFetch);
});
