// Buggie test launcher — boots the app on an ISOLATED seeded test DB (never the real signals.db).
// Run via: npx tsx start-test.mjs   (env can't be set in launch.json, so we set it here in JS first).
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { rmSync } from "node:fs";

process.chdir(dirname(fileURLToPath(import.meta.url)));
process.env.SIGNAL_DB = "data/test-buggie.db";
process.env.CLIENTS_DIR = "clients-buggie-none";      // nonexistent → no real YAML seeding
process.env.PORT = "4055";
// Remove the WAL/SHM sidecars too — an orphaned -wal from a prior run would replay stale rows into
// (or corrupt) the freshly-seeded DB when the new connection opens in WAL mode.
for (const f of ["data/test-buggie.db", "data/test-buggie.db-wal", "data/test-buggie.db-shm"]) {
  try { rmSync(f, { force: true }); } catch {}
}

// Schema runs on import. Then seed synthetic data so all three views render with content.
const db = await import("./src/db.ts");
const { makeJob } = await import("./src/normalize.ts");

// --- two clients: a keyword search + a domain watchlist ---
const searchCfg = {
  name: "acme-roles", active: true, kind: "search",
  search: { keywords: ["engineer", "designer"], exclude: [], excludeCompanies: [], sourceMode: "corporate",
    locations: [], workplaceTypes: [], commitmentTypes: [], seniorityLevels: [], departments: [],
    datePostedDays: 0, searchDepth: "deep", sortBy: "default" },
  delivery: { webhook_url: "", mode: "realtime" },
};
const watchCfg = {
  name: "target-accounts", active: true, kind: "watchlist",
  search: { keywords: ["engineer"], exclude: [], orgDomains: ["stripe.com", "notion.so"],
    datePostedDays: 0, searchDepth: "deep" },
  refreshCron: "0 */6 * * *", signals: ["velocity"], delivery: { webhook_url: "", mode: "realtime" },
};
db.dbUpsertClientConfig(searchCfg.name, JSON.stringify(searchCfg));
db.dbUpsertClientConfig(watchCfg.name, JSON.stringify(watchCfg));

