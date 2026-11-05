// Domain → company-name resolution for name-keyed producers (SEC EDGAR, news, WARN, app stores).
// Order: the jobs DB's own knowledge (most-seen company name on that domain) → the homepage <title>
// → the domain stem. Cached in-memory per process (names don't churn mid-run).
import { db } from "../db.ts";
import { foldDiacritics, stripLegalSuffix, hasLegalSuffix, countryFromLocation, usStateFromLocation } from "../geo.ts";
import { cityCc, subdivisionCc } from "../places.ts";
import { safeFetch } from "../safeFetch.ts";
import { decodeEntities } from "../normalize.ts";

const cache = new Map<string, CompanyIdentity>();

const TITLE_JUNK = /\s*[|–—:·-]\s*(home|homepage|official site|welcome).*$/i;

// Page furniture and bot-wall titles that are NOT a company name. This list is load-bearing, not
// tidiness: whatever comes out of here is the company's IDENTITY for every name-keyed producer
// (WARN, EDGAR, news, GDELT, Companies House, app stores), so a wrong name doesn't degrade a result,
// it attributes another company's events to this one.
//
// Measured on the audit snapshot before this guard existed: ELEVEN unrelated freight companies all
// resolved to the name "Home" — their homepages are titled "Home" or "Home | <something>" — and WARN
// then matched that against "Home Express Delivery Service, LLC" and "Home Depot U.S.A, Inc." by
// word-bounded prefix. Result: 25 false "layoff" signals per notice, spread across 13 companies that
// were not laying anyone off. Three more domains resolved to "Cloudflare", off an interstitial titled
// "Attention Required! | Cloudflare" — the split takes the shorter side, and the shorter side is the
// name of the CDN. In a tool used to decide who to email, that is worse than having no signal.
// Page furniture and status strings. Nothing is CALLED these, so they are rejected everywhere.
const GENERIC_TITLE = new Set([
  "home", "homepage", "welcome", "index", "main", "start", "start page", "untitled", "untitled document",
  "default", "official site", "official website", "website", "new page", "landing page", "coming soon",
  "under construction", "site maintenance", "maintenance", "test page",
  "just a moment", "attention required", "please wait", "redirecting", "access denied", "forbidden",
  "403 forbidden", "404", "404 not found", "not found", "error", "security check",
  "checking your browser", "are you a robot", "captcha", "bot verification", "service unavailable",
  "site temporarily unavailable", "page not found", "blocked",
]);

// Names of CDNs and bot-wall vendors. These are REAL COMPANIES, so they must not be rejected
// everywhere — only when the name was derived from a page <title>, where "Cloudflare" overwhelmingly
// means we hit that vendor's challenge page rather than a company called Cloudflare.
//
// This distinction exists because the test caught the first version of the fix making the actual
// Cloudflare unmatchable against its own funding news. Note the title path loses nothing by
// rejecting it: cloudflare.com falls through to the domain stem, which is "Cloudflare" anyway.
const INTERSTITIAL_VENDOR = new Set(["cloudflare", "akamai", "imperva", "incapsula", "sucuri", "fastly", "datadome", "perimeterx"]);

// Website builders and hosts, rejected on the title path for exactly the reason above. A site built
// on one of these ships a default <title> carrying the BUILDER's name — bay2main.com is titled
// "Wix" — and that name then becomes the company's identity for every name-keyed producer. Caught
// on the live data: bay2main.com resolved to "Wix", which matched the App Store seller "WIX.COM,
// INC." and filed Wix's own app under a freight company as evidence they had shipped one.
//
// Same shape as the CDN list, same care: these are real companies with real filings, real layoffs
// and real apps, so the rejection is title-only. squarespace.com still resolves to "Squarespace"
// through the domain stem, which is where every one of these falls to.
const BUILDER_VENDOR = new Set([
  "wix", "wix.com", "squarespace", "godaddy", "weebly", "shopify", "wordpress", "wordpress.com",
  "webflow", "duda", "hostinger", "ionos", "jimdo", "site123", "strikingly", "bigcommerce",
  "blogger", "google sites", "webnode", "zyro", "carrd", "web.com", "network solutions",
  "sitebuilder", "hostgator", "bluehost", "namecheap", "wpengine", "yola", "homestead",
]);

