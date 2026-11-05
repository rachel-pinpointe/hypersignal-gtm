// One-shot repair: delete app signals whose app was published by someone other than the company.
//
// The old matcher accepted an App Store result on any of three arms — seller contains the company,
// company contains the seller, or the app's NAME starts with the company — none word-bounded and none
// with a length floor. Of 14 app-stale signals inspected on the live feed, 10 were about an unrelated
// app: a freight forwarder matched to "Airgroup: All In One Gym", a customs broker to "FCBF Church",
// a logistics firm to a Chinese DJ turntable app.
//
// Unlike the news repair, the stored row does NOT carry enough to re-judge it: detail held only
// { lastUpdated }, and the app name and publisher were never recorded (6e3fa5b adds them, but only
// for signals written from now on). So this has to ASK APPLE AGAIN — one search per distinct company,
// rate-limited — and re-run the shipped picker over the live results.
//
// A signal survives only if the app it points at is still the app the fixed picker chooses. Anything
// the picker now rejects, or that resolves to a different app id, is a signal about someone else's
// software.
//
// Deliberately conservative: if the lookup FAILS (network, throttling, non-2xx) the signal is KEPT
// and reported as unverified. Deleting on a failed lookup would silently drop real signals whenever
// Apple rate-limits us.
//
// Usage:  node scripts/repair-misattributed-app-signals.mjs [--apply]
import { db } from "../src/db.ts";
import { pickCompanyApp } from "../src/signals/appPresence.ts";

const APPLY = process.argv.includes("--apply");
const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0)";
const PAUSE_MS = 500;                      // Apple throttles; this pass is not in a hurry

const rows = db.prepare(
  "SELECT id, domain, company, type, title, url FROM signals WHERE type IN ('app-stale','app-published')",
).all();
console.log(`app signals: ${rows.length}`);
if (!rows.length) process.exit(0);

/** The App Store id the signal points at, from its stored url. */
const idOf = (url) => (String(url ?? "").match(/\/id(\d+)/) || [])[1] ?? null;

const byCompany = new Map();
for (const r of rows) {
  const k = String(r.company ?? "").trim();
  if (!byCompany.has(k)) byCompany.set(k, []);
  byCompany.get(k).push(r);
}
console.log(`distinct companies to re-check: ${byCompany.size}\n`);

const drop = [], keep = [], unverified = [];
for (const [company, sigs] of byCompany) {
  if (!company) { drop.push(...sigs.map((s) => [s, "no company name on the signal"])); continue; }
  let results = null;
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(company)}&entity=software&country=US&limit=10`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
    if (res.ok) results = (await res.json()).results ?? [];
  } catch { /* handled below */ }
  if (results === null) { unverified.push(...sigs.map((s) => [s, "lookup failed — kept"])); continue; }

  const picked = pickCompanyApp(company, results);
  for (const s of sigs) {
    if (!picked) { drop.push([s, "no app on the store is published by this company"]); continue; }
    const want = String(picked.trackId ?? "");
    const have = idOf(s.url);
    if (have && want && have !== want) drop.push([s, `points at app ${have}, the company's app is ${want} (${picked.trackName})`]);
    else keep.push([s, `${picked.trackName} [${picked.sellerName}]`]);
  }
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}

console.log(`  keep:       ${keep.length}`);
console.log(`  drop:       ${drop.length}`);
console.log(`  unverified: ${unverified.length} (kept — a failed lookup must never delete)\n`);
if (keep.length + drop.length + unverified.length !== rows.length) { console.error("counts do not partition — aborting"); process.exit(1); }

for (const [s, why] of drop.slice(0, 20)) console.log("  DROP", String(s.domain).slice(0, 24).padEnd(24), why.slice(0, 62));
if (drop.length > 20) console.log(`   … and ${drop.length - 20} more`);
console.log("\n  KEEP");
for (const [s, what] of keep.slice(0, 10)) console.log("      ", String(s.domain).slice(0, 24).padEnd(24), what.slice(0, 52));
for (const [s, why] of unverified) console.log("  UNVERIFIED", String(s.domain).slice(0, 24).padEnd(24), why);

if (!APPLY) { console.log("\nDry run. Re-run with --apply to delete."); process.exit(0); }
if (!drop.length) { console.log("\nNothing to delete."); process.exit(0); }

const before = db.prepare("SELECT COUNT(*) c FROM signals").get().c;
db.exec("BEGIN");
let n = 0;
try {
  const del = db.prepare("DELETE FROM signals WHERE id = ?");
  for (const [s] of drop) n += Number(del.run(s.id).changes);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

console.log(`\ndeleted ${n}`);
console.log(`signals: ${before} -> ${db.prepare("SELECT COUNT(*) c FROM signals").get().c}`);
console.log(`quick_check: ${db.prepare("PRAGMA quick_check").get().quick_check}`);