// --- synthetic jobs ---
const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86400e3).toISOString();
const mk = (o) => makeJob(o);
const jobs = [
  // hiringcafe (search) matches "engineer"
  mk({ source: "hiringcafe", externalId: "hc1", title: "Senior Software Engineer", company: "Globex", location: "Austin, TX, United States", url: "https://jobs.globex.com/eng-1", domain: "globex.com", postedAt: iso(1), status: "open", raw: { seniority: "Senior Level", employees: 320, industry: "Software", description: "About the role\n\nWe're hiring a Senior Software Engineer to design, build, and ship core platform services. You'll own features end-to-end, mentor mid-level engineers, and shape our technical direction.\n\nRequirements\n- 5+ years building production backend systems\n- Strong TypeScript/Node.js and SQL\n- Experience with distributed systems and observability" } }),
  mk({ source: "hiringcafe", externalId: "hc2", title: "Frontend Engineer", company: "Initech", location: "Remote", url: "https://boards.greenhouse.io/initech/jobs/2", postedAt: iso(3), remote: true, status: "open", raw: { seniority: "Mid Level", requirements_summary: "3+ years building React applications; strong TypeScript and CSS; experience with component design systems and web performance.", role_activities: ["Build and maintain UI components", "Optimize page performance", "Collaborate closely with design and product"], yoe: 3, degrees: "Bachelor's degree in Computer Science", tools: ["React", "TypeScript", "Webpack", "Figma"], certifications: [], languages: ["English"], benefits: ["401(k) matching", "Generous PTO", "Tuition reimbursement"], comp_min: 110000, comp_max: 150000, currency: "USD" } }),
  mk({ source: "hiringcafe", externalId: "hc3", title: "Product Designer", company: "Globex", location: "Austin, TX, United States", url: "https://jobs.globex.com/design-1", domain: "globex.com", postedAt: iso(5), status: "open", raw: {} }),
  mk({ source: "hiringcafe", externalId: "hc4", title: "Staff Engineer", company: "Initech", location: "New York, NY, United States", url: "https://boards.greenhouse.io/initech/jobs/4", postedAt: iso(40), status: "closed", raw: {} }),
  // hcorg (watchlist) — domain-scoped, match "engineer"
  mk({ source: "hcorg", externalId: "org1", title: "Backend Engineer", company: "Stripe", location: "San Francisco, CA, United States", url: "https://stripe.com/jobs/be-1", domain: "stripe.com", postedAt: iso(2), status: "open", raw: { seniority: "Senior Level", employees: 8000 } }),
  mk({ source: "hcorg", externalId: "org2", title: "Infrastructure Engineer", company: "Notion", location: "Remote", url: "https://notion.so/careers/infra-1", domain: "notion.so", postedAt: iso(6), remote: true, status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "org3", title: "Marketing Lead", company: "Notion", location: "Remote", url: "https://notion.so/careers/mktg-1", domain: "notion.so", postedAt: iso(4), remote: true, status: "open", raw: {} }), // should NOT match (no "engineer")
  // --- velocity-signal fixtures (target-accounts has signals:["velocity"]) ---
  // notion.so: 1 old job (>60d) + 4 recent → posting SPIKE (4 ≥ 3×1, min 3) + first SALES hire (recent AE, older non-sales history exists)
  mk({ source: "hcorg", externalId: "vel-old1", title: "Operations Manager", company: "Notion", location: "New York, NY, United States", url: "https://notion.so/careers/ops-1", domain: "notion.so", postedAt: iso(75), status: "closed", raw: {} }),
  mk({ source: "hcorg", externalId: "vel-n1", title: "Account Executive", company: "Notion", location: "Austin, TX, United States", url: "https://notion.so/careers/ae-1", domain: "notion.so", postedAt: iso(3), status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "vel-n2", title: "Platform Engineer", company: "Notion", location: "Remote", url: "https://notion.so/careers/pe-1", domain: "notion.so", postedAt: iso(5), remote: true, status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "vel-n3", title: "Data Engineer", company: "Notion", location: "Remote", url: "https://notion.so/careers/de-1", domain: "notion.so", postedAt: iso(8), remote: true, status: "open", raw: {} }),
  // stripe.com: the same title three times → chronic REPOST
  mk({ source: "hcorg", externalId: "rep-1", title: "Backend Engineer", company: "Stripe", location: "Seattle, WA, United States", url: "https://stripe.com/jobs/be-2", domain: "stripe.com", postedAt: iso(20), status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "rep-2", title: "Backend Engineer", company: "Stripe", location: "Chicago, IL, United States", url: "https://stripe.com/jobs/be-3", domain: "stripe.com", postedAt: iso(35), status: "closed", raw: {} }),
  // --- geo fixtures: only the two US CONTROLS may produce a US state ---
  mk({ source: "hcorg", externalId: "geo-de1", title: "Backend Engineer", company: "Globex", location: "Berlin, Germany", url: "https://jobs.globex.com/de-1", domain: "globex.com", postedAt: iso(2), status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "geo-de2", title: "Backend Engineer", company: "Globex", location: "Berlin, DE", url: "https://jobs.globex.com/de-2", domain: "globex.com", postedAt: iso(3), status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "geo-in1", title: "Backend Engineer", company: "Globex", location: "Mumbai, IN", url: "https://jobs.globex.com/in-1", domain: "globex.com", postedAt: iso(4), status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "geo-gb1", title: "Backend Engineer", company: "Globex", location: "London, United Kingdom", url: "https://jobs.globex.com/gb-1", domain: "globex.com", postedAt: iso(5), status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "geo-us1", title: "Backend Engineer", company: "Globex", location: "Wilmington, DE", url: "https://jobs.globex.com/us-1", domain: "globex.com", postedAt: iso(6), status: "open", raw: {} }),
  mk({ source: "hcorg", externalId: "geo-us2", title: "Backend Engineer", company: "Globex", location: "Indianapolis, IN", url: "https://jobs.globex.com/us-2", domain: "globex.com", postedAt: iso(7), status: "open", raw: {} }),
];
for (const j of jobs) db.upsertJob(j);

