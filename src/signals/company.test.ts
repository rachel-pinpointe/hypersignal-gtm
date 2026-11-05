// Regression tests for companyNameMatches — the shared whole-word name matcher that guards the
// name-keyed producers (news, Product Hunt, WARN) against false-positive substring matches.
// Run: npx tsx --test src/signals/company.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { companyNameMatches, companyEntityMatches, isUsableCompanyName, cleanTitle, isDistinctiveIdentity } from "./company.ts";

test("rejects short / stem names that are too generic to match safely", () => {
  assert.equal(companyNameMatches("Box", "Dropbox launches new API"), false); // < 4 chars
  assert.equal(companyNameMatches("Co", "Costco earnings"), false);
});

test("rejects a name that is only a substring of a larger word", () => {
  assert.equal(companyNameMatches("Ramp", "Snowplow clears the on-ramp"), false); // hyphen ≠ boundary
  assert.equal(companyNameMatches("Meta", "Metabolic Labs cuts staff"), false);   // inside a word
  assert.equal(companyNameMatches("Apple", "Applebee's closes locations"), false);
});

test("matches the name as a whole word / phrase", () => {
  assert.equal(companyNameMatches("Ramp", "Ramp raises $150M Series D"), true);
  assert.equal(companyNameMatches("Ramp", "Fintech startup Ramp, valued at $8B"), true); // trailing comma
  assert.equal(companyNameMatches("Acme Corp", "Acme Corp names new CFO"), true);        // multi-word phrase
  assert.equal(companyNameMatches("Datadog", "\"Datadog\" acquires observability startup"), true); // quoted
});

test("case-insensitive", () => {
  assert.equal(companyNameMatches("stripe", "STRIPE expands to Brazil"), true);
});

// ── non-Latin + accented names (the app monitors companies worldwide, not just US/UK ones) ──

test("accents fold on both sides, so either spelling finds the other", () => {
  assert.equal(companyNameMatches("Société Générale", "Societe Generale posts record quarter"), true);
  assert.equal(companyNameMatches("Societe Generale", "Société Générale posts record quarter"), true);
  assert.equal(companyNameMatches("Malmö Energi", "Malmo Energi opens new plant"), true);
});

test("Han names match at 2 characters and respect a Japanese particle", () => {
  assert.equal(companyNameMatches("楽天", "楽天が新サービスを発表"), true);   // particle が follows
  assert.equal(companyNameMatches("楽天", "楽天、100億円を調達"), true);      // ideographic comma
});

test("a Han name does NOT match a longer company containing it", () => {
  assert.equal(companyNameMatches("楽天", "楽天モバイルが値下げ"), false);    // 楽天モバイル is a different company
});

test("Hangul names match at 3 characters with a particle", () => {
  assert.equal(companyNameMatches("카카오", "카카오가 신규 투자를 유치했다"), true);
  assert.equal(companyNameMatches("카카오", "카카오뱅크가 상장한다"), false); // 카카오뱅크 is a different company
});

test("Cyrillic names still need a real word boundary", () => {
  assert.equal(companyNameMatches("Яндекс", "Яндекс запускает новый сервис"), true);
  assert.equal(companyNameMatches("Яндекс", "ЯндексМаркет запускает"), false);
});

test("short non-Latin names below their script's floor are still rejected", () => {
  assert.equal(companyNameMatches("楽", "楽天が発表"), false);   // 1 Han char
  assert.equal(companyNameMatches("카카", "카카오가 발표"), false); // 2 Hangul chars
});

// 的 is a possessive particle in Chinese but a productive ADJECTIVE suffix in Japanese, so treating
// it as a name boundary made any 2-character Han name match an ordinary word built from it.
test("的 is not a name boundary — 楽天的 (optimistic) is not Rakuten", () => {
  assert.equal(companyNameMatches("楽天", "楽天的な予測が広がる"), false);
  assert.equal(companyNameMatches("楽天", "楽天が新サービスを発表"), true);   // real particle still matches
  assert.equal(companyNameMatches("阿里巴巴", "阿里巴巴和腾讯が提携"), true); // 和 ("and") still matches
});

