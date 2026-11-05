// Phase 21: quarantine confirmed wrong-company ATS boards and seed the manual allow-list.
//
//   PLAN (read-only):  SIGNAL_DB=/path/to/copy.db npx tsx scripts/phase21-quarantine.mts --out plan.json
//   APPLY to a copy:   SIGNAL_DB=/path/to/copy.db npx tsx scripts/phase21-quarantine.mts --apply --out plan.json
//   APPLY to live:     ... --apply --live --i-have-approval     (refused without BOTH flags)
//
// What --apply does, per scripts/phase21-quarantine-seed.json:
//   1. inserts each quarantine row (ats_quarantine) and withdraws the matching ats_boards positive;
//   2. closes every OPEN raw_jobs row on that domain whose board — by source tag, hiring.cafe's raw.ats
//      hint, or apply URL — is the quarantined one, logging each in ats_quarantine_closed;
//   3. inserts the override rows (ats_board_overrides).
// The plan also re-runs the strict verifyBoard over EVERY found board using its stored postings, and
// reports which would now fail. Those are NOT quarantined or changed by this script — report only.
//
// SIGNAL_DB must be set explicitly: db.ts opens and migrates whatever it names at import time.
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const apply = flag("--apply");
const here = dirname(fileURLToPath(import.meta.url));
// Any file named signals.db under a hypersignal-style data/ directory counts as LIVE — including the
// main checkout's when this script runs from a git worktree, whose own data/ path differs. (A first cut
// compared only against this checkout's data/signals.db, so from a worktree it let the real live file
// through. Matching the shape, after resolving symlinks, closes that.)
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const isLive = (p: string) => /(^|\/)data\/signals\.db$/.test(p)
  || p === real(resolve(here, "..", "data", "signals.db"));

const dbPath = process.env.SIGNAL_DB ? real(process.env.SIGNAL_DB) : "";
if (!dbPath) { console.error("REFUSING: set SIGNAL_DB explicitly (a copy for a dry run)."); process.exit(2); }
if (isLive(dbPath) && !(flag("--live") && flag("--i-have-approval"))) {
  console.error("REFUSING: SIGNAL_DB is the live signals.db. Pass --live --i-have-approval only after sign-off.");
  process.exit(2);
}

const { db, dbQuarantineBoard, dbAddBoardOverride, dbCloseQuarantinedJobs, dbIsBoardOverridden, dbIsBoardQuarantined } = await import("../src/db.ts");
const { explainBoard, jobBoardOf } = await import("../src/sources/ats.ts");

type Seed = {
  quarantine: Array<{ domain: string; vendor: string; slug: string; reason: string }>;
  overrides: Array<{ domain: string; vendor: string; slug: string; note: string }>;
  left_alone_unsure: Array<{ domain: string; vendor: string; slug: string }>;
};
const seed = JSON.parse(readFileSync(opt("--seed") ?? resolve(here, "phase21-quarantine-seed.json"), "utf8")) as Seed;

type JobRow = { id: string; source: string; url: string; title: string; status: string; raw: string | null; company: string | null; description: string | null; last_seen_at: string | null };
const parseRaw = (r: string | null) => { try { return r ? JSON.parse(r) : null; } catch { return null; } };
const rowsForDomain = db.prepare(
  "SELECT id, source, url, title, status, raw, company, description, last_seen_at FROM raw_jobs WHERE domain = ?");

const plan: Record<string, unknown> = { db: dbPath, applied: apply, at: new Date().toISOString() };
const boards: unknown[] = [];
for (const q of seed.quarantine) {
  const dom = q.domain.toLowerCase(), slug = q.slug.toLowerCase();
  const all = rowsForDomain.all(dom) as unknown as JobRow[];
  const matched = all.filter((r) => {
    const b = jobBoardOf({ source: r.source, url: r.url, raw: parseRaw(r.raw) });
    return b && b.vendor === q.vendor && b.slug === slug;
  });
  const open = matched.filter((r) => r.status === "open");
  const boardRow = db.prepare("SELECT found, checked_at FROM ats_boards WHERE domain = ? AND vendor = ? AND lower(slug) = ?")
    .get(dom, q.vendor, slug) as { found: number; checked_at: string } | undefined;
  const entry = {
    domain: dom, board: `${q.vendor}:${slug}`, reason: q.reason,
    ats_boards_row: boardRow ? { found: boardRow.found, checked_at: boardRow.checked_at } : null,
    jobs_matched_any_status: matched.length,
    jobs_to_close: open.map((r) => ({ id: r.id, title: r.title, lane: r.source, url: r.url, last_seen_at: r.last_seen_at })),
    closed: 0,
  };
  if (apply) {
    dbQuarantineBoard(dom, q.vendor, slug, q.reason);
    entry.closed = dbCloseQuarantinedJobs(open.map((r) => ({ id: r.id, status: r.status })), { domain: dom, vendor: q.vendor, slug });
  }
  boards.push(entry);
}
plan.quarantine = boards;
if (apply) for (const o of seed.overrides) dbAddBoardOverride(o.domain, o.vendor, o.slug, o.note);
plan.overrides = seed.overrides;
plan.left_alone_unsure = seed.left_alone_unsure;

// Report only: every found board re-judged by the strict rule from its stored postings.
const found = db.prepare("SELECT domain, vendor, slug FROM ats_boards WHERE found = 1 AND slug IS NOT NULL").all() as unknown as Array<{ domain: string; vendor: string; slug: string }>;
const reverify: unknown[] = [];
for (const b of found) {
  const rows = (rowsForDomain.all(b.domain) as unknown as JobRow[]).filter((r) => {
    const k = jobBoardOf({ source: r.source, url: r.url, raw: parseRaw(r.raw) });
    return k && k.vendor === b.vendor && k.slug === b.slug.toLowerCase();
  });
  // Lever and Ashby state no employer; the company on their stored rows was filled in afterwards by
  // nameTheEmployer from the domain. A live probe sees them unnamed, so judge them unnamed here too.
  const vendorStatesName = !["ashby", "lever"].includes(b.vendor);
  const jobs = rows.map((r) => ({ id: r.id, source: r.source, externalId: r.id, title: r.title, company: vendorStatesName ? r.company : null, location: null,
    state: null, remote: false, url: r.url, postedAt: null, domain: b.domain, raw: parseRaw(r.raw), description: r.description }));
  const verdict = rows.length ? explainBoard(b.domain, b.slug, jobs as never) : { ok: false, why: "no stored postings to judge (would be re-probed live)" };
  reverify.push({ domain: b.domain, board: `${b.vendor}:${b.slug}`, stored_jobs: rows.length,
    open_jobs: rows.filter((r) => r.status === "open").length, strict_ok: verdict.ok, why: verdict.why,
    overridden: dbIsBoardOverridden(b.domain, b.vendor, b.slug), quarantined: dbIsBoardQuarantined(b.domain, b.vendor, b.slug) });
}
plan.strict_reverify = reverify;

const out = opt("--out");
if (out) writeFileSync(out, JSON.stringify(plan, null, 2));
const closeCount = (boards as Array<{ jobs_to_close: unknown[] }>).reduce((n, b) => n + b.jobs_to_close.length, 0);
console.log(`${apply ? "APPLIED" : "PLAN"}: ${boards.length} board(s) to quarantine, ${closeCount} open raw_jobs row(s) to close, ` +
  `${seed.overrides.length} override(s); strict re-verify: ${(reverify as Array<{ strict_ok: boolean }>).filter((r) => !r.strict_ok).length} of ${reverify.length} found boards would fail.`);
process.exit(0);
