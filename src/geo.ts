// Country detection + name normalisation for a WORLDWIDE company set.
//
// The governing rule is "unknown ≠ US". Everything here returns null rather than guessing, because
// the callers use a non-null answer to switch off US-specific behaviour: deriveState() must keep
// parsing "Wilmington, DE" as Delaware while refusing to read "Berlin, DE" as Delaware, and the
// only safe way to do that is to be *confident* about Berlin and *silent* about everything else.
//
// No db access, so src/db.ts can call it during the boot migration. Its one import is src/places.ts,
// a GENERATED table of every country, subdivision and city in
// dr5hn/countries-states-cities-database whose name is unambiguous worldwide. That is the source of
// truth for place names; the hand-written lists below are kept only where they are richer than the
// dataset (native spellings, informal aliases) and are consulted FIRST.

import { EXTRA_COUNTRY_NAMES, subdivisionCc, cityCc } from "./places.ts";
import { isSubdivisionCodeOf, countryCodeByName } from "./subdivisionCodes.ts";

// ── country detection ───────────────────────────────────────────────────────────────────────────

/** ISO alpha-2 codes that are ALSO US state abbreviations. A bare one of these is ambiguous and
 *  never resolves a country on its own — the city has to disambiguate it. */
const AMBIGUOUS_CC = new Set(["DE", "IN", "CA", "ID", "LA", "MD", "MS", "MT", "NE", "PA", "AL", "AR", "CO", "OR", "OK", "MO", "MN", "MA", "SC", "SD", "ND", "NC", "NH", "NJ", "NM", "NV", "NY", "OH", "RI", "TN", "VA", "VT", "WA", "WI", "WV", "WY", "AK", "AZ", "CT", "FL", "GA", "HI", "IA", "IL", "KS", "KY", "ME", "MI", "TX", "UT"]);

/** Unambiguous alpha-2 codes (not US state abbrs) we accept as a trailing country segment. */
const SAFE_CC = new Set(["GB", "UK", "FR", "NL", "JP", "SG", "BR", "AE", "PL", "CH", "SE", "NO", "DK", "FI", "IE", "PT", "CZ", "RO", "TR", "GR", "IL", "ZA", "NZ", "SA", "MY", "TH", "VN", "HK", "CN", "KR", "AT", "BE", "ES", "IT", "MX", "AU", "PH", "PK", "BD", "NG", "KE", "EG", "CL", "AR", "PE", "UY", "EE", "LV", "LT", "SK", "SI", "HR", "BG", "RS", "UA", "IS", "LU", "MT", "CY", "QA", "KW", "BH", "OM", "JO", "LK", "TW"]);

/** Country name / alias → alpha-2. Longest match wins. "Georgia" is deliberately absent (US state). */
const COUNTRY_NAMES: Array<[string, string]> = [
  ["united states of america", "US"], ["united states", "US"], ["u.s.a", "US"], ["usa", "US"], ["u.s.", "US"],
  ["united kingdom", "GB"], ["great britain", "GB"], ["england", "GB"], ["scotland", "GB"], ["wales", "GB"], ["northern ireland", "GB"],
  ["deutschland", "DE"], ["germany", "DE"], ["france", "FR"], ["nederland", "NL"], ["netherlands", "NL"], ["holland", "NL"],
  ["españa", "ES"], ["espana", "ES"], ["spain", "ES"], ["italia", "IT"], ["italy", "IT"], ["portugal", "PT"],
  ["ireland", "IE"], ["belgium", "BE"], ["belgië", "BE"], ["luxembourg", "LU"], ["switzerland", "CH"], ["schweiz", "CH"],
  ["austria", "AT"], ["österreich", "AT"], ["poland", "PL"], ["polska", "PL"], ["czechia", "CZ"], ["czech republic", "CZ"],
  ["sweden", "SE"], ["sverige", "SE"], ["norway", "NO"], ["norge", "NO"], ["denmark", "DK"], ["danmark", "DK"],
  ["finland", "FI"], ["suomi", "FI"], ["iceland", "IS"], ["estonia", "EE"], ["latvia", "LV"], ["lithuania", "LT"],
  ["romania", "RO"], ["bulgaria", "BG"], ["greece", "GR"], ["hungary", "HU"], ["slovakia", "SK"], ["slovenia", "SI"],
  ["croatia", "HR"], ["serbia", "RS"], ["ukraine", "UA"], ["turkey", "TR"], ["türkiye", "TR"],
  ["india", "IN"], ["bharat", "IN"], ["pakistan", "PK"], ["bangladesh", "BD"], ["sri lanka", "LK"],
  ["china", "CN"], ["hong kong", "HK"], ["taiwan", "TW"], ["japan", "JP"], ["south korea", "KR"], ["korea", "KR"],
  ["singapore", "SG"], ["malaysia", "MY"], ["thailand", "TH"], ["vietnam", "VN"], ["viet nam", "VN"],
  ["indonesia", "ID"], ["philippines", "PH"], ["australia", "AU"], ["new zealand", "NZ"],
  ["canada", "CA"], ["mexico", "MX"], ["méxico", "MX"], ["brazil", "BR"], ["brasil", "BR"],
  ["argentina", "AR"], ["chile", "CL"], ["colombia", "CO"], ["peru", "PE"], ["uruguay", "UY"],
  ["south africa", "ZA"], ["nigeria", "NG"], ["kenya", "KE"], ["egypt", "EG"], ["morocco", "MA"],
  ["israel", "IL"], ["united arab emirates", "AE"], ["saudi arabia", "SA"], ["qatar", "QA"], ["kuwait", "KW"],
];

