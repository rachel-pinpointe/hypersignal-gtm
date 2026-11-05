// Fill the country on job rows that have none, using the full place dataset (src/places.ts).
//
// STRICTLY ADDITIVE. It only touches rows where country is NULL or empty, and it only ever writes a
// value — it cannot change or clear a country the app already recorded. That is deliberate: the
// same pass that made these rows resolvable also made ~766 OTHER rows resolve to "unknown", because
// they are shortlists of alternatives ("Beijing or Hanoi or Mumbai or Shanghai or Singapore") that
// were previously answered by whichever single name happened to be recognised. Those stored answers
// are wrong, but overwriting them is a separate decision with a much bigger blast radius, and it is
// not this script's to make. Verified before writing: 0 rows would change to a DIFFERENT country.
//
// The `state` column is passed through to deriveCountry, and left alone — a US state already on the
// row is stronger evidence than anything here and the rule respects it.
//
// Usage:  node scripts/backfill-country-from-places.mjs [--apply]
import { db } from "../src/db.ts";
import { deriveCountry } from "../src/normalize.ts";

const APPLY = process.argv.includes("--apply");

const rows = db.prepare(
  "SELECT id, location, state FROM raw_jobs WHERE (country IS NULL OR country = '') AND location IS NOT NULL AND location <> ''",
).all();
console.log(`rows with no country: ${rows.length}`);

const fills = [];
for (const r of rows) {
  const cc = deriveCountry(r.location, r.state);
  if (cc) fills.push([r.id, cc, r.location]);
}
const byCc = {};
for (const [, cc] of fills) byCc[cc] = (byCc[cc] ?? 0) + 1;
console.log(`resolvable now: ${fills.length}`);
console.log(Object.entries(byCc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  "));
for (const [, cc, loc] of fills.slice(0, 15)) console.log("   ", cc, "<-", JSON.stringify(loc).slice(0, 62));
if (fills.length > 15) console.log(`   … and ${fills.length - 15} more`);
if (!fills.length) { console.log("\nNothing to fill."); process.exit(0); }

// Guard the instrument: this script must never be able to overwrite. Re-assert it against the
// actual statement rather than trusting the WHERE clause to have been written correctly.
const before = db.prepare("SELECT COUNT(*) c FROM raw_jobs WHERE country IS NOT NULL AND country <> ''").get().c;

if (!APPLY) { console.log("\nDry run. Re-run with --apply."); process.exit(0); }

db.exec("BEGIN");
let n = 0;
try {
  // The WHERE repeats the blank test, so a row that gained a country between the read above and
  // this write is skipped rather than clobbered.
  const upd = db.prepare("UPDATE raw_jobs SET country = ? WHERE id = ? AND (country IS NULL OR country = '')");
  for (const [id, cc] of fills) n += Number(upd.run(cc, id).changes);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

const after = db.prepare("SELECT COUNT(*) c FROM raw_jobs WHERE country IS NOT NULL AND country <> ''").get().c;
console.log(`\nfilled ${n} row(s)`);
console.log(`rows with a country: ${before} -> ${after}  (delta ${after - before}, must equal ${n})`);
if (after - before !== n) { console.error("MISMATCH — something other than a blank fill happened"); process.exit(1); }
console.log(`raw_jobs: ${db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c}`);
console.log(`quick_check: ${db.prepare("PRAGMA quick_check").get().quick_check}`);
