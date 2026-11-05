// A UI label for a chip that can never render is a promise the engine cannot keep.
//
// signals/index.ts writes a current-state flag only `if (out.flag)`. A producer that never returns
// one therefore never gets a row in domain_flags, so its chip in the Companies "Why now" column and
// in the current-signals fallback feed is permanently blank — while web/app.js's PRODUCER_LABELS
// advertises it. Nothing errors; the column is just quietly emptier than it should be.
//
// This was found FOUR times before it was worth automating: techStack (912 domains with a baseline,
// 0 flags), then dns (1,018/0), subdomains (273/0) and news (953/0) in a single sweep. Reading each
// producer and remembering to check is exactly the process that missed it three times, so the
// invariant is a set difference computed here instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, ".");
const APP_JS = join(import.meta.dirname, "..", "..", "web", "app.js");

/** producer key -> its source text, for every registered producer file. */
function producerSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "types.ts" || f === "index.ts") continue;
    const src = readFileSync(join(DIR, f), "utf8");
    // The producer's own `key:` field, not a key inside a taxonomy table — take the one that sits in
    // an exported SignalProducer literal, which in every file is the first `key: "..."` after the
    // `: SignalProducer = {` opener.
    const m = /:\s*SignalProducer\s*=\s*\{[\s\S]{0,200}?key:\s*"([a-z]+)"/.exec(src);
    if (m) out.set(m[1]!, src);
  }
  return out;
}

/** Does this producer hand a current-state flag back to the runner?
 *
 *  TWO shapes, and the first draft of this test knew only one. Matching just an inline `flag: {`
 *  accused atsSwitch and appPresence, which build `const flag = …` and return it by shorthand — and
 *  the live data proves them innocent: they hold 1,324 and 396 flag rows respectively. A checklist
 *  that reports healthy code as broken is worse than no checklist, because the next person learns to
 *  ignore it. Verify the instrument against known-good cases before trusting what it accuses. */
