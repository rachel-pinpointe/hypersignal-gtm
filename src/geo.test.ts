// Tests for the country/name-normalisation layer. The safety property under test everywhere is
// "unknown ≠ US": geo may only answer when it is sure, because deriveState() and the matcher's
// country gate switch off US-specific behaviour on any non-null answer.
// Run: npx tsx --test src/geo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { countryFromLocation, countryFromDomain, foldDiacritics, transliterate, stripLegalSuffix, usStateFromLocation } from "./geo.ts";
import { deriveState, deriveCountry } from "./normalize.ts";

test("an explicit country name wins over everything else", () => {
  assert.equal(countryFromLocation("Berlin, Germany"), "DE");
  assert.equal(countryFromLocation("London, United Kingdom"), "GB");
  assert.equal(countryFromLocation("Remote (India)"), "IN");
  assert.equal(countryFromLocation("Austin, TX, United States"), "US");
});

test("an unambiguous 2-letter code resolves; UK is folded to GB", () => {
  assert.equal(countryFromLocation("Paris, FR"), "FR");
  assert.equal(countryFromLocation("Tel Aviv, IL"), "IL");
  assert.equal(countryFromLocation("Bristol, UK"), "GB");
});

test("a code that is ALSO a US state abbreviation needs the city to agree", () => {
  assert.equal(countryFromLocation("Berlin, DE"), "DE");        // Berlin is a German city → Germany
  assert.equal(countryFromLocation("Mumbai, IN"), "IN");        // Mumbai is an Indian city → India
  assert.equal(countryFromLocation("Wilmington, DE"), null);    // unknown city → NOT Germany, stays US-parseable
  assert.equal(countryFromLocation("Indianapolis, IN"), null);
});

test("a bare world city resolves; an unknown location stays null", () => {
  assert.equal(countryFromLocation("Amsterdam"), "NL");
  assert.equal(countryFromLocation("Singapore"), "SG");
  assert.equal(countryFromLocation("Springfield"), null);
  assert.equal(countryFromLocation("Remote"), null);
  assert.equal(countryFromLocation(""), null);
  assert.equal(countryFromLocation(null), null);
});

test("deriveState no longer files foreign cities under a US state", () => {
  assert.equal(deriveState("Berlin, DE"), null);
  assert.equal(deriveState("Mumbai, IN"), null);
  assert.equal(deriveState("Munich, Germany"), null);
  assert.equal(deriveState("London, United Kingdom"), null);
});

test("deriveState is unchanged for every US location", () => {
  assert.equal(deriveState("Wilmington, DE"), "DE");
  assert.equal(deriveState("Indianapolis, IN"), "IN");
  assert.equal(deriveState("San Francisco, CA"), "CA");
  assert.equal(deriveState("Austin, Texas"), "TX");
  assert.equal(deriveState("Atlanta, Georgia"), "GA"); // "Georgia" the US state, not the country
  assert.equal(deriveState("New York, NY, United States"), "NY");
});

test("countryFromDomain reads the ccTLD and ignores generic TLDs", () => {
  assert.equal(countryFromDomain("monzo.co.uk"), "GB");
  assert.equal(countryFromDomain("acme.de"), "DE");
  assert.equal(countryFromDomain("flipkart.in"), "IN");
  assert.equal(countryFromDomain("stripe.com"), null);
  assert.equal(countryFromDomain(""), null);
});

test("foldDiacritics handles both decomposing and non-decomposing letters", () => {
  assert.equal(foldDiacritics("Société Générale"), "Societe Generale");
  assert.equal(foldDiacritics("Malmö"), "Malmo");
  assert.equal(foldDiacritics("Ørsted"), "Orsted");
  assert.equal(foldDiacritics("Straße"), "Strasse");
});

test("transliterate romanises Cyrillic/Greek and drops scripts it cannot romanise", () => {
  assert.equal(transliterate("Яндекс"), "yandeks");
  assert.equal(transliterate("Δέλτα"), "delta");
  assert.equal(transliterate("楽天"), ""); // honest blank, not a bad guess
});

