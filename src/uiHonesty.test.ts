// A failed request must never be rendered as a fact about the data.
//
// This is the defect class that produced three separate user-visible bugs in one sitting, all of
// which read as "the product is broken" rather than "the request failed":
//
//   • Typing "Oracle" or "SAP" into the technology picker → "No match in the dictionary."
//     The dictionary holds both, with 40 further matches each.
//   • Opening the New watchlist drawer → "No signal types available."
//     The engine has thirteen, and has never had zero.
//   • A timeout on the old-jobs summary → "Restore 3,781 hidden" silently vanished from the toolbar,
//     because the failure path wrote zeros and zero hides the button.
//
// Every one of them is the same two lines of code: `catch { }` leaves an empty collection, and the
// renderer treats empty as a measured answer. And every one of them is INTERMITTENT, which is what
// makes the class so expensive — the same action works a moment later, so nobody suspects the
// request. They conclude the feature is broken and stop using it.
//
// This file is a static guard over web/app.js, in the same shape as channelParity and flagParity: it
// reads the shipped source and fails if a catalogue fetch reintroduces the pattern. A DOM test would
// need a browser; the defect lives in the source, so the source is what gets checked.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const line = (needle: string): number => SRC.slice(0, SRC.indexOf(needle)).split("\n").length;

test("the source under test is the real one", async () => {
  // Guard the instrument. Every assertion below is a substring search, and a search over the wrong
  // file — or an empty one — passes silently and proves nothing.
  assert.ok(SRC.length > 100_000, `web/app.js should be the ~340KB dashboard, got ${SRC.length} bytes`);
  assert.match(SRC, /function sigProducers\(/, "sigProducers must exist for these tests to mean anything");
  assert.match(SRC, /No match in the dictionary/, "the genuine no-match message must still exist");
});

test("the technology dictionary never reports a failed lookup as a missing technology", async () => {
  // The three pickers all funnel through techLookup, which throws rather than returning []. If
  // someone reintroduces a swallowing fetch next to a "no match" message, this fails.
  assert.match(SRC, /async function techLookup\(q\)/, "the shared lookup must exist");
  assert.ok(!/items = \(await \(await fetch\("\/api\/technologies\?q="/.test(SRC),
    "a picker is calling /api/technologies directly again — it must go through techLookup, which throws on failure");
  // The apostrophe is stored as a \u2019 escape in the source, so match around it rather than on it.
  assert.match(SRC, /reach the dictionary just now/,
    "the failure path must say the request failed, not that the technology is absent");
});

test("the signal-type catalogue reports 'could not ask' separately from 'there are none'", async () => {
  // The exact bug behind "no signals available when creating an account monitoring job".
  const fn = SRC.slice(SRC.indexOf("async function sigProducers("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /catch \{ return null; \}/,
    "sigProducers must return null on failure — [] is a claim that the engine offers no signal types");
  assert.ok(!/catch \{ return \[\]; \}/.test(body), "returning [] on failure is the defect itself");
  assert.match(SRC, /load the signal types/,
    "the watchlist editor must have a distinct message for a failed catalogue fetch");
});

test("counts that drive a control's visibility are never invented on failure", async () => {
  // "Hide N old" and "Restore N hidden" are hidden when their count is 0. Writing 0 on a timeout
  // therefore REMOVES the control, which reads as "there is nothing hidden" — about the user's own
  // data, on the strength of a request that never answered.
  const i = SRC.indexOf("async function refreshOldSummary(");
  assert.ok(i > 0, "refreshOldSummary must exist");
  const body = SRC.slice(i, SRC.indexOf("\n}", i));
  assert.ok(!/catch \{ oldSummary = \{[^}]*oldCount: 0/.test(body),
    "the failure path must not fabricate zero counts");
  assert.match(body, /retrySoon\("oldSummary"/, "it must retry instead");
});

test("a failed monitor list does not erase the monitors you have", async () => {
  // AC_MONITORS feeds the "Matched by" filter. Blanking it on a timeout says "you have no account
  // checks" — again, a statement about the user's data caused by the network.
  assert.ok(!/catch \{ AC_MONITORS = \[\]; \}/.test(SRC),
    "a failed fetch must keep the last known monitors, not blank them");
  assert.match(SRC, /retrySoon\("acMonitors"/, "and must retry");
});

test("every catalogue fetch that failed gets another chance without a page reload", async () => {
  // A catalogue fetched once per session and never retried leaves a control dead until reload. Each
  // of these is a list the user picks FROM, so an empty one is not a degraded view — it is a feature
  // that appears not to exist.
  for (const key of ['"qbOpts"', '"taxonomy"', '"acMonitors"', '"oldSummary"']) {
    assert.ok(SRC.includes(`retrySoon(${key}`), `${key} has no retry — one timeout disables it for the session`);
  }
});

test("the filterable-signal list is not a second hand-written copy of the engine's", async () => {
  // The list drifted in both directions: it offered "Running Meta ads" while that producer wrote no
  // flag at all (so the filter could only ever return nothing), and omitted six producers that did.
  assert.match(SRC, /loadFilterableSignals/, "the filter must be built from /api/signals/producers");
  assert.match(SRC, /p\.flagged/, "…using the flag the producers themselves declare");
});

test("the editor's domain limit is the one the server actually enforces", async () => {
  // The browser holds its own copy of DOMAIN_CAP so the watchlist editor can say "over the limit"
  // while you are still editing, rather than only when the save comes back rejected. Two copies of a
  // number drift, and this one drifting is worse than useless: the editor would either refuse a list
  // the server would have taken, or promise to accept one the server then rejects after the rest of
  // the form is filled in. src/config.ts is the authority — it rejects an over-limit save from any
  // source, including a hand-edited YAML file.
  const { DOMAIN_CAP } = await import("./config.ts");
  const m = SRC.match(/^const DOMAIN_CAP = (\d+);/m);
  assert.ok(m, "web/app.js must declare DOMAIN_CAP");
  assert.equal(Number(m![1]), DOMAIN_CAP, "web/app.js and src/config.ts disagree about the domain limit");
});

test("an over-limit list is refused, never silently trimmed to fit", async () => {
  // Keeping the first 10,000 and dropping the rest is the silent cap this project keeps having to
  // hunt down — and here the dropped rows are companies the user chose. Which ones matter is theirs
  // to decide, so the save fails and says by how much.
  const cfg = await import("node:fs").then((fs) => fs.readFileSync("src/config.ts", "utf8"));
  const i = cfg.indexOf("is over the");
  assert.ok(i > 0, "the schema must reject an over-limit list with a message saying so");
  assert.ok(!/orgDomains[^\n]*\.slice\(0, DOMAIN_CAP\)/.test(cfg), "it must not trim the list to fit");
});
