// One-shot backfill: give every tracked domain we hold NO postings for its "hiring velocity" answer.
//
// velocityProducer returned early with `{ "Jobs on record": "0" }` and no flag, so a company with no
// postings on record was filed as UNKNOWN rather than as "not hiring". 1,146 of the 1,280 domains on
// the live watchlist are that shape, which means the Hiring-velocity filter was deciding for 134 of
// them and silently omitting the rest. The producer now answers; this fills in what it already
// should have said, so the filter is complete today instead of after the next full scan.
//
// SAFE BY CONSTRUCTION, and this is why velocity is the only producer backfilled here:
//   • It is answered ENTIRELY from our own raw_jobs table. No network, no external API, nothing that
//     could be rate-limited or return a different answer than the app would.
//   • On the zero-rows path the producer touches nothing at all — no state write, no signal, no
//     cache — so calling it here is a pure read.
//   • It is the SHIPPED producer that is called, not a re-implementation, so this cannot disagree
//     with what the app will conclude next time it looks.
//
// Everything else that is missing flags (edgar, subdomains, companieshouse, dns, tech, news, ads)
// needs a live fetch per domain to answer honestly, and guessing on their behalf is exactly the bug
// being fixed. Those fill in on the next scan.
//
// Usage:  node scripts/backfill-velocity-flags.mjs [--apply]
import { db, dbSetDomainFlag } from "../src/db.ts";
import { velocityProducer } from "../src/signals/velocity.ts";

const APPLY = process.argv.includes("--apply");

// Every domain the app already tracks: watchlist config, prior baselines, prior flags. Deliberately
// NOT "every domain in raw_jobs" — this must not invent rows for domains nobody is watching.
const domains = db.prepare(`
  SELECT DISTINCT domain FROM domain_state
  UNION SELECT DISTINCT domain FROM domain_flags
`).all().map((r) => r.domain).filter(Boolean);
for (const r of db.prepare("SELECT config FROM clients").all()) {
  for (const d of (JSON.parse(r.config).search?.orgDomains ?? [])) {
    const n = String(d ?? "").trim().toLowerCase();
    if (n && !domains.includes(n)) domains.push(n);
  }
}
console.log(`tracked domains: ${domains.length}`);

const have = new Set(db.prepare("SELECT domain FROM domain_flags WHERE producer = 'velocity'").all().map((r) => r.domain));
const todo = [];
for (const domain of domains) {
  if (have.has(domain)) continue;
  const out = await velocityProducer.check(domain, {});
  // Only the zero-postings answer. A domain WITH postings must be measured by a real scan, because
  // that path also emits signals and advances state, which a backfill has no business doing.
  if (out.facts["Jobs on record"] !== "0" || !out.flag) continue;
  todo.push({ domain, flag: out.flag });
}
console.log(`already answered: ${have.size}`);
console.log(`to fill in (no postings on record): ${todo.length}\n`);
for (const t of todo.slice(0, 6)) console.log(`  ${t.domain.padEnd(34)} hit=${t.flag.hit}  "${t.flag.summary}"`);
if (todo.length > 6) console.log(`   … and ${todo.length - 6} more`);
if (!todo.length) { console.log("Nothing to fill."); process.exit(0); }
if (!APPLY) { console.log("\nDry run. Re-run with --apply."); process.exit(0); }

const before = {
  jobs: db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c,
  flags: db.prepare("SELECT COUNT(*) c FROM domain_flags").get().c,
  sigs: db.prepare("SELECT COUNT(*) c FROM signals").get().c,
};
db.exec("BEGIN");
try { for (const t of todo) dbSetDomainFlag(t.domain, "velocity", t.flag.hit, t.flag.summary); db.exec("COMMIT"); }
catch (e) { db.exec("ROLLBACK"); throw e; }

const after = {
  jobs: db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c,
  flags: db.prepare("SELECT COUNT(*) c FROM domain_flags").get().c,
  sigs: db.prepare("SELECT COUNT(*) c FROM signals").get().c,
};
console.log(`\nvelocity flags: ${have.size} -> ${db.prepare("SELECT COUNT(*) c FROM domain_flags WHERE producer='velocity'").get().c}`);
console.log(`domain_flags total: ${before.flags} -> ${after.flags}`);
// This script adds flags and NOTHING else. If either of these moved, it did something it shouldn't.
if (after.jobs !== before.jobs) { console.error(`raw_jobs CHANGED ${before.jobs} -> ${after.jobs}`); process.exit(1); }
if (after.sigs !== before.sigs) { console.error(`signals CHANGED ${before.sigs} -> ${after.sigs}`); process.exit(1); }
console.log(`raw_jobs ${after.jobs} unchanged | signals ${after.sigs} unchanged | quick_check: ${db.prepare("PRAGMA quick_check").get().quick_check}`);
