// One-shot repair: clear the Meta ad flags that were produced by keyword counting.
//
// Every stored `ads` flag answers the question the producer used to ask — "how many ads in the Ad
// Library mention this company's NAME?" — while the Companies view presents it as "this company is
// running ads". Those differ for any company whose name is also an ordinary word, which on this
// data is most of them: 49% of all watched domains were flagged as active advertisers, and 43 sat
// at Meta's 50,000-result ceiling (already cleared by repair-capped-ad-readings.mjs).
//
// Unlike the app-attribution repair, individual rows cannot be re-judged. There is no stored
// evidence of WHICH ads were counted, so there is no way to tell a correct reading for a
// distinctive name from a meaningless one for a generic name. What can be said about every row is
// that it answers a different question from the one displayed next to it.
//
// So: flags go, state stays.
//
//   - A FLAG is a live claim rendered on the Companies view right now. An unverifiable claim should
//     not be displayed, so it is removed. The producer re-measures on its next pass, page-scoped.
//   - STATE is history, and it is already neutralised in code: adActivity now records `method` and
//     treats a row without `method = "page"` as a different basis, so an old keyword count is
//     re-baselined rather than diffed against. Without that, every inflated old count would fire a
//     spurious ads-stopped the first time a real page-scoped reading came in lower. Keeping the
//     rows costs nothing and preserves the record of what was measured before.
//
// Usage:  node scripts/repair-keyword-ad-flags.mjs [--apply]
import { DatabaseSync } from "node:sqlite";

const APPLY = process.argv.includes("--apply");
const d = new DatabaseSync(process.env.SIGNAL_DB ?? "data/signals.db", { readOnly: !APPLY });

const total = d.prepare("SELECT COUNT(*) c FROM domain_flags WHERE producer = 'ads'").get().c;
const hits = d.prepare("SELECT COUNT(*) c FROM domain_flags WHERE producer = 'ads' AND hit = 1").get().c;
const pageScoped = d.prepare(
  "SELECT COUNT(DISTINCT domain) c FROM domain_state WHERE producer = 'ads' AND key = 'method' AND value = 'page'",
).get().c;
console.log(`ads flags: ${total} (${hits} claiming "running ads")`);
console.log(`domains already re-measured page-scoped: ${pageScoped} — these are kept\n`);

// Anything measured by the NEW method is a real answer and must survive a re-run of this script.
const doomed = d.prepare(`
  SELECT domain FROM domain_flags WHERE producer = 'ads' AND domain NOT IN (
    SELECT domain FROM domain_state WHERE producer = 'ads' AND key = 'method' AND value = 'page')
`).all().map((r) => String(r.domain));
console.log(`keyword-derived flags to clear: ${doomed.length}`);
for (const x of doomed.slice(0, 10)) console.log("   clear ", x);
if (doomed.length > 10) console.log(`   … and ${doomed.length - 10} more`);
if (!doomed.length) { console.log("\nNothing to clear."); process.exit(0); }

// Transition signals emitted off a keyword reading are the same kind of claim. Count them so the
// number is stated rather than discovered later.
const ph = doomed.map(() => "?").join(",");
const sigs = d.prepare(
  `SELECT COUNT(*) c FROM signals WHERE type IN ('ads-started','ads-stopped') AND domain IN (${ph})`,
).get(...doomed).c;
console.log(`\nads transition signals resting on a keyword reading: ${sigs}`);

if (!APPLY) { console.log("\nDry run. Re-run with --apply."); process.exit(0); }

d.exec("BEGIN");
let removed = 0, sigsRemoved = 0;
try {
  removed = Number(d.prepare(`DELETE FROM domain_flags WHERE producer = 'ads' AND domain IN (${ph})`).run(...doomed).changes);
  sigsRemoved = Number(d.prepare(
    `DELETE FROM signals WHERE type IN ('ads-started','ads-stopped') AND domain IN (${ph})`,
  ).run(...doomed).changes);
  d.exec("COMMIT");
} catch (e) { d.exec("ROLLBACK"); throw e; }

console.log(`\nremoved ${removed} flag(s) and ${sigsRemoved} transition signal(s)`);
console.log(`ads flags remaining: ${d.prepare("SELECT COUNT(*) c FROM domain_flags WHERE producer = 'ads'").get().c}`);
console.log(`signals: ${d.prepare("SELECT COUNT(*) c FROM signals").get().c}`);
console.log(`quick_check: ${d.prepare("PRAGMA quick_check").get().quick_check}`);
