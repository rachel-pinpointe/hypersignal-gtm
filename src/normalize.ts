import { createHash } from "node:crypto";
import { countryFromLocation, usStateFromLocation, placeFromLocation, isListOfAlternatives, CC_TLDS,
         cityCountryFromLocation, foldDiacritics, US_STATES } from "./geo.ts";
import { isSubdivisionCodeOf, countryCodeByName } from "./subdivisionCodes.ts";
import type { RawJob } from "./types.ts";

export function jobId(source: string, externalId: string): string {
  return createHash("sha1").update(`${source}:${externalId}`).digest("hex");
}


/** Best-effort 2-letter US state from a free-text location — US ONLY.
 *  A location we are confident is outside the US returns null instead of a state, because the raw
 *  2-letter scan below cannot tell "Wilmington, DE" (Delaware) from "Berlin, DE" (Germany), and used
 *  to file Berlin under Delaware and Mumbai under Indiana. countryFromLocation only answers when it
 *  is sure, so every location that used to yield a state still yields the same one. */
export function deriveState(location: string | null): string | null {
  if (!location) return null;
  // countryFromLocation already returns null for a multi-region string that carries an independent
  // US state, so a surviving non-US answer here means the location really is foreign.
  const cc = countryFromLocation(location);
  if (cc && cc !== "US") return null;
  // A shortlist of alternatives has no single state either, and usStateFromLocation scans for the
  // FIRST state token it can find — so "Alabama or Alaska or Arizona or Arkansas or …", which is a
  // job open in any US state, came back as Alabama. 154 rows in the live table are that shape. The
  // country rule in deriveCountry says the same thing one level up; this is the state half of it.
  if (isListOfAlternatives(location)) return null;
  const st = usStateFromLocation(location);
  if (!st) return null;
  // CORROBORATION, not assertion. "Chennai, TN" was stored as Tennessee; so were "Sao Paulo, MA"
  // (Maranhao), "Perth, WA" (Western Australia) and "Tbilisi, Georgia". countryFromLocation stays
  // silent on all of them because it is not certain, the 2-letter scan then finds a US-looking token,
  // and deriveCountry short-circuits to "US" — throwing away a correct answer it had already
  // computed. That shape is the standard output of Workable, Recruitee and Personio, which compose
  // the location from separate city/region/country fields where the country is often blank.
  //
  // The obvious repair — "if the city says a non-US country, drop the state" — was implemented and
  // MEASURED and is worse than the bug: "Berlin, NH" became Germany and "Paris, TX" became France,
  // because the city tier only knows one Berlin and one Paris. Trading a wrong foreign answer for a
  // wrong American one is not a fix.
  //
  // So the city's country has to be CORROBORATED by the region code beside it:
  //   Chennai + TN -> TN is Tamil Nadu in IN, and the city says IN     -> not Tennessee
  //   Berlin  + NH -> NH is not a German subdivision, whatever the city says -> New Hampshire stands
  // src/subdivisionCodes.ts is generated for exactly this question. "Tbilisi, Georgia" works the same
  // way through the country-name half of that table, which keeps the ambiguous names places.ts drops.
  const byCity = cityCountryFromLocation(location);
  if (byCity && byCity !== "US"
      && (isSubdivisionCodeOf(st, byCity)
          || countryCodeByName(foldDiacritics(stateNameIn(location, st))) === byCity)) return null;
  return st;
}

/** The words in `location` that produced this state abbreviation, if it was matched by full NAME
 *  rather than by its two-letter code. "" when the code was what matched. Used only to ask whether
 *  that name is also a country ("Georgia"). */
function stateNameIn(location: string, abbr: string): string {
  const low = location.toLowerCase();
  for (const [name, a] of Object.entries(US_STATES)) {
    if (a === abbr && new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(low)) return name;
  }
  return "";
}

/** Country for a location: what geo is sure of, else "US" when a US state survived deriveState
 *  (a state only survives when the location is not confidently foreign), else null = unknown. */
/** `state` lets a caller supply a US state the source already gave structurally, which the free-text
 *  location may not repeat. The country backfill applied that rule ("a US state implies US") but the
 *  live insert path did not, so 375 rows ended up with a state and a NULL country — dropped by a
 *  Country=US filter while the State facet still showed them in NY/CA/TX. Same rule on both paths. */
