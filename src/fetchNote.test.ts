// A phase that fetches nothing still has to say what it is doing.
//
// A watchlist run probes EVERY watched domain for a job board before it fetches a single posting, and
// on a cold cache that is the longest part of the run. Measured on the live app: a 7,470-company
// watchlist whose cache had just been emptied had 5,967 domains left to probe at ~4 a second — around
// 25 minutes during which the dock read "0 new jobs found · 0 matched" and the bar did not move.
//
// Every one of those numbers was correct. fetched, fresh and matched really were zero, and the unit
// total genuinely was not known yet, because it is only computed after discovery finishes. The screen
// was accurate and still told the user the wrong thing: it looked exactly like a hung process, which
// is what it was reported as.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchStarted, fetchNote, fetchProgress, fetchDone, activeFetches, subscribeFetch } from "./fetchBus.ts";

const KEY = "client:note-test";
const cur = () => activeFetches().find((a) => a.key === KEY);
const start = () => fetchStarted(KEY, { client: "note-test", kind: "watchlist", total: 0 });

test("a note describes the phase the counters cannot describe", () => {
  start();
  assert.equal(cur()?.note, undefined, "a run says nothing until there is something to say");
  fetchNote(KEY, "Looking for job boards: 1,503 of 7,470 companies checked");
  assert.match(String(cur()?.note), /1,503 of 7,470/);
  fetchDone(KEY, { fetched: 0, fresh: 0, matched: 0 });
});

test("clearing the note removes it — a finished phase must stop describing itself", () => {
  // The note outliving its phase is worse than never having one: it would keep saying "no jobs are
  // fetched until this finishes" while jobs were arriving, and the counters beside it moved.
  start();
  fetchNote(KEY, "Looking for job boards: 7,470 of 7,470 companies checked");
  assert.ok(cur()?.note);
  fetchNote(KEY, null);
  assert.equal(cur()?.note, undefined);
  fetchDone(KEY, { fetched: 0, fresh: 0, matched: 0 });
});

test("the note reaches a tab that is already open", () => {
  // The dock is driven by broadcasts, not by polling. A note that updated the map without emitting
  // would only appear on the next unrelated progress event — i.e. once jobs started arriving, which
  // is precisely when it is no longer needed.
  start();
  const seen: (string | undefined)[] = [];
  const off = subscribeFetch((_e, a) => { if (a.key === KEY) seen.push(a.note); });
  fetchNote(KEY, "Looking for job boards: 40 of 7,470 companies checked");
  off();
  assert.deepEqual(seen, ["Looking for job boards: 40 of 7,470 companies checked"]);
  fetchDone(KEY, { fetched: 0, fresh: 0, matched: 0 });
});

test("a note on a run that has already ended is ignored, not resurrected", () => {
  start();
  fetchDone(KEY, { fetched: 0, fresh: 0, matched: 0 });
  fetchNote(KEY, "too late");
  assert.equal(cur(), undefined, "a finished run must not reappear in the active list");
});

test("real progress still overwrites nothing — the note and the counters are independent", () => {
  start();
  fetchNote(KEY, "Looking for job boards: 100 of 7,470 companies checked");
  fetchProgress(KEY, { completed: 3, fetched: 40, fresh: 12, matched: 5 });
  assert.equal(cur()?.fresh, 12);
  assert.ok(cur()?.note, "fetchProgress must not silently drop it — only fetchNote(null) clears it");
  fetchDone(KEY, { fetched: 40, fresh: 12, matched: 5 });
});