test("stripLegalSuffix strips international legal forms without eating real names", () => {
  assert.equal(stripLegalSuffix("Monzo Bank Limited"), "Monzo Bank");
  assert.equal(stripLegalSuffix("Zalando SE"), "Zalando");           // Societas Europaea
  assert.equal(stripLegalSuffix("Acme GmbH"), "Acme");
  assert.equal(stripLegalSuffix("Acme GmbH & Co. KG"), "Acme");
  assert.equal(stripLegalSuffix("Adyen N.V."), "Adyen");
  assert.equal(stripLegalSuffix("Infosys Pvt Ltd"), "Infosys");
  assert.equal(stripLegalSuffix("トヨタ株式会社"), "トヨタ");
  assert.equal(stripLegalSuffix("Limited Brands"), "Limited Brands"); // suffix only strips at the END
  assert.equal(stripLegalSuffix("Ltd"), "Ltd");                       // never returns empty
});

// A location that names TWO different countries is not evidence for either. Picking one used to
// both name the wrong country and null out deriveState, so the job silently stopped matching a
// US-scoped search — a common remote/ATS posting shape.
test("a location naming two countries is not confident, so the US state fallback still works", () => {
  assert.equal(countryFromLocation("San Francisco, CA, United States; London, United Kingdom"), null);
  assert.equal(countryFromLocation("New York, NY / London, UK"), null);
  assert.equal(deriveState("San Francisco, CA, United States; London, United Kingdom"), "CA");
  assert.equal(deriveState("New York, NY / London, UK"), "NY");
  // Two mentions of the SAME country are still confident.
  assert.equal(countryFromLocation("Berlin, Germany or Munich, Germany"), "DE");
  assert.equal(countryFromLocation("Remote — USA, United States"), "US");
});

// A foreign address's OWN subdivision code frequently spells a US state: WA in Australia, and in
// Brazil and India almost half of them (SC, PA, MT, MS, AL, MA / TN, GA, OR). Scanning the whole
// string for a US-state-looking token therefore filed "Perth, WA, Australia" as Washington State,
// USA — the same class of error as reading "Berlin, DE" as Delaware, one input shape over. Inside a
// single address, a 2-letter code belongs to that address's country.
test("a foreign subdivision that spells a US state does not make the job American", () => {
  for (const [loc, cc] of [
    ["Perth, WA, Australia", "AU"],
    ["Florianópolis, SC, Brazil", "BR"],
    ["Belém, PA, Brazil", "BR"],
    ["Cuiabá, MT, Brazil", "BR"],
    ["Chennai, TN, India", "IN"],
    ["Panaji, GA, India", "IN"],
  ] as const) {
    assert.equal(countryFromLocation(loc), cc, `country for ${loc}`);
    assert.equal(deriveState(loc), null, `${loc} must have no US state`);
    assert.equal(deriveCountry(loc), cc, `${loc} must not fall back to US`);
  }
});

// The multi-region escape hatch must still fire — but only on a genuine SECOND listing.
test("only a separate listing makes a location multi-region", () => {
  assert.equal(countryFromLocation("Remote (US) | Berlin, Germany"), null);
  assert.equal(countryFromLocation("Paris, France; Austin, TX"), null);
  assert.equal(deriveState("Paris, France; Austin, TX"), "TX");
  // …and a single address is never multi-region, however many commas it has.
  assert.equal(countryFromLocation("Level 3, 100 King St, Perth, WA, Australia"), "AU");
});

// The US path must be byte-for-byte unchanged — this is the safety property the whole module rests
// on ("unknown is not US"), so every previously-working American location still behaves.
test("US locations are unaffected", () => {
  assert.equal(deriveState("Austin, TX, United States"), "TX");
  assert.equal(deriveState("Wilmington, DE"), "DE");
  assert.equal(deriveState("Indianapolis, IN"), "IN");
  assert.equal(deriveState("San Francisco, CA"), "CA");
  assert.equal(deriveCountry("New York, NY"), "US");
  assert.equal(deriveCountry("Remote"), null);
});