// ── companyEntityMatches — name-vs-name, NOT name-vs-text ────────────────────────────────────────
// These exist because the free-text matcher was used for registry lookups, where "does the brand
// appear as a word inside this legal name?" is the wrong question. Every false case below was
// accepted by companyNameMatches; the first one shipped a real wrong signal.

test("a registry name that merely ENDS with the brand is not the brand", () => {
  // Observed live: EDGAR full-text search returned this filer for company "Stripe", and the feed
  // reported the fund's Form D as Stripe raising money.
  assert.equal(companyEntityMatches("Stripe", "Pantera Opportunities Fund SP Stripe"), false);
  assert.equal(companyEntityMatches("Notion", "Microsoft Corp - Notion Division"), false);
  assert.equal(companyEntityMatches("Ramp", "Sequoia Capital Global Growth Ramp"), false);
  // The free-text matcher USED to accept all three, which is why the two were separated. It now
  // rejects this shape too, by its own prepended-qualifier rule — a capitalised word running into
  // the match means the text names something else. Belt and braces, not a reason to merge them.
  assert.equal(companyNameMatches("Stripe", "Pantera Opportunities Fund SP Stripe"), false);
  // The two still answer DIFFERENT questions, and this is the case that shows it: a headline can be
  // about a company without the company's name being a prefix of the headline.
  assert.equal(companyNameMatches("Stripe", "payments company Stripe expands into lending"), true,
    "free text: the brand appears as a whole word, after a lowercase word — a real mention");
  assert.equal(companyEntityMatches("Stripe", "payments company Stripe expands into lending"), false,
    "entity: a legal name is built by appending to the brand, so this is not Stripe's registered name");
});

test("qualifiers APPENDED to the brand still match — that is how legal names are built", () => {
  assert.equal(companyEntityMatches("Notion", "Notion Labs, Inc."), true);
  assert.equal(companyEntityMatches("Monzo", "MONZO BANK LIMITED"), true);
  assert.equal(companyEntityMatches("Datadog", "Datadog Holdings LLC"), true);
  assert.equal(companyEntityMatches("Notion Labs", "Notion"), true);          // either direction
  assert.equal(companyEntityMatches("Trade Desk", "The Trade Desk, Inc."), true); // leading article
  assert.equal(companyEntityMatches("Zalando", "Zalando SE"), true);          // non-English suffix
});

test("a prefix must end on a word boundary", () => {
  assert.equal(companyEntityMatches("Note", "Notebook Labs"), false);
  assert.equal(companyEntityMatches("Cloud", "Cloudflare"), false);
  assert.equal(companyEntityMatches("Face", "Facebook Inc"), false);
});

test("entity matching keeps the same length floor and folds accents", () => {
  assert.equal(companyEntityMatches("Box", "Box, Inc."), false);              // 3 letters, too short
  assert.equal(companyEntityMatches("Societe Generale", "Société Générale S.A."), true);
  assert.equal(companyEntityMatches("", "Anything Ltd"), false);
});

test("CJK entity names need no space to be a prefix", () => {
  assert.equal(companyEntityMatches("楽天", "楽天株式会社"), true);   // 株式会社 is stripped as a suffix
  assert.equal(companyEntityMatches("楽天", "日本楽天"), false);      // brand is not the prefix
});

