// One-shot repair: drop the Meta ad readings that are the Ad Library's result CEILING, not a count.
//
// facebook.com/ads/library stops counting at 50,000 and renders "~50,000 results" for anything above
// it. The producer read that header as a measurement, so 43 domains hold `active = 50000` — among
// them a2a-logistics.com, aacb.com and americanbearlogistics.com, none of which is running fifty
// thousand adverts. Each was flagged "running ads" on the Companies view with "50000 active Meta
// ads" beside it. What the ceiling actually means is the opposite: the keyword search matched so
// much of the library that nothing in it is evidence about this company.
//
// parseAdReading now returns `count: null` at the ceiling, which the producer already treats as
// unmeasurable — no flag, no state write, no ads-started/ads-stopped transition. This clears what
// the old reading left behind so the Companies view stops asserting it.
//
// What gets removed, and why that is the whole row: the reading is what the row IS. `active`,
// `status`, `confirm` and `established` were all derived from the capped number, and `_checked`
// would keep the 12-hour cache serving it. A partial delete would leave a confirm counter that had
// counted nonsense. The next scan re-measures from scratch and, at the ceiling, records nothing —
// which is the correct state for a company this method cannot measure.
//
// Domains BELOW the ceiling are untouched, including the large ones: 29,000 active ads is a
// plausible reading for a real advertiser and this script has no basis to second-guess it.
//
// Usage:  node scripts/repair-capped-ad-readings.mjs [--apply]
import { DatabaseSync } from "node:sqlite";

const APPLY = process.argv.includes("--apply");
const CAP = 50000;
const d = new DatabaseSync(process.env.SIGNAL_DB ?? "data/signals.db", { readOnly: !APPLY });

const domains = d.prepare(
  "SELECT domain, value FROM domain_state WHERE producer = 'ads' AND key = 'active' AND CAST(value AS INTEGER) >= ?",
).all(CAP);
console.log(`ad readings at or above the ${CAP.toLocaleString("en-US")} ceiling: ${domains.length}`);
for (const r of domains.slice(0, 20)) console.log("   clear ", String(r.domain).padEnd(32), `active=${r.value}`);
if (domains.length > 20) console.log(`   … and ${domains.length - 20} more`);
if (!domains.length) { console.log("\nNothing to clear."); process.exit(0); }

const names = domains.map((r) => String(r.domain));
const ph = names.map(() => "?").join(",");
const nState = d.prepare(`SELECT COUNT(*) c FROM domain_state WHERE producer = 'ads' AND domain IN (${ph})`).get(...names).c;
const nFlags = d.prepare(`SELECT COUNT(*) c FROM domain_flags WHERE producer = 'ads' AND domain IN (${ph})`).get(...names).c;
console.log(`\nwould remove: ${nState} state row(s), ${nFlags} ads flag(s)`);

// A capped reading can also have been the "on" side of a transition that fired. Report any, so the
// number is stated rather than discovered later — none exist on this data, and if that changes the
// next person sees it here instead of trusting a silent zero.
const sigs = d.prepare(
  `SELECT COUNT(*) c FROM signals WHERE type IN ('ads-started','ads-stopped') AND domain IN (${ph})`,
).get(...names).c;
console.log(`ads transition signals emitted for these domains: ${sigs}${sigs ? " — REVIEW THESE, they rest on a capped reading" : ""}`);

if (!APPLY) { console.log("\nDry run. Re-run with --apply."); process.exit(0); }

const flagsBefore = d.prepare("SELECT SUM(hit) h FROM domain_flags WHERE producer = 'ads'").get().h;
d.exec("BEGIN");
try {
  d.prepare(`DELETE FROM domain_state WHERE producer = 'ads' AND domain IN (${ph})`).run(...names);
  d.prepare(`DELETE FROM domain_flags WHERE producer = 'ads' AND domain IN (${ph})`).run(...names);
  d.exec("COMMIT");
} catch (e) { d.exec("ROLLBACK"); throw e; }

console.log(`\nremoved ${nState} state row(s) and ${nFlags} flag(s) across ${names.length} domain(s)`);
console.log(`ads flags reading "running ads": ${flagsBefore} -> ${d.prepare("SELECT SUM(hit) h FROM domain_flags WHERE producer = 'ads'").get().h}`);
console.log(`readings still at the ceiling: ${d.prepare("SELECT COUNT(*) c FROM domain_state WHERE producer = 'ads' AND key = 'active' AND CAST(value AS INTEGER) >= ?").get(CAP).c}`);
console.log(`quick_check: ${d.prepare("PRAGMA quick_check").get().quick_check}`);
