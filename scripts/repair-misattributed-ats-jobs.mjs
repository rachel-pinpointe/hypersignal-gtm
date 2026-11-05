// Remove job rows that were pulled from ANOTHER COMPANY'S applicant-tracking board.
//
// The bug (fixed in src/sources/ats.ts): an ATS board slug is GUESSED from the domain name
// ("tcm.llc" -> "tcm"), and Greenhouse/Lever/Ashby/Personio tenants are a first-come global
// namespace. Whoever registered that name first owns it. Discovery accepted any board that answered
// to the guessed slug and stamped the watched domain on every posting it published:
//
//   us.com   -> greenhouse:us    served itel International's roles
//   abc.edu  -> greenhouse:abc   served "ThoughtWorks_new"
//   ohio.edu -> greenhouse:ohio  served OH.io, a Columbus startup-jobs brand
//   tcm.llc  -> personio:tcm     served TCM Systems GmbH (Austria)
//
// verifyBoard now gates discovery, which stops NEW ones. It cannot un-write the rows already stored,
// and those rows are the harmful part: the Companies view shows a watched account as actively hiring
// for roles it has never posted, and both the CSV export and the webhook carry them out to whatever
// the user does next.
//
// TWO things are cleaned, and the second matters as much as the first:
//   1. raw_jobs rows (and their matches) from a board that fails verification.
//   2. the ats_boards discovery cache rows that recorded the board as found. Those are read BEFORE
//      any probe (discoverAndCacheAts returns cached hits without re-verifying), so leaving them
//      would re-import the same wrong jobs on the next fetch until the 24h positive TTL expired.
//
// This re-probes each cached board LIVE and re-runs the real verifyBoard, rather than hardcoding a
// list — so it deletes what is genuinely wrong today, not what was wrong when this was written.
//
// DRY RUN BY DEFAULT. It prints what it would delete and changes nothing. Pass --apply to delete.
//   node scripts/repair-misattributed-ats-jobs.mjs                 # report only
//   node scripts/repair-misattributed-ats-jobs.mjs --apply         # delete
//   SIGNAL_DB=data/copy.db node scripts/repair-misattributed-ats-jobs.mjs --apply   # on a copy first
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const PATH = process.env.SIGNAL_DB ?? "data/signals.db";
const APPLY = process.argv.includes("--apply");

// Import the app's own gate so the script can never drift from the rule the engine enforces. ats.ts
// pulls in db.ts, which opens SIGNAL_DB and migrates on import — point that at a throwaway file for
// the duration so importing a module can't touch the database this script is auditing.
const realDb = process.env.SIGNAL_DB;
process.env.SIGNAL_DB = resolve(process.env.TEMP ?? "/tmp", `ats-repair-scratch-${process.pid}.db`);
const ats = await import(pathToFileURL(resolve("src/sources/ats.ts")).href);
if (realDb === undefined) delete process.env.SIGNAL_DB; else process.env.SIGNAL_DB = realDb;

const FETCHERS = {
  greenhouse: ats.fetchGreenhouse, lever: ats.fetchLever, ashby: ats.fetchAshby,
  smartrecruiters: ats.fetchSmartRecruiters, personio: ats.fetchPersonio,
  workable: ats.fetchWorkable, recruitee: ats.fetchRecruitee,
};

const db = new DatabaseSync(PATH, { readOnly: !APPLY });
const boards = db.prepare(`SELECT domain, vendor, slug FROM ats_boards WHERE found = 1 AND slug IS NOT NULL`).all();
console.log(`${boards.length} accepted board(s) in the discovery cache — re-probing each one.\n`);