// ---- Page-furniture names ------------------------------------------------------------------------
// These come from a real failure in the audit snapshot, not a hypothetical. ELEVEN unrelated freight
// companies resolved to the company name "Home" — their homepages are titled "Home" or "Home | X" —
// and WARN then matched that against "Home Express Delivery Service, LLC" and "Home Depot U.S.A, Inc."
// on the word-bounded prefix rule, filing 25 false layoff signals per notice across 13 companies that
// were not laying anyone off. Three more resolved to "Cloudflare" off an "Attention Required! |
// Cloudflare" interstitial, because the title splitter takes the shorter side.
//
// "Home" is 4 characters, so it cleared the existing length floor. The floor is a proxy for
// distinctiveness and a common word has none — hence a stoplist, not a longer floor.
test("a page-furniture title is not a usable company name", () => {
  for (const junk of ["Home", "home", "HOME", "Home ", "Welcome", "Index", "Untitled", "coming soon",
                      "Just a moment...", "Attention Required", "Access Denied",
                      "404 Not Found", "Checking your browser"]) {
    assert.equal(isUsableCompanyName(junk), false, `"${junk}" must never become a company identity`);
  }
});

test("a real company name is still usable, including short and punctuated ones", () => {
  for (const real of ["Stripe", "Home Depot U.S.A, Inc.", "AFL Inc", "Rakuten", "3M", "Ramp",
                      "Homebase", "Homeward", "楽天"]) {
    assert.equal(isUsableCompanyName(real), true, `"${real}" is a real name and must be kept`);
  }
});

test("the WARN mis-attribution cannot happen again", () => {
  // The exact pair that produced 25 wrong signals.
  assert.equal(companyEntityMatches("Home", "Home Express Delivery Service, LLC"), false);
  assert.equal(companyEntityMatches("Home", "Home Depot U.S.A, Inc."), false);
  assert.equal(companyEntityMatches("Home |", "Home Depot U.S.A, Inc."), false);
  // And the same name must not make a headline "about" these companies.
  assert.equal(companyNameMatches("Home", "Home Depot announces 797 layoffs"), false);
  assert.equal(companyNameMatches("Cloudflare", "Cloudflare raises $100M"), true,  // the real Cloudflare still matches
    "the stoplist must not blind us to the company that actually IS named Cloudflare — it only stops "
    + "that name being INVENTED for someone else by the resolver");
  // A genuine prefix match that should still work.
  assert.equal(companyEntityMatches("Home Depot", "Home Depot U.S.A, Inc."), true);
});

test("a page-furniture title cannot verify a guessed domain either", () => {
  // domainResolver.ts:136 accepts a candidate domain when the site's own <title> matches the company
  // name — in EITHER direction, so that title "Everhope" verifies "Everhope Oncology". The reverse
  // direction is what made this dangerous: a candidate homepage titled "Home" would have verified
  // itself as the company "Home Health Services", attaching a WRONG domain — and the domain is the
  // key every signal producer works from, so one bad guess mis-targets that company entirely.
  // Guarding companyNameMatches at the choke point closed this path as well as the WARN one.
  assert.equal(companyNameMatches("Home", "Home Health Services"), false);
  assert.equal(companyNameMatches("Welcome", "Welcome Break Holdings"), false);
  assert.equal(companyNameMatches("Everhope", "Everhope Oncology"), true, "real prefix verification must still work");
});

// ── Headline matching: a whole-word hit is necessary but not sufficient ────────────────────────
//
// Measured on the 154 news signals this app had actually emitted: 73 of them — 47% — were about a
// DIFFERENT organisation whose name merely contains the watched company's. Every headline below is
// one of those real signals, or a real one that must keep working.
//
// Two shapes covered all 73, and both are decidable from the headline alone.

