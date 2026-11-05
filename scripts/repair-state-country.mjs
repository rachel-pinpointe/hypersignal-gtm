// One-shot repair: re-derive state + country for every stored job whose location now parses
// differently.
//
// Three location bugs were fixed in the same pass and all three left wrong rows behind:
//   • "Charleston, West Virginia" was stored as VA, because the full-name state scan was an
//     unordered `includes` over an object whose key order puts "virginia" before "west virginia".
//   • "Washington, DC" was stored as WA for the same missing word boundary — DC was not in the
//     table at all, so nothing earlier could claim it.
//   • "Tbilisi, Tbilisi, Georgia" was stored as GA / US. deriveState now corroborates the city's
//     country against the region code beside it (src/subdivisionCodes.ts).
//
// The decision is made by re-running the SHIPPED deriveState/deriveCountry over the stored location,
// never by re-implementing them here, so a row is rewritten exactly when the app would now store
// something different.
//
// FILL AND CORRECT, not fill-only. This is the one repair that must overwrite a non-null value —
// the whole point is that the stored answer is wrong. It only ever writes where the newly-derived
// answer DIFFERS, and it reports every change class before touching anything.
//
// Usage:  node scripts/repair-state-country.mjs [--apply]
// Without --apply it only reports.
import { db } from "../src/db.ts";
import { deriveState, deriveCountry } from "../src/normalize.ts";

const APPLY = process.argv.includes("--apply");

const rows = db.prepare(
  "SELECT id, location, state, country FROM raw_jobs WHERE location IS NOT NULL AND location != ''",
).all();

const changes = [];
for (const r of rows) {
  const loc = String(r.location);
  const st = deriveState(loc);
  const cc = deriveCountry(loc, st);
  const oldSt = r.state ?? null, oldCc = r.country ?? null;
  if (st !== oldSt || cc !== oldCc) changes.push({ id: r.id, loc, oldSt, oldCc, st, cc });
}

console.log(`jobs with a location: ${rows.length}`);
console.log(`rows whose derived state/country changed: ${changes.length}\n`);

// Group by the SHAPE of the change so an unexpected class is visible before anything is written —
// "1,400 rows lost their state" is the kind of thing that must not slip past in a total.
const byShape = new Map();
for (const c of changes) {
  const k = `${c.oldSt ?? "-"}/${c.oldCc ?? "-"}  ->  ${c.st ?? "-"}/${c.cc ?? "-"}`;
  if (!byShape.has(k)) byShape.set(k, []);
  byShape.get(k).push(c);
}
for (const [shape, list] of [...byShape].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) {
  console.log(`  ${String(list.length).padStart(5)}  ${shape.padEnd(28)}  e.g. ${String(list[0].loc).slice(0, 46)}`);
}
if (byShape.size > 25) console.log(`   … and ${byShape.size - 25} more shapes`);

if (!APPLY) { console.log("\n(dry run — re-run with --apply to write)"); process.exit(0); }

const upd = db.prepare("UPDATE raw_jobs SET state = ?, country = ? WHERE id = ?");
const CHUNK = 500;
for (let i = 0; i < changes.length; i += CHUNK) {
  db.exec("BEGIN");
  try {
    for (const c of changes.slice(i, i + CHUNK)) upd.run(c.st, c.cc, c.id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
console.log(`\nrewrote state/country on ${changes.length} row(s)`);
