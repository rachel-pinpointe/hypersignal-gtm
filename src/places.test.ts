// Location → country, now backed by the full dr5hn place dataset (src/places.ts).
//
// Everything here is a case that was measured against the live jobs table or found while wiring the
// dataset in. The governing rule of geo.ts is "unknown ≠ US" — be confident or be silent — and most
// of these tests exist to pin the SILENT half, because a confident wrong country is what puts a job
// on the wrong continent without anyone noticing.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCountry, deriveState } from "./normalize.ts";
import { countryFromLocation, placeFromLocation, isListOfAlternatives } from "./geo.ts";
import { subdivisionCc, cityCc } from "./places.ts";

test("a subdivision names the country when nothing stronger does", () => {
  // The gap that started this: geo.ts had no subdivision table at all, so a Canadian province,
  // a German state or an Indian state told it nothing.
  assert.equal(deriveCountry("Windsor, Ontario"), "CA");
  assert.equal(deriveCountry("Vancouver, British Columbia"), "CA");
  assert.equal(deriveCountry("Munich, Bavaria"), "DE");
  assert.equal(deriveCountry("Bangalore, Karnataka"), "IN");
});

test("a bare city names the country too — the weakest tier, but a real one", () => {
  assert.equal(deriveCountry("Eindhoven"), "NL");
  assert.equal(cityCc("eindhoven"), "NL");
});

test("a US state ALWAYS beats a foreign region of the same name", () => {
  // Every left-hand name below is genuinely in the subdivision table as a foreign region. Without
  // the ordering in deriveCountry, each of these US jobs would be filed abroad.
  for (const [loc, name] of [
    ["Birmingham, AL", "birmingham"], ["Paris, TX", "paris"], ["Berlin, CT", "berlin"],
    ["Rome, GA", "rome"], ["Vienna, VA", "vienna"], ["Dublin, OH", "dublin"],
  ] as const) {
    assert.ok(subdivisionCc(name), `${name} must actually be in the table, or this test proves nothing`);
    assert.equal(deriveCountry(loc), "US", `${loc} must stay in the US`);
  }
});

// "Milan, MI" was in the list above and now resolves to Italy. That is a deliberate reversal, and it
// is narrower than it looks: this rule fires only when the two-letter code is ACTUALLY a subdivision
// of the country the city names. MI is the province of Milano; AL is not a British subdivision, so
// "Birmingham, AL" is untouched, and neither is TX French or CT German.
//
// Checked against the live table before changing it: there is not one "Milan, MI" row either way (7
// Milan rows, all spelling out "Italy"), so no stored data moves. What DOES move is "Tbilisi,
// Tbilisi, Georgia" — 3 rows, filed as Georgia the US state — and the shape generally, which is what
// Workable, Recruitee and Personio emit when their country field is blank.
test("a region code that corroborates the city wins over the US state it spells", () => {
  assert.equal(deriveCountry("Milan, MI"), "IT", "MI is the province of Milano");
  assert.equal(deriveState("Milan, MI"), null);
  // …and the same string WITH a US country marker is still American.
  assert.equal(deriveCountry("Milan, MI, United States"), "US");
  assert.equal(deriveState("Milan, MI, United States"), "MI");
});

test("a country name inside a longer region name is not a second country", () => {
  // "New South Wales" matched "wales" (GB) as well as "australia" (AU); the two-country guard saw a
  // conflict and returned null, so every posting in Australia's most populous state had no country.
  // 20 of them in the live table, each spelling out "Australia".
  assert.equal(countryFromLocation("Botany, New South Wales, Australia"), "AU");
  assert.equal(countryFromLocation("Sydney, New South Wales, Australia"), "AU");
  assert.equal(countryFromLocation("Perth, Western Australia, Australia"), "AU");
  // ...while Wales on its own is still Wales.
  assert.equal(countryFromLocation("Cardiff, Wales"), "GB");
});

test("a country whose name is also a region of itself still resolves", () => {
  // The masking rule must require an enclosing phrase STRICTLY LONGER than the match. Testing the
  // bare match would silence every country that is also a region in its own territory.
  assert.equal(countryFromLocation("Mexico City, Mexico"), "MX");
});

test("countries the hand-written list never had now resolve", () => {
  // All four appeared in stored locations that named the country in full and resolved to nothing.
  assert.equal(deriveCountry("Aguadilla, Puerto Rico"), "PR");
  assert.equal(deriveCountry("Alajuela, Costa Rica"), "CR");
  assert.equal(deriveCountry("Nicosia, Cyprus"), "CY");
  assert.equal(deriveCountry("Phnom Penh, Cambodia"), "KH");
});