test("a PREPENDED capitalised word means the headline is about a different entity", () => {
  // Each of these was a live signal filed under the company on the left.
  assert.equal(companyNameMatches("Armour", "Under Armour and 424 Unveil Collaborative Capsule"), false);
  assert.equal(companyNameMatches("Global Forwarding", "DHL Global Forwarding expands Transpacific air cargo capacity"), false);
  assert.equal(companyNameMatches("Alliance", "Western Alliance Launches WA VenueX for Round-the-Clock Settlement"), false);
  assert.equal(companyNameMatches("Alliance", "Chey Tae-won Unveils $500 Billion AI Alliance"), false);
  assert.equal(companyNameMatches("Affiliated", "Center for Military Affiliated Students receives enhanced technology"), false);
  assert.equal(companyNameMatches("Counselor", "DepEd to hire 10,000 School Counselor Associates nationwide"), false);
  assert.equal(companyNameMatches("Sealion", "BYD Sealion 7 and Seal depart Chinese market"), false);
  assert.equal(companyNameMatches("Triumph", "Youth Triumph: India's Education Minister Resigns Amid Protests"), false);
});

test("APPENDED words are the company's own fuller name and must still match", () => {
  // The asymmetry is the whole point: qualifiers get appended to a brand, never prepended. Blocking
  // trailing words would silence the genuine stories below, which is a worse trade than the noise.
  assert.equal(companyNameMatches("Expeditors", "Expeditors International to lay off 230 tech workers"), true);
  assert.equal(companyNameMatches("C.H. Robinson", "C.H. Robinson Worldwide (CHRW) Nears Earnings"), true);
  assert.equal(companyNameMatches("Werner Enterprises", "Werner Enterprises (WERN) Faces A Fresh Test"), true);
  assert.equal(companyNameMatches("Wix.com", "Wix.com (WIX) Expands Elavon Partnership"), true);
});

test("the match must be capitalised like a name, not read as prose", () => {
  assert.equal(companyNameMatches("US Services", "US services activity expands in June"), false);
  assert.equal(companyNameMatches("Home Base", "Bridger Ski Foundation launches fundraiser for first permanent home base"), false);
  assert.equal(companyNameMatches("Beta", "Matari Audio releases free public beta of BUFFR"), false);
  assert.equal(companyNameMatches("Logistics Services", "Expeditors expands aircraft on ground logistics services"), false);
  // CHANGED DELIBERATELY. This used to assert `true` — the prose rule was the only thing standing
  // between "Home Base" and a match, so a properly-capitalised occurrence was accepted. Grading the
  // live rows showed what that produced: avanzaloop.com resolved to "Home Base" and its feed filled
  // with Dolly Parton's Home Base Steamboat travel centre. "Home Base" is not an identity — every
  // component is an ordinary word — so it is now refused before capitalisation is even considered.
  // (avanzaloop.com itself now resolves to "Avanza"; see the '::' separator test.)
  assert.equal(companyNameMatches("Home Base", "City launches deed-restriction program dubbed Home Base Steamboat"), false);
});

test("a mention after a lowercase word is still a mention", () => {
  // The rule keys on CAPITALISATION of the preceding word, not on there being one — otherwise every
  // mid-sentence mention would be lost.
  assert.equal(companyNameMatches("Stripe", "fintech firm Stripe raises at a $90B valuation"), true);
  assert.equal(companyNameMatches("Expeditors", "logistics group Expeditors expands AOG service"), true);
});

// ---------------------------------------------------------------------------------------------
// The title path. resolveCompanyName falls to the homepage <title> when the jobs DB has no company
// string for the domain, and whatever comes out becomes that company's identity for every
// name-keyed producer. Two families of title are not a company name, and both were found live.
// ---------------------------------------------------------------------------------------------

test("a website builder's default title is not the company's name", () => {
  // bay2main.com is a freight company whose site is built on Wix and titled "Wix". That name
  // matched the App Store seller "WIX.COM, INC." and Wix's own app was filed as evidence that a
  // freight forwarder had shipped one. Caught while repairing 135 stored app attributions.
  assert.equal(cleanTitle("Wix", "bay2main.com"), "");
  assert.equal(cleanTitle("Squarespace", "someco.com"), "");
  assert.equal(cleanTitle("GoDaddy", "someco.com"), "");
  assert.equal(cleanTitle("Shopify", "someco.com"), "");
});

