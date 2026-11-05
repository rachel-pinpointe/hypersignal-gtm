// Fetch the webappanalyzer (Wappalyzer fork) technology list ONCE and cache it to disk as
// data/webappanalyzer.json (normalized [{name, category}] rows). Free + public GitHub raw, no key.
//
//   npx tsx scripts/cache-webappanalyzer.mts      (or: npm run cache:webappanalyzer)
//
// The cached file lets the isolated test launcher (start-test.mjs) merge webappanalyzer instantly and
// offline on every boot, so the test dictionary matches the real DB's count (~29k) with no network wait.
// Re-run this whenever you want to refresh the cache from upstream.
import { writeFileSync } from "node:fs";

const BASE = "https://raw.githubusercontent.com/enthec/webappanalyzer/main/src";
const LETTERS = ["_", ..."abcdefghijklmnopqrstuvwxyz".split("")];
const OUT = "data/webappanalyzer.json";
const OUT_FP = "data/webappanalyzer-fingerprints.json"; // static-HTML-matchable detection patterns

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

// Wappalyzer pattern strings carry "\;confidence:50" / "\;version:\1" suffixes — strip to the raw regex.
const cleanPat = (p: unknown): string | null => {
  if (typeof p !== "string" || !p.trim()) return null;
  const s = p.split("\\;")[0]!.trim();
  return s || null;
};
const cleanArr = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v != null ? [v] : []).map(cleanPat).filter((s): s is string => !!s);
const cleanMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { const c = cleanPat(val) ?? ""; out[k.toLowerCase()] = c; }
  return out;
};

interface FpRow { name: string; category: string | null; scriptSrc: string[]; html: string[]; meta: Record<string, string>; headers: Record<string, string> }
const rows: Array<{ name: string; category: string | null }> = [];
const fps: FpRow[] = [];
for (const L of LETTERS) {
  const obj = await getJson(`${BASE}/technologies/${L}.json`);
  if (!obj) continue;
  for (const [name, def] of Object.entries(obj)) {
    const d = def as Record<string, unknown>;
    const cats0 = d?.cats as number[] | undefined;
    const category = Array.isArray(cats0) && cats0.length ? catName(cats0[0]!) : null;
    if (!name || !name.trim()) continue;
    rows.push({ name: name.trim(), category });
    // Keep only pattern kinds matchable from statically-fetched HTML + response headers (no JS eval).
    const fp: FpRow = {
      name: name.trim(), category,
      scriptSrc: cleanArr(d.scriptSrc), html: cleanArr(d.html),
      meta: cleanMap(d.meta), headers: cleanMap(d.headers),
    };
    if (fp.scriptSrc.length || fp.html.length || Object.keys(fp.meta).length || Object.keys(fp.headers).length) fps.push(fp);
  }
  console.log(`  ${L}.json → ${Object.keys(obj).length} technologies`);
}
if (!rows.length) { console.error("no technologies fetched — aborting (nothing cached)"); process.exit(1); }

writeFileSync(OUT, JSON.stringify(rows));
writeFileSync(OUT_FP, JSON.stringify(fps));
console.log(`cached ${rows.length} webappanalyzer technologies → ${OUT}`);
console.log(`cached ${fps.length} static-matchable fingerprints → ${OUT_FP}`);
process.exit(0);
