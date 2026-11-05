// Seed the states that a production snapshot cannot show you.
//
// Two gaps in real data. First, run-scoped surfaces (account checks, signal checks) hold whatever the
// user happened to run — often nothing, and never a *failed* or *mid-flight* one on demand. Second,
// real rows are well-behaved: they don't contain a 200-character title or a null company, so
// truncation, wrapping and overflow defects stay invisible until a customer hits them.
//
// So: one check per lifecycle state, and TORTURE ROWS inside them. These are deliberately hostile —
// if a table can survive these it can survive anything the sources will produce.
//
// Written through the same db.* writers start-test.mjs uses, so the rows are schema-truthful rather
// than hand-built SQL that drifts from what the app actually stores.
// Writes ONLY to data/audit.db.
process.env.SIGNAL_DB = "data/audit.db";
process.env.CLIENTS_DIR = "clients-audit";

const db = await import("../src/db.ts");
const iso = (d) => new Date(Date.now() - d * 864e5).toISOString();

const LONG_CO = "Nordwestdeutsche Verkehrsbetriebe und Logistiksysteme Aktiengesellschaft für Personenbeförderung mbH & Co. KG";      // 113 chars
const LONG_TITLE = "Senior Staff Software Engineer, Distributed Systems and Platform Reliability (Remote — EMEA), Payments Infrastructure Group, Level 6";  // 131
const LONG_URL = "https://careers.example.com/en-gb/job/" + "segment/".repeat(40) + "apply";                                          // 400+

/** The rows that break layouts: overlong text, empty text, nulls, huge numbers, absurd dates. */
const torture = () => [
  { input_company: "long.example", matched_company: LONG_CO, title: LONG_TITLE, location: "Bremerhaven, Niedersachsen, Germany",
    state: null, remote: false, posted_at: iso(1), status: "open", url: LONG_URL, source: "hcorg", ats: null,
    industry: null, seniority: "Senior Level", reason: "corporate · org" },
  { input_company: "empty.example", matched_company: "", title: "", location: null,
    state: null, remote: false, posted_at: null, status: "open", url: "https://empty.example/j/1", source: "hcorg", ats: null,
    industry: null, seniority: null, reason: "" },
  { input_company: "future.example", matched_company: "Tomorrow Inc", title: "Engineer (starts next year)", location: "Remote",
    state: null, remote: true, posted_at: iso(-90), status: "open", url: "https://future.example/j/1", source: "hcorg", ats: null,
    industry: null, seniority: null, reason: "corporate · org" },
  { input_company: "ancient.example", matched_company: "三菱重工業株式会社", title: "ソフトウェアエンジニア", location: "東京都, Japan",
    state: null, remote: false, posted_at: iso(1100), status: "closed", url: "https://ancient.example/j/1", source: "hcorg", ats: null,
    industry: null, seniority: null, reason: "corporate · org" },
];

/** Enough rows to push the 15-per-page grid well past its first page. */
const bulk = (n) => Array.from({ length: n }, (_, i) => ({
  input_company: `co${i}.example`, matched_company: `Company ${i}`, title: `Software Engineer ${i}`,
  location: i % 3 ? "Remote" : "Austin, TX, United States", state: i % 3 ? null : "TX", remote: i % 3 === 1,
  posted_at: iso(i % 60), status: i % 7 ? "open" : "closed", url: `https://co${i}.example/jobs/${i}`,
  source: "hcorg", ats: null, industry: null, seniority: null, reason: "corporate · org",
}));

const params = (domains) => ({ mode: "domain", domains, search: { keywords: ["engineer"] }, maxPages: 8, scrapeDescriptions: false });
const ac = (id, name, hits, finish, total = Math.max(hits.length, 1)) => {
  db.dbCreateAccountSearch(id, name, params(hits.map((h) => h.input_company)), total);
  if (hits.length) db.dbAccountProgress(id, { checked: hits.length, found: hits.length, newHits: hits });
  if (finish) db.dbFinishAccountSearch(id, finish);
  console.log(`account check  ${name.padEnd(34)} ${hits.length} hit(s)  → ${finish ?? "RUNNING"}`);
};

ac("audit-ac-big",     "Audit — 64 hits (paginates)",   bulk(60).concat(torture()), "done");
ac("audit-ac-zero",    "Audit — zero hits",             [],                          "done", 25);
ac("audit-ac-failed",  "Audit — failed mid-run",        bulk(3),                     "error");
ac("audit-ac-running", "Audit — still running",         bulk(2),                     null, 40);
ac("audit-ac-one",     "Audit — single hit",            bulk(1),                     "done");

console.log("\nfixtures seeded into data/audit.db");
