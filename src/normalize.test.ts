import { test } from "node:test";
import assert from "node:assert/strict";
import { fixMojibake, extractDomain, isPlatformDomain, decodeEntities, makeJob } from "./normalize.ts";
import { countryFromLocation, countryFromDomain } from "./geo.ts";

// The repair has to be safe in BOTH directions. Failing to fix garbled text is a cosmetic bug;
// "fixing" text that was already correct is data corruption, so most of these guard that side.

/** Produce the exact bytes a feed sends when it double-encodes `s`. Generated rather than typed as a
 *  literal on purpose: real mojibake contains C1 control characters (U+0080-U+009F) which are
 *  invisible and do not reliably survive being written into a source file — a hand-typed fixture
 *  silently loses them and then tests a string that could never occur. That is exactly how the first
 *  draft of this test produced a false failure. */
const garble = (s: string) => Buffer.from(s, "utf8").toString("latin1");

const REAL_WORLD = [
  "Universia Perú",                      // combining accent
  "Universia Perú",                       // precomposed
  "شُعلة | Shu'la",   // Arabic with a diacritic — the live RemoteOK case
  "深圳市前海跨境", // Chinese
  "Café à Paris",
  "Ação Ltda",
  "日本電気株式会社",
  "Zürich GmbH",
  "\u{1D5E9}\u{1D5D4}",                        // astral plane (4-byte UTF-8)
];

test("repairs UTF-8 that was decoded as Latin-1", () => {
  for (const good of REAL_WORLD) {
    const bad = garble(good);
    assert.notEqual(bad, good, `${good} should garble into something different`);
    assert.equal(fixMojibake(bad), good, `failed to repair ${JSON.stringify(bad)}`);
  }
});

test("leaves already-correct text alone, including non-Latin scripts", () => {
  for (const s of [...REAL_WORLD, "Stripe", "", "  spaced  ", "100% remote", "C++ / C#"])
    assert.equal(fixMojibake(s), s, `must not touch ${JSON.stringify(s)}`);
});

test("leaves genuine Latin-1 text that merely looks suspicious", () => {
  // A lead byte followed by a NON-continuation byte fails the signature, and would not round-trip.
  for (const s of ["Ãü", "ÂÂÂ", "éé"])
    assert.equal(fixMojibake(s), s);
});

test("declines to convert when the bytes are not valid UTF-8", () => {
  // A lead byte promising more continuations than follow decodes to U+FFFD — refuse it rather than
  // storing a replacement character where a real name used to be.
  assert.equal(fixMojibake("ð"), "ð");
});

test("passes null and undefined straight through", () => {
  assert.equal(fixMojibake(null), null);
  assert.equal(fixMojibake(undefined), null);
});

test("is idempotent — repairing twice equals repairing once", () => {
  for (const good of REAL_WORLD) {
    const once = fixMojibake(garble(good));
    assert.equal(fixMojibake(once), once);
  }
});

// ---- Domain extraction: multi-label suffixes + platform hosts -------------------------------------
// Both of these were found by measuring the live data rather than by reading the code: a host that
// stores many DISTINCT employers cannot be an employer's own domain.
test("a multi-label public suffix is not the registrable domain", () => {
  // Taking the last two labels turned every one of these into a suffix shared by every company under
  // it. `domain` is the key every signal producer works from, so those companies inherited each
  // other's DNS, tech stack, ads, subdomains, layoff notices and news. "us.com" was the stored domain
  // for 29 unrelated companies (267 jobs) in the live data.
  assert.equal(extractDomain("https://acme.co.uk/careers"), "acme.co.uk");
  assert.equal(extractDomain("https://jobs.acme.co.uk/x"), "acme.co.uk");
  assert.equal(extractDomain("https://foo.us.com/jobs"), "foo.us.com");
  assert.equal(extractDomain("https://acme.com.au/careers"), "acme.com.au");
  assert.equal(extractDomain("https://acme.co.jp/saiyo"), "acme.co.jp");
  assert.equal(extractDomain("https://acme.com.br/vagas"), "acme.com.br");
  // Ordinary two-label domains are untouched.
  assert.equal(extractDomain("https://careers.stripe.com/x"), "stripe.com");
  assert.equal(extractDomain("https://stripe.com"), "stripe.com");
});

test("ATS and platform hosts never become an employer domain", () => {
  // Each of these was the stored `domain` for a crowd of unrelated companies before it was listed.
  for (const host of ["comeet.com", "hibob.com", "dover.com", "recruitingbypaycor.com", "ukg.net",
                      "hirebridge.com", "careerspage.io", "saashr.com", "silkroad.com",
                      "successfactors.eu", "paychex.com", "careerpuck.com", "personio.de"]) {
    assert.equal(extractDomain(`https://${host}/jobs/acme/123`), null, `${host} is a platform, not an employer`);
    assert.equal(extractDomain(`https://sub.${host}/jobs`), null, `${host} subdomains too`);
  }
  // A real employer is still extracted.
  assert.equal(extractDomain("https://boards.acmecorp.com/jobs/1"), "acmecorp.com");
});

