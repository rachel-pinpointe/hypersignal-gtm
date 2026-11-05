// Which Craigslist city a search actually scrapes.
//
// This is invisible from the outside, which is why it went unnoticed: a wrong city site returns
// real, well-formed job postings — just for the wrong continent — and they land in the dashboard
// looking exactly like correct local matches. The lookup was a bare substring test returning the
// first key in insertion order, so "Birmingham, AL" matched the UK's Birmingham. Verified against
// the live site while sweeping: that search returns postings in Dudley, in the English West
// Midlands.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCities, labelCountry, materializeSources } from "./materialize.ts";
import type { ClientConfig, SourceConfig } from "./types.ts";

const US_DEFAULT = ["newyork", "losangeles", "chicago", "houston", "miami"];

test("a US state token settles the country as firmly as a country name does", () => {
  // countryFromLocation alone returns null for all of these, and null used to mean "no constraint".
  assert.equal(labelCountry("Birmingham, AL"), "US");
  assert.equal(labelCountry("Manchester, NH"), "US");
  assert.equal(labelCountry("Birmingham, UK"), "GB");
  assert.equal(labelCountry("Remote"), null, "an unknowable label must stay unknowable");
});

test("an ambiguous city name does not cross an ocean", () => {
  // Every pair below is the same word in two countries. The left-hand side is the one that broke.
  for (const [label, wrongSite] of [
    ["Birmingham, AL", "birmingham"], ["Manchester, NH", "manchester"], ["Paris, TX", "paris"],
    ["Vancouver, WA", "vancouver"], ["Berlin, CT", "berlin"], ["Rome, GA", "rome"],
    ["Milan, MI", "milan"], ["Vienna, VA", "vienna"],
  ] as const) {
    const got = deriveCities(label);
    assert.ok(!got.includes(wrongSite), `${label} must not scrape ${wrongSite} — got ${JSON.stringify(got)}`);
    assert.deepEqual(got, US_DEFAULT, `${label} is a US place with no city site of its own`);
  }
});

test("the foreign city still resolves when the label actually says so", () => {
  // The guard must not cost us the cities it was added for.
  assert.deepEqual(deriveCities("Birmingham, UK"), ["birmingham"]);
  assert.deepEqual(deriveCities("Manchester, England"), ["manchester"]);
  assert.deepEqual(deriveCities("Paris, France"), ["paris"]);
  assert.deepEqual(deriveCities("Berlin, Germany"), ["berlin"]);
  assert.deepEqual(deriveCities("Vancouver, BC, Canada"), ["vancouver"]);
});

test("US cities resolve to their own site, not the five-city default", () => {
  assert.deepEqual(deriveCities("San Francisco, CA"), ["sfbay"]);
  assert.deepEqual(deriveCities("Seattle, WA"), ["seattle"]);
  assert.deepEqual(deriveCities("Austin, TX"), ["austin"]);
});

test("the city named FIRST wins, not the longest name in the string", () => {
  // A label names the city, then the wider region. "Seattle, Washington" must pick Seattle —
  // "washington" is the longer key and a naive longest-match sends it to Washington DC, which is
  // exactly what the first version of this fix did.
  assert.deepEqual(deriveCities("Seattle, Washington"), ["seattle"]);
  assert.deepEqual(deriveCities("Washington, DC"), ["washingtondc"]);
  // Length still breaks ties at the same position, so this is not decided by object ordering.
  assert.deepEqual(deriveCities("San Francisco Bay Area, CA"), ["sfbay"]);
  assert.deepEqual(deriveCities("San Diego, CA"), ["sandiego"]);
});

test("a known non-US country with no city site gets no Craigslist source at all", () => {
  // Falling back to five US cities would scrape New York for a search about Iceland and present the
  // results as local matches.
  assert.deepEqual(deriveCities("Reykjavik, Iceland"), []);
  assert.deepEqual(deriveCities("Kyoto, Japan"), []);
});

test("an unknown or absent location keeps the historical US default", () => {
  assert.deepEqual(deriveCities(undefined), US_DEFAULT);
  assert.deepEqual(deriveCities(""), US_DEFAULT);
  assert.deepEqual(deriveCities("Remote"), US_DEFAULT);
});

// ── Every selected location, not just the first ────────────────────────────────────────────────
//
// searchState.locations carries the whole array to hiring.cafe, so a three-city search is a
// three-city search there. The local tier read the FIRST location only: Craigslist scraped one city's
// site and SimplyHired ran one location string. Picking London, Berlin and Paris gave local coverage
// of London, with nothing on screen saying the other two were dropped — local coverage silently
// narrower than the corporate coverage beside it, for the same search.
const place = (formatted_address: string) => ({ formatted_address, address_components: [] });
const localSearch = (locations: ReturnType<typeof place>[], keywords: string[] = ["engineer"]) =>
  ({ name: "c", active: true, kind: "search",
     search: { keywords, sourceMode: "corporate_local", locations } }) as unknown as ClientConfig;
const of = (cfgs: SourceConfig[], type: string) => cfgs.filter((c) => c.type === type);

test("Craigslist covers every selected city, not just the first", () => {
  const cl = of(materializeSources(localSearch([place("London, UK"), place("Berlin, Germany"), place("Paris, France")])), "craigslist");
  assert.equal(cl.length, 1, "one source carries the whole city list — the adapter walks it");
  assert.deepEqual([...(cl[0] as unknown as { cities: string[] }).cities].sort(), ["berlin", "london", "paris"]);
});

test("SimplyHired runs once per keyword AND per location", () => {
  const sh = of(materializeSources(localSearch([place("London, UK"), place("Berlin, Germany")], ["engineer", "designer"])), "simplyhired");
  assert.equal(sh.length, 4, "2 keywords x 2 locations");
  assert.deepEqual(sh.map((c) => `${(c as unknown as { query: string }).query}@${(c as unknown as { location: string }).location}`).sort(),
    ["designer@Berlin, Germany", "designer@London, UK", "engineer@Berlin, Germany", "engineer@London, UK"]);
});

test("a place with no Craigslist site does not cost the others their coverage", () => {
  // Reykjavik resolves to no city site. Before, being FIRST would have meant no Craigslist at all.
  const cl = of(materializeSources(localSearch([place("Reykjavik, Iceland"), place("London, UK")])), "craigslist");
  assert.equal(cl.length, 1);
  assert.deepEqual((cl[0] as unknown as { cities: string[] }).cities, ["london"]);
});

test("two places resolving to the same city site are scraped once", () => {
  const cl = of(materializeSources(localSearch([place("San Francisco, CA"), place("Bay Area, CA")])), "craigslist");
  assert.deepEqual((cl[0] as unknown as { cities: string[] }).cities, ["sfbay"]);
});

test("with no location set, the previous behaviour is unchanged", () => {
  const cfgs = materializeSources(localSearch([]));
  assert.deepEqual((of(cfgs, "craigslist")[0] as unknown as { cities: string[] }).cities, US_DEFAULT);
  const sh = of(cfgs, "simplyhired");
  assert.equal(sh.length, 1);
  assert.equal((sh[0] as unknown as { location: string }).location, "");
});