test("the builder stoplist is title-only — the builders are real companies", () => {
  // Same care the CDN list takes. Rejecting these everywhere would make Wix unmatchable against
  // Wix's own funding round. The domain stem is where every one of them lands instead.
  // (Not "Wix" itself — three characters is under the matcher's distinctiveness floor, which is a
  // separate rule and would make this test pass for the wrong reason.)
  assert.equal(companyNameMatches("Shopify", "Shopify raises guidance"), true);
  assert.equal(companyEntityMatches("Squarespace", "Squarespace, Inc."), true);
  // And Wix's OWN domain loses nothing by the rejection: the title is refused, the resolver falls
  // through to the domain stem, and the stem is "Wix".
  assert.equal(cleanTitle("Wix.com | Create a Website", "wix.com"), "");
});

test("an interstitial vendor's title is not the company's name either", () => {
  // The pre-existing half of the same rule, pinned so a refactor of the shared branch can't drop it.
  assert.equal(cleanTitle("Attention Required! | Cloudflare", "someco.com"), "");
  assert.equal(cleanTitle("Just a moment...", "someco.com"), "");
  assert.equal(cleanTitle("Home", "someco.com"), "");
  assert.equal(cleanTitle("Home |", "someco.com"), "");
});

test("a real title still survives the stoplists", () => {
  assert.equal(cleanTitle("Expeditors International", "expeditors.com"), "Expeditors International");
  assert.equal(cleanTitle("Cloud Monitoring as a Service | Datadog", "datadoghq.com"), "Datadog");
});

// ── the stoplist must survive PUNCTUATION, not just wording ──────────────────────────────────────
//
// GENERIC_TITLE already contained "403 forbidden". The lookup could not reach it: only surrounding
// punctuation was stripped, so "403 - Forbidden" stayed a different string and Set.has is exact.
//
// Measured live across a 120-domain sample of the real watchlist, EIGHT domains resolved to
// "403 - Forbidden" — ~85 across the full 1,280 — and every name-keyed producer was handed that as
// the company's identity: EDGAR searched the SEC for it, WARN matched layoff notices against it, the
// news producer queried it. All 85 also share ONE name, so anything that groups by name treats them
// as a single entity. And the fallback that would have worked — the domain stem, "Ags", "Triumph" —
// never ran, because the bad title had already been accepted.
//
// This is the same failure the list was written for (eleven companies resolving to "Home", 25 false
// layoff signals per notice), arriving through a hyphen.

test("a status page is refused however its punctuation is rendered", () => {
  // One separator per case, because each was a fresh miss against a list that plainly meant to
  // catch it — extending the list one variant at a time could never have won.
  for (const s of ["403 - Forbidden", "403 – Forbidden", "403: Forbidden", "403 | Forbidden",
                   "403  Forbidden", "Access | Denied", "Error: Not Found", "Page - Not Found"]) {
    assert.equal(isUsableCompanyName(s), false, `should be refused: ${JSON.stringify(s)}`);
  }
});

test("a status line is refused by COMPOSITION, not by enumeration", () => {
  // Servers word these differently and no phrase list keeps up: two rounds of adding phrases still
  // missed "Error: Not Found" (no status code) and "500 Internal Server Error" (status word fourth).
  // The rule is now "every word here is furniture", which needs nothing added when nginx rewords.
  for (const s of ["404 Not Found", "500 Internal Server Error", "502 Bad Gateway",
                   "429 Too Many Requests", "503 Service Unavailable", "401 Unauthorized"]) {
    assert.equal(isUsableCompanyName(s), false, `should be refused: ${JSON.stringify(s)}`);
  }
});