export function deriveCountry(location: string | null, state?: string | null): string | null {
  // Order is load-bearing. An explicit country wins; then a US state, because dozens of US place
  // names are also foreign region names (birmingham, paris, rome, milan, vienna and dublin are all
  // in the subdivision table); only then a subdivision, which is what finally gives a country to
  // "Windsor, Ontario" and "Bangalore, Karnataka". Subdivisions come LAST and can only fill a
  // blank — they never override an answer either stronger rule already gave.
  const named = countryFromLocation(location);
  if (named) return named;
  // A shortlist of alternatives has no country, and the US fallback must not answer for one either.
  // "Beijing or Hanoi or Mumbai or Shanghai or Shenzhen or Singapore" mentions no US place at all,
  // yet strings of this shape were resolving to US because deriveState found "Texas" or "Arizona"
  // somewhere in a sibling alternative. A structurally-supplied `state` still counts — that comes
  // from the source's own field, not from scanning prose.
  if (!state && location && isListOfAlternatives(location)) return null;
  return ((state || deriveState(location)) ? "US" : null) ?? placeFromLocation(location);
}

export function looksRemote(...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => f && /\bremote\b|work from home|wfh|anywhere/i.test(f));
}

// Job-board / ATS / aggregator hosts whose URL is NOT the company's own site. For these we
// can't read a company domain from the URL (only a name). Everything else: the URL host IS
// the employer's domain (true for Greenhouse "absolute_url" → stripe.com, RefereeAI, etc.).
const PLATFORM_HOSTS = new Set([
  // our own sources / aggregators
  "hiring.cafe", "simplyhired.com", "themuse.com", "craigslist.org", "weworkremotely.com",
  "remoteok.com", "remoteok.io", "jobicy.com", "arbeitnow.com", "remotive.com", "himalayas.app",
  "ycombinator.com", "indeed.com", "ziprecruiter.com", "glassdoor.com", "linkedin.com", "refereeai.us",
  "monster.com", "dice.com", "builtin.com", "wellfound.com", "angel.co", "google.com",
  // ATS / recruiting platforms (URL host is the ATS, not the employer)
  "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "recruitee.com", "personio.com",
  "myworkdayjobs.com", "workday.com", "icims.com", "smartrecruiters.com", "jobvite.com",
  "bamboohr.com", "breezy.hr", "applytojob.com", "jazzhr.com", "taleo.net", "brassring.com",
  "successfactors.com", "oraclecloud.com", "paylocity.com", "paycomonline.net", "ultipro.com",
  "dayforcehcm.com", "adp.com", "eightfold.ai", "teamtailor.com", "rippling.com", "gusto.com",
  "paycor.com", "jobscore.com", "avature.net", "phenompeople.com", "hiringthing.com",
  "clearcompany.com", "trakstar.com", "pinpointhq.com", "ripplingats.com", "rec.co",
  "gem.com", "ashby.hq", "myworkdaysite.com", "wd1.myworkdayjobs.com", "oraclecloud.com",
  "censuswide.com", "applicantpro.com", "paycomonline.com", "isolvedhire.com", "hrmdirect.com",
  "zohorecruit.com", "zohorecruit.in", "zohorecruit.ca", "zohorecruit.eu", "zohorecruit.com.au", "zoho.com",
  "freshteam.com", "csod.com", "ukgpro.com", "ukg.com", "recruiterbox.com", "hireology.com", "jobylon.com",
  "keka.com", "kekahire.com", "darwinbox.com", "darwinbox.in", "zwayam.com", "peoplehum.com", "sapsf.com",
  "factorialhr.com", "jobdiva.com", "bullhorn.com", "crelate.com", "manatal.com", "workforcenow.com",
  "applytojobs.com", "snaphunt.com", "turbohire.co", "skillate.com", "ceipal.com", "jobvite.com",
  "jibeapply.com", "jobs.jibe.com", "myworkday.com", "successfactors.com", "brassring.com", "kenexa.com",
  // Found by MEASUREMENT, not by listing vendors from memory: any host storing many DISTINCT
  // employers is an ATS, because a real employer domain carries one employer. Each of these was the
  // stored `domain` for a crowd of unrelated companies in the live data (count in brackets), which
  // means every one of those companies was sharing this vendor's DNS, tech stack, ads and news as if
  // they were its own. scripts/detect-platform-domains.mjs is that measurement, kept runnable so the
  // next vendor is caught rather than discovered by luck.
  "comeet.com" /* 30 */, "dover.com" /* 21 */, "hibob.com" /* 18 */,
  "recruitingbypaycor.com" /* 13 */, "ukg.net" /* 13 */, "hirebridge.com" /* 11 */,
  "betterteam.com" /* 6 */, "salesforce-sites.com" /* 6 */, "careerspage.io" /* 5 */,
  "saashr.com" /* 5 */,
  // TLD variants of vendors already listed above — the list was host-exact, so personio.com was
  // caught while personio.de was not, and ukg.com while ukg.net was not.
  "personio.de", "comeet.co", "workable.co", "teamtailor.co",
  // Second pass — these four came from the detector's FIRST run, after the ten above were added.
  // Writing the list by hand had missed them; measuring found them in one command.
  "silkroad.com" /* 5 */, "successfactors.eu" /* 5, .com was listed */,
  "paychex.com" /* 4 */, "careerpuck.com" /* 4 */,
  // Third pass — found only because a trial run of the backfill relabelled 1,111 FedEx postings as
  // "paradox.ai". Their apply URLs are on fedex.paradox.ai; Paradox is a recruiting-AI vendor, not
  // an employer. Tenstreet is a trucking-industry ATS. Both were invisible to the "many distinct
  // companies per host" detector because these rows already carried the CORRECT employer domain —
  // the vendor only appears in the URL. Two different lenses, two different gaps.
  "paradox.ai", "tenstreet.com",
  // Fourth pass — a WHOLE LAYER the detector structurally could not see, found by dry-firing the
  // pending domain re-derive against a copy of production and reading which domains GAINED rows.
  //
  // The detector counts distinct employers per stored domain. These vendors were hiding one level
  // down: their rows were stored under a different platform (us.com, silkroad.com, comeet.com…), so
  // each of these hosts held only one or two employers and sat under the threshold. Clearing the
  // outer platform is what moved 1,167 rows onto them — the re-derive was not fixing those rows, it
  // was relabelling them from one vendor to another, and the result would have looked like a
  // successful cleanup. Confirmed employer-by-employer on the trial copy: entertimeonline.com holds
  // Trilliant Food, LR Paris, Jasper Group and Selective Site Consultants; join.com holds refive,
  // Enterprise Bot, FAE Beauty and Parkview Invest; cloud.sap holds W. L. Gore, Bechtel and RESRG.
  // The lesson for next time: run the detector AFTER the backfill, not before.
  "entertimeonline.com", "join.com", "brightmove.com", "careerplug.com", "cloud.sap",
  "deel.com", "pageuppeople.com", "ttcportals.com", "appone.com", "comparably.com",
  "fountain.com", "jobsoid.com", "phenompro.com", "selectminds.com", "wizehire.com", "hrsmart.com",
  //
  // FIFTH PASS, and it closes a BLIND SPOT in the detector rather than adding more of the same.
  //
  // The many-employers-per-host count cannot see a vendor that only one of YOUR companies happens to
  // use: with a single employer against it, a shared ATS looks exactly like an employer's own site.
  // hireclick.com is the case that exposed it — 596 Nexstar Media Group postings filed under it, one
  // employer, invisible at any threshold. Found instead by name: a stored employer domain whose HOST
  // is named after recruiting (recruit/hire/career/talent/apply/workforce/applicant/ats/payroll),
  // then confirmed vendor-by-vendor. Both tests are needed — neither finds the other's cases.
  "hireclick.com", "talentlyft.com", "prismhr-hire.com", "workforceready.eu", "gohire.io",
  "applicantpool.com", "atsondemand.com", "careers-page.com", "rippling-ats.com",
  // Matched the same name heuristic and are deliberately NOT platforms: mann-hummel-careers.com,
  // flix.careers and intasaccordcareers.com are the EMPLOYER'S OWN careers domain. Blocking those
  // would throw away a correct employer attribution to fix a problem they do not have. Also left out:
  // careerswith-us.com and gnahiring.com, which read as generic but could not be confirmed either way
  // on one employer and four jobs — an unconfirmed guess here costs a real domain.
  // Deliberately NOT added, though they also carry several company names: fedex.com (10),
  // lynden.com (7), fnsusa.com, landstar.com, evansdelivery.com, glovisusa.com, odysseylogistics.com,
  // worldpac.com, egetrans.com, cbxglobal.com, dunavant.com and bbe.ca carry genuine SUBSIDIARIES or
  // spelling variants of ONE group (FedEx Freight, Alaska Marine Lines, "WORLDPAC"/"Worldpac"). Those
  // share a parent's domain in real life, so the shared signals are correct.
]);
// Multi-label public suffixes. Taking the last two labels is wrong for every one of these: it turns
// "acme.co.uk" into "co.uk" and "acme.us.com" into "us.com", so every company under that suffix
// collapses onto ONE key. Since `domain` is the key every signal producer works from, those companies
// then share each other's DNS records, tech stack, ads, subdomains, layoff notices and news.
//
// Measured in the live data: "us.com" was the stored domain for 29 unrelated companies (267 jobs).
// "com.sg" and "co.uk" were there too, with fewer rows only because this dataset is mostly US .com —
// the bug is not rare, the dataset is skewed. A UK-heavy watchlist would have collapsed wholesale.
//
// Most of the list is DERIVED from geo.ts's CC_TLDS (any entry containing a dot) so the two cannot
// drift apart; the rest are commercial third-level registries and public second-levels that are not
// part of a country's ccTLD structure and so are not in CC_TLDS. This is not the full Public Suffix
// List — that is a 15k-entry file needing periodic refresh — but it covers the suffixes a company
// domain realistically uses, and being wrong now costs a merged identity.
const MULTI_LABEL_SUFFIX = new Set<string>([
  ...Object.values(CC_TLDS).flat().filter((t) => t.includes(".")),
  // Commercial third-level registries (they sell "yourname.us.com").
  "us.com", "eu.com", "uk.com", "cn.com", "de.com", "gb.com", "ru.com", "sa.com", "za.com",
  "br.com", "no.com", "se.com", "kr.com", "gr.com", "hu.com", "jpn.com", "qc.com", "uy.com", "ae.org",
  // Public second-levels beyond the one ccTLD entry each country contributes above.
  "org.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk", "me.uk", "ltd.uk", "plc.uk",
  "org.au", "net.au", "edu.au", "gov.au", "asn.au", "id.au",
  "org.nz", "net.nz", "govt.nz", "ac.nz",
  "org.in", "net.in", "ac.in", "gen.in", "ind.in", "firm.in",
  "org.br", "net.br", "gov.br", "edu.br",
  "or.jp", "ne.jp", "ac.jp", "go.jp", "ad.jp",
  "or.kr", "ne.kr", "re.kr", "pe.kr", "go.kr", "ac.kr",
  "org.za", "net.za", "web.za", "gov.za", "ac.za",
  "org.sg", "net.sg", "edu.sg", "gov.sg",
  "org.hk", "net.hk", "edu.hk", "gov.hk", "idv.hk",
  "org.tw", "net.tw", "idv.tw", "gov.tw",
  "org.mx", "net.mx", "gob.mx", "edu.mx",
  "org.tr", "net.tr", "gov.tr", "edu.tr", "gen.tr", "web.tr",
  "org.il", "net.il", "ac.il", "gov.il",
  "org.cn", "net.cn", "gov.cn", "edu.cn", "ac.cn",
  "com.pl", "org.pl", "net.pl", "com.ua", "com.ru", "com.pk", "com.np", "com.pt", "com.es",
]);

