// Find hosts that are being stored as an EMPLOYER's domain but are really a shared platform.
//
// The test is arithmetic, not a vendor list: a real employer domain carries ONE employer. A host
// carrying many DISTINCT company names is an ATS, a job board, or a public suffix that the domain
// parser failed to recognise. Either way every company under it shares one key — and `domain` is what
// every signal producer works from, so those companies inherit each other's DNS records, tech stack,
// running ads, subdomains, layoff notices and news.
//
// This exists because the last round of these was found by accident. PLATFORM_HOSTS in
// src/normalize.ts is a list written from memory, so it will always trail the market: comeet.com,
// hibob.com, dover.com, recruitingbypaycor.com, ukg.net, hirebridge.com, careerspage.io and saashr.com
// were all missing, and personio.com was listed while personio.de was not. Run this after a big fetch
// and the next gap shows up as a number instead of a surprise.
//
// Read-only. It reports; it changes nothing.
//   node scripts/detect-platform-domains.mjs
//   node scripts/detect-platform-domains.mjs --min 3
//   SIGNAL_DB=data/audit.db node scripts/detect-platform-domains.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const PATH = process.env.SIGNAL_DB ?? "data/signals.db";
const argMin = process.argv.indexOf("--min");
const MIN = argMin > -1 ? Number(process.argv[argMin + 1]) : 4;

// Read the current blocklist straight out of the source so this can never disagree with the app.
// A regex over the literal is enough: it is one flat Set of string literals.
let known = new Set();
try {
  const src = readFileSync("src/normalize.ts", "utf8");
  const block = /const PLATFORM_HOSTS = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? "";
  known = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
} catch { /* run from elsewhere — report everything */ }

const db = new DatabaseSync(PATH, { readOnly: true });
const rows = db.prepare(`
  SELECT domain, COUNT(DISTINCT company) AS companies, COUNT(*) AS jobs
  FROM raw_jobs
  WHERE domain IS NOT NULL AND domain <> '' AND company IS NOT NULL AND company <> ''
  GROUP BY domain HAVING companies >= ? ORDER BY companies DESC, jobs DESC`).all(MIN);

const flagged = rows.filter((r) => !known.has(r.domain));
console.log(`[detect] ${PATH}: ${rows.length} host(s) carry >= ${MIN} distinct companies; ${flagged.length} are NOT in PLATFORM_HOSTS.\n`);

if (!flagged.length) { console.log("[detect] nothing to add. (A conglomerate with real subsidiaries can legitimately appear above — judge by name.)"); process.exit(0); }

for (const r of flagged) {
  const names = db.prepare(
    "SELECT DISTINCT company FROM raw_jobs WHERE domain = ? AND company IS NOT NULL AND company <> '' LIMIT 4").all(r.domain)
    .map((x) => x.company).join(", ");
  console.log(`  ${String(r.companies).padStart(3)} companies · ${String(r.jobs).padStart(5)} jobs  ${r.domain}`);
  console.log(`      e.g. ${names}${r.companies > 4 ? ", …" : ""}`);
}

console.log(`\n[detect] Judge each one: unrelated companies => a platform, add it to PLATFORM_HOSTS in`);
console.log("[detect] src/normalize.ts. Related names (subsidiaries of one group, e.g. fedex.com) are fine.");
console.log("[detect] A BARE PUBLIC SUFFIX here (co.uk, com.au, us.com) is a different bug — the domain");
console.log("[detect] parser failed to recognise it; add it to MULTI_LABEL_SUFFIX instead.");
console.log("[detect] Existing rows keep their stored domain; scripts/repair-platform-domains.mjs re-derives them.");
