// Craigslist, the local-jobs tier — an HTML scraper with no tests, whose failure mode is a number
// going down rather than an error going up.
//
// Craigslist blocks the RSS feed outright, so this adapter parses the static search page. That means
// every posting it finds depends on one CSS class name owned by someone else. When Craigslist renames
// `li.cl-static-search-result`, nothing throws: the loop simply matches zero rows, the page is treated
// as the end of the results, and the run reports success with no jobs. That is indistinguishable from
// a quiet week in the market, which is why it can go unnoticed for a long time.
//
// Driven through the REAL adapter by stubbing global fetch, which is what `getText` calls. No test-only
// export, no parser copy to keep in sync — if the selector changes, these fail.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { craigslistAdapter } from "./craigslist.ts";
import type { SourceConfig } from "../types.ts";

/** A source config with the two fields every adapter shares, plus whatever this test is about. */
const cfg = (o: Record<string, unknown>): SourceConfig => ({ type: "craigslist", interval: "0 * * * *", ...o });

const realFetch = globalThis.fetch;
let asked: string[] = [];
let reply: (url: string, n: number) => { status: number; body: string } = () => ({ status: 200, body: "" });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const r = reply(url, asked.length);
  asked.push(url);
  return new Response(r.body, { status: r.status });
}) as typeof fetch;

/** One static-search row, in the shape Craigslist actually serves it. */
function row(id: string, title: string, place: string): string {
  return `<li class="cl-static-search-result" title="${title}">
    <a href="https://sfbay.craigslist.org/eby/lab/d/${title.toLowerCase().replace(/\W+/g, "-")}/${id}.html">
      <div class="title">${title}</div><div class="location">${place}</div>
    </a></li>`;
}
const page = (...rows: string[]) => `<html><body><ul class="cl-static-search-results">${rows.join("")}</ul></body></html>`;

function reset(): void { asked = []; }

test("the stub really drives the scraper, before anything is concluded from it", async () => {
  // Guard the instrument. An adapter that never reached fetch returns [] — and so does an adapter
  // whose selector stopped matching. Prove the request went out and rows came back before treating
  // any later empty result as meaningful.
  reset();
  reply = (_u, n) => ({ status: 200, body: n === 0 ? page(row("7712345678", "Warehouse Associate", "Oakland")) : page() });
  const jobs = await craigslistAdapter(cfg({ cities: ["sfbay"], queries: ["warehouse"] }));

  assert.equal(asked.length, 2, "one page of results, then one empty page that ends the loop");
  assert.match(asked[0]!, /^https:\/\/sfbay\.craigslist\.org\/search\/jjj\?query=warehouse$/,
    `the default category is jjj and the query is encoded — got ${asked[0]}`);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.title, "Warehouse Associate");
  assert.equal(jobs[0]!.location, "Oakland");
  assert.equal(jobs[0]!.source, "craigslist:sfbay");
  assert.equal(jobs[0]!.externalId, "7712345678", "the post id comes from the /<digits>.html tail, not the whole URL");
});

test("a row with no link is skipped rather than stored as a job with no way back to it", async () => {
  // Craigslist emits placeholder <li>s (deleted posts, ad slots) in the same list. A job whose URL is
  // "" is worse than a missing job: it reaches the dashboard, gets counted, and cannot be opened.
  reset();
  reply = (_u, n) => ({
    status: 200,
    body: n === 0
      ? page(`<li class="cl-static-search-result"><span>this posting has been deleted</span></li>`,
             row("7712345679", "Forklift Driver", "Hayward"))
      : page(),
  });
  const jobs = await craigslistAdapter(cfg({ cities: ["sfbay"], queries: ["forklift"] }));
  assert.equal(jobs.length, 1, "only the row that has somewhere to go");
  assert.equal(jobs[0]!.title, "Forklift Driver");
});

test("an HTTP error ends that search quietly instead of taking the run down", async () => {
  // Craigslist rate-limits by city. One 403 must cost us one city, not the whole cycle — the other
  // seven sources in the same run are unaffected and their jobs still need to land.
  //
  // The body carries a real result row on purpose. A 403 whose body is obviously not a job page is
  // rejected by the parser anyway, so it proves nothing about the status check — this fixture is the
  // case where the two disagree, and the status has to win. That is what a CDN serving a stale or
  // partial cached page under an error code looks like.
  reset();
  reply = () => ({ status: 403, body: page(row("999", "Night Auditor", "Oakland")) });
  const jobs = await craigslistAdapter(cfg({ cities: ["sfbay", "newyork"], queries: ["driver"] }));
  assert.deepEqual(jobs, []);
  assert.equal(asked.length, 2, "one attempt per city, and neither retried into the wall");
});

test("pagination advances by the result index and stops when a page repeats itself", async () => {
  // Craigslist's `&s=` is an offset into the result set, not a page number, and the last page keeps
  // serving the same rows rather than returning an empty list. Advance by the wrong amount, or trust
  // an empty page as the only stop condition, and this loops until maxPages against a live site.
  reset();
  const first = page(row("111", "Cook", "Oakland"), row("222", "Server", "Berkeley"));
  reply = (_u, n) => ({ status: 200, body: n === 0 ? first : first });   // page two repeats page one
  const jobs = await craigslistAdapter(cfg({ cities: ["sfbay"], queries: ["kitchen"], maxPages: 10 }));

  assert.equal(jobs.length, 2, "the repeat must not be stored twice");
  assert.equal(asked.length, 2, "and the repeat must stop the loop, not run to maxPages");
  assert.match(asked[1]!, /&s=2$/, `the second request offsets by the rows seen so far — got ${asked[1]}`);
});

test("the native filters the config offers actually reach the query string", async () => {
  // These are the only server-side narrowing this source has. If they silently drop, the adapter
  // still returns jobs — just the wrong ones, from the wrong radius, and nobody notices because the
  // dashboard fills up as usual.
  reset();
  reply = () => ({ status: 200, body: page() });
  await craigslistAdapter(cfg({
    cities: ["sfbay"], queries: ["cdl"], category: "trp",
    employment_type: [1, 3], postal: "94607", search_distance: 25,
  }));

  const u = asked[0]!;
  assert.match(u, /\/search\/trp\?/, "the configured category replaces the jjj default");
  assert.match(u, /employment_type=1&employment_type=3/, "both employment types, repeated not overwritten");
  assert.match(u, /postal=94607/);
  assert.match(u, /search_distance=25/);
});

test("every city and query pair is searched", async () => {
  // The nested loop is the whole point of the source: two cities and two queries is four searches,
  // not two. A break in the wrong scope here loses three quarters of the coverage silently.
  reset();
  reply = () => ({ status: 200, body: page() });
  await craigslistAdapter(cfg({ cities: ["sfbay", "newyork"], queries: ["cook", "driver"] }));
  assert.equal(asked.length, 4);
  assert.deepEqual(
    asked.map((u) => u.replace(/^https:\/\/([a-z]+)\.craigslist\.org\/search\/jjj\?query=/, "$1/")),
    ["sfbay/cook", "sfbay/driver", "newyork/cook", "newyork/driver"],
  );
});

test("teardown restores the real fetch", () => {
  globalThis.fetch = realFetch;
  assert.equal(globalThis.fetch, realFetch);
});