/** Registrable domain of a hostname, honouring multi-label public suffixes. */
export function registrable(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  // "acme.co.uk" → acme.co.uk (3 labels), not co.uk. "shop.acme.co.uk" → acme.co.uk too.
  if (MULTI_LABEL_SUFFIX.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}
/** The employer's domain from a job URL, or null for aggregator/ATS-hosted URLs. */
export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const reg = registrable(host);
    if (PLATFORM_HOSTS.has(reg) || PLATFORM_HOSTS.has(host)) return null;
    return reg;
  } catch { return null; }
}

/** Is a STORED domain provably not an employer's own domain? True only for a shared platform host or
 *  a bare public suffix — i.e. values that cannot belong to one company no matter where they came
 *  from. Used by the backfill to correct wrong rows WITHOUT touching rows it merely can't re-derive. */
export function isPlatformDomain(domain: string | null | undefined): boolean {
  const d = (domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!d || !d.includes(".")) return false;
  if (PLATFORM_HOSTS.has(d) || PLATFORM_HOSTS.has(registrable(d))) return true;
  return MULTI_LABEL_SUFFIX.has(d);   // the whole stored value IS a suffix: "us.com", "co.uk", "com.sg"
}

// Common non-org leading subdomains. Stripped so an uploaded careers/host URL still resolves to the
// company's registrable domain — which is how hiring.cafe keys its /org/<domain> pages.
const STRIP_SUBDOMAINS = new Set([
  "www", "jobs", "job", "careers", "career", "apply", "applications", "work", "working",
  "join", "boards", "board", "go", "get", "hire", "hiring", "talent", "recruiting", "recruit", "people", "app",
]);
/** Reduce any URL/host input to hiring.cafe's org key: the registrable host, lowercased, with the
 *  scheme, path/query, port, and common non-org leading subdomains (www, jobs, careers, …) stripped.
 *  Never reduces below 2 labels, so country-code TLDs survive (`careers.acme.co.uk` → `acme.co.uk`,
 *  but `go.com` stays `go.com`). hiring.cafe keys orgs by the full registrable domain incl. TLD. */
