// Probe browser-driven sources in isolation: npm run probe:browser -- <name> [query]
import type { RawJob, SourceConfig } from "./types.ts";
import { hiringCafeAdapter } from "./sources/hiringcafe.ts";
import { simplyHiredAdapter } from "./sources/simplyhired.ts";
import { closeBrowsers } from "./sources/browser.ts";

const which = process.argv[2] ?? "hiringcafe";
const query = process.argv[3] ?? "customer support";

const runners: Record<string, () => Promise<RawJob[]>> = {
  hiringcafe: () => hiringCafeAdapter({ type: "hiringcafe", interval: "", query, maxPages: 3 } as SourceConfig),
  simplyhired: () => simplyHiredAdapter({ type: "simplyhired", interval: "", query, location: process.argv[4] ?? "Houston, TX", maxPages: 2 } as SourceConfig),
};

const run = runners[which];
if (!run) { console.error(`unknown source "${which}". options: ${Object.keys(runners).join(", ")}`); process.exit(1); }

console.log(`probing ${which} (query="${query}") ...`);
const jobs = await run();
console.log(`\n${which}: ${jobs.length} jobs`);
for (const j of jobs.slice(0, 10)) console.log(`  ${(j.company ?? "?").padEnd(24)} ${j.title.slice(0, 50).padEnd(52)} ${j.location ?? ""}${j.remote ? " (remote)" : ""}`);
const bad = jobs.filter((j) => !j.externalId || !j.title || !j.url);
console.log(`\nfields: ${jobs.length - bad.length}/${jobs.length} have externalId+title+url`);
console.log("sample url:", jobs[0]?.url);
await closeBrowsers();
process.exit(0);
