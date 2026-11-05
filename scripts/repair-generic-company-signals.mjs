// Remove signals that were filed under a PAGE-FURNITURE company name.
//
// The bug (fixed in src/signals/company.ts): resolveCompanyName accepted a homepage <title> as the
// company's identity without checking it was a name. Eleven unrelated freight companies whose sites
// are titled "Home" all became the company "Home", and the WARN producer matched that against
// "Home Express Delivery Service, LLC" and "Home Depot U.S.A, Inc." on its word-bounded prefix rule.
// Three more became "Cloudflare", off a bot-wall interstitial titled "Attention Required! | Cloudflare".
//
// The code fix stops NEW ones. It cannot un-write the rows already stored, and those rows are the
// harmful part: a salesperson filtering for "recent layoffs" sees companies that are not laying anyone
// off, and may email them about it. Hence this.
//
// DRY RUN BY DEFAULT. It prints what it would delete and changes nothing. Pass --apply to delete.
//   node scripts/repair-generic-company-signals.mjs                 # report only
//   node scripts/repair-generic-company-signals.mjs --apply         # delete
//   SIGNAL_DB=data/audit.db node scripts/repair-generic-company-signals.mjs --apply   # on a copy first
import { DatabaseSync } from "node:sqlite";

const PATH = process.env.SIGNAL_DB ?? "data/signals.db";
const APPLY = process.argv.includes("--apply");

// Mirrors GENERIC_TITLE in src/signals/company.ts, plus the interstitial vendors — deliberately
// duplicated rather than imported, because this script must run against a database without loading
// the app (db.ts migrates on import, and a repair tool should not also migrate).
const GENERIC = [
  "home", "homepage", "welcome", "index", "main", "start", "start page", "untitled",
  "untitled document", "default", "official site", "official website", "website", "new page",
  "landing page", "coming soon", "under construction", "site maintenance", "maintenance", "test page",
  "just a moment", "attention required", "please wait", "redirecting", "access denied", "forbidden",
  "403 forbidden", "404", "404 not found", "not found", "error", "security check",
  "checking your browser", "are you a robot", "captcha", "bot verification", "service unavailable",
  "site temporarily unavailable", "page not found", "blocked",
  "cloudflare", "akamai", "imperva", "incapsula", "sucuri", "fastly", "datadome", "perimeterx",
];

const db = new DatabaseSync(PATH, { readOnly: !APPLY });

// Normalize the stored name the same way isUsableCompanyName does: strip surrounding punctuation
// (the real data contains "Home |", a half-cleaned title) and collapse whitespace, then compare.
// SQLite has no regex, so the trimming is done in JS over the distinct names — a short list.
const norm = (s) => String(s ?? "").toLowerCase()
  .replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "").replace(/\s+/g, " ").trim();

const names = db.prepare("SELECT DISTINCT company FROM signals WHERE company IS NOT NULL").all()
  .map((r) => r.company).filter((c) => GENERIC.includes(norm(c)));

if (!names.length) {
  console.log(`[repair] ${PATH}: no signals filed under a page-furniture company name. Nothing to do.`);
  process.exit(0);
}

const ph = names.map(() => "?").join(",");
const rows = db.prepare(
  `SELECT company, type, COUNT(*) AS n, COUNT(DISTINCT domain) AS domains
   FROM signals WHERE company IN (${ph}) GROUP BY company, type ORDER BY n DESC`).all(...names);
const total = rows.reduce((a, r) => a + r.n, 0);
const all = db.prepare("SELECT COUNT(*) AS n FROM signals").get().n;

console.log(`[repair] ${PATH}`);
console.log(`[repair] ${total} of ${all} signals (${((total / all) * 100).toFixed(1)}%) are filed under a name that is not a company:\n`);
for (const r of rows) console.log(`  ${String(r.n).padStart(4)}  ${r.type.padEnd(18)} company="${r.company}"  across ${r.domains} domain(s)`);

if (!APPLY) {
  console.log(`\n[repair] DRY RUN — nothing was changed. Re-run with --apply to delete these ${total} rows.`);
  console.log("[repair] Recommended: run it against a copy first (SIGNAL_DB=data/audit.db ...).");
  process.exit(0);
}

// Delete only these rows. domain_state is deliberately left alone: the producers' baselines are keyed
// by (domain, producer) and are still valid — the names were wrong, the diffs were not. domain_flags
// is left alone too; the next scan overwrites each flag with a correctly-named reading.
db.exec("BEGIN");
try {
  const n = db.prepare(`DELETE FROM signals WHERE company IN (${ph})`).run(...names).changes;
  db.exec("COMMIT");
  console.log(`\n[repair] deleted ${n} signal(s). The next scan will re-derive names with the fixed resolver.`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("[repair] FAILED, rolled back:", e.message);
  process.exit(1);
}
