// One-shot repair: rewrite every stored posted_at that is not comparable UTC ISO.
//
// Why this exists. Every date comparison in the app is a SQLite comparison against
// `datetime('now', ?)`, and posted_at has no index, so both sides were compared as plain text. That
// silently requires every stored value to share one shape and one timezone. Nothing enforced it, and
// production ended up with 282 WeWorkRemotely rows holding an RFC-2822 pubDate
// ("Fri, 05 Dec 2025 10:37:40 +0000"). It begins with a letter, letters sort above digits, so those
// rows compared as newer than any timestamp the app can produce: permanently inside "posted in the
// last 7 days", and permanently un-deletable by the 3am retention purge — 282 of 282 immortal.
//
// src/normalize.ts now normalizes at the single write boundary (makeJob) so no new row can look like
// this, and src/db.ts compares with julianday() on both sides so format can no longer decide the
// answer. This script fixes the rows that were already stored.
//
// The rewrite is a format conversion, not a data change: the same instant, re-rendered. A value that
// cannot be parsed at all is set to NULL, which means "date unknown" and is what every caller
// already handles — leaving junk in place keeps the row out of retention forever.
//
// Usage:  node scripts/repair-nonstandard-posted-dates.mjs [--apply]
// Without --apply it only reports.
import { DatabaseSync } from "node:sqlite";
import { toIsoInstant } from "../src/normalize.ts";

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.SIGNAL_DB ?? "data/signals.db";

const db = new DatabaseSync(DB_PATH, { readOnly: !APPLY });

// Everything SQLite itself cannot read as a date. julianday() returning NULL on a non-null value is
// the exact definition of "this row is invisible to every date comparison in the app".
const broken = db.prepare(`
  SELECT id, source, posted_at FROM raw_jobs
  WHERE posted_at IS NOT NULL AND posted_at <> '' AND julianday(posted_at) IS NULL
`).all();

console.log(`${DB_PATH}: ${broken.length} row(s) with a posted_at SQLite cannot compare\n`);
if (!broken.length) { console.log("Nothing to repair."); process.exit(0); }

const bySource = new Map();
const plan = [];
for (const r of broken) {
  const next = toIsoInstant(r.posted_at);
  plan.push({ id: r.id, from: r.posted_at, to: next });
  const k = `${r.source} → ${next === null ? "NULL (unparseable)" : "ISO"}`;
  bySource.set(k, (bySource.get(k) ?? 0) + 1);
}
for (const [k, n] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);

console.log("\nSample:");
for (const p of plan.slice(0, 5)) console.log(`  ${p.from}  →  ${p.to}`);

// Prove the repair does what it claims before touching anything: every rewritten value must be one
// SQLite can now compare, and must represent the same instant as the string it replaces.
let bad = 0;
for (const p of plan) {
  if (p.to === null) continue;
  if (!Number.isFinite(Date.parse(p.to)) || Date.parse(p.to) !== Date.parse(p.from)) {
    console.error(`  MISMATCH ${p.id}: ${p.from} -> ${p.to}`); bad++;
  }
}
if (bad) { console.error(`\n${bad} conversion(s) do not round-trip to the same instant. Aborting.`); process.exit(1); }
console.log(`\nAll ${plan.filter((p) => p.to !== null).length} conversions preserve the exact instant.`);

if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); process.exit(0); }

const upd = db.prepare("UPDATE raw_jobs SET posted_at = ? WHERE id = ?");
let n = 0;
db.exec("BEGIN");
try { for (const p of plan) n += Number(upd.run(p.to, p.id).changes); db.exec("COMMIT"); }
catch (e) { db.exec("ROLLBACK"); throw e; }

const left = db.prepare(
  "SELECT COUNT(*) c FROM raw_jobs WHERE posted_at IS NOT NULL AND posted_at <> '' AND julianday(posted_at) IS NULL",
).get().c;
console.log(`\nRewrote ${n} row(s). Rows still uncomparable: ${left}`);