/** World cities that identify a country on their own. Used to resolve an ambiguous trailing code
 *  ("Berlin, DE") and a bare city ("London"). US cities are deliberately NOT here — an unmatched
 *  city falls through to null, which leaves the existing US behaviour untouched. */
// Object.create(null), not {}. These maps are indexed with UNTRUSTED text straight off a scrape, and
// a plain object literal inherits Object.prototype — so countryFromLocation("constructor") returned a
// JavaScript FUNCTION where an ISO country code was expected, and that value flowed into the job's
// country column. Verified by execution. A null-prototype object has no inherited keys to hit.
const CITY_COUNTRY: Record<string, string> = Object.assign(Object.create(null), {
  london: "GB", manchester: "GB", birmingham: "GB", leeds: "GB", glasgow: "GB", edinburgh: "GB", bristol: "GB", cambridge: "GB", oxford: "GB",
  dublin: "IE", cork: "IE",
  berlin: "DE", münchen: "DE", munich: "DE", hamburg: "DE", frankfurt: "DE", köln: "DE", cologne: "DE", stuttgart: "DE", düsseldorf: "DE", leipzig: "DE",
  paris: "FR", lyon: "FR", marseille: "FR", toulouse: "FR", bordeaux: "FR", lille: "FR", nantes: "FR",
  amsterdam: "NL", rotterdam: "NL", utrecht: "NL", "den haag": "NL", eindhoven: "NL",
  madrid: "ES", barcelona: "ES", valencia: "ES", sevilla: "ES", málaga: "ES", malaga: "ES",
  milano: "IT", milan: "IT", roma: "IT", rome: "IT", torino: "IT", turin: "IT", napoli: "IT", bologna: "IT",
  lisboa: "PT", lisbon: "PT", porto: "PT",
  bruxelles: "BE", brussels: "BE", antwerp: "BE", antwerpen: "BE", ghent: "BE",
  zurich: "CH", zürich: "CH", geneva: "CH", genève: "CH", basel: "CH", lausanne: "CH", bern: "CH",
  vienna: "AT", wien: "AT", graz: "AT", salzburg: "AT",
  warsaw: "PL", warszawa: "PL", krakow: "PL", kraków: "PL", wroclaw: "PL", gdansk: "PL", poznan: "PL",
  prague: "CZ", praha: "CZ", brno: "CZ", bratislava: "SK", ljubljana: "SI", zagreb: "HR", belgrade: "RS",
  stockholm: "SE", gothenburg: "SE", göteborg: "SE", malmö: "SE", oslo: "NO", bergen: "NO",
  copenhagen: "DK", københavn: "DK", aarhus: "DK", helsinki: "FI", espoo: "FI", tallinn: "EE", riga: "LV", vilnius: "LT",
  bucharest: "RO", bucurești: "RO", cluj: "RO", sofia: "BG", athens: "GR", budapest: "HU", kyiv: "UA", kiev: "UA",
  istanbul: "TR", ankara: "TR", izmir: "TR",
  mumbai: "IN", bengaluru: "IN", bangalore: "IN", delhi: "IN", "new delhi": "IN", hyderabad: "IN", pune: "IN", chennai: "IN", kolkata: "IN", gurgaon: "IN", gurugram: "IN", noida: "IN", ahmedabad: "IN",
  karachi: "PK", lahore: "PK", dhaka: "BD", colombo: "LK",
  beijing: "CN", shanghai: "CN", shenzhen: "CN", guangzhou: "CN", hangzhou: "CN",
  "hong kong": "HK", taipei: "TW", tokyo: "JP", osaka: "JP", kyoto: "JP", yokohama: "JP", fukuoka: "JP",
  seoul: "KR", busan: "KR", singapore: "SG", "kuala lumpur": "MY", bangkok: "TH", hanoi: "VN", "ho chi minh city": "VN",
  jakarta: "ID", bali: "ID", manila: "PH", cebu: "PH",
  sydney: "AU", melbourne: "AU", brisbane: "AU", perth: "AU", adelaide: "AU", canberra: "AU",
  auckland: "NZ", wellington: "NZ",
  toronto: "CA", vancouver: "CA", montreal: "CA", montréal: "CA", calgary: "CA", ottawa: "CA", edmonton: "CA", waterloo: "CA",
  "mexico city": "MX", "ciudad de méxico": "MX", guadalajara: "MX", monterrey: "MX",
  "são paulo": "BR", "sao paulo": "BR", "rio de janeiro": "BR", "belo horizonte": "BR", curitiba: "BR",
  "buenos aires": "AR", santiago: "CL", bogotá: "CO", bogota: "CO", lima: "PE", montevideo: "UY",
  johannesburg: "ZA", "cape town": "ZA", pretoria: "ZA", lagos: "NG", abuja: "NG", nairobi: "KE", cairo: "EG",
  "tel aviv": "IL", jerusalem: "IL", haifa: "IL",
  dubai: "AE", "abu dhabi": "AE", riyadh: "SA", jeddah: "SA", doha: "QA", "kuwait city": "KW",
});

