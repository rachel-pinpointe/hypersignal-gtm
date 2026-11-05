/*
 * Why do my jobs show in the Jobs database but not under Client / Account Monitoring?
 *
 *   node scripts/diagnose-monitors.mjs
 *   SIGNAL_DB=/path/to/signals.db node scripts/diagnose-monitors.mjs
 *
 * READ-ONLY. Opens the database read-only and never writes, so it is safe to run while the app is up.
 *
 * The two monitoring screens read the `matches` table. The Jobs database reads `raw_jobs`. A job in
 * one and not the other means the job was stored but no monitor claimed it, and there are several
 * different reasons that happens which look identical on screen. This runs the same gates the matcher
 * runs and names the one that rejected each job.
 *
 * The output has your company names and domains in it, because that is what makes it diagnostic.
 * Read it before sending it to anyone.
 */
import { DatabaseSync } from "node:sqlite";

const DB = process.env.SIGNAL_DB ?? "data/signals.db";
const db = new DatabaseSync(DB, { readOnly: true });
const all = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);
const has = (t) => !!one("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", t);

// Mirrors src/normalize.ts normalizeOrgDomain closely enough to diagnose (host only, strip www-ish).
const STRIP = new Set(["www", "www2", "m", "en", "us", "web", "jobs", "careers"]);
const norm = (v) => {
  let s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "").replace(/^\/+/, "").split(/[/?#]/)[0].replace(/:\d+$/, "").trim();
  const parts = s.split(".").filter(Boolean);
  while (parts.length > 2 && STRIP.has(parts[0])) parts.shift();
  return parts.join(".");
};

console.log(`database: ${DB}\n`);

// ── 1. the monitors ─────────────────────────────────────────────────────────────────────────────
const clients = all("SELECT name, config FROM clients ORDER BY name").map((r) => {
  let c = {};
  try { c = JSON.parse(r.config); } catch { /* unreadable config is itself the finding */ }
  const orgDomains = c?.search?.orgDomains ?? [];
  return {
    name: r.name,
    kind: c.kind ?? "search",
    tab: (c.kind ?? "search") === "watchlist" ? "Account Monitoring" : "Client Monitoring",
    active: c.active !== false,
    domains: Array.isArray(orgDomains) ? orgDomains.length : 0,
    keywords: Array.isArray(c?.search?.keywords) ? c.search.keywords.length : 0,
    domainSet: new Set((Array.isArray(orgDomains) ? orgDomains : []).map(norm).filter(Boolean)),
    includeOrgJobs: c?.search?.includeOrgJobs === true,
  };
});
console.log("=== MONITORS (this is what each tab can show) ===");
if (!clients.length) console.log("  NONE. Both monitoring tabs will be empty no matter what is in the Jobs database.");
else console.table(clients.map(({ name, kind, tab, active, domains, keywords, includeOrgJobs }) =>
  ({ name, kind, tab, active, domains, keywords, includeOrgJobs })));

// ── 2. the two tables the screens read ──────────────────────────────────────────────────────────
const jobs = one("SELECT COUNT(*) c FROM raw_jobs").c;
const matches = one("SELECT COUNT(*) c FROM matches").c;
console.log(`\n=== TABLES ===\nraw_jobs (Jobs database): ${jobs}\nmatches  (both monitor tabs): ${matches}`);
if (jobs && !matches) console.log("  → jobs are being stored but NOTHING is being matched. Section 4 says why.");

console.log("\n=== MATCHES PER MONITOR ===");
const perClient = all("SELECT client, COUNT(*) n FROM matches GROUP BY client ORDER BY n DESC");
if (!perClient.length) console.log("  none");
else {
  const known = new Set(clients.map((c) => c.name));
  console.table(perClient.map((r) => ({
    client: r.client, matches: r.n,
    shownOnATab: known.has(r.client) ? "yes" : "NO - this monitor no longer exists, so these are invisible",
  })));
}

// ── 3. where the jobs came from ─────────────────────────────────────────────────────────────────
console.log("\n=== JOBS BY SOURCE ===");
console.table(all("SELECT source, COUNT(*) n, SUM(CASE WHEN domain IS NULL OR domain='' THEN 1 ELSE 0 END) AS no_domain FROM raw_jobs GROUP BY source ORDER BY n DESC LIMIT 12"));

if (has("job_origins")) {
  const ac = one("SELECT COUNT(DISTINCT job_id) c FROM job_origins WHERE origin LIKE 'ac:%'")?.c ?? 0;
  console.log(`\njobs inserted by an Account Check: ${ac}`);
  if (ac) console.log(
    "  NOTE: Account Checks are one-off lookups. They store jobs (so they appear in the Jobs database)\n" +
    "  and write their own check results, but they never create matches, so they never appear under\n" +
    "  Client or Account Monitoring. That is by design. If this number is close to your total, the\n" +
    "  monitoring tabs are empty because you ran checks rather than a monitor fetch.");
}

// ── 4. for unmatched jobs, WHICH gate rejected them ─────────────────────────────────────────────
console.log("\n=== WHY RECENT UNMATCHED JOBS DID NOT MATCH ===");
const unmatched = all(`
  SELECT j.id, j.company, j.domain, j.source, j.seen_at
  FROM raw_jobs j WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.job_id = j.id)
  ORDER BY j.seen_at DESC LIMIT 10`);
if (!unmatched.length) console.log("  every stored job is matched by at least one monitor.");
else if (!clients.length) console.log("  there are no monitors to match against.");
else {
  const active = clients.filter((c) => c.active);
  if (!active.length) console.log("  every monitor is switched OFF, so nothing can match.");
  for (const j of unmatched) {
    const d = norm(j.domain);
    const isOrg = j.source === "hcorg" || String(j.source).startsWith("ats:");
    console.log(`\n  ${(j.company || "(no company)").slice(0, 34)}  [${j.source}]  domain=${d || "(none)"}`);
    if (isOrg && !d) {
      console.log("    ! this is a company-board job with NO domain recorded, so no monitor can claim it.");
      continue;
    }
    for (const c of active) {
      let why = null;
      if (c.kind === "watchlist" && !c.domainSet.has(d)) {
        why = c.domains
          ? `domain is not one of this watchlist's ${c.domains} watched domains`
          : "this watchlist has NO domains in it, so it can never match anything";
      } else if (isOrg && !c.includeOrgJobs && !c.domainSet.has(d)) {
        why = c.domains
          ? `company-board job, and its domain is not in this monitor's ${c.domains} domains`
          : "company-board job, and this monitor has no domains of its own to claim it with";
      }
      console.log(`    ${c.name}: ${why ?? "passes the domain gate — rejected later, by keywords, dates, geo or facets"}`);
    }
  }
}

db.close();
console.log("\nDone. Nothing was written.");