// A state name that is a SUBSTRING of a longer state name used to win, because the full-name scan
// was an unordered, unbounded `low.includes(name)` over an object whose key order puts "virginia"
// before "west virginia". Every spelled-out West Virginia posting was stored as VA. The same missing
// word boundary made "Washington, DC" match "washington" and become Washington STATE — DC was not in
// the table at all, so nothing earlier could claim it. Contrast the abbreviation scan directly above
// it, which has always been boundary-safe.
test("a longer state name beats the shorter one it contains", () => {
  assert.equal(usStateFromLocation("Charleston, West Virginia"), "WV");
  assert.equal(usStateFromLocation("Morgantown, West Virginia"), "WV");
  assert.equal(deriveState("Charleston, West Virginia"), "WV");
  // …and the plain one still resolves.
  assert.equal(usStateFromLocation("Richmond, Virginia"), "VA");
  assert.equal(usStateFromLocation("Norfolk, VA"), "VA");
});

test("Washington DC is the District, not Washington state", () => {
  assert.equal(usStateFromLocation("Washington, DC"), "DC");
  assert.equal(usStateFromLocation("Washington, D.C."), "DC");
  assert.equal(usStateFromLocation("Washington, D. C."), "DC");
  assert.equal(usStateFromLocation("District of Columbia"), "DC");
  assert.equal(deriveCountry("Washington, DC"), "US");
  // …and the state keeps its own name.
  assert.equal(usStateFromLocation("Seattle, Washington"), "WA");
  assert.equal(usStateFromLocation("Spokane, WA"), "WA");
});

// A world city followed by a region code that collides with a US state abbreviation. This is the
// standard output of Workable, Recruitee and Personio, which compose the location from separate
// city/region/country fields where the country field is often blank — so it is not an edge case, it
// is the common foreign shape.
//
// The rule is CORROBORATION, not assertion: the city's country only wins when the two-letter code
// beside it really is a subdivision of that country. The naive version ("if the city says a foreign
// country, drop the state") was implemented and measured first, and it broke the four US cases at
// the bottom of this test — which is why they are here.
test("a foreign city is not filed under a US state", () => {
  assert.equal(deriveState("Chennai, TN"), null, "TN is Tamil Nadu, not Tennessee");
  assert.equal(deriveCountry("Chennai, TN"), "IN");
  assert.equal(deriveState("Sao Paulo, MA"), null, "MA is Maranhao, not Massachusetts");
  assert.equal(deriveCountry("Sao Paulo, MA"), "BR");
  assert.equal(deriveState("Milan, MI"), null, "MI is Milano, not Michigan");
  assert.equal(deriveCountry("Milan, MI"), "IT");
  // The full-NAME half of the same problem, decided by the country-alias table rather than the
  // subdivision codes: Tbilisi and Georgia agree on GE.
  assert.equal(deriveState("Tbilisi, Georgia"), null, "Georgia the country, not the US state");
  assert.equal(deriveCountry("Tbilisi, Georgia"), "GE");
});

test("…and a US city that shares a foreign name keeps its state", () => {
  // Every one of these broke under the naive rule. NH is not a German subdivision and TX is not a
  // French one, so the city's opinion is not corroborated and the state stands.
  assert.equal(deriveState("Berlin, NH"), "NH");
  assert.equal(deriveCountry("Berlin, NH"), "US");
  assert.equal(deriveState("Paris, TX"), "TX");
  assert.equal(deriveCountry("Paris, TX"), "US");
  assert.equal(deriveState("Rome, GA"), "GA");
  assert.equal(deriveState("Athens, OH"), "OH");
});

// The two tie-breaks in usStateFromLocation, each of which fixes what the other one breaks.
test("the state is the LAST name in the string, not the longest", () => {
  // Position: a location reads "City, State, Country", so an earlier name is the city.
  assert.equal(usStateFromLocation("Washington, Indiana, United States"), "IN");
  assert.equal(usStateFromLocation("Kansas City, Missouri, United States"), "MO");
  assert.equal(usStateFromLocation("Indiana, Pennsylvania, United States"), "PA");
  assert.equal(usStateFromLocation("Rome, New York, United States"), "NY");
  // Containment still wins over position, because "virginia" INSIDE "west virginia" is not a
  // separate, later mention — it is the same one.
  assert.equal(usStateFromLocation("Wheeling, West Virginia, United States"), "WV");
});