test("one ordinary word saves a real company, which is the whole safety of the rule", () => {
  // The over-reach risk is real and named in the CDN-vendor comment: a guard against wrong names
  // that starts producing them is worse than no guard. Every one of these shares a word with a
  // status page and is a real company.
  for (const s of ["500 Startups", "500 Global", "404 Media", "Bad Robot", "Home Depot",
                   "Under Armour", "Check Point Software", "Welcome Break", "Access Group",
                   "Server Central", "Main Street Capital", "New Relic"]) {
    assert.equal(isUsableCompanyName(s), true, `real company, must survive: ${JSON.stringify(s)}`);
  }
});

test("collapsing punctuation does not reject punctuated real names", () => {
  // The change only affects SET MEMBERSHIP — the function returns a boolean and never rewrites a
  // name — so a company keeps its exact spelling either way.
  for (const s of ["AT&T", "E-Corp", "Yahoo!", "Booking.com", "H-E-B", "Ben & Jerry's", "Rolls-Royce"]) {
    assert.equal(isUsableCompanyName(s), true, `should be kept: ${JSON.stringify(s)}`);
  }
});

test("cleanTitle drops a status page all the way to nothing, so the stem wins", () => {
  // The end-to-end consequence: returning "" is what makes resolveCompanyName fall through to the
  // domain stem, which is a usable name for the RIGHT company.
  assert.equal(cleanTitle("403 - Forbidden", "isgtransport.com"), "");
  assert.equal(cleanTitle("404 Not Found", "triumph.ca"), "");
  // ...while a genuine title on the same path is untouched.
  assert.equal(cleanTitle("ISG Transport", "isgtransport.com"), "ISG Transport");
});

test("a ONE-WORD company is left to the phrase list, not the word rule", () => {
  // Why isAllFurniture bails on a single token. "Challenge", "Missing", "Gateway" and "Sentinel" are
  // all furniture words in a status line and all plausible company names on their own. The exact
  // one-word cases that really are furniture ("Home", "Welcome", "Untitled") are in GENERIC_TITLE,
  // where each is a deliberate entry someone chose — that judgement belongs to the phrase list, not
  // to a rule that infers it from a vocabulary assembled for multi-word status lines.
  for (const s of ["Challenge", "Gateway", "Sentinel", "Access", "Server"]) {
    assert.equal(isUsableCompanyName(s), true, `one word, plausible company: ${JSON.stringify(s)}`);
  }
  // ...and the one-word furniture the phrase list DOES name is still refused.
  for (const s of ["Home", "Welcome", "Untitled", "Forbidden"]) {
    assert.equal(isUsableCompanyName(s), false, `listed furniture: ${JSON.stringify(s)}`);
  }
});

// ── cleanTitle must decode HTML, and strip furniture from the FRONT as well as the back ──────────
//
// Both found by resolving a 120-domain sample of the real watchlist and checking, with
// companyEntityMatches, whether the resolved name could match the company it belongs to. Neither
// produces a WRONG match — they produce a permanent SILENT MISS, which is harder to notice: the
// producer runs, finds nothing, and reports "no filings" or "no notices" for a company it was never
// able to search for correctly.

test("a title's HTML entities are decoded, or the name can never match its company", () => {
  // Five of the sampled 120 were this shape, ~50 across the full watchlist. companyEntityMatches
  // folds punctuation to spaces, so "&amp;" becomes the token "amp" and breaks the prefix:
  // "Air &amp; Sea International" vs "Air & Sea International Inc" was verified FALSE beforehand.
  assert.equal(cleanTitle("Air &amp; Sea International", "airseaintl.net"), "Air & Sea International");
  assert.ok(companyEntityMatches(cleanTitle("Air &amp; Sea International", "airseaintl.net"),
    "Air & Sea International Inc"), "and now it matches the real entity");
  // A numeric entity is a SEPARATOR, so decoding also lets the brand/tagline split do its job:
  // "Film Logic &#8211; Los Angeles-based Time Critical…" becomes an en dash and splits.
  assert.equal(cleanTitle("Film Logic &#8211; Los Angeles-based Time Critical Logistics", "filmlogicchb.com"), "Film Logic");
  assert.equal(cleanTitle("NRL &#8211; Your Freight Gate", "nrllogistics.com"), "NRL");
});

