// Focused probe: is Craigslist actually usable from here, and what does the HTML contain?
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const browserHeaders = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://newyork.craigslist.org/",
  "sec-ch-ua": '"Chromium";v="126", "Not.A/Brand";v="24"',
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Upgrade-Insecure-Requests": "1",
};

async function get(label, url, headers) {
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    const text = await res.text();
    const markers = {
      "cl-search-result": (text.match(/cl-search-result/g) || []).length,
      "cl-static-search-result": (text.match(/cl-static-search-result/g) || []).length,
      "result-row": (text.match(/result-row/g) || []).length,
      "<li": (text.match(/<li/g) || []).length,
      "blocked/denied": /blocked|denied|unusual|automated|too many requests/i.test(text.slice(0, 3000)),
      "title": (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || "",
    };
    console.log(`\n[${label}] ${url}`);
    console.log(`  status=${res.status} ct=${res.headers.get("content-type")} len=${text.length}`);
    console.log(`  markers:`, JSON.stringify(markers));
    console.log(`  head: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`\n[${label}] ${url}\n  ERROR ${e.message}`);
  }
}

await get("HTML rich headers", "https://newyork.craigslist.org/search/jjj?query=bookkeeper", browserHeaders);
await get("RSS rich headers", "https://newyork.craigslist.org/search/jjj?query=bookkeeper&format=rss", { ...browserHeaders, Accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.8" });
await get("HTML no query", "https://newyork.craigslist.org/search/jjj", browserHeaders);

// Fix Tier-1 misses with correct tokens/endpoints
console.log("\n--- Tier 1 retries ---");
async function jsonProbe(label, url, pick) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    const t = await res.text();
    let n = -1; try { n = pick(JSON.parse(t)); } catch {}
    console.log(`  ${res.status}  ${label.padEnd(28)} ${n >= 0 ? n + " jobs" : "shape? " + t.slice(0, 60)}`);
  } catch (e) { console.log(`  ERR ${label}: ${e.message}`); }
}
await jsonProbe("Lever (lever)", "https://api.lever.co/v0/postings/lever?mode=json", j => j.length);
await jsonProbe("Workable (gohire)", "https://www.workable.com/api/accounts/gohire", j => j?.jobs?.length);
await jsonProbe("Workable (apply widget)", "https://apply.workable.com/api/v1/widget/accounts/jobs?account=workable", j => j?.jobs?.length);