const bad = [], unprobeable = [];
let next = 0;
const worker = async () => {
  for (let i = next++; i < boards.length; i = next++) {
    const b = boards[i];
    const f = FETCHERS[b.vendor];
    if (!f) { unprobeable.push({ ...b, why: "no fetcher for this vendor" }); continue; }
    let jobs = [];
    try { jobs = await f(b.slug, b.domain, { existenceOnly: true }); }
    catch (e) { unprobeable.push({ ...b, why: e.message }); continue; }
    // An empty board proves nothing either way (a wrong slug and a company with no openings look
    // identical), so it is left alone rather than deleted on absent evidence.
    if (!jobs.length) { unprobeable.push({ ...b, why: "board is empty right now" }); continue; }
    if (!ats.verifyBoard(b.domain, b.slug, jobs)) {
      bad.push({ ...b, names: [...new Set(jobs.map((j) => j.company).filter(Boolean))].slice(0, 3) });
    }
  }
};
await Promise.all(Array.from({ length: 6 }, worker));

if (unprobeable.length) console.log(`(${unprobeable.length} board(s) could not be re-checked and are left untouched)\n`);
if (!bad.length) { console.log("Nothing to repair — every re-probed board verifies."); db.close(); process.exit(0); }

const selJobs = db.prepare(`SELECT id, title, company FROM raw_jobs WHERE source = ? AND domain = ?`);
const countMatches = db.prepare(`SELECT COUNT(*) c FROM matches WHERE job_id = ?`);
let totalJobs = 0, totalMatches = 0;
const plan = [];
for (const b of bad) {
  const source = `ats:${b.vendor}:${b.slug}`;
  const rows = selJobs.all(source, b.domain);
  const matches = rows.reduce((s, r) => s + countMatches.get(r.id).c, 0);
  totalJobs += rows.length; totalMatches += matches;
  plan.push({ ...b, source, rows, matches });
  console.log(`${b.domain} <- ${source}`);
  console.log(`   board actually posts as: ${b.names.length ? JSON.stringify(b.names) : "(no company name given)"}`);
  console.log(`   ${rows.length} job row(s), ${matches} match row(s)`);
  for (const r of rows.slice(0, 5)) console.log(`     - ${JSON.stringify(r.company)} :: ${r.title.slice(0, 60)}`);
  if (rows.length > 5) console.log(`     ... and ${rows.length - 5} more`);
}
console.log(`\nTOTAL: ${bad.length} bad board(s), ${totalJobs} job row(s), ${totalMatches} match row(s), plus ${bad.length} stale discovery-cache row(s).`);

if (!APPLY) { console.log("\nDRY RUN — nothing changed. Re-run with --apply to delete."); db.close(); process.exit(0); }

// raw_jobs has no cascade and no triggers — every side table keyed by job_id is maintained by hand in
// src/db.ts, so deleting only the parent row leaves orphans behind. jobs_fts is the one that actually
// bites: it is an FTS5 table whose job_id column is UNINDEXED, so an orphaned row still MATCHes a
// fuzzy search and puts a deleted job back on screen through a filter that reads
// "j.id IN (SELECT job_id FROM jobs_fts WHERE jobs_fts MATCH ?)".
const delMatches = db.prepare(`DELETE FROM matches WHERE job_id = ?`);
const delTech = db.prepare(`DELETE FROM job_technologies WHERE job_id = ?`);
const delOrigin = db.prepare(`DELETE FROM job_origins WHERE job_id = ?`);
const delFts = db.prepare(`DELETE FROM jobs_fts WHERE job_id = ?`);
const delJob = db.prepare(`DELETE FROM raw_jobs WHERE id = ?`);
const delBoard = db.prepare(`DELETE FROM ats_boards WHERE domain = ? AND vendor = ? AND slug = ?`);
db.exec("BEGIN");
try {
  for (const p of plan) {
    for (const r of p.rows) { delMatches.run(r.id); delTech.run(r.id); delOrigin.run(r.id); delFts.run(r.id); delJob.run(r.id); }
    delBoard.run(p.domain, p.vendor, p.slug);
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }
console.log(`\nDeleted ${totalJobs} job row(s), ${totalMatches} match row(s), and ${bad.length} discovery-cache row(s).`);
console.log("Those domains will be re-probed on the next fetch and will only be accepted if they verify.");
db.close();
