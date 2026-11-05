// Live probe for the advertiser-page resolver. Prints, for each domain, the handles found on its
// own site, what Meta's typeahead suggested, and whether the two matched by identity.
//
// This exists because every other check on this path is a unit test over pure functions. The two
// halves that actually talk to the network — reading a footer, replaying Meta's typeahead — cannot
// be asserted in the suite, so they get exercised by hand before the producer is trusted.
//
// Usage:  npx tsx scripts/probe-meta-advertiser.mts stripe.com "Stripe" [more pairs...]
import { resolveSiteHandles, searchAdvertisers, pickHandleMatch, closeTypeahead } from "../src/signals/metaPage.ts";
import { closeBrowsers } from "../src/sources/browser.ts";

const args = process.argv.slice(2);
const pairs: Array<[string, string]> = [];
for (let i = 0; i < args.length; i += 2) pairs.push([args[i]!, args[i + 1] ?? args[i]!]);
if (!pairs.length) { console.error("usage: probe-meta-advertiser.mts <domain> <company> [...]"); process.exit(1); }

for (const [domain, company] of pairs) {
  const t0 = Date.now();
  const h = await resolveSiteHandles(domain);
  console.log(`\n${domain}`);
  console.log(`  site handles: fb=${h.facebook ?? "-"} ig=${h.instagram ?? "-"} (fetched=${h.fetched} via=${h.via}, ${Date.now() - t0}ms)`);
  if (!h.facebook && !h.instagram) { console.log("  -> would report: no advertiser page identified"); continue; }
  let pages = await searchAdvertisers(company, "US");
  console.log(`  typeahead("${company}") -> ${pages.length}`);
  for (const p of pages.slice(0, 6)) console.log(`      ${p.pageId}  alias=${p.pageAlias ?? "-"}  ig=${p.igUsername ?? "-"}  ${p.name}`);
  let hit = pickHandleMatch(pages, h);
  if (!hit) {
    const byHandle = h.facebook || h.instagram;
    console.log(`  no match on the name — retrying the typeahead with the handle "${byHandle}"`);
    pages = await searchAdvertisers(byHandle!, "US");
    for (const p of pages.slice(0, 6)) console.log(`      ${p.pageId}  alias=${p.pageAlias ?? "-"}  ig=${p.igUsername ?? "-"}  ${p.name}`);
    hit = pickHandleMatch(pages, h);
  }
  console.log(`  MATCH: ${hit ? `${hit.page.name} (page ${hit.page.pageId}) via ${hit.via}` : "none — producer reports 'no advertiser page identified'"}`);
}
closeTypeahead();
await closeBrowsers();
process.exit(0);   // Playwright keeps handles alive; the probe is done talking.
