// SimplyHired (Indeed-owned, DataDome). Free best-effort: Playwright Firefox + a
// coherent fingerprint, hourly cadence, residential IP. Probed June 2026 → 200 OK,
// real cards. If it ever walls us, we detect it and return [] (never crash the cycle).
// Cards: [data-testid=searchSerpJob]; lines = [ title, "Company —Location",
//   salary, type, ... ]. Pagination follows the page's own opaque `cursor=` link.
import { withPage, jitter, looksBlocked } from "./browser.ts";
import { makeJob } from "../normalize.ts";
import type { RawJob, SourceConfig } from "../types.ts";
import { pageCap } from "./fetchUtil.ts";
import { reportDegraded } from "./degraded.ts";

const BASE = "https://www.simplyhired.com";

// SimplyHired shows the post age as a small chip ("14d", "3 hours ago", "Today", "30+ days").
// It often renders outside the text we capture, so we read a <time datetime> when present and
// otherwise pick the one card line that is ONLY a date token (so "8 hour shift" can't be misread).
const REL = /^(\d+)\s*\+?\s*(year|yr|month|mo|week|wk|day|d|hour|hr|h|minute|min|m)s?(?:\s+ago)?$/i;
const NOWISH = /^(just posted|just now|today|posted today|new|moments? ago)$/i;
function unitMs(u: string): number {
  const map: Record<string, number> = {
    year: 31536e6, yr: 31536e6, month: 2592e6, mo: 2592e6, week: 6048e5, wk: 6048e5,
    day: 864e5, d: 864e5, hour: 36e5, hr: 36e5, h: 36e5, minute: 6e4, min: 6e4, m: 6e4,
  };
  return map[u.toLowerCase()] ?? 0;
}
/** Parse SimplyHired's relative date chip → ISO. Best-effort; null when no usable token. */
export function parsePosted(dateAttr: string, lines: string[]): string | null {
  if (dateAttr) { const t = Date.parse(dateAttr); if (!isNaN(t)) return new Date(t).toISOString(); }
  const cand = lines.map((l) => l.trim()).find((l) => NOWISH.test(l) || REL.test(l));
  if (!cand) return null;
  if (NOWISH.test(cand)) return new Date().toISOString();
  const m = cand.match(REL);
  if (!m) return null;
  const ms = unitMs(m[2]!);
  return ms ? new Date(Date.now() - Number(m[1]) * ms).toISOString() : null;
}

/** type: simplyhired — { query, location?, maxPages?, enabled? } */
export async function simplyHiredAdapter(cfg: SourceConfig): Promise<RawJob[]> {
  if (cfg.enabled === false) return [];
  const query = String(cfg.query ?? "").trim();
  const location = String(cfg.location ?? "").trim();
  const datePostedDays = cfg.datePostedDays ? Number(cfg.datePostedDays) : 0; // t= max age in days
  // Math.max(1, NaN) is NaN, and `1 <= NaN` is false — the floor of 1 did not protect this loop, so a
  // typo'd maxPages in a client YAML silently disabled the whole source. pageCap validates instead.
  const maxPages = pageCap(cfg.maxPages, 20); // follow pages until no 'next' link (or this cap)

  return withPage({ engine: "firefox", site: "simplyhired", timeoutMs: 45000 }, async (page) => {
    let url = `${BASE}/search?q=${encodeURIComponent(query)}${location ? `&l=${encodeURIComponent(location)}` : ""}${datePostedDays ? `&t=${datePostedDays}` : ""}`;
    const all: RawJob[] = [];
    const seen = new Set<string>();

    for (let pageN = 1; pageN <= maxPages; pageN++) {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
      await page.waitForTimeout(2500);
      const html = await page.content();
      if (looksBlocked(html, resp?.status())) {
        const m = `simplyhired "${query}" blocked at page ${pageN} (DataDome) — returning the ${all.length} found so far`;
        console.warn(`[simplyhired] ${m}`); reportDegraded(m);
        break;
      }

      // SimplyHired paginates via numbered links: a[data-testid="paginationBlock{N}"].
      const { cards, next } = await page.evaluate((nextPage) => {
        const cards: { href: string; lines: string[]; dateAttr: string }[] = [];
        for (const el of Array.from(document.querySelectorAll("[data-testid=searchSerpJob]"))) {
          const a = el.querySelector('a[href*="/job/"]');
          const href = a?.getAttribute("href");
          if (!href) continue;
          const timeEl = el.querySelector("time[datetime], [datetime]");
          const dateAttr = timeEl?.getAttribute("datetime") || "";
          cards.push({ href, lines: ((el as HTMLElement).innerText || "").split("\n").map((s) => s.trim()).filter(Boolean), dateAttr });
        }
        const nextEl = document.querySelector(`a[data-testid="paginationBlock${nextPage}"]`) || document.querySelector('a[rel="next"], a[aria-label="Next"]');
        return { cards, next: nextEl?.getAttribute("href") || null };
      }, pageN + 1);
      console.log(`[simplyhired]   page ${pageN}: ${cards.length} cards`);

      for (const { href, lines, dateAttr } of cards) {
        if (seen.has(href)) continue;
        seen.add(href);
        const coLine = lines[1] || "";
        const [companyPart, ...locParts] = coLine.split("—");
        // strip a trailing star-rating that bleeds into the location (e.g. "Houston, TX1.4")
        const loc = (locParts.join("—").trim() || location).replace(/\s*\d+(?:\.\d+)?$/, "").trim();
        all.push(makeJob({
          source: "simplyhired",
          externalId: href,
          title: lines[0] || "(untitled)",
          company: companyPart?.trim() || null,
          location: loc || null,
          url: href.startsWith("http") ? href : BASE + href,
          remote: /\bremote\b|work from home/i.test(lines.join(" ")),
          postedAt: parsePosted(dateAttr, lines),
          raw: { href, lines, dateAttr },
        }));
      }

      if (!next) break;
      // The href comes from the page we just scraped, and page.goto is the one outbound navigation
      // in the codebase that does not go through safeFetch. A hostile or compromised upstream page
      // could point it anywhere — including a file:// path or an internal host. Resolve it against
      // BASE and require the result to stay on SimplyHired over http(s).
      let nextUrl: URL;
      try { nextUrl = new URL(next, BASE); } catch { break; }
      const okHost = nextUrl.hostname === "www.simplyhired.com" || nextUrl.hostname.endsWith(".simplyhired.com");
      if (!/^https?:$/.test(nextUrl.protocol) || !okHost) {
        console.warn(`[simplyhired] refusing off-site pagination link: ${next.slice(0, 120)}`);
        break;
      }
      url = nextUrl.href;
      await jitter(2500, 5000); // human-like pause between pages
    }

    console.log(`[simplyhired] "${query}" → ${all.length} cards`);
    return all.filter((j) => j.title && j.title !== "(untitled)");
  });
}