/** ccTLD → country, and the reverse (which TLDs to try for a company hinted to a country). */
export const CC_TLDS: Record<string, string[]> = {
  GB: ["co.uk", "uk"], IE: ["ie"], DE: ["de"], FR: ["fr"], NL: ["nl"], ES: ["es"], IT: ["it"], PT: ["pt"],
  BE: ["be"], CH: ["ch"], AT: ["at"], PL: ["pl"], CZ: ["cz"], SE: ["se"], NO: ["no"], DK: ["dk"], FI: ["fi"],
  IS: ["is"], EE: ["ee"], LV: ["lv"], LT: ["lt"], RO: ["ro"], BG: ["bg"], GR: ["gr"], HU: ["hu"], SK: ["sk"],
  SI: ["si"], HR: ["hr"], RS: ["rs"], UA: ["ua"], TR: ["com.tr"], IN: ["in", "co.in"], PK: ["pk"], BD: ["com.bd"],
  LK: ["lk"], CN: ["cn", "com.cn"], HK: ["com.hk", "hk"], TW: ["com.tw", "tw"], JP: ["co.jp", "jp"],
  KR: ["co.kr", "kr"], SG: ["com.sg", "sg"], MY: ["com.my", "my"], TH: ["co.th"], VN: ["vn", "com.vn"],
  ID: ["co.id", "id"], PH: ["com.ph", "ph"], AU: ["com.au"], NZ: ["co.nz", "nz"], CA: ["ca"],
  MX: ["com.mx", "mx"], BR: ["com.br"], AR: ["com.ar"], CL: ["cl"], CO: ["com.co"], PE: ["com.pe"],
  UY: ["com.uy"], ZA: ["co.za"], NG: ["com.ng", "ng"], KE: ["co.ke"], EG: ["com.eg"], MA: ["ma"],
  IL: ["co.il"], AE: ["ae"], SA: ["com.sa"], QA: ["qa"], KW: ["com.kw"], LU: ["lu"], MT: ["com.mt"], CY: ["com.cy"],
};
const TLD_TO_CC: Record<string, string> = (() => {
  const m: Record<string, string> = Object.create(null);   // same untrusted-key rule as CITY_COUNTRY
  for (const [cc, tlds] of Object.entries(CC_TLDS)) for (const t of tlds) if (!(t in m)) m[t] = cc;
  return m;
})();

