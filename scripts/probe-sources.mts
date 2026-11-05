// Live smoke probe for the job SOURCES. Every one of them is a scrape of somebody else's site, so
// the failure mode is silent: the API shape changes, the adapter returns zero, and the app simply
// goes quiet rather than erroring. Nothing in the test suite can catch that — the tests stub fetch,
// which is correct for them and useless for this.
//
// Run it when the feed looks thin, or after a long gap, to tell "nobody is hiring" apart from
// "we stopped being able to read the site".
//
// Usage:  npx tsx scripts/probe-sources.mts
import { hiringCafeAdapter, hiringCafeOrgAdapter } from "../src/sources/hiringcafe.ts";
import { buildSearchState } from "../src/hiringcafeFilters.ts";
import { craigslistAdapter } from "../src/sources/craigslist.ts";
import { remoteBoardsAdapter } from "../src/sources/remoteBoards.ts";
import { fetchGreenhouse, fetchLever, fetchAshby, fetchSmartRecruiters } from "../src/sources/ats.ts";
import { closeBrowsers } from "../src/sources/browser.ts";

const line = (name: string, n: number | string, extra = "") =>
  console.log(`  ${String(n).padStart(6)}  ${name.padEnd(28)} ${extra}`);

async function probe(name: string, fn: () => Promise<Array<{ title?: string; company?: string | null }>>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    line(name, r.length, `${Date.now() - t0}ms ${r[0] ? `| ${String(r[0].title).slice(0, 44)}` : "| (empty)"}`);
    return r.length;
  } catch (e) { line(name, "ERR", `| ${String((e as Error).message).slice(0, 60)}`); return 0; }
}

console.log("\nsource                                 jobs  detail");
await probe("hiringcafe:keyword", () => hiringCafeAdapter({
  type: "hiringcafe", interval: "0 * * * *", maxPages: 1,
  searchState: buildSearchState({ keywords: ["driver"] }, { searchQuery: "driver" }),
} as never));
await probe("hiringcafe:org", () => hiringCafeOrgAdapter({
  type: "hcorg", interval: "0 * * * *", maxPages: 1, domain: "stripe.com",
} as never));
await probe("greenhouse", () => fetchGreenhouse("stripe", null, { existenceOnly: true }));
await probe("lever", () => fetchLever("heartworksvt", null, { existenceOnly: true }));
await probe("ashby", () => fetchAshby("ramp", null, { existenceOnly: true }));
await probe("smartrecruiters", () => fetchSmartRecruiters("Expeditors", null, { existenceOnly: true }));
await probe("craigslist:newyork", () => craigslistAdapter({
  type: "craigslist", interval: "0 * * * *", cities: ["newyork"], category: "jjj", queries: ["driver"], maxPages: 1,
} as never));
await probe("remoteok+wwr", () => remoteBoardsAdapter({
  type: "remoteboards", interval: "0 * * * *", boards: ["remoteok", "weworkremotely"],
} as never));

await closeBrowsers();
process.exit(0);
