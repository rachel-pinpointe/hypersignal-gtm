// Zero-dependency live probe of candidate job sources.
// Node 18+ (global fetch). Run: node probe.mjs
// Reports per source: HTTP status, latency, item count, and a verdict.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const TIMEOUT_MS = 15000;

/** @type {{name:string,tier:string,kind:'json'|'rss'|'html',url:string,count?:(text:string,res:Response)=>number}[]} */
const SOURCES = [
  // ---- Tier 1: public keyless JSON APIs ----
  { name: "Greenhouse (gitlab)", tier: 1, kind: "json", url: "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs", count: t => safeJson(t)?.jobs?.length ?? -1 },
  { name: "Greenhouse (stripe)", tier: 1, kind: "json", url: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs", count: t => safeJson(t)?.jobs?.length ?? -1 },
  { name: "Lever (netlify)", tier: 1, kind: "json", url: "https://api.lever.co/v0/postings/netlify?mode=json", count: t => arrLen(safeJson(t)) },
  { name: "Lever (leverdemo)", tier: 1, kind: "json", url: "https://api.lever.co/v0/postings/leverdemo?mode=json", count: t => arrLen(safeJson(t)) },
  { name: "Ashby (ashby)", tier: 1, kind: "json", url: "https://api.ashbyhq.com/posting-api/job-board/ashby", count: t => safeJson(t)?.jobs?.length ?? -1 },
  { name: "Ashby (ramp)", tier: 1, kind: "json", url: "https://api.ashbyhq.com/posting-api/job-board/ramp", count: t => safeJson(t)?.jobs?.length ?? -1 },
  { name: "Workable (sample)", tier: 1, kind: "json", url: "https://apply.workable.com/api/v1/widget/accounts/workable?details=true", count: t => safeJson(t)?.jobs?.length ?? -1 },
  { name: "The Muse", tier: 1, kind: "json", url: "https://www.themuse.com/api/public/jobs?page=1", count: t => safeJson(t)?.results?.length ?? -1 },
  { name: "Remotive API", tier: 1, kind: "json", url: "https://remotive.com/api/remote-jobs?limit=20", count: t => safeJson(t)?.jobs?.length ?? -1 },
  { name: "Arbeitnow API", tier: 1, kind: "json", url: "https://www.arbeitnow.com/api/job-board-api", count: t => safeJson(t)?.data?.length ?? -1 },
  { name: "Himalayas API", tier: 1, kind: "json", url: "https://himalayas.app/jobs/api?limit=20", count: t => safeJson(t)?.jobs?.length ?? safeJson(t)?.data?.length ?? -1 },
  { name: "HN Algolia (who is hiring)", tier: 1, kind: "json", url: "https://hn.algolia.com/api/v1/search?query=hiring&tags=comment&hitsPerPage=20", count: t => safeJson(t)?.hits?.length ?? -1 },

  // ---- Tier 2: open RSS ----
  { name: "RemoteOK RSS", tier: 2, kind: "rss", url: "https://remoteok.com/rss" },
  { name: "WeWorkRemotely RSS", tier: 2, kind: "rss", url: "https://weworkremotely.com/remote-jobs.rss" },
  { name: "WWR Customer Support RSS", tier: 2, kind: "rss", url: "https://weworkremotely.com/categories/remote-customer-support-jobs.rss" },
  { name: "Remotive RSS", tier: 2, kind: "rss", url: "https://remotive.com/remote-jobs/feed" },
  { name: "Jobicy RSS", tier: 2, kind: "rss", url: "https://jobicy.com/?feed=job_feed" },
  { name: "Craigslist NY jobs RSS (?format=rss)", tier: 2, kind: "rss", url: "https://newyork.craigslist.org/search/jjj?query=bookkeeper&format=rss" },
  { name: "Craigslist NY jobs RSS (#search rss)", tier: 2, kind: "rss", url: "https://newyork.craigslist.org/search/jjj?format=rss&query=data%20entry" },

  // ---- Tier 3/4: scrape targets (plain request to see block reality) ----
  { name: "Craigslist NY HTML", tier: 3, kind: "html", url: "https://newyork.craigslist.org/search/jjj?query=bookkeeper" },
  { name: "Indeed HTML", tier: 4, kind: "html", url: "https://www.indeed.com/jobs?q=data+entry&l=Houston%2C+TX" },
  { name: "ZipRecruiter HTML", tier: 4, kind: "html", url: "https://www.ziprecruiter.com/jobs-search?search=data+entry&location=Houston%2C+TX" },
  { name: "Google Jobs (search HTML)", tier: 4, kind: "html", url: "https://www.google.com/search?q=data+entry+jobs+houston&ibp=htl;jobs" },
];

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
function arrLen(x) { return Array.isArray(x) ? x.length : -1; }

function rssCount(t) {
  const items = (t.match(/<item[\s>]/g) || []).length;
  const entries = (t.match(/<entry[\s>]/g) || []).length;
  return Math.max(items, entries);
}

function blockSignal(status, text) {
  const low = text.slice(0, 4000).toLowerCase();
  if (status === 403 || status === 429) return "BLOCKED(" + status + ")";
  if (low.includes("just a moment") || low.includes("cf-challenge") || low.includes("cloudflare")) return "CLOUDFLARE";
  if (low.includes("captcha") || low.includes("unusual traffic") || low.includes("are you a robot")) return "CAPTCHA";
  if (low.includes("px-captcha") || low.includes("perimeterx") || low.includes("datadome")) return "BOT-WALL";
  return null;
}

async function probe(s) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(s.url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: s.kind === "json" ? "application/json,*/*" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const text = await res.text();
    const ms = Date.now() - start;
    const ct = res.headers.get("content-type") || "";

    let verdict, detail;
    const block = blockSignal(res.status, text);

    if (s.kind === "json") {
      const n = s.count ? s.count(text) : -1;
      if (block) { verdict = "❌ " + block; detail = ""; }
      else if (!res.ok) { verdict = "❌ HTTP " + res.status; detail = ct; }
      else if (n > 0) { verdict = "✅ OK"; detail = n + " jobs"; }
      else if (n === 0) { verdict = "⚠️ empty"; detail = "0 jobs (token may be invalid)"; }
      else { verdict = "⚠️ shape?"; detail = ct + " " + text.slice(0, 60).replace(/\s+/g, " "); }
    } else if (s.kind === "rss") {
      const n = rssCount(text);
      const isXml = ct.includes("xml") || text.trimStart().startsWith("<?xml") || text.includes("<rss") || text.includes("<feed");
      if (block) { verdict = "❌ " + block; detail = ""; }
      else if (!res.ok) { verdict = "❌ HTTP " + res.status; detail = ct; }
      else if (isXml && n > 0) { verdict = "✅ OK"; detail = n + " items"; }
      else if (isXml) { verdict = "⚠️ xml, 0 items"; detail = ct; }
      else { verdict = "❌ not XML"; detail = ct + " " + text.slice(0, 50).replace(/\s+/g, " "); }
    } else { // html scrape target
      if (block) { verdict = "❌ " + block; detail = "len=" + text.length; }
      else if (!res.ok) { verdict = "❌ HTTP " + res.status; detail = ct; }
      else if (text.length > 20000) { verdict = "✅ reachable"; detail = "len=" + text.length + " (needs parser)"; }
      else { verdict = "⚠️ thin"; detail = "len=" + text.length; }
    }
    return { ...s, status: res.status, ms, verdict, detail };
  } catch (e) {
    return { ...s, status: 0, ms: Date.now() - start, verdict: "❌ " + (e.name === "AbortError" ? "TIMEOUT" : "ERR"), detail: String(e.message || e).slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const s of SOURCES) {
  results.push(await probe(s));
}

results.sort((a, b) => a.tier - b.tier);
let lastTier = null;
console.log("\n=== SIGNAL ENGINE — LIVE SOURCE PROBE ===\n");
for (const r of results) {
  if (r.tier !== lastTier) {
    const labels = { 1: "TIER 1 — public keyless JSON APIs", 2: "TIER 2 — open RSS", 3: "TIER 3 — free scrape", 4: "TIER 4 — walled scrape (paid normally)" };
    console.log("\n" + labels[r.tier]);
    lastTier = r.tier;
  }
  console.log(
    "  " + r.verdict.padEnd(16) +
    String(r.ms + "ms").padStart(7) + "  " +
    r.name.padEnd(34) + "  " + (r.detail || "")
  );
}
const ok = results.filter(r => r.verdict.startsWith("✅")).length;
console.log("\n" + ok + "/" + results.length + " sources returned usable data.\n");