const lc = (s: string) => s.trim().toLowerCase();

// ONE combined regex over every country alias, longest-first, with letter boundaries on both sides.
// Boundaries are non-negotiable: a plain substring test read "Indianapolis, IN" as India. A single
// pass also keeps makeJob() cheap — this runs once per ingested job.
// The curated aliases above win; the generated list fills what they never covered. Measured on the
// live jobs table, the hand-written 98 had no entry for Puerto Rico, Costa Rica, Cyprus, Malta,
// Cambodia, the Dominican Republic, Ecuador, the Bahamas or El Salvador — all of which appeared in
// stored locations that spelled the country out in full and still resolved to nothing.
const NAME_TO_CC = new Map<string, string>(EXTRA_COUNTRY_NAMES);
for (const [n, cc] of COUNTRY_NAMES) NAME_TO_CC.set(n, cc);
const COUNTRY_RE = new RegExp(
  `(?<!\\p{L})(?:${[...NAME_TO_CC.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?!\\p{L})`,
  "giu",
);

/** Best-effort country (ISO alpha-2) for a free-text location — or null when NOT confident.
 *  Confidence order: explicit country name → unambiguous trailing code → ambiguous code resolved by
 *  the preceding city → bare world city. Anything else is null, so US parsing keeps working. */
export function countryFromLocation(loc: string | null | undefined): string | null {
  const cc = countryOnly(loc);
  if (!cc || cc === "US") return cc;
  // Confidently foreign — unless the string is really TWO postings and the other one is American
  // ("New York, NY / London, UK", "Paris, France; Austin, TX"), where no single country is right.
  //
  // The US signal has to come from a SEPARATE listing, not from anywhere in the text. The earlier
  // version tested the whole string for a US-state-looking token, which meant every foreign address
  // whose own subdivision code happens to spell a US state was read as American: "Perth, WA,
  // Australia" became Washington State, and Brazil (SC, MA, PA, MT, MS, AL) and India (TN, GA, OR)
  // collide constantly. That reproduced the exact "Berlin, DE filed as Delaware" bug this function
  // exists to prevent, one input class over. Inside one address a 2-letter code belongs to that
  // address's country, so only a genuine list separator can introduce a second region.
  // A lowercase "or" separates alternatives just as a slash or semicolon does — ATS boards write
  // "Accra or Bogota or Cape Town or Dubai" with no punctuation at all, and without this the guard
  // below sees one part and cannot fire. Case-sensitive: "OR" is Oregon (see LIST_OF_ALTERNATIVES).
  const parts = String(loc).split(/[\/;|\n]|\bor\b/).map((s) => s.trim()).filter(Boolean);
  const saysUS = (p: string) =>
    countryOnly(p) === "US"
    || /\b(?:US|USA|U\.S\.?A?\.?)\b/.test(p)          // "Remote (US)" names no city and no state
    || (countryOnly(p) === null && usStateFromLocation(p) !== null);
  if (parts.length > 1 && parts.some(saysUS)) return null;
  // The same reasoning, generalised past the US. Only ONE alternative in a shortlist may happen to
  // be a country NAME, and step 1 above then answers for the whole list on the strength of it:
  // "Beijing or Hanoi or Mumbai or Shanghai or Singapore" resolved to Singapore, because Singapore
  // is the only one of the five that is also a country. Reading each part separately shows five
  // different countries, which is no answer at all.
  if (parts.length > 1) {
    const perPart = new Set(parts.map(countryOnly).filter(Boolean) as string[]);
    if (perPart.size > 1) return null;
  }
  return cc;
}

