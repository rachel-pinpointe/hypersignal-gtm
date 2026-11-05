// Regenerates src/places.ts from dr5hn/countries-states-cities-database.
//
// One committed, generated place table is the source of truth for turning a free-text location into
// a country. Before this, geo.ts carried three hand-written lists — 98 country aliases, ~80 world
// cities, no subdivisions at all — and the gaps were real: postings that spelled out "Puerto Rico",
// "Costa Rica", "Cyprus" or "Cambodia" resolved to no country, and "Windsor, Ontario" had nothing
// to match on.
//
// Generated and committed rather than fetched at runtime or pulled as a dependency: it is reference
// data that changes a few times a decade, it is read on a hot path, and the app must work offline.
//
// THE ONE RULE: a name is kept only if it is UNAMBIGUOUS across the whole dataset. A name in two
// countries decides nothing, and guessing between them files a job on the wrong continent silently.
// That single rule is also what protects US behaviour for free — any foreign town sharing a name
// with a US one is dropped by it, because the US places are in the dataset too.
//
// Usage:  node scripts/gen-places.mjs
import { writeFileSync } from "node:fs";

const BASE = "https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json";
const get = async (f) => {
  const r = await fetch(`${BASE}/${f}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${f}`);
  return r.json();
};

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

// Ordinary words that happen to be a place name somewhere. As an exact comma-segment match these
// are unlikely but not impossible, and a wrong country costs more than a missing one.
const GENERIC = new Set([
  "north", "south", "east", "west", "central", "northern", "southern", "eastern", "western",
  "centre", "center", "capital", "capital city", "city", "district", "region", "province",
  "state", "county", "island", "islands", "coast", "delta", "lake", "river", "valley", "plateau",
  "highland", "highlands", "lowlands", "national capital district", "federal capital territory",
  "metropolitan", "municipality", "territory", "special region", "autonomous region",
  "united", "national", "border", "centrale", "nord", "sud", "est", "ouest", "norte", "sur",
  "remote", "anywhere", "worldwide", "global", "home", "office", "headquarters", "main", "union",
  // Continents and macro-regions. These are NOT places this table should answer for, and they are
  // in the dataset as real settlements: there is a town called Asia in the Philippines, and without
  // this a posting whose location is the single word "Asia" resolved to PH.
  "asia", "africa", "europe", "america", "americas", "north america", "south america",
  "central america", "latin america", "oceania", "antarctica", "eurasia", "middle east",
  "apac", "emea", "latam", "anz", "benelux", "nordics", "scandinavia", "caribbean", "balkans",
  "asia pacific", "far east", "near east", "western europe", "eastern europe", "sub saharan africa",
]);

// Country names that are also something else common enough to misfire on. Georgia is the one that
// matters: it is a US state, and reading "Atlanta, Georgia" as the country would be a far worse
// error than leaving "Tbilisi, Georgia" unresolved.
const RISKY_COUNTRY = new Set([
  "georgia", "jersey", "chad", "mali", "niger", "jordan", "guinea", "samoa", "guam", "palau",
  "nauru", "tonga", "niue", "aruba", "curacao", "reunion", "mayotte", "martinique", "guadeloupe",
  "gibraltar", "monaco", "andorra", "san marino",
]);
const US_STATE_NAMES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming",
]);

