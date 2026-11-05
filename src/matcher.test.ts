// Keyword matching. This was `text.includes(kw)` — substring matching — which is wrong in both
// directions and silently so: an include keyword pulls in unrelated postings, an exclude keyword
// drops relevant ones, and nothing in the UI or the logs says a thing. Measured on a real title,
// "Senior Maintenance Technician - Retail, email chain trainer, Israel" substring-matched BOTH "ai"
// and "sr".
// Run: npx tsx --test src/matcher.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordHit, evaluate } from "./matcher.ts";

const JOB = "senior maintenance technician - retail, email chain trainer, israel";

test("a short keyword no longer matches the middle of an unrelated word", () => {
  assert.equal(keywordHit(JOB, "ai"), false, "'ai' must not match maintenance/retail/email/chain/trainer");
  assert.equal(keywordHit(JOB, "sr"), false, "'sr' must not match Israel");
  assert.equal(keywordHit(JOB, "rain"), false, "'rain' must not match trainer");
  assert.equal(keywordHit("AI Engineer wanted", "ai"), true, "but a real term still matches");
  assert.equal(keywordHit("Lead AI/ML Engineer", "ai"), true, "including next to punctuation");
});

test("longer keywords still prefix-match, which is the point of not using whole-word", () => {
  assert.equal(keywordHit("ReactJS developer", "react"), true);
  assert.equal(keywordHit("React Native engineer", "react"), true);
  assert.equal(keywordHit("Kubernetes admin", "kubernet"), true);
  // …but only from the START of a word. This is the half that was broken.
  assert.equal(keywordHit("counterreaction analyst", "react"), false, "not from inside another word");
});

test("keywords starting with punctuation are not broken by a word boundary", () => {
  // \b before "." means "between a word char and a non-word char", which is the opposite of what a
  // leading-punctuation keyword needs — so those get no leading boundary at all.
  assert.equal(keywordHit("Senior .NET developer", ".net"), true);
  assert.equal(keywordHit("C++ systems engineer", "c++"), true);
});

test("multi-word phrases work, and regex metacharacters are escaped not executed", () => {
  assert.equal(keywordHit("Supply Chain Manager", "supply chain"), true);
  assert.equal(keywordHit("Supply Chain Manager", "supply  chain"), false, "spacing is literal");
  // A keyword is user input. If it were interpolated raw it would be a regex injection: ".*" would
  // match everything and "(" would throw at match time, taking the whole run down.
  assert.equal(keywordHit("anything at all", ".*"), false);
  assert.doesNotThrow(() => keywordHit("anything", "("));
  assert.equal(keywordHit("100% remote", "100%"), true);
});

test("case is ignored in both directions", () => {
  assert.equal(keywordHit("SENIOR ENGINEER", "senior"), true);
  assert.equal(keywordHit("senior engineer", "SENIOR"), true);
});

// ---------------------------------------------------------------------------------------------
// The location gate.
//
// This had no test at all, which is how it shipped doing two wrong things at once. Every component
// of a selected place was tested independently and ANY hit passed the job, so a search for Berlin,
// GERMANY matched "Berlin, CT" and "Berlin, New Hampshire" on the bare city name — and matched
// "Hamburg, Germany" too, because the place carries a country component and that alone was enough.
// Picking a city filtered no more narrowly than picking its country.
// ---------------------------------------------------------------------------------------------

const cCountry = (long: string, short: string) => ({ long_name: long, short_name: short, types: ["country"] });
const cRegion = (long: string, short: string) => ({ long_name: long, short_name: short, types: ["administrative_area_level_1"] });
const cLocality = (long: string) => ({ long_name: long, short_name: long, types: ["locality"] });

const place = (formatted_address: string, address_components: Array<{ long_name: string; short_name: string; types: string[] }>) =>
  ({ formatted_address, address_components });

const BERLIN_DE = place("Berlin, Germany", [cLocality("Berlin"), cRegion("Berlin", "BE"), cCountry("Germany", "DE")]);
const GERMANY = place("Germany", [cCountry("Germany", "DE")]);
const TEXAS = place("Texas, US", [cRegion("Texas", "TX"), cCountry("United States", "US")]);

const job = (o: Record<string, unknown>) =>
  ({ id: "j", source: "hcorg", title: "Driver", company: "Acme", url: "u", domain: "acme.com", remote: 0, ...o }) as never;
const searchFor = (...locations: unknown[]) =>
  ({ name: "c", kind: "search", search: { keywords: [], locations } }) as never;
const matches = (j: unknown, cl: unknown) => evaluate(j as never, cl as never, { orgScoped: false }) !== null;

test("a city in one country does not match the same city name in another", () => {
  assert.equal(matches(job({ location: "Berlin, Germany", country: "DE" }), searchFor(BERLIN_DE)), true);
  assert.equal(matches(job({ location: "Berlin, CT", state: "CT", country: "US" }), searchFor(BERLIN_DE)), false);
  assert.equal(matches(job({ location: "Berlin, New Hampshire", state: "NH", country: "US" }), searchFor(BERLIN_DE)), false);
});

test("selecting a city filters to that city, not to its whole country", () => {
  // The half that is easy to miss: the place's own country component must be a GATE, not another
  // way to satisfy the place.
  assert.equal(matches(job({ location: "Hamburg, Germany", country: "DE" }), searchFor(BERLIN_DE)), false);
});

test("selecting a country still matches the whole country", () => {
  assert.equal(matches(job({ location: "Berlin, Germany", country: "DE" }), searchFor(GERMANY)), true);
  assert.equal(matches(job({ location: "Hamburg, Germany", country: "DE" }), searchFor(GERMANY)), true);
  assert.equal(matches(job({ location: "Berlin, CT", state: "CT", country: "US" }), searchFor(GERMANY)), false);
});

test("selecting a US state matches by state code across its cities", () => {
  assert.equal(matches(job({ location: "Austin, TX", state: "TX", country: "US" }), searchFor(TEXAS)), true);
  assert.equal(matches(job({ location: "Dallas, TX", state: "TX", country: "US" }), searchFor(TEXAS)), true);
  assert.equal(matches(job({ location: "Berlin, Germany", country: "DE" }), searchFor(TEXAS)), false);
});

test("several selected places are alternatives, and each keeps its own granularity", () => {
  const both = searchFor(BERLIN_DE, TEXAS);
  assert.equal(matches(job({ location: "Berlin, Germany", country: "DE" }), both), true);
  assert.equal(matches(job({ location: "Austin, TX", state: "TX", country: "US" }), both), true);
  assert.equal(matches(job({ location: "Hamburg, Germany", country: "DE" }), both), false);
});

test("a remote job ignores the location gate, and no selection allows everything", () => {
  assert.equal(matches(job({ location: "Anywhere", remote: 1 }), searchFor(BERLIN_DE)), true);
  assert.equal(matches(job({ location: "Berlin, CT", state: "CT", country: "US" }), searchFor()), true);
});

test("an unknown country is not assumed to be the US", () => {
  // geo.ts's governing rule, applied here: a job whose country cannot be told must not satisfy a US
  // place just by having no evidence against it.
  assert.equal(matches(job({ location: "Somewhereville" }), searchFor(TEXAS)), false);
});
