// Remove "Chronic repost" signals emitted by the old, inverted rule.
//
// The old rule counted rows sharing a job title — any city, any date — so a company opening seven
// driver seats across four cities in one day was reported as "Reposted 7×: CDL-A Driver — likely
// struggling to fill". That is expansion described as failure, and it was 876 of 1,255 feed rows.
//
// The producer is fixed (src/signals/velocity.ts) and its dedup key now includes the location, so a
// correct signal can be emitted for a role the old key already claimed. But the old rows stay in the
// feed until removed, and they are the harmful part: a salesperson filtering for "struggling to fill"
// gets a list of companies that are hiring healthily.
//
// Safe to delete wholesale: velocity-repost has no baseline gate ("valid regardless of history"), so
// the next scan re-emits a correct signal for every role that genuinely qualifies. Nothing is lost
// that the next scan cannot rebuild.
//
// DRY RUN BY DEFAULT (opens the database read-only). Pass --apply to delete.
//   node scripts/repair-false-reposts.mjs
//   SIGNAL_DB=data/audit.db node scripts/repair-false-reposts.mjs --apply   # on a copy first
import { DatabaseSync } from "node:sqlite";

const PATH = process.env.SIGNAL_DB ?? "data/signals.db";
const APPLY = process.argv.includes("--apply");
const db = new DatabaseSync(PATH, { readOnly: !APPLY });

// The old title format is `Reposted N×: "role" — likely struggling to fill`; the new one is
// `Reposted N× over D days: "role" (location) — …`. Matching on the ABSENCE of " over " keeps this
// from deleting correct signals if it is ever run twice, or run after a good scan.
const OLD = "type = 'velocity-repost' AND title NOT LIKE 'Reposted %× over %'";

const total = db.prepare("SELECT COUNT(*) AS n FROM signals").get().n;
const stale = db.prepare(`SELECT COUNT(*) AS n FROM signals WHERE ${OLD}`).get().n;
const kept = db.prepare("SELECT COUNT(*) AS n FROM signals WHERE type = 'velocity-repost' AND title LIKE 'Reposted %× over %'").get().n;

console.log(`[repair] ${PATH}`);
console.log(`[repair] ${stale} of ${total} signals (${((stale / Math.max(1, total)) * 100).toFixed(1)}%) came from the old inverted repost rule.`);
if (kept) console.log(`[repair] ${kept} already-correct repost signal(s) will be left alone.`);

if (!stale) { console.log("[repair] nothing to do."); process.exit(0); }

console.log("\n[repair] a sample of what would go:");
for (const r of db.prepare(`SELECT domain, title FROM signals WHERE ${OLD} ORDER BY id DESC LIMIT 5`).all()) {
  console.log(`   ${String(r.domain).padEnd(24)} ${String(r.title).slice(0, 88)}`);
}

if (!APPLY) {
  console.log(`\n[repair] DRY RUN — nothing changed. Re-run with --apply to delete these ${stale} rows.`);
  console.log("[repair] The next scan re-emits a correct signal for every role that genuinely qualifies.");
  process.exit(0);
}

db.exec("BEGIN");
try {
  const n = db.prepare(`DELETE FROM signals WHERE ${OLD}`).run().changes;
  db.exec("COMMIT");
  console.log(`\n[repair] deleted ${n} signal(s).`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("[repair] FAILED, rolled back:", e.message);
  process.exit(1);
}