function returnsAFlag(src: string): boolean {
  // The \b is load-bearing. Without it "xflag: {" matches, which is precisely the string a mutation
  // test produces — so the guard silently could not detect its own removal and reported healthy.
  // Caught only by mutating a real producer and noticing the suite stayed green.
  //
  // THIRD shape, and the second time this instrument was too narrow: edgar returns
  // `flag: recent.length ? { … } : NO_RECENT_FILINGS`, which is neither an inline object literal nor
  // a bare shorthand. Rather than add a third regex, ask the exit scanner — it already has the exit
  // text, and "does any exit mention a flag" is the question this function is actually asking.
  if (/\bflag:\s*\{/.test(src)) return true;                     // return { …, flag: { hit, summary } }
  if (/return\s*\{[^{}]*\bflag\b[^{}]*\}/.test(src)) return true; // const flag = …; return { …, flag }
  return checkExits(src).some((e) => /\bflag\b/.test(e.code));
}

/** The chip labels the dashboard advertises. */
function labelledKeys(): string[] {
  const app = readFileSync(APP_JS, "utf8");
  const m = /const PRODUCER_LABELS = \{([\s\S]*?)\};/.exec(app);
  assert.ok(m, "PRODUCER_LABELS not found in web/app.js — this test is measuring the wrong thing");
  return [...m[1]!.matchAll(/(\w+)\s*:/g)].map((x) => x[1]!);
}

test("the producer files parse into a key -> source map", () => {
  // Guard the instrument before trusting it: a regex that matched nothing would make every
  // assertion below vacuously pass, which is how a broken test looks exactly like a clean codebase.
  const srcs = producerSources();
  assert.ok(srcs.size >= 10, `expected 10+ producers, found ${srcs.size}: ${[...srcs.keys()].join(", ")}`);
  for (const k of ["dns", "news", "subdomains", "tech", "ats", "velocity"]) assert.ok(srcs.has(k), `missing ${k}`);
  assert.ok(labelledKeys().length >= 10, "PRODUCER_LABELS parsed as near-empty");
});

test("every producer the UI advertises a chip for actually returns a flag", () => {
  const srcs = producerSources();
  const offenders: string[] = [];
  for (const key of labelledKeys()) {
    const src = srcs.get(key);
    if (!src) continue;                                  // a label with no producer is a separate check below
    if (returnsAFlag(src)) continue;
    // Explicit, documented opt-out. launches ("ph") is a one-day-window EVENT, not a lasting state,
    // so a flag would be meaningless — it says so in the file. A waiver has to be written down.
    if (/No current-state flag/.test(src)) continue;
    offenders.push(key);
  }
  assert.deepEqual(offenders, [],
    `these producers are advertised in PRODUCER_LABELS but never return a flag, so their chip can never render: ${offenders.join(", ")}`);
});

/** The four ways a producer can legitimately exit having measured NOTHING, so that leaving the last
 *  real answer in place is correct and writing "no" would be a lie. Kept as one list rather than as
 *  a comment repeated at seventeen exits, because the classification is the point and it should be
 *  readable in one place — and because a NEW exit that matches none of these is exactly the thing
 *  this test exists to catch. */
const NOT_MEASURED: RegExp[] = [
  /no company name resolved/,            // name-keyed producer, no name — nothing could be looked up
  /ctx\.stop\?\.\(\)/,                   // the user aborted the run part-way through this domain
  /unavailable|unreachable|retry next scan|returned HTTP/,  // the source failed to answer (429, WAF, timeout, dead site)
  /no API key|saved API key|API key rejected/,  // not configured, or the key was refused — nothing measured
];

/** Every TOP-LEVEL `return` out of a producer's `check()`, as source text.
 *
 *  Top-level means an exit of check() itself, at its own indentation — not a return inside a nested
 *  helper or IIFE (appPresence builds its flag in one), and not a return from a module-level helper
 *  defined earlier in the file (edgar and appPresence both have those). Braces are counted so a
 *  multi-line return object is captured whole. */
interface Exit { code: string; lead: string }
function checkExits(src: string): Exit[] {
  const start = src.indexOf("async check(");
  if (start < 0) return [];
  const lines = src.slice(start).split("\n");
  const out: Exit[] = [];
  for (let i = 0; i < lines.length; i++) {
    // An exit of check() sits at 4 spaces: either "    return {" or "    if (…) return {".
    if (!/^\s{4,}(?:if \(.*?\) )?return \{/.test(lines[i]!)) continue;
    // Include the comment block immediately above: that is where a deliberate flagless exit says so,
    // and reading only the return line would make every such waiver invisible to this test.
    // One intervening code line is tolerated, because the guard is usually written as
    //   // why this exit measures nothing
    //   if (cond) {
    //     return { … };
    // and stopping at the `if` would hide the very comment being looked for.
    let lead = "", skipped = 0;
    for (let k = i - 1; k >= 0; k--) {
      if (/^\s*\/\//.test(lines[k]!)) { lead = lines[k] + "\n" + lead; continue; }
      if (lines[k]!.trim() && skipped++ < 1) continue;
      break;
    }
    let code = "", depth = 0;
    for (let j = i; j < lines.length; j++) {
      code += lines[j] + "\n";
      for (const ch of lines[j]!) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (depth <= 0) break;
    }
    // An exit of check() always returns `facts` — that is its contract. This is what separates a real
    // exit from a return inside a nested helper, and it is why the indentation above is a floor
    // rather than an exact depth: two of edgar's exits sit inside an `if (!sub) { … }` block, so a
    // strict 4-space rule would have skipped the very exits this test was written to catch.
    //
    // `code` and `lead` are kept APART. Searching one blob for the word "flag" meant a comment
    // explaining a missing flag counted as having one — every fix in this sweep is documented in a
    // comment mentioning flags, so the blob version passed while the flags themselves were deleted.
    if (/\bfacts\b/.test(code)) out.push({ code, lead });
  }
  return out;
}

test("EVERY exit of a producer carries a flag, or says in a comment why it cannot", () => {
  // The finer-grained half of the invariant above, and the one that matters in practice.
  //
  // The file-level test only asks whether a producer returns a flag from ANY exit. velocity and
  // edgar both did — from their main exit — and both passed while answering almost nothing. Measured
  // on the live 1,280-domain watchlist: velocity returned early with "Jobs on record: 0" for 1,146
  // domains and edgar with 'no SEC filer matches "…"' for 1,164, every one of them flagless. So the
  // two filters that looked healthy were in fact deciding for 134 and 67 companies respectively, and
  // the other ~1,150 were neither a yes nor a no but simply missing.
  //
  // The distinction a flagless exit must respect is NOT positive-vs-negative. It is MEASURED vs
  // UNKNOWN. "The SEC has no such filer" and "we hold no postings for this domain" are measurements,
  // and a measurement belongs in the flag even when the answer is no. "EDGAR returned 429" and "no
  // company name resolved" are not measurements, and those must leave the previous answer standing —
  // overwriting a real yes with a no because a fetch failed is the worse bug of the two.
  //
  // So a flagless exit is allowed, but it has to be deliberate and it has to say so.
  const srcs = producerSources();
  const offenders: string[] = [];
  for (const [key, src] of srcs) {
    if (/No current-state flag/.test(src)) continue;            // whole-producer waiver (launches)
    for (const exit of checkExits(src)) {
      if (/\bflag\b/.test(exit.code)) continue;                 // the CODE carries a flag — the comment doesn't count
      if (NOT_MEASURED.some((re) => re.test(exit.code))) continue;   // a recognised no-measurement exit
      // Anything else has to say so for itself, with the marker "no-flag:" on or above the return.
      //
      // The hyphen is load-bearing, and it took a mutation test to see why. The first version matched
      // the plain words "no flag", which is a phrase that turns up naturally in prose — including in
      // the very comments written to EXPLAIN these fixes ("Returning no flag filed the company as
      // UNKNOWN"). So the act of documenting a bug silently waived the check on it, and deleting the
      // flag that comment described left the suite green. "no-flag:" is a token, not a phrase.
      if (/\/\/[^\n]*\bno-flag:/i.test(exit.lead + exit.code)) continue;
      offenders.push(`${key}: ${exit.code.trim().split("\n")[0]!.slice(0, 88)}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these producer exits return no flag and no reason — either flag the measurement, or add a "// no-flag: <why>" comment:\n  ${offenders.join("\n  ")}`);
});

test("the exit scanner actually finds the exits", () => {
  // Guard the instrument, same as above. A scanner that found nothing would make the test vacuous,
  // and this one is a brace-counter over source text — exactly the sort of thing that quietly stops
  // matching after a reformat.
  const srcs = producerSources();
  assert.ok(checkExits(srcs.get("edgar")!).length >= 5, "edgar has 5+ exits");
  assert.ok(checkExits(srcs.get("velocity")!).length >= 2, "velocity has 2 exits");
  // ...and it must not be fooled by a return that belongs to a nested helper rather than to check().
  assert.ok(checkExits(srcs.get("apps")!).every((e) => !/\bhit: p\.length\b/.test(e.code)),
    "the IIFE that builds appPresence's flag is not an exit of check()");
});

test("every advertised label maps to a producer that exists", () => {
  // The other direction of the set difference: a label for a producer that was renamed or removed
  // renders nothing and hides the fact that the data is gone.
  const srcs = producerSources();
  const unknown = labelledKeys().filter((k) => !srcs.has(k));
  assert.deepEqual(unknown, [], `PRODUCER_LABELS names producers that do not exist: ${unknown.join(", ")}`);
});