// --- one finished account-check with hits ---
const acId = "buggie-ac-1";
db.dbCreateAccountSearch(acId, "Q3 targets — support", { mode: "domain", domains: ["stripe.com", "notion.so"], search: { keywords: ["engineer"] }, maxPages: 8, scrapeDescriptions: false }, 2);
db.dbAccountProgress(acId, { checked: 2, found: 2, newHits: [
  { input_company: "stripe.com", matched_company: "Stripe", title: "Backend Engineer", location: "San Francisco, CA", state: "CA", remote: false, posted_at: iso(2), status: "open", url: "https://stripe.com/jobs/be-1", source: "hcorg", ats: null, industry: null, seniority: "Senior Level", reason: "corporate · org" },
  { input_company: "notion.so", matched_company: "Notion", title: "Infrastructure Engineer", location: "Remote", state: null, remote: true, posted_at: iso(6), status: "open", url: "https://notion.so/careers/infra-1", source: "hcorg", ats: null, industry: null, seniority: null, reason: "corporate · org" },
]});
db.dbFinishAccountSearch(acId, "done");

// --- signal fixtures: cross-source COLLAPSE cases (one event reported by several sources) ---
// globex funding: 4 sources inside the 21-day window → ONE row led by the Form D (rank 100).
// The 120-day-old news item must stay its own row. The two tech-added must never merge.
// notion layoffs: WARN (25d) + news (2d) = 23-day gap, inside the 30-day window → one row, WARN leads.
const sig = (dedupKey, domain, company, type, title, url, daysAgo) =>
  db.dbInsertSignal({ dedupKey, domain, company, type, title, url, client: "target-accounts", observedAt: ymd(daysAgo) });
const ymd = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
sig("fx-formd", "globex.com", "Globex", "funding-form-d", "Form D — raised capital", "https://www.sec.gov/example-formd", 10);
sig("fx-news", "globex.com", "Globex", "news-funding", "Globex raises $20M Series B", "https://example.com/globex-series-b", 8);
sig("fx-gdelt", "globex.com", "Globex", "gdelt-funding", "Globex lève 20M€ (Les Echos)", "https://example.fr/globex", 3);
sig("fx-ch", "globex.com", "Globex", "ch-share-allotment", "Share allotment (SH01) filed", "https://find-and-update.company-information.service.gov.uk/example", 12);
sig("fx-old", "globex.com", "Globex", "news-funding", "Globex raised its seed round", "https://example.com/globex-seed", 120);
sig("lx-warn", "notion.so", "Notion", "warn-layoff", "WARN notice — layoff: Notion (CA)", "https://example.gov/warn", 25);
sig("lx-news", "notion.so", "Notion", "news-layoffs", "Notion cuts 40 roles", "https://example.com/notion-cuts", 2);
sig("tx-1", "notion.so", "Notion", "tech-added", "Segment detected on the site", null, 5);
sig("tx-2", "notion.so", "Notion", "tech-added", "Amplitude detected on the site", null, 4);

console.log("[start-test] seeded test DB → data/test-buggie.db");
await import("./src/index.ts"); // boots schedules + dashboard on PORT 4055 against the test DB

// Merge the cached webappanalyzer list so the isolated test dictionary matches the real DB (~29k) —
// instant + offline (reads data/webappanalyzer.json, no network). index.ts seeds the TheirStack CSV in a
// deferred setTimeout, so poll until that base seed lands, THEN merge (else the empty-check would skip the CSV).
(async () => {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync("data/webappanalyzer.json")) { console.warn("[start-test] no webappanalyzer cache — run: npm run cache:webappanalyzer"); return; }
    for (let i = 0; i < 100 && db.dbTechCount() < 20000; i++) await new Promise((r) => setTimeout(r, 100)); // wait for CSV base seed
    const { importTechnologies } = await import("./src/techSeed.ts");
    const { backfillTech } = await import("./src/techDetect.ts");
    const rows = JSON.parse(readFileSync("data/webappanalyzer.json", "utf8"));
    const before = db.dbTechCount();
    importTechnologies(rows, "merge"); // dedup by lowercased name — overlaps with TheirStack collapse
    backfillTech();                    // re-tag the seeded jobs against the expanded dictionary
    console.log(`[start-test] merged webappanalyzer cache → dictionary ${before} → ${db.dbTechCount()}`);
  } catch (e) { console.warn("[start-test] webappanalyzer merge skipped:", e.message); }
})();