/**
 * ORDINARY WORDS. A company name that is ONE of these and nothing else is not an identity — it is a
 * word, and thousands of unrelated organisations contain it.
 *
 * This list is the single highest-value guard in the file, because without it the whole name-keyed
 * half of the product reports other companies' events. Graded across every stored row rather than a
 * sample: 123 of 177 name-keyed signals (69.5%) were about a DIFFERENT organisation. All 49 SEC
 * filings, 18 of 41 layoff notices, 56 of 87 news items. The mechanism is always the same — the
 * resolver produced a short common word, and companyEntityMatches' word-bounded-prefix rule then let
 * anything beginning with that word through:
 *
 *   armour.ca            -> "Armour"    -> ARMOUR Residential REIT's 32 SEC filings
 *   alliance.com         -> "Alliance"  -> Alliance Laundry's filings + LA charter schools' layoffs
 *   shipblock.com        -> "Block"     -> Block, Inc.'s WARN notices
 *   targetshipping.com   -> "Target"    -> Target's WARN notice
 *   compassfwd.com       -> "Compass"   -> Compass Inc (the real-estate brokerage), filed under
 *                                          THREE different customs brokers at once
 *   tliindia.com         -> "India"     -> Reuters coverage of India's education minister
 *
 * THE COST IS REAL AND IS ACCEPTED. A genuine company actually called Block, Target or Alliance now
 * gets no name-keyed signals. That is this file's stated trade, made twice already in the two
 * matchers below: a missed match is a quiet feed, a false match is a bogus sales signal that sends
 * someone to email a stranger about a layoff that never happened. At a measured 69.5% error rate the
 * trade is not close.
 *
 * Two words are enough to escape — "Trade Lines Inc", "The Block Logistics", "Alliance Shippers" are
 * all distinctive. This only ever refuses a name that is one bare word.
 */
const COMMON_WORD = new Set([
  // the observed offenders
  "alliance", "armour", "armor", "block", "target", "compass", "xpress", "express", "universal",
  "affiliated", "webster", "triumph", "beta", "unis", "us", "usa", "services", "service",
  "home", "based",
  // DELIBERATELY ABSENT, each tried and then removed after re-grading against every stored signal:
  // "group", "legacy", "direct", "gateway". Every one of them refused a name that was CORRECT —
  // "Gateway Group" (3 accurate news items) and "Legacy Supply Chain" (6 accurate layoff notices)
  // both went dark. A guard that starts producing wrong answers is worse than no guard, and the only
  // way to tell which is which is to re-grade, not to reason about which words feel generic.
  // Shared proper nouns — myth, astronomy and heraldry are the commons of brand naming, so a bare one
  // of them names dozens of unrelated organisations. Measured: "Pegasus" pulled in Pegasus Airlines,
  // the Pegasus rocket and Pegasus Tech Ventures; "Hercules" pulled in Hercules Capital and a West End
  // musical; "Sealion" pulled in the BYD Sealion EV.
  "pegasus", "hercules", "apollo", "orion", "odyssey", "olympus", "spartan", "trojan", "samson",
  "sealion", "neptune", "poseidon", "hermes", "athena", "artemis", "zeus", "argo", "sphinx", "griffin",
  // ordinary nouns and adjectives that turn up as a whole company name
  "access", "action", "active", "advance", "advantage", "agency", "alpha", "anchor", "apex", "apple",
  "arrow", "aspect", "asset", "atlas", "aurora", "avenue", "axis", "banner", "base", "beacon", "bell",
  "benchmark", "best", "beyond", "bird", "blue", "bold", "bond", "boost", "border", "boston", "box",
  "brand", "bridge", "bright", "broad", "buffalo", "build", "cable", "cannon", "canvas", "capital",
  "cardinal", "cargo", "carrier", "castle", "catalyst", "cedar", "center", "central", "century",
  "chain", "champion", "channel", "charter", "chase", "check", "choice", "circle", "city", "class",
  "clear", "climb", "cloud", "coast", "collective", "colonial", "columbia", "comet", "command",
  "commerce", "common", "compact", "complete", "concept", "connect", "consult", "core", "corner",
  "coronet", "counter", "county", "courier", "cover", "craft", "crane", "creek", "crest", "cross",
  "crown", "crystal", "cycle", "dart", "dash", "data", "dawn", "delta", "diamond", "digital",
  "discovery", "dispatch", "dominion", "double", "dover", "drive", "eagle", "east", "eastern",
  "echo", "edge", "element", "elevate", "elite", "empire", "endeavor", "energy", "engine", "enterprise",
  "epic", "equity", "essential", "everest", "evergreen", "exact", "excel", "exchange", "expert",
  "falcon", "family", "federal", "fidelity", "field", "first", "flag", "flash", "fleet", "flex",
  "flow", "focus", "force", "forest", "forge", "fortune", "forward", "foundation", "fountain", "fox",
  "frame", "freedom", "freight", "frontier", "fusion", "future", "galaxy", "garden", "gemini",
  "general", "genesis", "giant", "global", "gold", "golden", "grand", "granite", "graph", "green",
  "grid", "growth", "guard", "guardian", "guide", "gulf", "halo", "harbor", "harbour",
  "harvest", "hawk", "heritage", "hero", "highland", "hill", "hope", "horizon", "hub", "hunter",
  "ideal", "impact", "imperial", "impulse", "index", "industry", "infinity", "insight", "integral",
  "integrity", "iron", "island", "ivory", "jet", "journey", "junction", "keystone", "kinetic", "king",
  "knight", "lake", "landmark", "laurel", "leader", "leading", "legend", "liberty", "life",
  "light", "lighthouse", "lightning", "line", "link", "lion", "logic", "logistics", "loop", "lucky",
  "lunar", "magnet", "magnum", "major", "mariner", "maritime", "market", "mars", "marvel", "master",
  "matrix", "maverick", "meridian", "merit", "metro", "midland", "midwest", "mile", "milestone",
  "mission", "mobile", "modern", "momentum", "monarch", "moon", "motion", "mountain", "national",
  "native", "nature", "navigator", "network", "next", "noble", "nordic", "north", "northern", "nova",
  "ocean", "olympic", "omega", "onward", "open", "optimal", "optimum", "orbit", "order", "origin",
  "outlook", "pacific", "package", "palm", "paragon", "paramount", "partner", "path", "patriot",
  "peak", "pearl", "peninsula", "phoenix", "pilot", "pinnacle", "pioneer", "pivot", "planet",
  "platinum", "plus", "point", "polar", "port", "portal", "power", "precision", "preferred", "premier",
  "premium", "prestige", "prime", "principal", "priority", "pro", "progress", "proper", "protect",
  "provider", "pulse", "pure", "quality", "quantum", "quest", "quick", "rail", "rainbow",
  "ranger", "rapid", "reach", "ready", "real", "record", "red", "regal", "regency", "regional",
  "reliable", "reliance", "renew", "republic", "reserve", "resolute", "resource", "response", "ridge",
  "rise", "river", "road", "rock", "royal", "rush", "safe", "sage", "sail", "saturn", "scale", "scope",
  "seaboard", "seal", "search", "second", "secure", "select", "sentinel", "service", "seven", "shield",
  "shift", "ship", "shipping", "shore", "sierra", "signal", "silver", "simple", "sky", "smart",
  "solid", "solution", "solutions", "source", "south", "southern", "sovereign", "space", "span",
  "spark", "spectrum", "speed", "sphere", "spirit", "sport", "spring", "square", "stack", "standard",
  "star", "state", "steel", "stellar", "sterling", "stone", "storm", "strategic", "stream", "strong",
  "summit", "sun", "sunrise", "superior", "supply", "support", "supreme", "surge", "swift", "system",
  "systems", "talent", "tempo", "terminal", "thunder", "tide", "tiger", "titan", "top", "torch",
  "total", "tower", "trace", "track", "trade", "trail", "transit", "transport", "travel", "tribute",
  "trident", "trinity", "triple", "true", "trust", "union", "unique", "unified", "unity", "value",
  "vanguard", "vector", "venture", "vertex", "victory", "view", "viking", "vintage", "vision",
  "vista", "vital", "voyage", "voyager", "warrior", "watch", "water", "wave", "west", "western",
  "white", "wind", "wing", "wise", "wolf", "wonder", "world", "worldwide", "zenith", "zone",
]);