// ── platform-host recognition (the fourth pass) ───────────────────────────────────────────────────
//
// These 16 vendors were invisible to the "many distinct employers per stored domain" detector: their
// rows were stored under a DIFFERENT platform (us.com, silkroad.com, comeet.com…), so each held only
// one or two employers and sat under the threshold. Clearing the outer platform moved 1,167 rows onto
// them — the re-derive would have relabelled a vendor as a vendor and looked like a successful
// cleanup. Each host below was confirmed employer-by-employer on a copy of the live data.
test("extractDomain rejects the second-layer ATS vendors", () => {
  const cases: Array<[string, string[]]> = [
    ["entertimeonline.com", ["Trilliant Food & Nutrition", "LR Paris", "Jasper Group"]],
    ["join.com", ["refive", "Enterprise Bot", "FAE Beauty"]],
    ["cloud.sap", ["W. L. Gore & Associates", "Bechtel", "RESRG Automotive"]],
    ["pageuppeople.com", ["Leighton Asia", "CIMIC Group", "Thiess"]],
    ["ttcportals.com", ["Syneos Health", "Meltwater", "Ness Digital Engineering"]],
    ["brightmove.com", ["Congruex", "Energy Spray Systems", "AutoAlert"]],
    ["careerplug.com", ["Integrated Aqua Systems", "RealCraft", "Pacific Soda"]],
    ["deel.com", ["CellPoint Digital", "ComplianceQuest", "Skylink"]],
    ["appone.com", ["Sandy Alexander", "Food Sales East"]],
    ["comparably.com", ["Verifone", "Contentstack"]],
    ["fountain.com", ["Curefoods", "ACT Fibernet"]],
    ["jobsoid.com", ["EDGE Tutor International", "Buoyancy Consultants"]],
    ["phenompro.com", ["Phenom", "Quest Global"]],
    ["selectminds.com", ["Virtusa", "Petrofac"]],
    ["wizehire.com", ["StrategicSource", "HOODZ of the Lowcountry"]],
    ["hrsmart.com", []],
  ];
  for (const [host, sharedBy] of cases) {
    const why = sharedBy.length ? ` (shared by ${sharedBy.join(", ")})` : "";
    assert.equal(extractDomain(`https://${host}/jobs/1`), null, `${host} is a platform${why}`);
    assert.equal(extractDomain(`https://secure3.${host}/ta/1.careers`), null, `${host} subdomains too`);
  }
});

test("isPlatformDomain still trusts real employers that share a domain with subsidiaries", () => {
  // fedex.com carries FedEx Freight / Supply Chain / Trade Networks, lynden.com carries Alaska Marine
  // Lines. They look like a platform to a distinct-employer count and are the opposite of one: the
  // subsidiaries genuinely share the parent's DNS, tech stack and news, so the shared signals are
  // correct. A rule that cannot tell these apart from an ATS would delete 2,300 correct rows.
  for (const d of ["fedex.com", "lynden.com", "glovisusa.com", "worldpac.com", "odysseylogistics.com",
                   "evansdelivery.com", "landstar.com", "ups.com", "expeditors.com"])
    assert.equal(isPlatformDomain(d), false, `${d} is a real employer`);
  // …while the vendors and the bare public suffixes are still caught.
  for (const d of ["comeet.com", "silkroad.com", "entertimeonline.com", "cloud.sap", "us.com", "co.uk", "com.sg"])
    assert.equal(isPlatformDomain(d), true, `${d} cannot belong to one company`);
});

// ── PLATFORM_HOSTS fifth pass: vendors the employer-count detector cannot see ──────────────────
//
// The many-employers-per-host detector needs several distinct employers on one domain. A vendor that
// only ONE of your companies uses looks exactly like that company's own website, at any threshold.
// hireclick.com exposed it: 596 Nexstar Media Group postings filed under it, one employer, invisible.
//
// The second test is the one that matters most. An over-eager blocklist is worse than a missing
// entry: blocking an employer's own careers domain throws away a correct attribution to fix a problem
// it does not have.
test("a recruiting vendor used by a single employer is still a platform, not their website", () => {
  for (const host of ["hireclick.com", "talentlyft.com", "prismhr-hire.com", "workforceready.eu",
                      "gohire.io", "applicantpool.com", "atsondemand.com", "careers-page.com", "rippling-ats.com"])
    assert.equal(extractDomain(`https://acme.${host}/jobs/1`), null,
      `${host} is a shared ATS — attributing it to the employer aims every signal check at the vendor`);
});