test("LEADING page furniture is stripped, not just trailing", () => {
  // TITLE_JUNK only ever matched a separator FOLLOWED by the word, so "Cloud Monitoring | Home" was
  // handled and "Home - Dolphin Logistics Inc." was not. Three of the sampled 120, ~30 across the
  // watchlist, and each fails to match its own company because the name starts with a word the
  // company's does not: "Home - Dolphin Logistics Inc." vs "Dolphin Logistics Inc" was FALSE.
  assert.equal(cleanTitle("Home - Dolphin Logistics Inc.", "dolphin-usa.com"), "Dolphin Logistics Inc.");
  assert.equal(cleanTitle("Home - Golden Logistics Solutions LLC", "gogoldenlogistics.com"), "Golden Logistics Solutions LLC");
  assert.equal(cleanTitle("Home - CURA", "shipcura.com"), "CURA");
  // "Welcome to X" is the one furniture prefix followed by a WORD, so the separator rule cannot see
  // it. Its own narrow pattern, rather than loosening that rule — which would eat "Home Depot".
  assert.equal(cleanTitle("Welcome to Regal Customer Broker", "regalbrokers.com"), "Regal Customer Broker");
  assert.equal(cleanTitle("Welcome to the Port of Tacoma", "portoftacoma.com"), "Port of Tacoma");
  assert.ok(companyEntityMatches(cleanTitle("Home - Dolphin Logistics Inc.", "dolphin-usa.com"),
    "Dolphin Logistics Inc"), "and now it matches");
});

test("a real company whose name STARTS with a furniture word keeps it", () => {
  // The separator is required after the word, which is the whole guard: a real name continues with a
  // space, page furniture continues with a dash or a bar. Getting this wrong would turn a fix for
  // wrong names into a source of them — the trap the CDN-vendor list documents falling into once.
  assert.equal(cleanTitle("Home Depot", "homedepot.com"), "Home Depot");
  assert.equal(cleanTitle("Welcome Break Group", "welcomebreak.co.uk"), "Welcome Break Group");
  assert.equal(cleanTitle("Homepage Digital Ltd", "homepagedigital.com"), "Homepage Digital Ltd");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE DISTINCTIVENESS GATE.
//
// The measurement that forced it: every stored name-keyed signal was graded against its source, not
// sampled. 123 of 177 (69.5%) were about a DIFFERENT organisation — all 49 SEC filings, 18 of 41
// layoff notices, 56 of 87 news items. One mechanism produced all of them: the resolver returned a
// short ordinary word, and the word-bounded-prefix rule then admitted anything beginning with it.
//
// Each case below is a real row from the live database.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a bare ordinary word is not a company identity", () => {
  for (const w of ["Alliance", "Armour", "Block", "Target", "Compass", "Express", "Universal", "Beta"]) {
    assert.equal(isDistinctiveIdentity(w), false, `"${w}" must not be usable as an identity`);
  }
});

test("a bare place name is not a company identity", () => {
  // tliindia.com resolved to "India" and the feed filled with Reuters coverage of the country.
  for (const p of ["India", "Georgia", "Milan", "Perth", "Lynden"]) {
    assert.equal(isDistinctiveIdentity(p), false, `"${p}" is a place, not a company`);
  }
});