/** US states live here rather than in normalize.ts because countryFromLocation needs them to spot a
 *  multi-region location, and this module must stay import-free (db.ts loads it during boot). */
export const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
  // Not a state, but it is a US subdivision people filter on, and leaving it out was actively wrong
  // rather than merely incomplete: with no "DC" to match, "Washington, DC" fell through to the
  // full-name scan and came back as Washington STATE.
  "district of columbia": "DC",
};
export const US_STATE_ABBRS = new Set(Object.values(US_STATES));

/** Raw US-state scan with NO country gate. On its own it reads "Berlin, DE" as Delaware, which is
 *  exactly why deriveState() wraps it — do not use this directly as a job's state. */
export function usStateFromLocation(loc: string | null | undefined): string | null {
  const raw = (loc ?? "").trim();
  if (!raw) return null;
  // EVERY two-letter token, not just the first. This tested `raw.match(...)` — a single match — so any
  // string whose first uppercase pair isn't a state gave up before reaching the one that is:
  // "US - Remote, CA" stopped at "US", "IT Support, Austin, TX" stopped at "IT". hiring.cafe emits a
  // tidy "City, ST, Country" so nothing in the current table is affected (measured: 0 rows), but the
  // ATS boards added since compose their location from free-form vendor fields, which is exactly where
  // a leading token like that shows up — and the failure is silent: the job simply loses its state and
  // drops out of a state-scoped client filter.
  for (const m of raw.matchAll(/\b([A-Z]{2})\b/g)) if (US_STATE_ABBRS.has(m[1]!)) return m[1]!;
  const low = lc(raw);
  if (/(^|[^a-z])d\.\s?c\.?([^a-z]|$)/.test(low)) return "DC"; // the punctuated "Washington, D.C."
  // Word-bounded, and then TWO tie-breaks, because the obvious single one is wrong each way round.
  //
  // The bug being fixed: a bare `low.includes(name)` over an object whose key order puts "virginia"
  // before "west virginia" stored every spelled-out "Charleston, West Virginia" as VA, and made
  // "Washington, DC" match "washington" and become WA. (The abbreviation loop above has always been
  // boundary-safe; only this path was not.)
  //
  // Sorting longest-first fixes the first case and BREAKS a second one: "Washington, Indiana" is a
  // town in Indiana, and "washington" is the longer name, so it started resolving to WA. Measured on
  // the live table while writing the repair script — one row, but a wrong rule.
  //
  //   1. CONTAINMENT — drop a match that sits inside a longer match. "virginia" inside
  //      "west virginia" is not evidence for Virginia.
  //   2. POSITION — of what survives, take the LAST. A location reads "City, State, Country", so the
  //      state is the later name and the city is the earlier one. "Washington, Indiana" -> IN;
  //      "Kansas City, Missouri" -> MO; "Indiana, Pennsylvania" -> PA.
  const hits: Array<{ at: number; len: number; abbr: string }> = [];
  for (const [name, abbr] of Object.entries(US_STATES)) {
    const m = new RegExp(`(^|[^a-z])(${name})([^a-z]|$)`).exec(low);
    if (m) hits.push({ at: m.index + m[1]!.length, len: name.length, abbr });
  }
  if (!hits.length) return null;
  const outer = hits.filter((h) => !hits.some((o) => o !== h && o.at <= h.at && o.at + o.len >= h.at + h.len));
  return outer.reduce((best, h) => (h.at > best.at ? h : best)).abbr;
}

/**
 * Is this country-name match merely part of a longer place name? ("wales" inside "New South Wales")
 *
 * Checked per match rather than by masking every subdivision in the string up front: there are
 * 6,478 of them and building one alternation regex out of that would be a large object compiled on
 * a hot path, for a question that only arises when a country name actually matched.
 *
 * The enclosing phrase must be STRICTLY LONGER than the match. Testing the bare match would mask
 * every country whose name is also a region somewhere in its own territory — "Mexico City, Mexico"
 * would stop resolving.
 */
