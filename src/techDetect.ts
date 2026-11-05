// Technology detection — scans a job's title + description against a dictionary of ~24k technologies
// (the user's TheirStack list + webappanalyzer) and records which ones it mentions. Free, local,
// millisecond-fast per job via an n-gram lookup (word-boundary correct by construction: we match on
// whole-word windows, so "java" never matches inside "javascript", and "R"/"Go" only match standalone).
import { db } from "./db.ts";

interface TechEntry { id: number; names: string[] }

// Two lookup maps, rebuilt whenever the dictionary changes:
//   longMap  — lowercased name → tech id, for names ≥3 chars or with symbols (the vast majority).
//   shortMap — EXACT-case name → tech id, for ≤2-char alphabetic names (R, Go, C…), which need the
//              original casing to avoid false positives on lowercased prose.
let longMap = new Map<string, number>();
let shortMap = new Map<string, number>();
let idToCanonical = new Map<number, string>(); // tech id → canonical lowercased name (for name-based detection)
let maxWords = 1;          // longest tech name in words (bounds the n-gram window)
let ready = false;

const isShortAlpha = (s: string) => s.length <= 2 && /^[A-Za-z]+$/.test(s);

// ── the ambiguity problem ────────────────────────────────────────────────────────────────────────
//
// The dictionary is ~24k names from TheirStack + webappanalyzer, and a great many products are named
// after ordinary English words. Matching them against JOB PROSE (not a website's markup, which is what
// webappanalyzer was built for) means every warehouse posting that says "lift 50 lbs" was recorded as
// using the Lift framework. Measured on the live 24,945-job table, the MOST-DETECTED technologies were
// almost all English:
//
//   Lift 4687 · Qualified 4399 · Make 3656 · JOIN 3561 ("join our team") · Basic 3469 · Here 3191
//   Base 2717 · Impact 2346 · Community 2294 · Control 2251 · JUST 1996 · Pallet 1063 · Visa 454
//
// Python (2261), Azure (1456) and Salesforce (1342) — the answers a user actually wants — sat BELOW
// "Here" and "JUST". 140,723 tags across 21,161 jobs, and the Technologies page, the per-company tech
// chips and the technology filter were all ranked by that noise.
//
// The cure is NOT to delete these names: Spring, Make, Flow, Box and Go are real technologies, and a
// Java posting really does mean the Spring Framework. What separates the two cases is WHAT SURROUNDS
// THE WORD, so an ambiguous name is a SOFT match that has to be corroborated.
//
// The rule is PROXIMITY: an unambiguous technology has to sit within PROXIMITY_TOKENS words. A real
// stack is written as a list ("Java, Spring Boot, Hibernate"), while "lift up to 50 lbs" and whatever
// tool appears in the benefits section are paragraphs apart.
//
// Nearby, not merely present in the document — measured, not assumed. Requiring one hard hit anywhere
// in the text barely helped: "Lift" fell only from 4,687 to 3,284 and "Spring" still attached itself
// to a Primo Brands WAREHOUSE posting. With 29,334 dictionary entries virtually every job matches
// something unambiguous somewhere, so a document-level test is satisfied by almost anything.
//
// CASE WAS TRIED AND REJECTED, and the record matters because the idea is so plausible: a product is
// a proper noun, so why not demand the dictionary's own casing? The first measurement looked decisive
// — counting JOBS CONTAINING the word, exact casing versus any casing, Lift fell 4,703 to 256, JOIN
// 3,622 to 80, Make 3,716 to 336. Adding a guard for capitals that English forces anyway (start of a
// line, a bullet, after a full stop, and inside a Title Case run like "Inventory Control Specialist")
// tightened it further.
//
// Then the rule was run over the whole corpus, and the ranking it produced exposed the flaw. Counting
// how often a word appears capitalised is NOT the same question as whether the capitalised
// occurrences are the product. Job prose is full of capitalised proper nouns that are not
// technologies — above all the employer's own brands, in its own marketing copy:
//     Primo 737 hits, 730 of them Primo Brands' own postings
//     Mountain 716 and Splash 709, both ~708 Primo Brands — Mountain Valley and Splash are its drinks
//     Express 1,008, of which 949 are FedEx (FedEx Express)
// Under proximity alone those are 3 and 388. Case bought roughly 2,400 extra tags on words like
// "Basic" and gave back four brand names in the top fifteen, so it is a net loss on this corpus. The
// neighbours discriminate; the capital letter does not.
const PROXIMITY_TOKENS = 6;

