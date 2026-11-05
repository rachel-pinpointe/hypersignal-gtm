// One-shot repair: clear the state/country on jobs whose location is a SHORTLIST OF ALTERNATIVES.
//
// ATS boards routinely put a whole shortlist in the location field — "Accra or Bogota or Cape Town
// or Dubai or Dakar", "Alabama or Alaska or Arizona or Arkansas or …", "Africa or Asia or Europe".
// None of those is a place. The old derivation answered anyway, by taking whichever single name it
// recognised first, and the results are not merely arbitrary, they are wrong in a way a user can
// see in a filter:
//
//   "Accra or Bogota or Cape Town or Dubai"   -> state WA        (Washington State)
//   "Alabama or Alaska or Arizona or …"       -> state AL        (a job open in ANY state)
//   "Beijing or Hanoi or Mumbai or Singapore" -> country SG      (one of five, alphabetically lucky)
//
// deriveState and deriveCountry now both refuse these. This clears what the old rule wrote, so the
// State and Country facets stop asserting a place the posting never named.
//
// STRICTLY A CLEAR. It only ever writes NULL, only to rows the CURRENT code refuses to answer for,
// and it recomputes with the shipped functions rather than re-implementing the rule — so it cannot
// invent a value and cannot disagree with what the app would do next time it saw the row.
//
// Cross-checked before writing: 0 rows would change to a DIFFERENT state or country. Every
// difference is an answer becoming "unknown", which is the correct answer for a shortlist.
//
// Usage:  node scripts/repair-shortlist-locations.mjs [--apply]
import { db } from "../src/db.ts";
import { deriveState, deriveCountry } from "../src/normalize.ts";

const APPLY = process.argv.includes("--apply");

const rows = db.prepare(`
  SELECT id, location, state, country FROM raw_jobs
  WHERE location IS NOT NULL AND location <> '' AND (
    (state IS NOT NULL AND state <> '') OR (country IS NOT NULL AND country <> ''))
`).all();
console.log(`rows carrying a state or country: ${rows.length}`);

const clears = [];
let wouldChange = 0;
for (const r of rows) {
  const s = deriveState(r.location);
  const c = deriveCountry(r.location, null);   // null: judge the LOCATION alone, not a stored state
  const dropState = (r.state ?? "") !== "" && s === null;
  const dropCountry = (r.country ?? "") !== "" && c === null;
  // A row the code would answer DIFFERENTLY is not this script's business — that would be a
  // re-derive, which is a much larger decision. Count them and refuse to touch them.
  if ((s !== null && s !== r.state) || (c !== null && c !== r.country)) { wouldChange++; continue; }
  if (dropState || dropCountry) clears.push({ id: r.id, dropState, dropCountry, was: r });
}
console.log(`rows to clear: ${clears.length}`);
console.log(`rows the code would answer DIFFERENTLY (left alone): ${wouldChange}\n`);
for (const f of clears.slice(0, 15)) {
  const bits = [f.dropState ? `state ${f.was.state}` : "", f.dropCountry ? `country ${f.was.country}` : ""].filter(Boolean);
  console.log(`  clear ${bits.join(" + ").padEnd(24)} <- ${JSON.stringify(f.was.location).slice(0, 58)}`);
}
if (clears.length > 15) console.log(`   … and ${clears.length - 15} more`);
if (!clears.length) { console.log("Nothing to clear."); process.exit(0); }

if (!APPLY) { console.log("\nDry run. Re-run with --apply."); process.exit(0); }

const before = {
  rows: db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c,
  st: db.prepare("SELECT COUNT(*) c FROM raw_jobs WHERE state IS NOT NULL AND state <> ''").get().c,
  cc: db.prepare("SELECT COUNT(*) c FROM raw_jobs WHERE country IS NOT NULL AND country <> ''").get().c,
};
db.exec("BEGIN");
let n = 0;
try {
  const clrBoth = db.prepare("UPDATE raw_jobs SET state = NULL, country = NULL WHERE id = ?");
  const clrState = db.prepare("UPDATE raw_jobs SET state = NULL WHERE id = ?");
  const clrCc = db.prepare("UPDATE raw_jobs SET country = NULL WHERE id = ?");
  for (const f of clears) {
    const stmt = f.dropState && f.dropCountry ? clrBoth : f.dropState ? clrState : clrCc;
    n += Number(stmt.run(f.id).changes);
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

const after = {
  rows: db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c,
  st: db.prepare("SELECT COUNT(*) c FROM raw_jobs WHERE state IS NOT NULL AND state <> ''").get().c,
  cc: db.prepare("SELECT COUNT(*) c FROM raw_jobs WHERE country IS NOT NULL AND country <> ''").get().c,
};
console.log(`\ncleared ${n} row(s)`);
console.log(`rows with a state:   ${before.st} -> ${after.st}`);
console.log(`rows with a country: ${before.cc} -> ${after.cc}`);
if (after.rows !== before.rows) { console.error(`ROW COUNT CHANGED ${before.rows} -> ${after.rows} — this script only clears`); process.exit(1); }
console.log(`raw_jobs: ${after.rows} (unchanged) | quick_check: ${db.prepare("PRAGMA quick_check").get().quick_check}`);
