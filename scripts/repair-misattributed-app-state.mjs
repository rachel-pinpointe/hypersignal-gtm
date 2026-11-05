// One-shot repair: clear the stored iOS app attributions that belong to another company.
//
// The companion script repair-misattributed-app-signals.mjs deleted 52 of 64 app SIGNALS that were
// about someone else's software. It did not touch what PRODUCED them. domain_state still holds an
// iOS app id for 135 domains, every one of them chosen by the old three-arm matcher, and
// domain_flags still says "Has iOS app" for 195 domains on the strength of it.
//
// That stored state is not inert. Three things read it:
//
//   1. The Companies view renders the flag. A company with no app is listed as having one.
//   2. appPresence.ts carries the prior state forward whenever a scan cannot definitively measure
//      the platform (`if (!measured.ios) for (const k of [...]) state[k] = prior.get(k)`). A wrong
//      id therefore survives every failed or region-blind lookup, indefinitely.
//   3. app-stale fires from state["iosUpdated"] alone, bucketed by month and independent of any
//      baseline. So in the carry-forward case the deleted signals come BACK next month, about the
//      same wrong app.
//
// Verification is by app id, not by re-searching. The stored row already names the exact app, so the
// precise question is "who published app N?" — one batched iTunes /lookup call per 100 ids answers
// it, and companyEntityMatches (the shipped test, the same one pickCompanyApp filters on) judges the
// seller against the company. Re-running the search would instead re-ask "what does Apple rank first
// today", which is a different and noisier question.
//
// Same conservative rule as the signal repair: an id Apple does not return is left alone and
// reported as unverified. Deleting on a failed lookup would quietly erase real attributions.
//
// Android is NOT repaired here and this is deliberate: the stored android value is "1", with no id,
// so nothing about it can be re-checked from the row. Its only cure is a re-scan with the fixed
// labelNamesCompany, which happens on the next pass. The count is reported so it is not forgotten.
//
// Usage:  node scripts/repair-misattributed-app-state.mjs [--apply]
import { db, dbSetDomainFlag } from "../src/db.ts";
import { resolveCompanyName, companyEntityMatches } from "../src/signals/company.ts";

const APPLY = process.argv.includes("--apply");
const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0)";
const IOS_KEYS = ["ios", "iosName", "iosSeller", "iosUpdated", "iosUrl"];

const rows = db.prepare(
  "SELECT domain, value AS id FROM domain_state WHERE producer = 'apps' AND key = 'ios' AND value <> ''",
).all();
const android = db.prepare(
  "SELECT COUNT(*) c FROM domain_state WHERE producer = 'apps' AND key = 'android'",
).get().c;
// The Android arm used to store the bare string "1", so there was nothing in the row to re-check and
// this script could only report the number and move on. It now records the package id it found, the
// label that matched and whether the package itself names the company — so newer rows carry their own
// evidence. Split the count rather than calling the whole set unrepairable, which stopped being true.
const androidWithId = db.prepare(
  "SELECT COUNT(*) c FROM domain_state WHERE producer = 'apps' AND key = 'androidId' AND value <> ''",
).get().c;
console.log(`domains with a stored iOS app: ${rows.length}`);
console.log(`domains with a stored Android app: ${android} — ${androidWithId} name the package they rest on, `
  + `${android - androidWithId} predate that and hold no evidence at all (the next scan records it)\n`);
if (!rows.length) process.exit(0);

// One /lookup per 100 ids. Apple returns only the ids it knows; a missing one is unverified, never a
// licence to delete — a delisted app and a throttled request look identical from here.
const ids = [...new Set(rows.map((r) => String(r.id)))];
const seller = new Map();
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const res = await fetch(`https://itunes.apple.com/lookup?id=${chunk.join(",")}&country=US`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) { console.error(`lookup failed: HTTP ${res.status} — aborting rather than guessing`); process.exit(1); }
  for (const a of (await res.json()).results ?? []) {
    seller.set(String(a.trackId), { name: a.trackName ?? "", by: a.sellerName ?? "" });
  }
  console.log(`  looked up ${Math.min(i + 100, ids.length)}/${ids.length}`);
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`  Apple knows ${seller.size} of ${ids.length} ids\n`);

