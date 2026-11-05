// Free remote-job boards — RemoteOK (public JSON) and WeWorkRemotely (public RSS). Extra coverage for
// remote roles beyond hiring.cafe, opt-in per keyword search (search.extraBoards). Both are UNFILTERED
// feeds, so the matcher applies the client's keyword/date refinement locally (source-aware, like the
// local Craigslist/SimplyHired tier). Free, public, own-IP — no keys, no cost.
import { load } from "cheerio";
import { makeJob } from "../normalize.ts";
import { reportDegraded } from "./degraded.ts";
import type { RawJob, SourceConfig } from "../types.ts";

const UA = "Mozilla/5.0 (compatible; HyperSignal/1.0; +local hiring-signal tool)";
const TIMEOUT_MS = Math.max(3000, Number(process.env.BOARDS_TIMEOUT_MS ?? 15000));

async function getText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`boards-http-${r.status}`);
  return r.text();
}
const num = (v: unknown): number | undefined => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };

/** RemoteOK: GET /api → JSON array. Element 0 is a legal notice (skipped); the rest are jobs. Includes
 *  salary_min/max (USD/yr) and a tags[] tech list. */
export async function fetchRemoteOK(): Promise<RawJob[]> {
  const data = JSON.parse(await getText("https://remoteok.com/api"));
  const rows = Array.isArray(data) ? data.filter((j: any) => j && j.id && j.position) : [];
  return rows.map((j: any): RawJob | null => {
    const url = String(j.url ?? j.apply_url ?? "");
    if (!url) return null;
    const raw: Record<string, unknown> = { ats: "remoteok", tools: Array.isArray(j.tags) ? j.tags : [], hc_url: null };
    if (typeof j.description === "string" && j.description.trim()) raw.description = load(j.description).text().trim();
    const lo = num(j.salary_min), hi = num(j.salary_max);
    if (lo) raw.comp_min = lo; if (hi) raw.comp_max = hi; if (lo || hi) raw.currency = "USD";
    return makeJob({
      source: "remoteok", externalId: `rok:${j.id}`, title: String(j.position),
      company: j.company ?? null, location: j.location || "Remote", url, remote: true,
      postedAt: j.date ?? (j.epoch ? new Date(Number(j.epoch) * 1000).toISOString() : null),
      raw,
    });
  }).filter((j: RawJob | null): j is RawJob => !!j);
}

// WeWorkRemotely public category RSS feeds (title format "Company: Role").
const WWR_FEEDS: Record<string, string> = {
  programming: "remote-programming-jobs", design: "remote-design-jobs",
  marketing: "remote-marketing-jobs", sales: "remote-sales-and-marketing-jobs",
  support: "remote-customer-support-jobs", devops: "remote-devops-sysadmin-jobs",
  product: "remote-product-jobs", management: "remote-management-and-finance-jobs",
};
const WWR_DEFAULT = ["programming", "design", "marketing", "sales", "support"];

/** WeWorkRemotely: parse one or more category RSS feeds. */
export async function fetchWWR(categories: string[] = WWR_DEFAULT): Promise<RawJob[]> {
  const cats = categories.filter((c) => WWR_FEEDS[c]);
  const feeds = await Promise.all(cats.map(async (c) => {
    try { return await getText(`https://weworkremotely.com/categories/${WWR_FEEDS[c]}.rss`); }
    // Was a fully empty catch. All five feeds could fail and the adapter would then print a confident
    // "wwr -> 0 jobs" with NOTHING anywhere saying a request had failed — not even the console, which
    // its sibling fetchRemoteOK at least writes to. A dead feed and an empty feed must not look alike.
    catch (e) { const m = `weworkremotely/${c}: ${(e as Error).message}`; console.warn(`[wwr] ${m}`); reportDegraded(m); return ""; }
  }));
  const out: RawJob[] = [];
  const seen = new Set<string>();
  for (const xml of feeds) {
    if (!xml) continue;
    const $ = load(xml, { xmlMode: true });
    $("item").each((_, el) => {
      const $i = $(el);
      const rawTitle = $i.find("title").first().text().trim();
      const url = $i.find("link").first().text().trim();
      if (!rawTitle || !url || seen.has(url)) return; seen.add(url);
      const [companyPart, ...rest] = rawTitle.split(":");
      const company = rest.length ? (companyPart ?? "").trim() || null : null;
      const title = (rest.length ? rest.join(":") : rawTitle).trim();
      const descHtml = $i.find("description").first().text();
      const region = $i.find("region").first().text().trim() || $i.children("region").text().trim();
      const raw: Record<string, unknown> = { ats: "weworkremotely", hc_url: null };
      if (descHtml) raw.description = load(descHtml).text().replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
      out.push(makeJob({
        source: "weworkremotely", externalId: `wwr:${url.split("/").filter(Boolean).pop()}`,
        title, company, location: region || "Remote", url, remote: true,
        postedAt: $i.find("pubDate").first().text().trim() || null, raw,
      }));
    });
  }
  return out;
}

/** type: remoteboards — { boards: ["remoteok","wwr"], wwrCategories?: string[] }. */
export async function remoteBoardsAdapter(cfg: SourceConfig): Promise<RawJob[]> {
  if (cfg.enabled === false) return [];
  const boards = Array.isArray(cfg.boards) ? (cfg.boards as unknown[]).map(String) : [];
  const jobs: RawJob[] = [];
  const tasks: Promise<RawJob[]>[] = [];
  const swallow = (label: string) => (e: Error) => {
    const m = `${label}: ${e.message}`;
    console.warn(`[${label}] ${e.message}`); reportDegraded(m);   // a dead board must not read as an empty one
    return [] as RawJob[];
  };
  if (boards.includes("remoteok")) tasks.push(fetchRemoteOK().catch(swallow("remoteok")));
  if (boards.includes("wwr")) tasks.push(fetchWWR(Array.isArray(cfg.wwrCategories) ? (cfg.wwrCategories as string[]) : undefined).catch(swallow("wwr")));
  for (const list of await Promise.all(tasks)) jobs.push(...list);
  console.log(`[remoteboards] ${boards.join("+")} → ${jobs.length} jobs`);
  return jobs;
}