// A third tier, for names so common that proximity cannot save them. "here" survived at 1,031 hits
// after the proximity rule — more than Java — because "here at Acme" and "click here" land next to a
// real technology often enough. HERE Technologies is a genuine mapping platform and genuinely
// relevant to a logistics watchlist, but it is always written out ("HERE Maps", "HERE Technologies"),
// and those multi-word names are unambiguous and still match. Only the bare adverb is refused.
const NEVER_TECH = new Set(["here"]);
//
// Ambiguity is judged per NAME, not per technology id, so a tech reached through a distinctive alias
// still counts as hard — "spring framework" is unambiguous even though "spring" is not.
//
// This list is EMPIRICAL: every entry was observed firing on the live data (the counts above are from
// that scan), rather than guessed from a dictionary. Single letters are included for the same reason —
// "C" is a real language and also the most common way to write a bullet marker.
const AMBIGUOUS_TECH = new Set([
  "a", "b", "c", "d", "e", "f", "g", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "lift", "qualified", "make", "join", "basic", "here", "base", "impact", "community", "control",
  "just", "express", "clear", "enable", "together", "point", "processing", "optimize", "balance",
  "thrive", "pallet", "spring", "route", "flow", "play", "mountain", "influence", "attribution",
  "adapt", "ice", "primo", "interact", "splash", "line-up", "beyond", "adjust", "history", "branch",
  "choices", "cargo", "unless", "twist", "merit", "retain", "forge", "capacity", "less", "visa",
  "distributor", "sharing", "box", "courier", "cornerstone", "vessel", "clarity", "element", "studio",
  "four", "circle", "fueled", "true", "motion", "component", "interactive", "dialogue", "nurture",
  "pace", "divide", "convert", "ordering", "spread", "ramp", "workspace", "bridge", "send", "abstract",
  "cursor", "turning", "vector", "fork", "signal", "signals", "ambassador", "fabric", "periodic",
  // Added after the proximity rule was measured — these survived it because they sit inside technical
  // sentences: "adopt" (the product AdOpt), "root cause" ("root cause analysis" is standard job prose),
  // "streamline" (the verb, in every operations posting).
  "adopt", "root cause", "streamline",
  "notify", "clerk", "go", "chef", "puppet", "rust", "swift", "dart", "scratch", "processing",
  "pipeline", "harvest", "compass", "atlas", "beacon", "anchor", "canvas", "prism", "origin", "summit",
]);
// Bump when AMBIGUOUS_TECH or the matching rules change, so stored tags are re-detected once.
export const TECH_RULES_VERSION = "2";

/** (Re)build the detection maps from the technologies table. Call after import + at boot. */
export function rebuildTechIndex(): void {
  longMap = new Map(); shortMap = new Map(); idToCanonical = new Map(); maxWords = 1;
  const rows = db.prepare("SELECT id, name, aliases FROM technologies").all() as Array<{ id: number; name: string; aliases: string | null }>;
  for (const r of rows) {
    idToCanonical.set(r.id, r.name.trim().toLowerCase());
    let names: string[] = [r.name];
    if (r.aliases) { try { const a = JSON.parse(r.aliases); if (Array.isArray(a)) names = names.concat(a.filter((x) => typeof x === "string")); } catch { /* ignore */ } }
    for (const raw of names) {
      const n = raw.trim(); if (!n) continue;
      const lowName = n.toLowerCase();
      if (NEVER_TECH.has(lowName)) continue;   // this NAME never matches; other aliases of the same tech still can
      if (isShortAlpha(n)) { shortMap.set(n, r.id); continue; } // exact-case short names
      const low = lowName;
      if (!longMap.has(low)) longMap.set(low, r.id);
      const wc = low.split(/\s+/).length; if (wc > maxWords) maxWords = wc;
    }
  }
  ready = rows.length > 0;
  console.log(`[tech] index built — ${rows.length} technologies (${longMap.size} names, ${shortMap.size} short, up to ${maxWords} words)`);
}

export const techReady = () => ready;

