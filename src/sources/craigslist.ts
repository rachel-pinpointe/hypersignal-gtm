// Craigslist — local backbone. RSS is hard-blocked (403), but the STATIC HTML
// search page returns `li.cl-static-search-result` rows with plain fetch + browser
// headers (probed June 2026). Parsed with cheerio; no browser automation needed.
import * as cheerio from "cheerio";
import { getText, BROWSER_UA, pageCap } from "./fetchUtil.ts";
import { reportDegraded } from "./degraded.ts";
import { makeJob } from "../normalize.ts";
import type { RawJob, SourceConfig } from "../types.ts";

const clHeaders = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Upgrade-Insecure-Requests": "1",
};

function postId(url: string): string {
  const m = url.match(/\/(\d+)\.html/);
  return m?.[1] ?? url;
}

async function searchCity(city: string, category: string, query: string, offset = 0, extra = ""): Promise<RawJob[]> {
  const url = `https://${city}.craigslist.org/search/${category}?query=${encodeURIComponent(query)}${offset ? `&s=${offset}` : ""}${extra}`;
  const { status, text } = await getText(url, { headers: { ...clHeaders, Referer: `https://${city}.craigslist.org/` } });
  // A non-200 here used to return [] silently, which the run then recorded as "this city has no
  // matching posts". Craigslist 403s under load; a blocked search and an empty one must not look alike.
  if (status !== 200) {
    const m = `craigslist/${city}: HTTP ${status} for "${query}"`;
    console.warn(`[craigslist:${city}] HTTP ${status} for "${query}"`); reportDegraded(m);
    return [];
  }

  const $ = cheerio.load(text);
  const jobs: RawJob[] = [];
  $("li.cl-static-search-result").each((_, el) => {
    const li = $(el);
    const a = li.find("a").first();
    const href = a.attr("href") ?? "";
    if (!href) return;
    const title = (li.attr("title") || li.find(".title").first().text() || a.text()).trim();
    const location = li.find(".location").first().text().trim() || null;
    jobs.push(makeJob({
      source: `craigslist:${city}`,
      externalId: postId(href),
      title,
      company: null, // craigslist rarely names the company in the list view
      location: location ?? city,
      url: href,
      postedAt: null, // not present on the static list; detail page has it
      raw: { city, query, href, title, location },
    }));
  });
  return jobs;
}

/** type: craigslist — { cities: string[], category?: string, queries: string[] } */
export async function craigslistAdapter(cfg: SourceConfig): Promise<RawJob[]> {
  const cities = (cfg.cities as string[]) ?? [];
  const category = (cfg.category as string) ?? "jjj";
  const queries = (cfg.queries as string[]) ?? [""];
  // pageCap, not bare Number(): `Number("abc")` is NaN and `0 < NaN` is false, so a typo in a
  // hand-written clients/*.yaml made this source fetch ZERO pages and return zero jobs, with no error
  // anywhere — indistinguishable from "nothing matched this week".
  const maxPages = pageCap(cfg.maxPages, 10); // safety cap; loop stops when a page yields no new posts
  // native filters: employment_type (1=FT,2=PT,3=contract,4=employee-choice), radius via postal+distance
  const ep = new URLSearchParams();
  for (const t of (cfg.employment_type as (string | number)[]) ?? []) ep.append("employment_type", String(t));
  if (cfg.postal) ep.set("postal", String(cfg.postal));
  if (cfg.search_distance) ep.set("search_distance", String(cfg.search_distance));
  const extra = ep.toString() ? `&${ep}` : "";
  const out: RawJob[] = [];
  for (const city of cities) {
    for (const query of queries) {
      const seen = new Set<string>();
      let offset = 0;
      for (let page = 0; page < maxPages; page++) {
        let pageJobs: RawJob[] = [];
        try { pageJobs = await searchCity(city, category, query, offset, extra); }
        catch (e) {
          const m = `craigslist/${city} "${query}" stopped at page ${page}: ${(e as Error).message}`;
          console.warn(`[craigslist:${city}] ${m}`); reportDegraded(m); break;
        }
        const fresh = pageJobs.filter((j) => !seen.has(j.externalId));
        for (const j of fresh) seen.add(j.externalId);
        out.push(...fresh);
        if (fresh.length === 0) break;          // no new posts → end of results
        offset += pageJobs.length;              // craigslist &s = result index to start from
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 700)); // politeness jitter
      }
    }
  }
  return out;
}
