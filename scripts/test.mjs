// Test runner. Its whole job is to point SIGNAL_DB somewhere disposable BEFORE any test file loads.
//
// Why this exists: src/db.ts defaults to data/signals.db and runs its schema/migration block at MODULE
// LOAD. Several test files import a module that transitively imports db.ts (company.test.ts -> company.ts
// -> db.ts), so a plain `tsx --test src/**` opens the real 1.1GB production database and migrates it.
// That is how `npm test` silently added two indexes to production during a UI audit — harmless that
// time, but the same path would have run a data-repair migration against real rows.
//
// Setting the variable inside package.json is not portable across shells, and setting it inside a test
// file is too late — the import graph is resolved first. A launcher is the only place early enough.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "signal-engine-test-"));
process.env.SIGNAL_DB = join(dir, "test.db");
process.env.CLIENTS_DIR = join(dir, "clients-none");   // never the real watchlists either
process.env.GDELT_GAP_MS = "0";   // the producer's real 5.2s politeness gap, against a stubbed fetch,
                                  // is 21s of the suite spent asleep. No network is touched here.

const files = [
  "src/geo.test.ts",
  "src/places.test.ts",
  "src/safeFetch.test.ts",
  "src/normalize.test.ts",
  "src/payload.test.ts",
  "src/channelParity.test.ts",
  "src/hcOptionsParity.test.ts",
  "src/uiHonesty.test.ts",
  "src/delivery.test.ts",
  "src/domainBackfill.test.ts",
  "src/backfillMatches.test.ts",
  "src/accountCacheKey.test.ts",
  "src/materialize.test.ts",
  "src/dbBulk.test.ts",
  "src/dates.test.ts",
  "src/datePosted.test.ts",
  "src/dbOrphanRuns.test.ts",
  "src/dbAtsProbe.test.ts",
  "src/dbQuarantine.test.ts",
  "src/domainResolver.test.ts",
  "src/dbDeleteChecks.test.ts",
  "src/dbRetention.test.ts",
  "src/dbLearnDomain.test.ts",
  "src/dbSalaryCurrency.test.ts",
  "src/dbDescUpgrade.test.ts",
  "src/dbExportCap.test.ts",
  "src/dbIndustries.test.ts",
  "src/dbSignalCheckCounts.test.ts",
  "src/dbSlowQueue.test.ts",
  "src/dbJobAttributed.test.ts",
  "src/deliveryBacklog.test.ts",
  "src/domainShape.test.ts",
  "src/degraded.test.ts",
  "src/fetchNote.test.ts",
  "src/scheduler.test.ts",
  "src/server.test.ts",
  "src/matcher.test.ts",
  "src/keywordMatch.test.ts",
  "src/queryEval.test.ts",
  "src/orgFacets.test.ts",
  "src/config.test.ts",
  "src/sources/ats.test.ts",
  "src/sources/hcGate.test.ts",
  "src/sources/orgTruncation.test.ts",
  "src/sources/orgCoherence.test.ts",
  "src/sources/browser.test.ts",
  "src/sources/craigslist.test.ts",
  "src/sources/remoteBoards.test.ts",
  "src/sources/simplyhired.test.ts",
  "src/techDetect.test.ts",
  "src/techSeed.test.ts",
  "src/signals/adActivity.test.ts",
  "src/signals/metaPage.test.ts",
  "src/signals/edgar.test.ts",
  "src/signals/contact.test.ts",
  "src/signals/velocity.test.ts",
  "src/signals/warn.test.ts",
  "src/signals/appPresence.test.ts",
  "src/signals/company.test.ts",
  "src/signals/classify.test.ts",
  "src/signals/gdelt.test.ts",
  "src/signals/slowQueue.test.ts",
  "src/signals/dedupKeys.test.ts",
  "src/signals/flagParity.test.ts",
];

// The list above is EXPLICIT (order matters for the DB-touching files), which means a newly written
// test file silently never runs — it passes review, it passes `npm test`, and it protects nothing.
// That already happened once: src/dbExportCap.test.ts was added and the suite total did not move.
// So the list is checked against what is actually on disk, and a missing file fails the run.
const onDisk = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".test.ts")).map((f) => "src/" + f.replaceAll("\\", "/")).sort();
const missing = onDisk.filter((f) => !files.includes(f));
if (missing.length) {
  console.error(`\nTest files exist but are not in scripts/test.mjs — they would never run:\n  ${missing.join("\n  ")}\n`);
  process.exit(1);
}
const gone = files.filter((f) => !onDisk.includes(f));
if (gone.length) { console.error(`\nListed test files that no longer exist:\n  ${gone.join("\n  ")}\n`); process.exit(1); }

// --test-concurrency=1: node --test runs each file in its own process, in parallel by default, and
// they all inherit the single SIGNAL_DB path above. Two of these files transitively import src/db.ts,
// which opens the database and immediately sets `PRAGMA journal_mode = WAL` — do that from two
// processes against the same fresh file and one of them loses the race with "database is locked".
// The whole suite runs in well under a second, so serialising costs nothing.
const r = spawnSync("npx", ["tsx", "--test", "--test-concurrency=1", ...files],
  { stdio: "inherit", shell: process.platform === "win32" });
try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
process.exit(r.status ?? 1);