export function normalizeOrgDomain(input: string | null | undefined): string {
  let s = (input ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "").replace(/^\/+/, "");      // strip scheme + leading slashes
  s = s.split(/[/?#]/)[0]!.replace(/:\d+$/, "").trim();       // host only — drop path/query/fragment/port
  const parts = s.split(".").filter(Boolean);
  while (parts.length > 2 && STRIP_SUBDOMAINS.has(parts[0]!)) parts.shift();
  return parts.join(".");
}

/**
 * Is a NORMALIZED value actually shaped like a domain?
 *
 * normalizeOrgDomain reduces input to an org key; it deliberately does not validate. Fed junk it
 * returns junk that is still truthy, so a `.filter(Boolean)` gate lets it through: "https://" and
 * "?a=b" normalize to "", but "www." becomes "www", ".com" becomes "com", and "a" stays "a" — none of
 * which is a domain, and all of which were accepted as one by the bulk Signal Check and Account Check
 * entry points. Whatever came back then got stored under that key in domain_flags, domain_state,
 * signals and slow_queue, and it is indistinguishable there from a real answer about a real company.
 *
 * The single-domain route (/api/companies/domain) already had this exact regex inline. Having the
 * strict check on the one-at-a-time path and no check at all on the thousand-at-a-time path is
 * backwards, so it lives here now and every entry point uses it.
 *
 * Deliberately shape-only: it says "this could be a domain", never "this company exists". A caller
 * that wants proof fetches it.
 */
const DOMAIN_SHAPE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
export function isDomainShaped(normalized: string | null | undefined): boolean {
  return DOMAIN_SHAPE.test(String(normalized ?? ""));
}

/** Build a normalized RawJob, filling id/state/remote consistently. */
/** Mojibake signature: a lead byte from the UTF-8 range immediately followed by a continuation byte,
 *  both sitting in the page as separate Latin-1 characters. */
const MOJIBAKE = /[Â-ô][-¿]/;

/**
 * Repair text that arrived as UTF-8 bytes reinterpreted as Latin-1 — "Universia Perú" delivered as
 * "Universia PerÃº", "شُعلة" as "Ø´ÙØ¹ÙØ©".
 *
 * This is NOT our decode bug: Response.text() is always UTF-8 per spec. RemoteOK's public API serves
 * the double-encoded bytes itself (verified live: 5 of 100 current items), and 19% of everything we
 * had ingested from it was garbled in company/title/location. Any feed can do this, so the repair
 * lives here, at the one point every source funnels through, rather than in one adapter.
 *
 * Deliberately conservative — mis-"fixing" good text is worse than leaving bad text alone:
 *   • the string must match the mojibake byte-pair signature;
 *   • the Latin-1 round-trip must produce no U+FFFD, i.e. the bytes really were valid UTF-8;
 *   • re-encoding the result must reproduce the input exactly, so the transform is provably lossless.
 * Genuine Latin-1 text like "Café" fails the first two tests and is returned untouched.
 */
// The handful of HTML entities that actually turn up in job feeds, plus numeric ones. Not a full
// entity table on purpose: this runs on a title, a company and a location, not on a document, and
// the long tail of named entities does not appear in those fields.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…",
  reg: "®", copy: "©", trade: "™", deg: "°", eacute: "é", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß",
};

/**
 * Decode HTML entities in a plain-text field.
 *
 * Several feeds hand back HTML-escaped text in fields that are not HTML. Measured live on the remote
 * boards: RemoteOK returns the title "BUSINESS &amp; SUPPORT" and the employer "NHS Ayrshire &amp;
 * Arran", and both were stored and displayed exactly like that.
 *
 * It matters most on the COMPANY field, which is not just cosmetic there — it is the identity every
 * name-keyed producer matches on. "NHS Ayrshire &amp; Arran" can never match the real "NHS Ayrshire
 * & Arran" in a WARN notice, an SEC filing, a news headline or an App Store listing, so the company
 * silently produces no signals at all.
 *
 * Runs BEFORE fixMojibake, because a numeric entity can encode a byte that mojibake repair would
 * then misread.
 */
export function decodeEntities(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  if (!s.includes("&")) return s;                       // the overwhelmingly common case, untouched
  // Repeat until it stops changing. Feeds that HTML-escape an already-escaped field are common (the
  // WWR description path runs an escaped body through a HTML parser, and RemoteOK does the same), so
  // one pass turned "NHS Ayrshire &amp;amp; Arran" into "NHS Ayrshire &amp; Arran" — still not the
  // employer's name, and per the note above, a company whose name carries a literal "&amp;" produces
  // no signals at all. Capped at 4 rounds: a fixed point is reached in one or two, and the cap means
  // no crafted input can spin here.
  let out = s;
  for (let i = 0; i < 4; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}
function decodeOnce(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,9});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Reject anything that is not a sane scalar value; a bad numeric entity stays literal rather
      // than becoming U+FFFD or throwing.
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      try { return String.fromCodePoint(cp); } catch { return whole; }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole; // an entity we do not know stays as written
  });
}