const keep = [], clear = [], unverified = [];
for (const r of rows) {
  const app = seller.get(String(r.id));
  if (!app) { unverified.push([r, "Apple did not return this id — left in place"]); continue; }
  const company = await resolveCompanyName(r.domain);
  if (companyEntityMatches(company, app.by)) keep.push([r, company, app]);
  else clear.push([r, company, app]);
}
if (keep.length + clear.length + unverified.length !== rows.length) { console.error("counts do not partition — aborting"); process.exit(1); }
console.log(`  keep:       ${keep.length}`);
console.log(`  clear:      ${clear.length}`);
console.log(`  unverified: ${unverified.length} (left in place — a failed lookup must never delete)\n`);

for (const [r, company, app] of clear.slice(0, 25)) {
  console.log("  CLEAR", r.domain.slice(0, 26).padEnd(26), `${company.slice(0, 26)} != "${app.by}" (${app.name})`.slice(0, 76));
}
if (clear.length > 25) console.log(`   … and ${clear.length - 25} more`);
console.log("\n  KEEP");
for (const [r, company, app] of keep.slice(0, 20)) {
  console.log("       ", r.domain.slice(0, 26).padEnd(26), `${app.name} [${app.by}]`.slice(0, 60));
}
for (const [r, why] of unverified) console.log("  UNVERIFIED", r.domain.padEnd(26), why);

if (!APPLY) { console.log("\nDry run. Re-run with --apply."); process.exit(0); }

const flagsBefore = db.prepare("SELECT SUM(hit) h FROM domain_flags WHERE producer = 'apps'").get().h;
db.exec("BEGIN");
let cleared = 0, backfilled = 0;
try {
  const del = db.prepare("DELETE FROM domain_state WHERE producer = 'apps' AND domain = ? AND key = ?");
  const put = db.prepare(
    "INSERT INTO domain_state (domain, producer, key, value) VALUES (?, 'apps', ?, ?) " +
    "ON CONFLICT(domain, producer, key) DO UPDATE SET value = excluded.value",
  );
  for (const [r] of clear) {
    for (const k of IOS_KEYS) cleared += Number(del.run(r.domain, k).changes);
    // The flag is recomputed from what SURVIVES, not blanked: a domain can still hold an Android
    // attribution, and blanking would claim we had measured "no apps" when we had not.
    const still = db.prepare(
      "SELECT COUNT(*) c FROM domain_state WHERE producer = 'apps' AND domain = ? AND key = 'android'",
    ).get(r.domain).c > 0;
    dbSetDomainFlag(r.domain, "apps", still, still ? "Has Android app" : "No mobile app found");
  }
  // Survivors get the publisher recorded, so the next app-stale signal names the app it is about
  // and a future wrong attribution is visible on the signal without opening the store link.
  for (const [r, , app] of keep) {
    put.run(r.domain, "iosName", app.name);
    put.run(r.domain, "iosSeller", app.by);
    backfilled++;
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

console.log(`\ncleared ${cleared} state row(s) across ${clear.length} domain(s); backfilled the publisher on ${backfilled}`);
console.log(`apps flags reading "has an app": ${flagsBefore} -> ${db.prepare("SELECT SUM(hit) h FROM domain_flags WHERE producer = 'apps'").get().h}`);
console.log(`stored iOS attributions: ${rows.length} -> ${db.prepare("SELECT COUNT(*) c FROM domain_state WHERE producer = 'apps' AND key = 'ios'").get().c}`);
console.log(`quick_check: ${db.prepare("PRAGMA quick_check").get().quick_check}`);