// Tokenizer: maximal runs of the chars tech names use (letters, digits, + # . -). It KEEPS internal
// and edge punctuation ("C++", "C#", "Node.js", ".NET") so leading-symbol names survive; we then try a
// leading/trailing-stripped candidate so a name at the end of a sentence ("…React.") still resolves.
const TOKEN_RE = /[A-Za-z0-9+#.\-]*[A-Za-z0-9][A-Za-z0-9+#.\-]*/g; // must contain ≥1 alphanumeric
// Strip only TRAILING "." and "-" (never internal, never leading, never the C++/C# trailing +/#). Used
// as a SECONDARY candidate — raw is tried first, so "c++"/"c#" match on their exact key; keeping the
// leading dot means ".NET" and ".NET." both resolve, while "React." → "react" still gets stripped.
const stripEdges = (s: string): string => s.replace(/[.\-]+$/, "");


/** Detect technology ids mentioned in a text (title + description). Returns a de-duplicated id set. */
export function detectTechIds(text: string): Set<number> {
  // Two buckets, not one: `hard` is matches on a distinctive name, `soft` is matches on a name that is
  // also an ordinary English word (see AMBIGUOUS_TECH). Soft matches survive only if a hard one
  // corroborates them, which is what stops "lift 50 lbs" from becoming the Lift framework.
  const hard = new Set<number>();
  const hardAt: number[] = [];                       // token indexes where a hard match started
  const soft: Array<{ id: number; at: number }> = []; // ambiguous matches, with their token index
  const found = hard;
  if (!ready || !text) return found;
  // Capture tokens WITH positions so short-name matches can inspect their neighbours in the raw text.
  const raws: string[] = []; const starts: number[] = [];
  for (const m of text.matchAll(TOKEN_RE)) { raws.push(m[0]); starts.push(m.index!); }
  const lower = raws.map((t) => t.toLowerCase());
  const core = lower.map(stripEdges); // leading/trailing "."/"-" removed, internal kept
  for (let i = 0; i < raws.length; i++) {
    // Short exact-case names (R, Go, C…): match the raw token (trailing "."/"-" trimmed for "Go.").
    const shortTok = raws[i]!.replace(/[.\-]+$/, "");
    const sid = shortMap.get(shortTok);
    if (sid) {
      // Guard the biggest false-positive source: a short name split off an abbreviation by & or /
      // ("R&D" → "R", "A/B" → "A"). If the token is immediately flanked by & or /, it's not the tech.
      const before = text[starts[i]! - 1]; const after = text[starts[i]! + raws[i]!.length];
      if (before !== "&" && before !== "/" && after !== "&" && after !== "/") {
        if (AMBIGUOUS_TECH.has(shortTok.toLowerCase())) soft.push({ id: sid, at: i });
        else { hard.add(sid); hardAt.push(i); }
      }
    }
    // n-gram windows of 1..maxWords words. Try the raw-joined gram (keeps ".net"/"c++"), and — only when
    // it differs — the edge-stripped gram (catches "react." → "react"), so both recall paths are covered.
    let gramRaw = "", gramCore = "";
    for (let w = 0; w < maxWords && i + w < lower.length; w++) {
      gramRaw = w === 0 ? lower[i]! : gramRaw + " " + lower[i + w]!;
      gramCore = w === 0 ? core[i]! : gramCore + " " + core[i + w]!;
      const take = (id: number, key: string) => {
        if (AMBIGUOUS_TECH.has(key)) soft.push({ id, at: i });
        else { hard.add(id); hardAt.push(i); }
      };
      const id = longMap.get(gramRaw); if (id) take(id, gramRaw);
      if (gramCore !== gramRaw) { const id2 = longMap.get(gramCore); if (id2) take(id2, gramCore); }
    }
  }
  // An ambiguous name survives only with an unambiguous technology within PROXIMITY_TOKENS words of
  // it. hardAt is built in ascending token order (the outer loop walks tokens left to right), so a
  // linear scan with a moving lower bound is enough — no sort, no nested rescan per soft hit.
  if (soft.length && hardAt.length) {
    let lo = 0;
    for (const s of soft) {
      while (lo < hardAt.length && hardAt[lo]! < s.at - PROXIMITY_TOKENS) lo++;
      if (lo < hardAt.length && hardAt[lo]! <= s.at + PROXIMITY_TOKENS) hard.add(s.id);
    }
  }
  return found;
}

/** Detect technologies in a text and return their canonical lowercased NAMES (for the matcher's
 *  monitor-time technology gate — lets a search/watchlist require any of a set of technologies). */
export function detectedTechNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const id of detectTechIds(text)) { const n = idToCanonical.get(id); if (n) names.add(n); }
  return names;
}

const delJobTech = db.prepare("DELETE FROM job_technologies WHERE job_id = ?");
const insJobTech = db.prepare("INSERT OR IGNORE INTO job_technologies (job_id, tech_id) VALUES (?, ?)");
/** Detect + persist a job's technologies (replaces any prior set for that job). */
export function tagJobTech(jobId: string, text: string): number {
  if (!ready) return 0;
  const ids = detectTechIds(text);
  delJobTech.run(jobId);
  for (const id of ids) insJobTech.run(jobId, id);
  return ids.size;
}