/** True when this single token names a place — a country, a region or a city. Same reason as the word
 *  list: "India", "Georgia", "Lynden", "Milan" and "Webster" are places thousands of organisations
 *  are named after or located in, so they identify nobody. Uses the same generated tables the
 *  location parser does rather than a second hand-written list. */
function isPlaceName(folded: string): boolean {
  // usStateFromLocation as well as the generated tables, because the generated ones deliberately DROP
  // any name that occurs in two countries — and "Georgia" is exactly that (a US state and a country),
  // so neither table holds it and it sailed through as a company identity.
  return !!(countryFromLocation(folded) || subdivisionCc(folded) || cityCc(folded) || usStateFromLocation(folded));
}

/**
 * Is this name distinctive enough to be a company's IDENTITY — the key a registry lookup or a news
 * match is performed on? Different question from isUsableCompanyName, which asks whether the string
 * is a name at all rather than page furniture.
 *
 * Multi-word names pass unconditionally. A single bare word passes only if it is neither an ordinary
 * English word nor a place. "Notion", "Datadog", "Kolhorn" and "Expeditors" pass; "Alliance",
 * "Block", "India" and "Perth" do not.
 */
export function isDistinctiveIdentity(name: string | null | undefined): boolean {
  const base = stripLegalSuffix(foldDiacritics(String(name ?? "")))
    .toLowerCase()
    .replace(/^(the|le|la|el|het)\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return false;
  // ONE distinctive token is enough — and it has to be there. The first version of this rule passed
  // any multi-word name, and re-grading it against every stored signal showed that was too weak:
  // "US Services" (both words ordinary), "Home Base", "Vancouver-Based" and "Compass Logistics" all
  // walked straight through and are all names that identify nobody. A name whose every component is
  // an ordinary word or a place is a description, not an identity.
  //
  // "Alliance Shippers" and "Trade Lines" pass — "shippers" and "lines" are not on the list — which
  // is the point: the moment a real, chosen word appears the name becomes usable again.
  return base.split(" ").some((w) => !COMMON_WORD.has(w) && !isPlaceName(w));
}

/** Is this string usable as a company's identity for name-keyed matching? */
export function isUsableCompanyName(name: string | null | undefined): boolean {
  // Punctuation is collapsed EVERYWHERE, not just at the ends, and that is the whole point.
  //
  // The list already contained "403 forbidden". The lookup did not reach it, because stripping only
  // the surrounding punctuation left "403 - forbidden" — a different string — and Set.has is exact.
  // Measured live across a 120-domain sample of the watchlist: EIGHT domains resolved to
  // "403 - Forbidden" and handed that to every name-keyed producer as the company's identity, which
  // is ~85 across the full 1,280. Every rendering of the same status page ("403 – Forbidden",
  // "Error: Not Found", "Access | Denied") was a fresh miss against a list that plainly intended to
  // catch it, so the list was being extended one punctuation variant at a time and could never win.
  //
  // Collapsing internal punctuation only affects SET MEMBERSHIP — this function returns a boolean and
  // never rewrites the name — so a real company keeps its exact spelling. "AT&T" folds to "at t" and
  // "E-Corp" to "e corp"; neither is in the list, so neither is affected.
  const s = (name ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (s.length < 2) return false;
  if (GENERIC_TITLE.has(s)) return false;
  return !isAllFurniture(s);
}

/**
 * Words that only ever appear in page furniture and status lines. A title made ENTIRELY of these is
 * a server talking, not a company.
 *
 * A phrase list cannot win here and two rounds of trying proved it. "403 Forbidden" was already
 * listed, and the live data still produced "403 - Forbidden"; adding separators then still missed
 * "Error: Not Found" (no status code at all) and "500 Internal Server Error" (the status word is
 * fourth, not first). Every server words these differently and every CDN re-words them again.
 *
 * Composition is the stable test: not "is this one of the phrases I thought of", but "is there a
 * single word here that belongs to a company". Nothing needs to be added when nginx invents a new
 * phrasing out of the same vocabulary.
 *
 * THE WHOLE STRING must be furniture, which is what keeps this from eating real names. One ordinary
 * word saves it, and real companies always have one: "500 Startups" (startups), "404 Media" (media),
 * "Bad Robot" (robot), "Home Depot" (depot), "Under Armour" (armour), "Check Point" (point),
 * "Welcome Break" (break). All of those survive; "Access Denied", "Error Not Found" and "Site
 * Maintenance" do not. The over-reach risk is real and named in the CDN-vendor comment below — a
 * guard against wrong names that starts producing them is worse than no guard.
 */
const FURNITURE_WORDS = new Set([
  // status lines
  "forbidden", "unauthorized", "unauthorised", "denied", "access", "unavailable", "temporarily",
  "timeout", "timed", "out", "gateway", "internal", "server", "error", "errors", "bad", "request",
  "requests", "too", "many", "service", "not", "found", "page", "missing", "blocked",
  // bot walls and interstitials
  "just", "moment", "attention", "required", "please", "wait", "redirecting", "checking", "your",
  "browser", "captcha", "verification", "security", "check", "challenge",
  // CAREERS-PAGE furniture. An ATS board's "company name" field is often the section heading rather
  // than the employer: trillium.ag's Greenhouse tenant files every posting under "Open Roles". That
  // string is not an employer, and reading it as one made verifyBoard reject a legitimate board for
  // "naming a different company". Same composition rule as the rest of this list — the WHOLE name
  // has to be furniture, so "Open Table" and "Career Group Inc" are untouched.
  "open", "roles", "role", "careers", "career", "jobs", "job", "vacancies", "vacancy",
  "opportunities", "openings", "opening", "positions", "position", "hiring", "apply", "join",
  "team", "us", "our", "all", "current", "available", "listings",
  // placeholder and furniture pages
  "home", "homepage", "welcome", "index", "main", "start", "untitled", "document", "default",
  "official", "site", "website", "new", "landing", "coming", "soon", "under", "construction",
  "maintenance", "test",
]);

/** True when every token is furniture (a 4xx/5xx status code counts as one). */
function isAllFurniture(collapsed: string): boolean {
  const tokens = collapsed.split(" ").filter(Boolean);
  // A single token is GENERIC_TITLE's job — it holds the exact one-word cases and its list is
  // deliberate. Applying the word rule to one token would reject a company called "Main" or "Start",
  // which is a judgement the phrase list should own rather than this one.
  if (tokens.length < 2) return false;
  return tokens.every((t) => FURNITURE_WORDS.has(t) || /^[45]\d\d$/.test(t));
}

/** Exported for tests: this is where the title-path stoplists are enforced, and a guard whose only
 *  caller does network I/O is a guard nothing can prove. */
export function cleanTitle(t: string, domain: string): string {
  // DECODE FIRST, before anything looks at the string. A <title> is HTML, so its separators and
  // ampersands arrive encoded, and every step below reasons about literal characters.
  //
  // Measured live across a 120-domain sample of the watchlist: five resolved to a name carrying a raw
  // entity — "Air &amp; Sea International", "Film Logic &#8211; Los Angeles…", "IGH Group &#8211; One
  // Stop Shop", "NRL &#8211; Your Freight Gate", "Magno International - Minority owned…&amp;…" —
  // roughly 50 across the full 1,280. None of them can ever match the company they belong to:
  // companyEntityMatches folds punctuation to spaces, so "Air &amp; Sea International" becomes
  // "air amp sea international" and the stray "amp" breaks the prefix against "Air & Sea
  // International Inc". Verified false before this line existed.
  //
  // Decoding also does real work for the SPLIT below: "&#8211;" becomes an en dash, which is a
  // separator this function already knows how to reason about, so "Film Logic – Los Angeles-based
  // Time Critical Logistic Solutions" now resolves to "Film Logic" instead of the whole tagline.
  let s = (decodeEntities(t) ?? t).replace(/\s+/g, " ").trim();
  // Leading furniture, which had no handler at all — TITLE_JUNK strips the word only when it follows
  // a separator, so "Cloud Monitoring | Home" was cleaned and "Home - Dolphin Logistics Inc." was
  // not. Three of the sampled 120 were that shape ("Home - Dolphin Logistics Inc.", "Home - Golden
  // Logistics Solutions LLC", "Home - CURA"), ~30 across the watchlist, and each one fails to match
  // its own company for the same reason: the name now begins with a word the company's name does not.
  //
  // A separator is REQUIRED after the word, which is what keeps "Home Depot" and "Welcome Break"
  // intact — a real name continues with a space, not with a dash.
  s = s.replace(/^(home|homepage|welcome|official site|official website)\s*[|–—·:-]\s*/i, "").trim();
  // "Welcome to <company>" — the one furniture prefix that is followed by a WORD rather than a
  // separator, so the rule above cannot see it. Found by re-running the same 120 domains after the
  // fix and finding one survivor: regalbrokers.com resolved to "Welcome to Regal Customer Broker".
  // Kept as its own narrow pattern rather than by loosening the separator requirement above, which
  // would immediately start eating "Home Depot".
  s = s.replace(/^welcome\s+to\s+(the\s+)?/i, "").trim();
  // Titles are usually "Brand | Tagline" or "Tagline | Brand" — the brand can sit on EITHER side
  // (Datadog: "Cloud Monitoring as a Service | Datadog"). Prefer the side that matches the domain
  // stem; if neither matches, take the SHORTER side (brands are short, taglines are long).
  // "::" is a separator too. avanzaloop.com is titled "Home Base | Avanza :: Expert Logistics
  // Operators", and without it the whole right-hand side stayed one part, so the shorter-side rule
  // chose "Home Base" and that became the company. ":" alone is deliberately NOT a separator — it
  // occurs inside real names and taglines ("Acme: The Company").
  const parts = s.split(/\s*(?:::|[|–—·])\s*/).map((p) => p.trim()).filter((p) => p.length >= 2);
  if (parts.length > 1) {
    const stem = domain.split(".")[0]!.replace(/[-_]/g, "").toLowerCase();
    const squash = (x: string) => x.replace(/[^a-z0-9]/gi, "").toLowerCase();
    // A LEGAL SUFFIX WINS, ahead of both other rules. A part ending in Inc / Ltd / GmbH / LLC is a
    // registered name; nothing else in a page title is. This is the fix for the single worst shape in
    // the measured data — the stem rule was actively choosing the wrong side:
    //   tliindia.com "Trade Lines Inc | India"          -> stem "tliindia" CONTAINS "india", so the
    //                                                      company became "India" and the feed filled
    //                                                      with Reuters coverage of the country
    //   alliance.com "Alliance – Alliance Shippers Inc." -> stem matched the bare word "Alliance",
    //                                                      which then matched Alliance Laundry's SEC
    //                                                      filings and LA charter-school layoffs
    // Datadog is unaffected: "Cloud Monitoring as a Service | Datadog" has no legal suffix on either
    // side, so it still falls through to the stem rule and still resolves to "Datadog".
    s = parts.find((p) => hasLegalSuffix(p))
      ?? parts.find((p) => squash(p).includes(stem) || stem.includes(squash(p)))
      ?? parts.slice().sort((a, b) => a.length - b.length)[0]!;
  }
  s = s.replace(TITLE_JUNK, "").trim();
  // Strip a dangling separator. When the split above yields at most one usable part, `s` is still the
  // RAW title — so "Home |" came through with its bar attached and was stored as the company name.
  s = s.replace(/^[\s|–—·:-]+/, "").replace(/[\s|–—·:-]+$/, "").trim();
  // Title-only rejection: page furniture anywhere, plus the CDN/bot-wall vendors, which are real
  // companies but are almost never the company whose homepage we asked for. Either way we fall
  // through to the domain stem, which is a far better guess than the wrong company's name.
  const low = s.toLowerCase().trim();
  if (!isUsableCompanyName(s) || INTERSTITIAL_VENDOR.has(low) || BUILDER_VENDOR.has(low)) return "";
  return s.length >= 2 && s.length <= 80 ? s : "";
}

// Grammatical particles that legitimately follow a company name with no space in Japanese, Chinese
// and Korean. Without these, every "楽天が…" headline is a miss; without the letter guard, "楽天" also
// matches "楽天モバイル" (a different company). Longest first so ROM/particle alternation is greedy.
// 的 is deliberately NOT here. In Chinese it is a possessive particle, but in Japanese it is a
// productive adjective suffix, so a 2-character Han name plus 的 is often just an ordinary word:
// companyNameMatches("楽天", "楽天的な予測が広がる") matched, and 楽天的 means "optimistic" — nothing
// to do with Rakuten. Per this function's own rule, a missed match is a quiet feed while a false
// match is a bogus sales signal. 和 / 與 / 与 ("and") stay: they genuinely follow a name in a list.
const CJK_PARTICLES = ["から", "まで", "では", "には", "とは", "が", "は", "を", "の", "に", "で", "と", "も", "や", "へ", "在", "和", "與", "与", "이", "가", "는", "은", "을", "를", "에", "와", "과", "의", "도"];
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HAN_KANA = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /[\p{Script=Hangul}]/u;

/**
 * Defensible company-name match against free text (news headlines, PH titles) or another entity name.
 * The name must appear as a whole word/phrase — not a bare substring of a larger word — and be long
 * enough to be distinctive. Deliberately conservative: a missed match is a quiet feed; a false match
 * is a bogus sales signal.
 *
 * Latin/Cyrillic/Greek: boundaries are string-edge / whitespace / quotes / sentence punctuation, NOT
 * hyphens — which is what kills the classic false positives ("Box" in "Dropbox", "Ramp" in "on-ramp").
 * Accents are folded on BOTH sides, so "Société Générale" matches "Societe Generale" and vice versa.
 *
 * Han/Kana/Hangul: these scripts don't use spaces, so a whitespace boundary would match nothing. The
 * boundary becomes "not a letter or digit", widened by the particle list above — 楽天が matches,
 * 楽天モバイル does not. Their length floors are lower (2 Han / 3 Hangul) because a 2-character Han
 * name is as distinctive as a 4-letter Latin one.
 */
export function companyNameMatches(company: string, text: string): boolean {
  const raw = company.trim();
  if (!raw) return false;
  // Same reason as companyEntityMatches: a page-furniture name has no distinctiveness, and this
  // matcher decides whether a news headline is ABOUT this company. "Home" would match half the press.
  if (!isUsableCompanyName(raw)) return false;
  // And the distinctiveness gate. A bare ordinary word cannot decide that a headline is ABOUT this
  // company: "India" matched Reuters on India's education minister, "Alliance" matched the Bharat 6G
  // Alliance, "Armour" matched ARMOUR Residential REIT. See COMMON_WORD for the full measurement.
  if (!isDistinctiveIdentity(raw)) return false;
  const cjk = HAN_KANA.test(raw), hangul = HANGUL.test(raw);
  const floor = cjk ? 2 : hangul ? 3 : 4;
  if ([...raw].length < floor) return false;

  if (cjk || hangul) {
    // No case folding (these scripts have no case) and no diacritic folding (it would mangle kana).
    const part = CJK_PARTICLES.map(reEsc).join("|");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${reEsc(raw)}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${reEsc(raw)}(?=${part})`, "u");
    return re.test(text);
  }
  const c = foldDiacritics(raw).toLowerCase();
  if (c.length < floor) return false;
  const folded = foldDiacritics(text);
  const m = new RegExp(`(^|[\\s"'(\\[{])(${reEsc(c)})($|[\\s"'.,;:!?)\\]}])`, "i").exec(folded.toLowerCase());
  if (!m) return false;

  // A whole-word hit is necessary but not sufficient. Measured on the 154 news signals this app had
  // actually emitted, 73 of them — 47% — were about a DIFFERENT organisation whose name merely
  // contains ours. Two shapes account for all of them, and both are decidable from the headline.
  const at = m.index + m[1]!.length;

  // (1) PREPENDED QUALIFIER. If a capitalised word runs straight into the match, the headline names
  // something else that ENDS with our brand: "Under Armour" for Armour, "DHL Global Forwarding" for
  // Global Forwarding, "Western Alliance" for Alliance, "BYD Sealion" for Sealion, "Youth Triumph"
  // for Triumph. Exactly the asymmetry companyEntityMatches relies on below — a registered name is
  // built by APPENDING qualifiers to a brand, never by prepending them — so a leading qualifier means
  // a different entity. Trailing words are left alone on purpose: "Expeditors International" and
  // "C.H. Robinson Worldwide" are the company's own fuller name and must keep matching.
  const prev = /([\p{L}\p{N}][\p{L}\p{N}'’.-]*)\s*$/u.exec(folded.slice(0, at))?.[1] ?? "";
  if (prev && /^[\p{Lu}]/u.test(prev)) return false;

  // (2) PROSE, NOT A NAME. The matched span must be capitalised the way a name is. "US services
  // activity expands in June" is ordinary prose that happens to contain the words "US Services";
  // "a new home base" is not the company Home Base; "releases free public beta" is not Beta.
  const span = folded.slice(at, at + c.length);
  const words = span.split(/\s+/).filter((w) => /[\p{L}]/u.test(w));
  if (!words.every((w) => /^[\p{Lu}\p{N}]/u.test(w))) return false;

  // KNOWN COST, accepted deliberately: in a fully title-cased headline every word is capitalised, so
  // "Freight Giant Expeditors Expands…" is refused by (1). This file states the trade twice already —
  // a missed match is a quiet feed, a false match is a bogus signal — and on the real corpus the cost
  // did not materialise: 0 of the 73 rejections was a legitimate story.
  return true;
}

/**
 * Match two ENTITY NAMES - a resolved company name against a registry's name for a legal entity
 * (an SEC filer, a Companies House title, a WARN employer). That is a different question from the
 * one companyNameMatches answers, and using it here was the bug.
 *
 * companyNameMatches asks "does this name appear as a whole word inside this text?", which is right
 * for a headline and badly wrong for an entity name: it lets a registry entry that merely ENDS with
 * the brand pass as the brand. EDGAR's full-text search returned the filer "Pantera Opportunities
 * Fund SP Stripe" for company "Stripe", the whole-word test said yes, and the feed reported a
 * Pantera fund's Form D as Stripe raising money.
 *
 * A registered name is built by APPENDING qualifiers to the brand - "Notion Labs, Inc.", "Monzo Bank
 * Limited", "Datadog Holdings" - never by prepending them. So the test is: after folding accents,
 * stripping legal suffixes and dropping a leading article, one name must be a WORD-BOUNDED PREFIX of
 * the other. "notion labs" starts with "notion" (yes); "pantera opportunities fund sp stripe" does
 * not start with "stripe" (no).
 *
 * Same bias as companyNameMatches: a missed match is a quiet feed, a false match is a bogus signal.
 */
export function companyEntityMatches(a: string, b: string): boolean {
  const norm = (x: string) => stripLegalSuffix(foldDiacritics(String(x ?? "")).toLowerCase())
    .replace(/^(the|le|la|el|het)\s+/, "")     // "The Trade Desk" vs "Trade Desk"
    .replace(/[^\p{L}\p{N}]+/gu, " ")          // punctuation carries no meaning in a legal name
    .replace(/\s+/g, " ").trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  // Defence in depth at the choke point. The resolver now refuses to hand back page furniture, but a
  // name also arrives from scraped job listings and from user-uploaded check lists, and the cost of a
  // wrong entity match here is another company's layoff notice or SEC filing filed under this one.
  // "Home" cleared the length floor below (4 characters) and matched "Home Depot U.S.A" on the
  // word-bounded prefix rule — the floor is about distinctiveness, and a common word has none.
  if (!isUsableCompanyName(a) || !isUsableCompanyName(b)) return false;
  // BOTH sides must be distinctive, and the registry side matters as much as ours. The prefix rule
  // below is what turns a bare word into a wrong answer, in both directions:
  //   ours "The Block Logistics" vs registry "Block, Inc."   -> "block logistics" starts with "block"
  //   ours "Compass"             vs registry "Compass Inc."  -> both normalise to "compass", equal
  //   ours "Alliance"            vs "Alliance (College-Ready Public Schools)"
  // Every one of those passed the length floor, because the floor measures LETTERS and the thing that
  // is missing is distinctiveness.
  if (!isDistinctiveIdentity(a) || !isDistinctiveIdentity(b)) return false;
  // Same length floor as the free-text matcher, for the same reason: 3 letters is not distinctive.
  const cjk = HAN_KANA.test(x) || HAN_KANA.test(y), hangul = HANGUL.test(x) || HANGUL.test(y);
  const floor = cjk ? 2 : hangul ? 3 : 4;
  if ([...x].length < floor || [...y].length < floor) return false;
  if (x === y) return true;
  // The prefix must end on a word boundary, so "note" never matches "notebook". CJK has no spaces,
  // so there the bare prefix IS the boundary (the same concession companyNameMatches makes).
  const pre = (long: string, short: string) =>
    long.startsWith(short) && (cjk || hangul || long[short.length] === " ");
  return pre(x, y) || pre(y, x);
}

/**
 * A domain's company identity, WITH the provenance of the name.
 *
 * `name` is always a best-effort string and is what the UI shows. `keyable` is the separate, harder
 * question: may this name be used to query a registry or decide that a headline is about this
 * company? Those are not the same question, and conflating them is what produced the misattribution
 * measured in COMMON_WORD above.
 *
 * The domain stem is the weakest source by a distance — it is not a name anybody chose, it is a URL
 * with the dots removed — and it is where the worst offenders came from: armour.ca was behind a 403
 * and triumph.ca returned "403 - Forbidden", so both fell to the stem and the app then went looking
 * for filings and layoffs belonging to "Armour" and "Triumph". 38 of 217 stored signals carry a bare
 * domain-stem identity.
 */
export interface CompanyIdentity {
  /** Best-effort display name. Never empty. */
  name: string;
  /** Where it came from, weakest last. */
  source: "jobs" | "title" | "stem";
  /** Safe to use as a registry/news matching key. */
  keyable: boolean;
}

/** The display name only. Kept as the name every existing caller already uses. */
export async function resolveCompanyName(domain: string): Promise<string> {
  return (await resolveCompanyIdentity(domain)).name;
}

export async function resolveCompanyIdentity(domain: string): Promise<CompanyIdentity> {
  const hit = cache.get(domain);
  if (hit) return hit;
  let name = "";
  let source: CompanyIdentity["source"] = "stem";
  // 1) our own jobs data — the most frequently-seen company string on this domain
  try {
    const r = db.prepare(
      "SELECT company, COUNT(*) c FROM raw_jobs WHERE domain = ? AND company IS NOT NULL AND company != '' GROUP BY company ORDER BY c DESC LIMIT 1",
    ).get(domain) as { company: string } | undefined;
    // Guarded too: a scraped listing can carry "Home" or a bot-wall string in its company field just
    // as a <title> can, and this path is trusted FIRST — so an unguarded hit here wins over
    // everything and is never reconsidered.
    if (r?.company && isUsableCompanyName(r.company)) { name = r.company; source = "jobs"; }
  } catch { /* fall through */ }
  // 2) homepage <title> (one polite fetch, 6s)
  if (!name) {
    try {
      // safeFetch, not fetch: this <title> becomes the company name shown in the UI, so a redirect
      // onto an internal host would surface a fragment of that host's page back to the user.
      const res = await safeFetch(`https://${domain}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; HyperSignal/1.0)" },
        signal: AbortSignal.timeout(6000),
      });
      const html = (await res.text()).slice(0, 20000);
      const t = /<title[^>]*>([^<]{2,200})<\/title>/i.exec(html)?.[1];
      if (t) { const c = cleanTitle(t, domain); if (c) { name = c; source = "title"; } }
    } catch { /* fall through */ }
  }
  // 3) domain stem ("acme-corp.io" → "Acme Corp")
  if (!name) {
    name = domain.split(".")[0]!.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    source = "stem";
  }
  // A stem-derived SINGLE WORD is never keyable, even when the word itself is unusual. The stem is
  // not a name anybody chose — nobody verified that "Armour" is what armour.ca calls itself, and in
  // that case it was not. A stem with two or more words ("acme-corp.io" → "Acme Corp") did survive
  // somebody's deliberate choice of domain and is treated like any other name.
  const stemSingleWord = source === "stem" && !name.includes(" ");
  const identity: CompanyIdentity = {
    name,
    source,
    keyable: !stemSingleWord && isUsableCompanyName(name) && isDistinctiveIdentity(name),
  };
  cache.set(domain, identity);
  return identity;
}
