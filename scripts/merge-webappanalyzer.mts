// One-time (re-runnable) merge of the webappanalyzer technology list into the detection dictionary.
// Free + local: fetches the maintained Wappalyzer fork's public JSON from GitHub raw (no key, no cost),
// normalizes name + category, and MERGES via the existing import path — overlaps with the TheirStack
// seed update rather than duplicate (dedup is by lowercased name), so it's safe to run more than once.
//
//   SIGNAL_DB=data/signals.db npx tsx scripts/merge-webappanalyzer.mts     (or: npm run merge:webappanalyzer)
//
// Reversible: to reset to the TheirStack-only list, re-import that CSV in Settings → Technologies (replace).
import { importTechnologies } from "../src/techSeed.ts";
import { backfillTech } from "../src/techDetect.ts";
import { dbTechCount } from "../src/db.ts";

const BASE = "https://raw.githubusercontent.com/enthec/webappanalyzer/main/src";
const LETTERS = ["_", ..."abcdefghijklmnopqrstuvwxyz".split("")];

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.warn(`  skip ${url.split("/").pop()} — HTTP ${r.status}`); return null; }
    return await r.json() as Record<string, unknown>;
  } catch (e) { console.warn(`  skip ${url.split("/").pop()} — ${(e as Error).message}`); return null; }
}

const cats = await getJson(`${BASE}/categories.json`);
if (!cats) { console.error("could not fetch categories.json — aborting"); process.exit(1); }
const catName = (id: number): string | null => (cats[String(id)] as { name?: string })?.name ?? null;

const rows: Array<{ name: string; category: string | null }> = [];
for (const L of LETTERS) {
  const obj = await getJson(`${BASE}/technologies/${L}.json`);
  if (!obj) continue;
  for (const [name, def] of Object.entries(obj)) {
    const cats0 = (def as { cats?: number[] })?.cats;
    const category = Array.isArray(cats0) && cats0.length ? catName(cats0[0]!) : null;
    if (name && name.trim()) rows.push({ name: name.trim(), category });
  }
  console.log(`  ${L}.json → ${Object.keys(obj).length} technologies`);
}
console.log(`fetched ${rows.length} webappanalyzer technologies`);
if (!rows.length) { console.error("no technologies fetched — aborting (nothing merged)"); process.exit(1); }

const before = dbTechCount();
const processed = importTechnologies(rows, "merge"); // merge = add-or-update, dedup by lowercased name
const after = dbTechCount();
console.log(`merged: ${processed} rows processed → dictionary ${before} → ${after} (+${after - before} net-new)`);
const tagged = backfillTech(); // re-scan every stored job against the expanded dictionary
console.log(`re-tagged ${tagged} job(s) with the expanded dictionary`);
process.exit(0);
