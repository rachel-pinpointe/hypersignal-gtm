// One-shot: drop watchlist entries that are a PUBLIC SUFFIX rather than a company.
//
// "us.com" is a commercial subdomain registry — the same kind of thing as "co.uk". It is not an
// employer, and 28 unrelated companies had 266 postings filed under it, all of them matching the
// Docxster watchlist as if they were one account. normalize.ts already knows this: isPlatformDomain
// rejects it via MULTI_LABEL_SUFFIX. The entry simply predates that rule, so nothing ever re-checked
// the watchlist against it.
//
// Judged by the SHIPPED isPlatformDomain, not by a list written here, so this cannot disagree with
// what the app believes and will find the next one without being edited.
//
// TWO STORES, and getting only one is the trap. loadClients() reads the `clients` TABLE — the YAML is
// a seed that seedFromYaml() skips for any client already in the database. So editing the file alone
// changes nothing at runtime, and editing only the database leaves the file ready to reintroduce the
// entry if that row is ever deleted and re-seeded. Both, or it is not done.
//
// EXACT matches only. Eight real companies in this watchlist have domains ENDING in "us.com" —
// acb-us.com, baybrokerageus.com, hunterexpressus.com, nexterus.com, sli-us.com and others. A
// substring edit would have deleted eight real accounts to remove one bad one.
//
// Usage:  node scripts/remove-suffix-watchlist-entries.mjs [--apply]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db.ts";
import { isPlatformDomain } from "../src/normalize.ts";

const APPLY = process.argv.includes("--apply");
const CLIENTS_DIR = process.env.CLIENTS_DIR ?? "clients";

const work = [];
for (const r of db.prepare("SELECT name, config FROM clients").all()) {
  const cfg = JSON.parse(r.config);
  const doms = cfg.search?.orgDomains ?? [];
  const bad = doms.filter((d) => isPlatformDomain(String(d)));
  if (bad.length) work.push({ name: r.name, cfg, doms, bad });
}
if (!work.length) { console.log("No watchlist entry is a public suffix. Nothing to do."); process.exit(0); }

for (const w of work) {
  console.log(`${w.name}: ${w.doms.length} domains → removing ${w.bad.length}`);
  for (const d of w.bad) {
    const n = db.prepare("SELECT COUNT(*) c, COUNT(DISTINCT company) e FROM raw_jobs WHERE domain = ?").get(String(d).toLowerCase());
    console.log(`   ${String(d).padEnd(22)} ${n.c} job(s) across ${n.e} unrelated employer(s)`);
  }
}
if (!APPLY) { console.log("\nDry run. Re-run with --apply."); process.exit(0); }

const before = {
  jobs: db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c,
  clients: db.prepare("SELECT COUNT(*) c FROM clients").get().c,
};
db.exec("BEGIN");
try {
  for (const w of work) {
    const kept = w.doms.filter((d) => !isPlatformDomain(String(d)));
    w.cfg.search.orgDomains = kept;
    db.prepare("UPDATE clients SET config = ?, updated_at = datetime('now') WHERE name = ?")
      .run(JSON.stringify(w.cfg), w.name);
    console.log(`  db: ${w.name} ${w.doms.length} → ${kept.length} domains`);
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

// The seed file, so a future re-seed cannot bring it back. Line-exact, never a substring.
for (const w of work) {
  const f = join(CLIENTS_DIR, `${w.name}.yaml`);
  if (!existsSync(f)) { console.log(`  yaml: ${f} not present — database updated, nothing to seed from`); continue; }
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  const drop = new Set(w.bad.map((d) => String(d).trim().toLowerCase()));
  const out = lines.filter((l) => {
    const m = /^\s*-\s*(\S+)\s*$/.exec(l);
    return !(m && drop.has(m[1].toLowerCase()));
  });
  const removed = lines.length - out.length;
  if (removed !== w.bad.length) {
    console.error(`  yaml: expected to remove ${w.bad.length} line(s) from ${f}, removed ${removed} — NOT written`);
    continue;   // never write a file we do not understand
  }
  writeFileSync(f, out.join("\r\n"));
  console.log(`  yaml: ${f} ${lines.length} → ${out.length} lines (${removed} removed)`);
}

const after = {
  jobs: db.prepare("SELECT COUNT(*) c FROM raw_jobs").get().c,
  clients: db.prepare("SELECT COUNT(*) c FROM clients").get().c,
};
// This edits CONFIG only. A job or client row moving means it did something it was not asked to.
if (after.jobs !== before.jobs) { console.error(`raw_jobs CHANGED ${before.jobs} -> ${after.jobs}`); process.exit(1); }
if (after.clients !== before.clients) { console.error(`clients CHANGED ${before.clients} -> ${after.clients}`); process.exit(1); }
console.log(`\nraw_jobs ${after.jobs} unchanged | clients ${after.clients} unchanged | quick_check: ${db.prepare("PRAGMA quick_check").get().quick_check}`);
console.log("The 266 jobs stay in the database; they simply stop matching this watchlist. Their stored");
console.log("domain 'us.com' is itself rejected by isPlatformDomain, so the next boot's domain backfill");
console.log("re-derives it from each posting's URL.");