test("Georgia stays a US state, deliberately", () => {
  // The country of Georgia is excluded on purpose. Reading "Atlanta, Georgia" as Georgia would be a
  // far bigger error than leaving Tbilisi unresolved, and this is the trade being made — pinned so
  // nobody "fixes" it by adding the country and quietly breaks every Atlanta posting.
  assert.equal(deriveCountry("Atlanta, Georgia"), "US");
  assert.equal(deriveState("Atlanta, Georgia"), "GA");
  // …and the cost is no longer paid. This line used to assert "US" as "the accepted cost of the rule
  // above". It does not have to be: the country stays out of the name table exactly as before, and
  // Tbilisi is decided instead by CORROBORATION — the city says GE and "georgia" is GE's own name in
  // the alias table, so the two agree. Atlanta cannot trigger it, because no city in that string
  // resolves to GE. Three live rows were stored as Georgia-the-US-state.
  assert.equal(deriveCountry("Tbilisi, Georgia"), "GE");
  assert.equal(deriveState("Tbilisi, Georgia"), null);
});

test("a shortlist of alternatives has no country", () => {
  // ATS boards put whole shortlists in the location field. Answering one is picking a place out of
  // a hat: "Accra or Bogota or Cape Town or Dubai…" resolved to Mauritius, and lists containing a
  // stray "Texas" resolved to the US even when no US city was offered.
  assert.ok(isListOfAlternatives("Accra or Bogota or Cape Town or Dubai"));
  assert.equal(deriveCountry("Accra or Bogota or Cape Town or Dubai or Dakar"), null);
  assert.equal(deriveCountry("Beijing or Hanoi or Mumbai or Shanghai or Singapore"), null);
  assert.equal(deriveCountry("Africa or Asia or Europe or North America"), null);
  assert.equal(deriveCountry("Atlanta or California or India or Germany or Japan"), null);
});

test("Oregon is not a list of alternatives", () => {
  // "OR" is Oregon's abbreviation. A case-insensitive test for "or" would throw away every Oregon
  // location in the database.
  assert.equal(isListOfAlternatives("Portland, OR"), false);
  assert.equal(deriveCountry("Portland, OR"), "US");
  assert.equal(deriveState("Moore, OR"), "OR");
});

test("a name claimed by two countries is absent from the table entirely", () => {
  // The one rule the generator enforces. Victoria (AU state and cities elsewhere) and Georgia
  // decide nothing, so they are not there to be guessed with.
  assert.equal(subdivisionCc("victoria"), null);
  assert.equal(subdivisionCc("georgia"), null);
  assert.equal(cityCc("springfield"), null, "Springfield exists in a dozen countries");
});

test("a location naming several countries stays unknown", () => {
  // Pre-existing behaviour, pinned: it is the reason the Wales fix had to be surgical rather than
  // just relaxing the two-country guard.
  assert.equal(countryFromLocation("San Francisco, CA, United States; London, United Kingdom"), null);
});

test("placeFromLocation reads regions before cities, and refuses to guess between them", () => {
  assert.equal(placeFromLocation("Ontario"), "CA");
  assert.equal(placeFromLocation("Remote"), null);
  assert.equal(placeFromLocation(""), null);
  assert.equal(placeFromLocation(null), null);
});

test("a shortlist of alternatives has no STATE either", () => {
  // The state half of the same rule. usStateFromLocation scans for the FIRST state token it can
  // find, so "Alabama or Alaska or Arizona or Arkansas or …" — a job open in ANY US state — came
  // back as Alabama, and "Accra or Bogota or Cape Town or Dubai" came back as Washington because
  // one of the later alternatives contained a "WA". 569 stored rows are that shape.
  assert.equal(deriveState("Alabama or Alaska or Arizona or Arkansas"), null);
  assert.equal(deriveState("Aberdeen or Maryland or Pennsylvania or Virginia"), null);
  assert.equal(deriveState("Accra or Bogota or Cape Town or Dubai or Dakar"), null);
});

test("a single US location still yields its state", () => {
  // The guard must not cost the normal case, and must not trip on Oregon's abbreviation.
  assert.equal(deriveState("Austin, TX"), "TX");
  assert.equal(deriveState("Portland, OR"), "OR");
  assert.equal(deriveState("Seattle, Washington"), "WA");
});