/**
 * A location written as a shortlist of alternatives, which has no single country: "Accra or Bogota
 * or Cape Town or Dubai", "Africa or Asia or Europe or North America". ATS boards put these in the
 * location field routinely.
 *
 * CASE-SENSITIVE, and that is the whole subtlety. "OR" is Oregon's abbreviation, so a
 * case-insensitive test reads "Portland, OR" as a list and throws away a perfectly good location.
 * A prose "or" between place names is lowercase; the state code is not.
 */
const LIST_OF_ALTERNATIVES = /\bor\b/;

function partOfLongerPlace(low: string, at: number, hit: string): boolean {
  const WORDS = 3;   // "new south wales" is three; nothing useful is longer
  const before = low.slice(0, at).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const after = low.slice(at + hit.length).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let n = 1; n <= WORDS && n <= before.length; n++) {
    if (subdivisionCc([...before.slice(-n), hit].join(" "))) return true;
  }
  for (let n = 1; n <= WORDS && n <= after.length; n++) {
    if (subdivisionCc([hit, ...after.slice(0, n)].join(" "))) return true;
  }
  return false;
}

function countryOnly(loc: string | null | undefined): string | null {
  const raw = (loc ?? "").trim();
  if (!raw) return null;
  const low = lc(raw);
  // 1. explicit country name as a whole word (longest alias wins: "united states" beats "states").
  // If the text names two DIFFERENT countries we are not confident about either. That pattern is
  // common on remote/ATS postings ("San Francisco, CA, United States; London, United Kingdom"), and
  // picking one used to both name the wrong country AND null out deriveState, so a US-scoped search
  // silently stopped matching the job. Returning null lets the US state fallback run as before.
  let best = "";
  const named = new Set<string>();
  COUNTRY_RE.lastIndex = 0;
  for (const m of low.matchAll(COUNTRY_RE)) {
    // A country name that sits INSIDE a longer region name is not a second country. "New South
    // Wales, Australia" matched both "wales" (GB) and "australia" (AU), the two-country guard below
    // saw a conflict, and every posting in Australia's most populous state resolved to no country
    // at all — 20 in the live data, all correctly spelling out "Australia".
    if (partOfLongerPlace(low, m.index!, m[0])) continue;
    named.add(NAME_TO_CC.get(m[0])!);
    if (m[0].length > best.length) best = m[0];
  }
  if (named.size > 1) return null;
  if (best) return NAME_TO_CC.get(best)!;
  const segs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const last = segs.length ? lc(segs[segs.length - 1]!) : "";
  const prev = segs.length > 1 ? lc(segs[segs.length - 2]!) : "";
  // 2. trailing 2-letter code that is NOT also a US state abbreviation
  const upper = last.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && SAFE_CC.has(upper) && !AMBIGUOUS_CC.has(upper)) return upper === "UK" ? "GB" : upper;
  // 3. trailing code that IS a US state abbr → only the city can decide ("Berlin, DE" vs "Wilmington, DE")
  if (/^[A-Z]{2}$/.test(upper) && AMBIGUOUS_CC.has(upper)) {
    const byCity = CITY_COUNTRY[prev];
    return byCity && byCity === upper ? byCity : null;   // city must agree with the code, else unknown
  }
  // 4. a bare city we recognise
  return CITY_COUNTRY[last] ?? CITY_COUNTRY[low] ?? null;
}

/** Country implied by a domain's ccTLD (acme.co.uk → GB). null for generic TLDs. */
export function countryFromDomain(domain: string | null | undefined): string | null {
  const d = lc(domain ?? "");
  if (!d) return null;
  const parts = d.split(".");
  for (let i = Math.max(0, parts.length - 2); i < parts.length; i++) {
    const suffix = parts.slice(i).join(".");
    if (TLD_TO_CC[suffix]) return TLD_TO_CC[suffix]!;
  }
  return null;
}

// ── name normalisation ──────────────────────────────────────────────────────────────────────────

// NFD strips combining marks, but these letters don't decompose — without them "Malmö"→"Malmo"
// works while "Ørsted"→"Ørsted" doesn't, and half the comparisons silently fail.
const EXTRA_FOLD: Record<string, string> = { "ß": "ss", "ø": "o", "đ": "d", "ð": "d", "þ": "th", "ł": "l", "æ": "ae", "œ": "oe", "ı": "i", "ŧ": "t", "ħ": "h" };
/** Accent-insensitive form: "Société Générale" → "Societe Generale". Applied to BOTH sides of a
 *  comparison so either spelling matches the other. */
