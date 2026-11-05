// One-shot repair: drop signal flags and signals filed under a recruiting VENDOR's domain.
//
// A flag or signal keyed on a platform host describes the vendor, not a prospect — betterteam.com and
// ukg.net appear in the Companies view as if they were companies you were tracking. They got there
// because those hosts were stored in raw_jobs.domain as an employer's website, and the bulk-check
// paths derive their domain list from that column.
//
// Recurrence is already prevented: PLATFORM_HOSTS now lists these vendors and DOMAIN_RULES_VERSION
// was bumped, so the pending re-derive clears them out of raw_jobs.domain and they stop being
// derived. This script only removes the rows written before that.
//
// A domain the USER explicitly watches is never touched, even when it is a platform host — that is
// their choice to make, not this script's. On the live data that spares us.com, which is in a
// watchlist and is worth a human look, since it is a shared suffix rather than a company.
//
// Usage:  node scripts/repair-platform-host-flags.mjs [--apply]
import { DatabaseSync } from "node:sqlite";
import { isPlatformDomain } from "../src/normalize.ts";

const APPLY = process.argv.includes("--apply");
const d = new DatabaseSync(process.env.SIGNAL_DB ?? "data/signals.db", { readOnly: !APPLY });

const watched = new Set();
for (const r of d.prepare("SELECT config FROM clients").all()) {
  let c = {}; try { c = JSON.parse(r.config); } catch { /* a malformed config watches nothing */ }
  for (const dom of c.search?.orgDomains ?? []) watched.add(String(dom).toLowerCase());
}

const hosts = [...new Set(d.prepare("SELECT DISTINCT domain FROM domain_flags WHERE domain <> ''").all()
  .map((r) => String(r.domain)))].filter((h) => isPlatformDomain(h) && !watched.has(h.toLowerCase()));
const spared = [...new Set(d.prepare("SELECT DISTINCT domain FROM domain_flags WHERE domain <> ''").all()
  .map((r) => String(r.domain)))].filter((h) => isPlatformDomain(h) && watched.has(h.toLowerCase()));

console.log(`watchlist domains: ${watched.size}`);
console.log(`vendor hosts to clear: ${hosts.length}`);
for (const h of hosts) console.log("   clear ", h);
if (spared.length) { console.log(`\nSPARED (explicitly watched — your call, not this script's):`); for (const h of spared) console.log("   keep  ", h); }
if (!hosts.length) { console.log("\nNothing to clear."); process.exit(0); }

const ph = hosts.map(() => "?").join(",");
const nFlags = d.prepare(`SELECT COUNT(*) c FROM domain_flags WHERE domain IN (${ph})`).get(...hosts).c;
const nSigs = d.prepare(`SELECT COUNT(*) c FROM signals WHERE domain IN (${ph})`).get(...hosts).c;
console.log(`\nwould remove: ${nFlags} flag(s), ${nSigs} signal(s)`);

if (!APPLY) { console.log("\nDry run. Re-run with --apply to delete."); process.exit(0); }

d.exec("BEGIN");
try {
  d.prepare(`DELETE FROM domain_flags WHERE domain IN (${ph})`).run(...hosts);
  d.prepare(`DELETE FROM signals WHERE domain IN (${ph})`).run(...hosts);
  d.exec("COMMIT");
} catch (e) { d.exec("ROLLBACK"); throw e; }

console.log(`\nremoved ${nFlags} flag(s) and ${nSigs} signal(s)`);
console.log("flags now:", d.prepare("SELECT COUNT(*) c FROM domain_flags").get().c,
  "| signals now:", d.prepare("SELECT COUNT(*) c FROM signals").get().c);
console.log("quick_check:", d.prepare("PRAGMA quick_check").get().quick_check);
