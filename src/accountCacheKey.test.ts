// The Account Check caches each company's fetched jobs so repeat checks are near-instant. What goes
// into that cache key decides two different things, and the old key got both wrong at once.
//
// It hashed the whole searchState. But an /org/<domain> scan takes NO filter parameters — workplace,
// seniority, salary, department and the rest are applied afterwards by the matcher. So:
//
//   TOO BROAD  — changing any filter produced a byte-identical fetch under a brand-new key, throwing
//                the whole cache away. On a 1,280-domain check that is hours of re-scraping to
//                recompute a local filter.
//   TOO NARROW — maxPages and scrapeDescriptions DO change what comes back, and neither was in the
//                key (they live on RunOptions, not the SearchSpec being hashed). Raising the page
//                limit to reach the rest of a big company replayed the same truncated list it had
//                already stored: the user asks for more and is handed the old answer.
//
// Keywords and excludes are absent for the RIGHT reason — cache hits are re-filtered by the matcher,
// so changing them needs no refetch.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dirname, "accountCheck.ts"), "utf8");

test("the cache key is built from the fetch shape, not the filters", () => {
  const m = /const fetchShape = ([^;]+);/.exec(SRC);
  assert.ok(m, "could not find the cache key's inputs — this test would otherwise measure nothing");
  const expr = m![1]!;
  assert.match(expr, /maxPages/, "the page limit changes what is fetched and must be in the key");
  // fetchDesc = scrapeDescriptions OR a filter that MATCHES on description/technology. Either way the
  // run fetches job bodies a plain run does not, so it must not replay a body-less cached entry.
  assert.match(expr, /fetchDesc/, "description fetching changes what is stored and must be in the key");
});

test("no hiring.cafe filter reaches the cache key", () => {
  // Every one of these is applied locally, after the fetch. Any of them in the key means a filter
  // tweak re-scrapes every company for an identical result.
  const m = /const fetchShape = ([^;]+);/.exec(SRC);
  const expr = m![1]!;
  for (const f of ["workplaceTypes", "seniorityLevels", "departments", "salaryMin", "companySizeRanges",
                   "fundingStages", "industries", "keywords", "exclude", "locations"])
    assert.ok(!expr.includes(f), `"${f}" is applied after the fetch and must NOT bust the cache`);
});

test("the searchState is no longer hashed into the key at all", () => {
  // buildSearchState builds the hiring.cafe request. The /org/ path never sends one, so its presence
  // here was the whole confusion — it made filters look like they shaped the fetch.
  assert.ok(!SRC.includes("buildSearchState"),
    "accountCheck should not reference buildSearchState — /org/ takes no searchState");
});

test("cache hits are re-filtered rather than replayed as results", () => {
  // This is what makes it safe to leave keywords out of the key: the cached value is the raw job
  // list, and record() runs the matcher over it on every replay.
  assert.match(SRC, /cached\.has\(it\.key\)[\s\S]{0,120}record\(/,
    "a cache hit must go through record(), which applies the current filters");
  assert.match(SRC, /dbSetAccountCache\(it\.key, jobs\)/,
    "the cache must store the raw jobs, not the filtered hits");
});