export function fixMojibake(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  if (!MOJIBAKE.test(s)) return s;
  const decoded = Buffer.from(s, "latin1").toString("utf8");
  if (decoded.includes("�")) return s;
  if (Buffer.from(decoded, "utf8").toString("latin1") !== s) return s;
  return decoded;
}

/**
 * Force a posting date into UTC ISO ("2026-07-29T14:03:00.000Z"), or null if it is not a date at all.
 *
 * Every date comparison in this app is a plain SQLite string compare against `datetime('now', ?)` —
 * there is no index on posted_at and no parsing on either side. That only works if every stored value
 * has the SAME shape and the SAME timezone, so this is the one place that guarantees it. Two real
 * failures came from not doing it:
 *
 *   • WeWorkRemotely's RSS pubDate is RFC-2822 ("Fri, 05 Dec 2025 10:37:40 +0000"). It begins with a
 *     letter, and letters sort after digits, so all 282 rows compared as newer than every timestamp
 *     the app could produce. They showed up in "posted in the last 7 days" forever and the 3am
 *     retention purge could never delete a single one of them.
 *   • Greenhouse and Ashby send local offsets ("2026-02-10T13:27:12-05:00"). Compared as text against
 *     a UTC cutoff, a row is judged by its wall-clock reading rather than its actual instant.
 *
 * Rejecting an unparseable value rather than storing it is deliberate: a null means "date unknown",
 * which every caller already handles, whereas a junk string silently poisons ordering and retention.
 */