export function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC")
    .replace(/[ßøđðþłæœıŧħ]/giu, (ch) => {
      const low = EXTRA_FOLD[ch.toLowerCase()] ?? ch;
      return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? low.toUpperCase() : low;
    });
}

const CYRILLIC: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g" };
const GREEK: Record<string, string> = { α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o" };
/** Latin approximation of a Cyrillic/Greek name. Returns "" for scripts with no dictionary-free
 *  romanisation (CJK, Arabic) — callers must treat that as "can't guess", not as a bad guess. */
export function transliterate(s: string): string {
  return [...foldDiacritics(s).toLowerCase()]
    .map((ch) => CYRILLIC[ch] ?? GREEK[ch] ?? (/[a-z0-9 \-&.]/.test(ch) ? ch : ""))
    .join("").replace(/\s+/g, " ").trim();
}

// Legal forms across the markets this app now covers. Anchored at the END and applied repeatedly,
// because "Acme GmbH & Co. KG" needs several passes.
const CJK_FORMS = /（株）|\(株\)|株式会社|有限会社|合同会社|\(주\)|주식회사|有限公司|股份有限公司/g;
const LEGAL_SUFFIX = /[,.]?\s*\b(?:inc|incorporated|llc|l\.l\.c|ltd|limited|plc|llp|lp|corp|corporation|co|company|gmbh|mbh|ug|ag|kg|kgaa|ohg|se|sca|e\.?v|s\.?a|s\.?a\.?s|sasu|s\.?a\.?r\.?l|sarl|eurl|s\.?l|s\.?l\.?u|s\.?p\.?a|s\.?r\.?l|srl|b\.?v|n\.?v|v\.?o\.?f|ab|asa|as|a\/s|aps|oy|oyj|hf|ehf|sp\.?\s*z\.?\s*o\.?\s*o|de\s*c\.?v|pty\.?\s*ltd|pte\.?\s*ltd|sdn\.?\s*bhd|bhd|pvt\.?\s*ltd|private\s+limited|k\.?k|y\.?k)\b\.?$/i;
/** Does this string END in a legal form — i.e. does it look like a REGISTERED NAME rather than a
 *  tagline? Used to pick the company side of a "Brand | Tagline" page title: "Trade Lines Inc" beats
 *  "India" even though "India" is shorter. */
export function hasLegalSuffix(s: string): boolean {
  const t = s.replace(/\s+/g, " ").trim();
  // CJK_FORMS carries the /g flag, and .test() on a global regex is STATEFUL — it advances lastIndex
  // and the next call starts mid-string, so alternating inputs give alternating answers. Test against
  // a fresh non-global copy instead of the shared literal.
  return LEGAL_SUFFIX.test(t) || new RegExp(CJK_FORMS.source).test(t);
}

/** Strip the legal form so "Monzo Bank Limited" ≡ "Monzo Bank" and "Acme GmbH" ≡ "Acme".
 *  Never returns empty — "Limited Brands" must survive intact. */
export function stripLegalSuffix(s: string): string {
  let out = s.replace(CJK_FORMS, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEGAL_SUFFIX, "").replace(/[,.&\s]+$/, "").trim();
    if (next === out || !next) break;
    out = next;
  }
  return out || s.trim();
}

/**
 * Country implied by a SUBDIVISION name in a free-text location — "Windsor, Ontario" → CA.
 *
 * Backed by src/subdivisions.ts, generated from dr5hn/countries-states-cities-database and holding
 * only names that are unique across every country in that dataset. Names that occur in two
 * countries ("Victoria", "Georgia", "Central") are absent, because they decide nothing.
 *
 * Two rules make this safe to consult:
 *
 *   A US state wins, always. "Birmingham, AL", "Manchester, NH" and "Paris, TX" all name a region
 *   that also exists abroad — birmingham, paris, rome, milan, vienna and dublin are ALL in the
 *   table as foreign subdivisions — so a US state token anywhere in the string stops this cold.
 *   Callers get that for free by ordering their checks; deriveCountry does it explicitly.
 *
 *   Segments are read RIGHT TO LEFT. A location is written narrowest-first ("City, Region,
 *   Country"), so the rightmost recognised name is the broadest and the most trustworthy. Read
 *   left to right, "London, Ontario" matches London-the-GB-region first and lands in England —
 *   which is the exact class of bug this is here to close.
 */
