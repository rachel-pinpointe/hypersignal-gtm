// Probe candidate ATS boards: do they exist, how many roles, and how many match
// Hiring4Less outsourceable keywords (support/ops/data/admin)?
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const KW = ["customer support","customer service","support","data entry","data ","administrative","admin","operations","billing","bookkeep","receptionist","virtual assistant","appointment","social media","recruit","payroll","accounts payable","accounts receivable"];

const CANDIDATES = [
  ["greenhouse","stripe"],["greenhouse","gitlab"],["greenhouse","brex"],["greenhouse","robinhood"],
  ["greenhouse","databricks"],["greenhouse","dropbox"],["greenhouse","asana"],["greenhouse","gusto"],
  ["greenhouse","doordash"],["greenhouse","airbnb"],["greenhouse","coinbase"],["greenhouse","instacart"],
  ["lever","leverdemo"],["lever","plaid"],["lever","ramp"],
  ["ashby","ramp"],["ashby","ashby"],["ashby","deel"],["ashby","remote"],["ashby","vanta"],
  ["ashby","posthog"],["ashby","mercury"],["ashby","linear"],["ashby","rippling"],["ashby","openai"],
];

async function getJson(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) return { err: "HTTP " + r.status }; return { data: await r.json() }; }
  catch (e) { return { err: e.message }; } finally { clearTimeout(t); }
}

function titlesFor(provider, d) {
  if (provider === "greenhouse") return (d.jobs ?? []).map(j => j.title ?? "");
  if (provider === "lever") return (Array.isArray(d) ? d : []).map(j => j.text ?? "");
  if (provider === "ashby") return (d.jobs ?? []).map(j => j.title ?? "");
  return [];
}
function urlFor(provider, c) {
  if (provider === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${c}/jobs`;
  if (provider === "lever") return `https://api.lever.co/v0/postings/${c}?mode=json`;
  if (provider === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${c}`;
}

console.log("\nprovider:client            total  matches  sample matching titles");
console.log("-".repeat(90));
const winners = [];
for (const [provider, c] of CANDIDATES) {
  const { data, err } = await getJson(urlFor(provider, c));
  if (err) { console.log(`${(provider+":"+c).padEnd(26)} ${err}`); continue; }
  const titles = titlesFor(provider, data);
  const matching = titles.filter(t => KW.some(k => t.toLowerCase().includes(k)));
  const sample = matching.slice(0, 2).join(" | ").slice(0, 50);
  console.log(`${(provider+":"+c).padEnd(26)} ${String(titles.length).padStart(5)}  ${String(matching.length).padStart(7)}  ${sample}`);
  if (matching.length >= 3) winners.push(`${provider}:${c} (${matching.length})`);
}
console.log("\nWinners (>=3 matching roles):\n  " + winners.join("\n  "));