/** Collect name -> country, dropping any name claimed by more than one country. */
function uniqueNames(pairs, minLen = 4) {
  const seen = new Map();
  for (const [rawName, cc] of pairs) {
    const k = fold(rawName);
    if (!k || k.length < minLen || GENERIC.has(k)) continue;
    let s = seen.get(k);
    if (!s) seen.set(k, (s = new Set()));
    s.add(cc);
  }
  const kept = [...seen.entries()].filter(([, s]) => s.size === 1)
    .map(([n, s]) => [n, [...s][0]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { kept, dropped: seen.size - kept.length };
}

const countries = await get("countries.json");
const ccOf = new Map(countries.map((c) => [c.name, String(c.iso2 ?? "").toUpperCase()]));

// ---- countries ----------------------------------------------------------------------------
const countryPairs = [];
for (const c of countries) {
  const cc = String(c.iso2 ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) continue;
  for (const n of [c.name, c.native]) if (n) countryPairs.push([n, cc]);
}
const countryTable = uniqueNames(countryPairs)
  .kept.filter(([n]) => !RISKY_COUNTRY.has(n) && !US_STATE_NAMES.has(n));
console.log(`country names:     ${countryTable.length}`);

// ---- subdivisions -------------------------------------------------------------------------
// US subdivisions are excluded: geo.ts owns those in US_STATES and checks them FIRST. Two tables of
// the same fact is how they drift apart.
const states = await get("states.json");
const statePairs = [];
for (const s of states) {
  const cc = String(s.country_code ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || cc === "US") continue;
  for (const n of [s.name, s.native]) if (n) statePairs.push([n, cc]);
}
const sub = uniqueNames(statePairs);
console.log(`subdivisions:      ${sub.kept.length} kept, ${sub.dropped} ambiguous dropped`);

// ---- cities -------------------------------------------------------------------------------
// The weakest signal and the last one consulted, so ambiguity matters most here. US cities ARE
// included in the ambiguity computation (and in the output), which is what makes the rule protect
// US locations: any foreign town sharing a name with a US place is dropped by the same rule.
const withCities = await get("countries+cities.json");
const cityPairs = [];
for (const c of withCities) {
  const cc = ccOf.get(c.name);
  if (!cc || !/^[A-Z]{2}$/.test(cc)) continue;
  for (const city of c.cities ?? []) cityPairs.push([typeof city === "string" ? city : city.name, cc]);
}
const subNames = new Set(sub.kept.map(([n]) => n));
const countryNames = new Set(countryTable.map(([n]) => n));
const city = uniqueNames(cityPairs);
// A city name that is also a country or a subdivision is handled by the stronger tier; keeping it
// here too would only add a way for the tiers to disagree.
const cityTable = city.kept.filter(([n]) => !subNames.has(n) && !countryNames.has(n));
console.log(`cities:            ${cityTable.length} kept, ${city.dropped} ambiguous dropped, ` +
  `${city.kept.length - cityTable.length} shadowed by a stronger tier`);

// ---- emit ------------------------------------------------------------------------------------
// Tab-separated blobs parsed into Maps on first use. An object literal of 130,000 keys is slow for
// the compiler and for V8; a string is neither, and the parse is skipped entirely unless a lookup
// actually reaches that tier.
const blob = (rows) => rows.map(([n, cc]) => `${n}\t${cc}`).join("\n");
const out = `// GENERATED by scripts/gen-places.mjs — do not edit by hand. Re-run that script to update.
// Source: dr5hn/countries-states-cities-database (countries.json, states.json, countries+cities.json).
//
// Free-text place name -> ISO country code, in three tiers of decreasing confidence. Every name
// here is UNAMBIGUOUS across the whole dataset: a name claimed by two countries is dropped, because
// it decides nothing and guessing between them would file a job on the wrong continent in silence.
//
// That rule is also what keeps US locations safe without a special case. The dataset contains US
// places too, so any foreign town sharing a name with a US one is dropped by the same test.
//
// NOT here: US states (geo.ts owns those in US_STATES and checks them first) and a short stoplist of
// names that are ordinary words or US states — "georgia" above all, since reading "Atlanta, Georgia"
// as the country of Georgia is a much worse error than leaving "Tbilisi, Georgia" unresolved.
//
//   countries    ${String(countryTable.length).padStart(7)}
//   subdivisions ${String(sub.kept.length).padStart(7)}   (${sub.dropped} ambiguous dropped)
//   cities       ${String(cityTable.length).padStart(7)}   (${city.dropped} ambiguous dropped)

/** Country names beyond geo.ts's hand-written COUNTRY_NAMES, which stays authoritative. */
export const EXTRA_COUNTRY_NAMES: Array<[string, string]> = [
${countryTable.map(([n, cc]) => `  [${JSON.stringify(n)}, "${cc}"],`).join("\n")}
];

const SUBDIVISIONS = \`${blob(sub.kept)}\`;
const CITIES = \`${blob(cityTable)}\`;

function parse(blobText: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of blobText.split("\\n")) {
    const t = line.indexOf("\\t");
    if (t > 0) m.set(line.slice(0, t), line.slice(t + 1));
  }
  return m;
}

let subs: Map<string, string> | null = null;
let cities: Map<string, string> | null = null;

/** Country for an exact, already-folded subdivision name ("ontario" -> "CA"). */
export function subdivisionCc(folded: string): string | null {
  return (subs ??= parse(SUBDIVISIONS)).get(folded) ?? null;
}

/** Country for an exact, already-folded city name ("eindhoven" -> "NL"). Weakest tier — a city
 *  name is the least distinctive thing in a location string, so callers consult it last. */
export function cityCc(folded: string): string | null {
  return (cities ??= parse(CITIES)).get(folded) ?? null;
}
`;
writeFileSync("src/places.ts", out);
console.log(`wrote src/places.ts (${(Buffer.byteLength(out) / 1e6).toFixed(2)} MB)`);
