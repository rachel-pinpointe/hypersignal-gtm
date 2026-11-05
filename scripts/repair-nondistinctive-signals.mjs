// One-shot repair: delete every stored signal that the app would REFUSE to emit today, now that a
// company's identity has to be distinctive.
//
// WHY THIS EXISTS. Every name-keyed signal in the live database was graded against its own source —
// the full set, not a sample. 123 of 177 (69.5%) were about a DIFFERENT organisation:
//
//   • all 49 SEC filings.  armour.ca was behind a 403, so the resolver fell to the domain stem
//     "Armour" and the app collected ARMOUR Residential REIT's 32 filings. alliance.com's title is
//     "Alliance – Alliance Shippers Inc." and the old rule took the shorter side, so "Alliance"
//     collected Alliance Laundry Holdings'.
//   • 18 of 41 layoff notices.  "Block" for shipblock.com pulled Block, Inc.'s WARN filings;
//     "Compass" pulled Compass Inc's ONE 110-job notice into THREE unrelated customs brokers.
//   • 56 of 87 news items.  "India" (tliindia.com, from the title "Trade Lines Inc | India") pulled
//     Reuters coverage of India's education minister; "UNIS" pulled a K-pop group; "Sealion" pulled
//     a BYD electric car.
//
// The code fix is in src/signals/company.ts (a distinctiveness gate, plus a title-side rule that
// prefers the part carrying a legal suffix). This removes what was written before it.
//
// THE DECISION IS MADE BY THE SHIPPED CODE, never re-implemented here — the rows deleted are exactly
// the rows the app would now refuse. For news/WARN/GDELT that means re-running the matcher against
// the stored headline. For EDGAR and the app stores the stored `company` is the REGISTRY's name
// rather than ours, so those are decided by re-resolving the DOMAIN's identity instead; that costs
// one homepage fetch per domain, cached, and there are only a handful.
//
// Importing the matcher pulls in db.ts, which opens SIGNAL_DB — intended: this operates on the live
// database.
//
// Usage:  node scripts/repair-nondistinctive-signals.mjs [--apply]
// Without --apply it only reports.
import { db, dbRederiveSignalCheckCounts } from "../src/db.ts";
import {
  companyNameMatches, companyEntityMatches, isDistinctiveIdentity, resolveCompanyIdentity,
} from "../src/signals/company.ts";

const APPLY = process.argv.includes("--apply");

// Which producers key on a NAME. Everything else (dns, tech, subdomains, velocity, ats) is keyed on
// the domain itself and cannot be misattributed this way.
const OURS = (t) => t.startsWith("news-") || t.startsWith("gdelt") || t === "warn-layoff";
const REGISTRY = (t) => t.startsWith("filing-") || t === "funding-form-d" || t.startsWith("app-") || t.startsWith("ch-");

const rows = db.prepare(
  "SELECT id, domain, company, type, title FROM signals WHERE company IS NOT NULL AND company != ''",
).all().filter((r) => OURS(String(r.type)) || REGISTRY(String(r.type)));

console.log(`name-keyed signals stored: ${rows.length}`);
if (!rows.length) { console.log("nothing to do"); process.exit(0); }

// One identity resolution per domain, reused across that domain's rows.
const identities = new Map();
const identityOf = async (domain) => {
  if (!identities.has(domain)) {
    try { identities.set(domain, await resolveCompanyIdentity(domain)); }
    catch { identities.set(domain, { name: "", source: "stem", keyable: false }); }
  }
  return identities.get(domain);
};

const drop = [], keep = [];
for (const r of rows) {
  const type = String(r.type), stored = String(r.company ?? ""), title = String(r.title ?? "");
  const id = await identityOf(String(r.domain));
  let ok;
  let why = "";
  if (!id.keyable) {
    ok = false;
    why = `domain no longer resolves to a usable identity (${id.name || "?"} via ${id.source})`;
  } else if (OURS(type)) {
    // Our own name was stored on the row. Re-ask the question the producer asked.
    ok = isDistinctiveIdentity(stored) && companyNameMatches(stored, title);
    if (!ok) why = "the headline is not about this company";
  } else {
    // The registry entity was stored. Would our (now stricter) identity still match it?
    ok = companyEntityMatches(id.name, stored);
    if (!ok) why = `"${id.name}" no longer matches the registry entity`;
  }
  (ok ? keep : drop).push({ ...r, why });
}

// A partition, not a one-sided filter — if these do not add up, the classification is unsound and
// nothing should be deleted on the strength of it.
if (keep.length + drop.length !== rows.length) { console.error("counts do not partition — aborting"); process.exit(1); }

console.log(`  still correct: ${keep.length}`);
console.log(`  misattributed: ${drop.length}\n`);
const byType = new Map();
for (const d of drop) {
  const k = d.type.startsWith("news-") ? "news"
    : d.type.startsWith("filing-") || d.type === "funding-form-d" ? "edgar"
    : d.type;
  byType.set(k, (byType.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(16)} ${n}`);
console.log();
for (const d of drop.slice(0, 20)) {
  console.log("  DROP", String(d.domain).slice(0, 24).padEnd(24), String(d.company).slice(0, 22).padEnd(22), d.why);
}
if (drop.length > 20) console.log(`   … and ${drop.length - 20} more`);

// The SURVIVORS matter as much as the casualties. A guard that starts refusing correct rows is worse
// than the bug it replaces, and the only way to see that is to look at what it kept.
const keptBy = new Map();
for (const k of keep) keptBy.set(k.domain, (keptBy.get(k.domain) ?? 0) + 1);
console.log(`\n  KEPT, by domain (${keptBy.size} domains):`);
console.log("   " + [...keptBy].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}×${n}`).join(", "));

if (!APPLY) { console.log("\n(dry run — re-run with --apply to delete)"); process.exit(0); }

db.exec("BEGIN");
try {
  const del = db.prepare("DELETE FROM signals WHERE id = ?");
  for (const d of drop) del.run(d.id);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }
// The counters on every saved Signal Check are derived from a snapshot, so deleting signals without
// this leaves each check advertising a total it no longer has. This is the whole reason
// dbRederiveSignalCheckCounts exists.
const checks = dbRederiveSignalCheckCounts();
console.log(`\ndeleted ${drop.length} misattributed signal(s); re-derived the counters on ${checks} saved check(s)`);
