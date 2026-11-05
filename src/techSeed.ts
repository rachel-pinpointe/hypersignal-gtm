// Technology dictionary seeding + import. The dictionary ships WITH the app and is loaded once on
// first boot; the Settings import screen can later merge or replace it. All parsing uses a real
// RFC-4180 CSV reader (some rows contain quoted commas), never a naive split.
import { readFileSync, existsSync } from "node:fs";
import { db } from "./db.ts";
import { rebuildTechIndex } from "./techDetect.ts";

/* Where the starter dictionary comes from, in order.
 *
 * This used to be one path, `data/theirstack-technologies.csv`, and `data/` is gitignored — so the
 * file existed on exactly one machine and every clone booted with ZERO technologies. Nothing said so:
 * seeding logged one line to the console and returned, the Technologies screen rendered an empty list,
 * and the filter's typeahead searched an empty table and found nothing. To a user that is not "no data
 * yet", it is "this feature is broken", and it was reported as exactly that.
 *
 * The lists below are committed, so a fresh clone has a working dictionary offline on first boot. */
const SEED_CSVS = [
  process.env.TECH_CSV,                     // explicit override always wins
  "data/technologies.csv",                  // shipped with the repo
  "data/theirstack-technologies.csv",       // the older local file, for installs that already have it
].filter((p): p is string => !!p);

// Merged on top of whichever CSV was used. Public, MIT-licensed Wappalyzer fork; also committed, so
// the seeded dictionary matches the ~29k the detector's tests are calibrated against without a
// network call at boot. Refresh it with `npm run cache:webappanalyzer`.
const SEED_WAPP = "data/webappanalyzer.json";

export interface TechRow { name: string; category?: string | null; aliases?: string[]; companies?: number; jobs?: number }

/** RFC-4180-ish CSV → rows of fields (handles quoted fields with embedded commas/quotes/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
// "534k" / "6.2M" → a number; plain ints pass through.
const parseCount = (s: string): number => {
  const t = (s ?? "").replace(/,/g, "").trim(); if (!t) return 0; // strip thousands separators first ("1,234")
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/); if (!m) return Math.round(Number(t)) || 0;
  const n = parseFloat(m[1]!); const suf = m[2]!.toLowerCase();
  return Math.round(suf === "k" ? n * 1e3 : suf === "m" ? n * 1e6 : n);
};

// `aliases` was absent from the DO UPDATE list, so a MERGE import could never add one. Aliases are
// the whole reason to re-import — they are what makes "spring framework" resolve to Spring, and the
// detector treats a distinctive alias as unambiguous where the bare name is not. The import reported
// `imported: N` and success, and nothing changed. COALESCE, matching `category` on the line above, so
// a list that omits the column still cannot erase aliases that are already there.
//
// The counts deliberately only ever rise (MAX): a partial list must not zero the popularity of a
// technology it simply does not mention.
const insTech = db.prepare(
  `INSERT INTO technologies (name, canonical, category, aliases, companies_count, jobs_count) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(canonical) DO UPDATE SET name = excluded.name, category = COALESCE(excluded.category, category),
     aliases = COALESCE(excluded.aliases, aliases),
     companies_count = MAX(companies_count, excluded.companies_count), jobs_count = MAX(jobs_count, excluded.jobs_count)`);

/** Import technology rows (merge = add/update; replace = wipe first). Returns the imported count. */
export function importTechnologies(rows: TechRow[], mode: "merge" | "replace" = "merge"): number {
  db.exec("BEGIN");
  try {
    if (mode === "replace") { db.exec("DELETE FROM technologies"); db.exec("DELETE FROM job_technologies"); }
    let n = 0;
    for (const r of rows) {
      const name = (r.name ?? "").trim(); if (!name) continue;
      const canonical = name.toLowerCase();
      insTech.run(name, canonical, r.category ?? null, r.aliases?.length ? JSON.stringify(r.aliases) : null, r.companies ?? 0, r.jobs ?? 0);
      n++;
    }
    db.exec("COMMIT");
    rebuildTechIndex();
    return n;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Parse the TheirStack CSV (Technology, Category, Companies, Jobs columns) into rows. */
export function parseTheirStackCsv(text: string): TechRow[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const ci = (name: string) => head.indexOf(name);
  const iName = ci("technology"), iCat = ci("category"), iCo = ci("companies"), iJobs = ci("jobs");
  if (iName < 0) return [];
  const out: TechRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!; const name = (cells[iName] ?? "").trim(); if (!name) continue;
    out.push({ name, category: iCat >= 0 ? (cells[iCat] ?? "").trim() || null : null,
      companies: iCo >= 0 ? parseCount(cells[iCo] ?? "") : 0, jobs: iJobs >= 0 ? parseCount(cells[iJobs] ?? "") : 0 });
  }
  return out;
}

/** Parse a user-supplied import: TheirStack CSV format OR a simple `name,category,alias1|alias2` / one-per-line list. */
export function parseImport(text: string): TechRow[] {
  const first = text.slice(0, 200).toLowerCase();
  if (first.includes("technology") && first.includes("category")) return parseTheirStackCsv(text);
  // simple format
  const out: TechRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t) continue;
    const [name, category, aliasStr] = t.split(",").map((s) => s.trim());
    if (!name || name.toLowerCase() === "name") continue;
    out.push({ name, category: category || null, aliases: aliasStr ? aliasStr.split("|").map((a) => a.trim()).filter(Boolean) : undefined });
  }
  return out;
}

/** On first boot, seed the technologies table from the lists that ship with the app.
 *
 *  Both sources are merged, because that is what the detector was tuned against: the CSV carries the
 *  adoption counts that rank the leaderboard, and webappanalyzer carries several thousand names the
 *  CSV does not have. Missing either one is survivable; missing both leaves the feature with no data,
 *  and THAT is now said out loud rather than logged and forgotten. */
export function seedTechnologiesIfEmpty(): void {
  const count = (db.prepare("SELECT COUNT(*) c FROM technologies").get() as { c: number }).c;
  if (count > 0) { rebuildTechIndex(); return; }

  let seeded = 0;
  const csv = SEED_CSVS.find((p) => existsSync(p));
  if (csv) {
    try {
      seeded = importTechnologies(parseTheirStackCsv(readFileSync(csv, "utf8")), "replace");
      console.log(`[tech] seeded ${seeded} technologies from ${csv}`);
    } catch (e) { console.warn(`[tech] seed from ${csv} failed: ${(e as Error).message}`); }
  }

  if (existsSync(SEED_WAPP)) {
    try {
      const rows = JSON.parse(readFileSync(SEED_WAPP, "utf8")) as Array<{ name?: unknown; category?: unknown }>;
      const clean = (Array.isArray(rows) ? rows : [])
        .filter((r) => typeof r?.name === "string" && r.name.trim())
        .map((r) => ({ name: String(r.name).trim(), category: typeof r.category === "string" ? r.category : null }));
      if (clean.length) {
        // MERGE, never replace: this runs after the CSV and must not drop its adoption counts.
        const n = importTechnologies(clean, "merge");
        seeded = n;
        console.log(`[tech] merged ${clean.length} webappanalyzer technologies → ${n} total`);
      }
    } catch (e) { console.warn(`[tech] webappanalyzer merge failed: ${(e as Error).message}`); }
  }

  if (!seeded) {
    console.warn(
      `[tech] NO technology dictionary loaded — looked for ${SEED_CSVS.join(", ")} and ${SEED_WAPP}. ` +
      `Technology detection and the technology filter will find nothing until a list is imported ` +
      `(Settings → Technologies), because there is nothing to match against.`,
    );
  }
}