/** One-time (or post-import) backfill: detect technologies for every stored job. Transactional.
 *  Reads in rowid-ordered BATCHES so memory stays bounded even at hundreds of thousands of jobs with
 *  long descriptions (loading all rows at once would OOM a large DB). */
// Stored tags are a CACHE of the matching rules, so changing the rules has to invalidate them —
// otherwise the fix ships and every existing job keeps its old tags forever, because the boot backfill
// only fires when there are no tags at all. meta is read through db directly (getMeta is private to
// db.ts) with the same key shape the other one-shot backfills use.
const metaGet = db.prepare("SELECT v FROM meta WHERE k = ?");
const metaSet = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
/** True when the stored job_technologies were produced by an older version of the matching rules. */
export function techTagsStale(): boolean {
  return ((metaGet.get("tech:rules") as { v: string } | undefined)?.v ?? null) !== TECH_RULES_VERSION;
}

// Where an interrupted backfill got to, so the next boot resumes instead of starting over. Stored as
// "<rules version>:<rowid>" — a cursor written by an older rule set is worthless and is ignored.
const CURSOR_KEY = "tech:backfill:cursor";
const readCursor = (): number => {
  const v = (metaGet.get(CURSOR_KEY) as { v: string } | undefined)?.v ?? "";
  const i = v.lastIndexOf(":");
  if (i < 0 || v.slice(0, i) !== TECH_RULES_VERSION) return 0;
  return Number(v.slice(i + 1)) || 0;
};

/** One-time (or post-import) backfill: detect technologies for every stored job.
 *
 *  ASYNC AND CHUNKED ON PURPOSE. node:sqlite is synchronous, so this loop runs on the one thread that
 *  also serves the dashboard — while it holds the loop, the app is not slow, it is frozen. Measured on
 *  the real database it took 35,251ms over 26,356 jobs, and run.log shows it firing between
 *  "[tech] index built" and "[boot] ready": that 35-second gap IS the "why does it take so long to
 *  load" complaint. Each batch now commits and then yields, so the loading screen keeps painting and
 *  /api/ready keeps answering throughout.
 *
 *  Three things follow from chunking, and all three are deliberate:
 *   • The marker is written AFTER the last batch, not inside one giant transaction. Previously a
 *     process death during those 35 seconds rolled the whole thing back, so the next boot paid the
 *     full cost again — the intermittency behind "sometimes it's slow, sometimes it isn't".
 *   • A cursor is persisted per batch, so an interrupted run resumes near where it stopped instead of
 *     re-scanning from row 0.
 *   • There is no longer a mass "DELETE FROM job_technologies" up front. tagJobTech already replaces a
 *     job's own tags, so deleting everything first would only mean the UI showed a half-empty
 *     dictionary for the duration. Tags belonging to jobs that no longer exist are swept at the end. */
export async function backfillTech(): Promise<number> {
  if (!ready) return 0;
  const total = (db.prepare("SELECT COUNT(*) c FROM raw_jobs").get() as { c: number }).c;
  const page = db.prepare("SELECT rowid AS rid, id, title, description FROM raw_jobs WHERE rowid > ? ORDER BY rowid LIMIT ?");
  const BATCH = 500;
  let tagged = 0, seen = 0;
  let cursor = readCursor();
  const resumed = cursor > 0;
  for (;;) {
    const rows = page.all(cursor, BATCH) as Array<{ rid: number; id: string; title: string; description: string | null }>;
    if (!rows.length) break;
    db.exec("BEGIN");
    try {
      for (const r of rows) { const n = tagJobTech(r.id, `${r.title} ${r.description ?? ""}`); if (n) tagged++; cursor = r.rid; seen++; }
      metaSet.run(CURSOR_KEY, `${TECH_RULES_VERSION}:${cursor}`);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    await new Promise((r) => setImmediate(r));
  }
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM job_technologies WHERE job_id NOT IN (SELECT id FROM raw_jobs)");
    metaSet.run("tech:rules", TECH_RULES_VERSION);
    metaSet.run(CURSOR_KEY, "");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  console.log(`[tech] backfill tagged ${tagged}/${seen} job(s)${seen !== total ? ` (of ${total}${resumed ? ", resumed" : ""})` : ""}`);
  return tagged;
}