export function toIsoInstant(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Bare "YYYY-MM-DD" has no time. Date.parse reads it as UTC midnight, which is what we want, but
  // keep it verbatim — inventing a time on a date-only value would be a false precision.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s.replace(" UTC", "Z"));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function makeJob(input: {
  source: string; externalId: string; title: string;
  company?: string | null; location?: string | null;
  url: string; postedAt?: string | null; remote?: boolean;
  domain?: string | null; dedupKey?: string | null; expiresAt?: string | null; status?: "open" | "closed"; raw?: unknown;
}): RawJob {
  // Entities first, then mojibake repair: a numeric entity can encode a byte that the mojibake
  // heuristic would otherwise misread as a latin1/utf8 mix-up.
  const location = fixMojibake(decodeEntities(input.location ?? null));
  // Canonical identity of the posting: the source's own collapse key (same role across ATS boards) if
  // given, else the apply URL (same posting via different sources/scans), else the source-scoped id.
  const dedupKey = ((input.dedupKey && input.dedupKey.trim())
    || (input.url && input.url.trim())
    || `${input.source}:${input.externalId}`).toLowerCase();
  return {
    id: jobId(input.source, input.externalId),
    source: input.source,
    externalId: input.externalId,
    title: fixMojibake(decodeEntities((input.title ?? "").trim())) ?? "",
    company: fixMojibake(decodeEntities(input.company?.trim() || null)),
    location,
    state: deriveState(location),
    country: deriveCountry(location), // no structured state on this input — deriveCountry derives it

    remote: input.remote ?? looksRemote(location, input.title),
    url: input.url,
    postedAt: toIsoInstant(input.postedAt),
    domain: input.domain !== undefined ? input.domain : extractDomain(input.url),
    dedupKey,
    expiresAt: input.expiresAt ?? null,
    status: input.status,
    raw: input.raw ?? null,
  };
}