test("an employer's OWN careers domain is never blocked", () => {
  // These matched the same name heuristic that found the vendors above and were rejected by hand.
  // If a future pass adds one of them, this fails.
  for (const [host, expected] of [
    ["mann-hummel-careers.com", "mann-hummel-careers.com"],
    ["flix.careers", "flix.careers"],
    ["intasaccordcareers.com", "intasaccordcareers.com"],
  ] as const) assert.equal(extractDomain(`https://www.${host}/openings`), expected,
    `${host} is the employer's own careers site — blocking it discards a correct domain`);
});

// ---------------------------------------------------------------------------------------------
// HTML entities in plain-text fields.
//
// Several feeds hand back HTML-escaped text in fields that are not HTML. Measured live against
// RemoteOK while sweeping: the title "BUSINESS &amp; SUPPORT" and the employer "NHS Ayrshire &amp;
// Arran" were stored, displayed and exported exactly like that.
//
// On the COMPANY field this is not cosmetic. That string is the identity every name-keyed producer
// matches on, so "NHS Ayrshire &amp; Arran" can never match the real "NHS Ayrshire & Arran" in a
// WARN notice, an SEC filing, a news headline or an App Store listing — the company just silently
// produces no signals.
// ---------------------------------------------------------------------------------------------

test("HTML entities are decoded out of title, company and location", () => {
  const j = makeJob({
    source: "remoteok", externalId: "1", title: "BUSINESS &amp; SUPPORT",
    company: "NHS Ayrshire &amp; Arran", location: "Glasgow &amp; Clyde", url: "https://x.test/1",
  });
  assert.equal(j.title, "BUSINESS & SUPPORT");
  assert.equal(j.company, "NHS Ayrshire & Arran");
  assert.equal(j.location, "Glasgow & Clyde");
});

test("named, decimal and hex entities all decode", () => {
  assert.equal(decodeEntities("R&amp;D &lt;Lead&gt;"), "R&D <Lead>");
  assert.equal(decodeEntities("Caf&eacute; Nero"), "Café Nero");
  assert.equal(decodeEntities("Tom &amp; Jerry&#39;s"), "Tom & Jerry's");
  assert.equal(decodeEntities("&#8217;Round Midnight"), "\u2019Round Midnight");
  assert.equal(decodeEntities("&#x1F600; ok"), "\u{1F600} ok");
});

test("text with no entity is returned untouched", () => {
  // The fast path: the overwhelming majority of titles contain no "&" at all.
  assert.equal(decodeEntities("Senior Engineer"), "Senior Engineer");
  assert.equal(decodeEntities("R&D"), "R&D", "a bare ampersand is not an entity");
  assert.equal(decodeEntities(null), null);
  assert.equal(decodeEntities(""), "");
});

test("an unknown or malformed entity stays literal rather than becoming junk", () => {
  // Guessing here would corrupt real text. A surrogate or out-of-range code point must not become
  // U+FFFD, and an entity we do not know must survive as written.
  // Short enough to match the entity pattern and reach the lookup — "&notanentity;" is 11 chars and
  // fails the regex first, so it would prove nothing about what happens on a lookup miss.
  assert.equal(decodeEntities("&frasl; &amp;"), "&frasl; &");
  assert.equal(decodeEntities("&notanentity; &amp;"), "&notanentity; &");
  assert.equal(decodeEntities("&#0;"), "&#0;");
  assert.equal(decodeEntities("&#xD800;"), "&#xD800;", "a lone surrogate is not a scalar value");
  assert.equal(decodeEntities("&#x110000;"), "&#x110000;", "past the last code point");
});

// A feed that HTML-escapes an already-escaped field leaves "&amp;amp;", and one decoding pass turns
// that into "&amp;" — still not the employer's name. It matters more than it looks: `company` is the
// identity every name-keyed producer matches on, so a company carrying a literal "&amp;" silently
// produces no signals at all. The module's own docblock names this exact employer.
test("double-encoded entities decode all the way", () => {
  assert.equal(decodeEntities("NHS Ayrshire &amp;amp; Arran"), "NHS Ayrshire & Arran");
  assert.equal(decodeEntities("Compass Logistics &amp;amp;amp; Marine"), "Compass Logistics & Marine");
  // …and text that merely LOOKS doubled is not over-decoded.
  assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeEntities("100&percnt;"), "100&percnt;", "an unknown entity still stays literal");
});

// These maps are indexed with untrusted scraped text. As plain object literals they inherited
// Object.prototype, so a location segment equal to a prototype key returned a FUNCTION where an ISO
// country code was expected — and that value went on to be written to the job's country column.
test("a prototype key is not a country", () => {
  for (const s of ["constructor", "__proto__", "valueOf", "toString", "hasOwnProperty"]) {
    const cc = countryFromLocation(s);
    assert.ok(cc === null || typeof cc === "string", `countryFromLocation(${s}) returned a ${typeof cc}`);
  }
  assert.equal(countryFromDomain("acme.constructor"), null);
});