export function placeFromLocation(loc: string | null | undefined): string | null {
  const raw = (loc ?? "").trim();
  if (!raw) return null;
  // A location written as a LIST OF ALTERNATIVES is not a location. ATS boards emit whole
  // shortlists in this field — "Accra or Bogota or Cape Town or Dubai or Dakar or Freetown",
  // "Africa or Asia or Europe or North America" — and no country is the right answer for any of
  // them. Splitting on "or" and requiring agreement is not enough on its own, because only one name
  // in a list of ten may be in the table and it then answers alone: that first string resolved to
  // Mauritius. The list SHAPE is the evidence, so it stops here. ("and" is not a separator — it
  // occurs inside real place names.)
  if (LIST_OF_ALTERNATIVES.test(raw)) return null;
  const segs = raw.split(/[,/;|\n]/).map((s) => foldDiacritics(s).toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  // Two tiers, and a SUBDIVISION anywhere in the string beats a CITY anywhere in it — a region is
  // the more decisive of the two, so "Springfield, Ontario" resolves on Ontario.
  //
  // Within a tier, DISAGREEMENT MEANS SILENCE. Postings routinely list a dozen places at once
  // ("Accra or Bogota or Cape Town or Dubai or Dakar…"), and answering those means picking one city
  // out of ten and presenting it as the job's country. Measured on the live table: without this,
  // such a listing resolved to Mauritius. The same rule countryOnly already applies to two country
  // names, applied one tier down.
  for (const lookup of [subdivisionCc, cityCc]) {
    const found = new Set<string>();
    for (const s of segs) { const cc = lookup(s); if (cc) found.add(cc); }
    if (found.size === 1) return [...found][0]!;
    if (found.size > 1) return null;   // named several places in different countries — unknowable
  }
  return null;
}

/**
 * The CITY tier of placeFromLocation on its own, plus the country named in the same string.
 *
 * deriveState needs the city's opinion SEPARATELY from the subdivision's, which placeFromLocation
 * cannot give it: that function consults subdivisions first and returns as soon as they agree, so
 * for "Chennai, TN" the subdivision tier sees both Tennessee and Tamil Nadu, falls silent, and the
 * city decides — but for "Austin, TX" the subdivision tier answers US and the city is never asked.
 * The caller needs the city's answer in both cases, because it is corroborating a two-letter code
 * against it.
 *
 * Same disagreement rule as every other tier: two cities in different countries means silence.
 * Also answers for a country NAME in the string, including the ambiguous ones places.ts must drop —
 * "Tbilisi, Georgia" is decided by tbilisi and georgia agreeing on GE.
 */
export function cityCountryFromLocation(loc: string | null | undefined): string | null {
  const raw = (loc ?? "").trim();
  if (!raw || LIST_OF_ALTERNATIVES.test(raw)) return null;
  const segs = raw.split(/[,/;|\n]/).map((s) => foldDiacritics(s).toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const found = new Set<string>();
  // The hand-written CITY_COUNTRY first, exactly as countryOnly consults it: it is richer than the
  // generated table where it overlaps, and the generated one DROPS any city name that occurs in two
  // countries — which is why cityCc alone knows nothing about Perth.
  for (const s of segs) { const cc = CITY_COUNTRY[s] ?? cityCc(s) ?? countryCodeByName(s); if (cc) found.add(cc); }
  return found.size === 1 ? [...found][0]! : null;
}

/** Is this location a shortlist of alternatives rather than one place? See LIST_OF_ALTERNATIVES. */
export function isListOfAlternatives(loc: string | null | undefined): boolean {
  return LIST_OF_ALTERNATIVES.test(String(loc ?? ""));
}
