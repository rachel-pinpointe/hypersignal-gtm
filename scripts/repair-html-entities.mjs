// One-shot repair: decode HTML entities left in stored job titles, companies and locations.
//
// Some feeds hand back HTML-escaped text in fields that are not HTML. makeJob now decodes on the way
// in; this fixes what was written before that.
//
// The company field is the one that matters. It is not just displayed — it is the identity every
// name-keyed producer matches on, so "NHS Ayrshire &amp; Arran" can never match the real "NHS
// Ayrshire & Arran" in a WARN notice, an SEC filing, a news headline or an App Store listing. That
// company silently produces no signals at all, and nothing anywhere says why.
//
// Only rows that actually CHANGE are written, and only these three columns. state/country are left
// alone: they are derived from `location`, and an entity in a location has never been the thing
// that decided a country (the affected rows are "Glasgow & Clyde" shaped, not "Cote &#39;Ivoire").
// If that ever stops being true the fix is a country re-derive, which is a separate, bigger call.
//
// Usage:  node scripts/repair-html-entities.mjs [--apply]
import { db } from "../src/db.ts";
import { decodeEntities } from "../src/normalize.ts";

const APPLY = process.argv.includes("--apply");

// Cheap pre-filter in SQL so this reads a handful of rows rather than the whole table; the real
// test is decodeEntities disagreeing with what is stored.
const rows = db.prepare(`
  SELECT id, title, company, location FROM raw_jobs
  WHERE title LIKE '%&%;%' OR company LIKE '%&%;%' OR location LIKE '%&%;%'
`).all();
console.log(`rows containing something entity-shaped: ${rows.length}`);

const fixes = [];
for (const r of rows) {
  const t = decodeEntities(r.title), c = decodeEntities(r.company), l = decodeEntities(r.location);
  if (t !== r.title || c !== r.company || l !== r.location) fixes.push({ id: r.id, t, c, l, was: r });
}
console.log(`rows that actually change: ${fixes.length}\n`);
for (const f of fixes.slice(0, 25)) {
  for (const [k, col] of [["title", "t"], ["company", "c"], ["location", "l"]]) {
    if (f[col] !== f.was[k]) console.log(`  ${k.padEnd(8)} ${JSON.stringify(f.was[k]).slice(0, 46)} -> ${JSON.stringify(f[col]).slice(0, 46)}`);
  }
}
if (fixes.length > 25) console.log(`   … and ${fixes.length - 25} more`);
if (!fixes.length) { console.log("Nothing to repair."); process.exit(0); }

if (!APPLY) { console.log("\nDry run. Re-run with --apply."); process.exit(0); }

const before = db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c;
db.exec("BEGIN");
let n = 0;
try {
  const upd = db.prepare("UPDATE raw_jobs SET title = ?, company = ?, location = ? WHERE id = ?");
  for (const f of fixes) n += Number(upd.run(f.t, f.c, f.l, f.id).changes);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

const after = db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c;
console.log(`\nrepaired ${n} row(s)`);
if (after !== before) { console.error(`ROW COUNT CHANGED ${before} -> ${after} — this script only updates`); process.exit(1); }
const left = db.prepare(`SELECT COUNT(*) c FROM raw_jobs WHERE title LIKE '%&amp;%' OR company LIKE '%&amp;%' OR location LIKE '%&amp;%'`).get().c;
console.log(`raw_jobs: ${after} (unchanged) | rows still holding "&amp;": ${left}`);
console.log(`quick_check: ${db.prepare("PRAGMA quick_check").get().quick_check}`);