test("one distinctive word is enough — and one is required", () => {
  // These pass: "shippers", "lines", "kolhorn" and "datadog" are chosen words, not vocabulary.
  for (const n of ["Alliance Shippers Inc.", "Trade Lines Inc", "Fastfrate", "Datadog", "Expeditors", "Gateway Group"]) {
    assert.equal(isDistinctiveIdentity(n), true, `"${n}" should be usable`);
  }
  // THE PLACE RULE HAS A COST, and it lands on real companies named after places. "Kolhorn AG" is a
  // genuine employer and Kolhorn is a Dutch village, so its bare one-word name is refused. Kept
  // deliberately: the same rule is what stops "Lynden" pulling in the Lynden Police Department and
  // "Webster" pulling in Webster Financial, which is what it was doing. A second word — the company's
  // own fuller name — restores it, which is how most such companies are actually written.
  assert.equal(isDistinctiveIdentity("Kolhorn AG"), false, "a bare place-name identity is refused, real company or not");
  assert.equal(isDistinctiveIdentity("Kolhorn Produktions GmbH"), true, "…and a fuller name is usable again");
  // These do not: EVERY component is ordinary, so the whole name describes rather than identifies.
  // Being multi-word is not on its own enough — that was the first version of this rule and grading
  // it against the stored rows showed it let all four of these through.
  for (const n of ["US Services", "Home Base", "The Block Logistics", "Target Shipping", "Compass Logistics"]) {
    assert.equal(isDistinctiveIdentity(n), false, `"${n}" has no distinctive component`);
  }
});

test("the gate stops the exact registry mismatches that were live", () => {
  assert.equal(companyEntityMatches("The Block Logistics", "Block, Inc."), false);
  assert.equal(companyEntityMatches("Compass", "Compass Inc."), false);
  assert.equal(companyEntityMatches("Alliance", "Alliance (College-Ready Public Schools)"), false);
  assert.equal(companyEntityMatches("Target Shipping", "Target"), false);
  assert.equal(companyEntityMatches("Armour", "ARMOUR Residential REIT, Inc."), false);
  assert.equal(companyEntityMatches("Xpress", "Xpress Delivery LLC (DSJ9)"), false);
  // …without breaking the matches that were CORRECT.
  assert.equal(companyEntityMatches("Notion", "Notion Labs, Inc."), true);
  assert.equal(companyEntityMatches("Expeditors International", "Expeditors International of Washington"), true);
  assert.equal(companyEntityMatches("C.H. Robinson", "C. H. ROBINSON WORLDWIDE, INC."), true);
  assert.equal(companyEntityMatches("Gateway Group", "Gateway Group"), true);
});

test("a bare word cannot decide that a headline is about this company", () => {
  assert.equal(companyNameMatches("India", "India's education minister announces reform"), false);
  assert.equal(companyNameMatches("Alliance", "Bharat 6G Alliance signs MoU"), false);
  assert.equal(companyNameMatches("Pegasus", "Pegasus Airlines adds routes"), false);
  assert.equal(companyNameMatches("Sealion", "BYD Sealion 7 review"), false);
  // …and a real name still matches its own story.
  assert.equal(companyNameMatches("Expeditors International", "Expeditors International to lay off 230 tech workers"), true);
});

// ── cleanTitle: which side of the title is the company ──
test("a legal suffix identifies the company side of a page title", () => {
  // THE worst shape in the data: the stem rule was actively choosing the wrong half, because the
  // domain stem "tliindia" contains "india".
  assert.equal(cleanTitle("Trade Lines Inc | India", "tliindia.com"), "Trade Lines Inc");
  assert.equal(cleanTitle("Alliance – Alliance Shippers Inc.", "alliance.com"), "Alliance Shippers Inc.");
  // …and a title with no legal suffix on either side still resolves by the stem, as it always did.
  assert.equal(cleanTitle("Cloud Monitoring as a Service | Datadog", "datadoghq.com"), "Datadog");
});

test("'::' is a title separator", () => {
  // avanzaloop.com. Without it the right-hand side stayed one long part, the shorter-side rule chose
  // "Home Base", and Dolly Parton's Home Base Steamboat travel centre became this company's news.
  assert.equal(cleanTitle("Home Base | Avanza :: Expert Logistics Operators", "avanzaloop.com"), "Avanza");
});
