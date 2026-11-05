// One-shot repair: delete news signals whose headline is not about the company they were filed under.
//
// The news producer accepts a story when the company's name appears as a whole word in the headline.
// That is the right question, but on its own it is far too weak for a generic name. Measured across
// the 154 news signals this install had emitted, 73 — 47% — were about a DIFFERENT organisation:
//
//   Armour            <- "Under Armour and 424 Unveil Collaborative Capsule"
//   Global Forwarding <- "DHL Global Forwarding expands Transpacific air cargo capacity"
//   Alliance          <- "Western Alliance Launches WA VenueX"
//   Triumph           <- "Youth Triumph: India's Education Minister Resigns"
//   US Services       <- "US services activity expands in June"
//   Beta              <- "Matari Audio releases free public beta of BUFFR"
//
// companyNameMatches now rejects both shapes — a capitalised word running INTO the match (the
// headline names something else ending in our brand) and a match that is not capitalised like a name
// (ordinary prose). This removes the rows that were stored before that.
//
// The decision is made by IMPORTING the shipped matcher, never by re-implementing it here, so the
// rows deleted are exactly the rows the app would now refuse. Note that importing it pulls in db.ts,
// which opens SIGNAL_DB — that is intended: this script operates on the live database.
//
// Usage:  node scripts/repair-mismatched-news-signals.mjs [--apply]
// Without --apply it only reports.
import { db } from "../src/db.ts";
import { companyNameMatches } from "../src/signals/company.ts";

const APPLY = process.argv.includes("--apply");

const rows = db.prepare("SELECT id, domain, company, type, title FROM signals WHERE type LIKE 'news-%'").all();
const bad = rows.filter((r) => !companyNameMatches(String(r.company ?? ""), String(r.title ?? "")));
const kept = rows.filter((r) => companyNameMatches(String(r.company ?? ""), String(r.title ?? "")));

console.log(`news signals: ${rows.length}`);
console.log(`  still about their company: ${kept.length}`);
console.log(`  about someone else:        ${bad.length}\n`);
// A partition, not a one-sided filter — if these do not add up, the classification is unsound.
if (kept.length + bad.length !== rows.length) { console.error("counts do not partition — aborting"); process.exit(1); }

for (const r of bad.slice(0, 15)) console.log("  DROP", String(r.company).slice(0, 18).padEnd(18), String(r.title).slice(0, 66));
if (bad.length > 15) console.log(`   … and ${bad.length - 15} more`);
console.log("\n  KEEP (sample)");
for (const r of kept.slice(0, 6)) console.log("      ", String(r.company).slice(0, 18).padEnd(18), String(r.title).slice(0, 66));

if (!APPLY) { console.log("\nDry run. Re-run with --apply to delete."); process.exit(0); }

const before = db.prepare("SELECT COUNT(*) c FROM signals").get().c;
db.exec("BEGIN");
let n = 0;
try {
  const del = db.prepare("DELETE FROM signals WHERE id = ?");
  for (const r of bad) n += Number(del.run(r.id).changes);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

console.log(`\ndeleted ${n}`);
console.log(`signals: ${before} -> ${db.prepare("SELECT COUNT(*) c FROM signals").get().c}`);
console.log(`news remaining: ${db.prepare("SELECT COUNT(*) c FROM signals WHERE type LIKE 'news-%'").get().c}`);
console.log(`quick_check: ${db.prepare("PRAGMA quick_check").get().quick_check}`);
