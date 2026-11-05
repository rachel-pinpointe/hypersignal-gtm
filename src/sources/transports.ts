// Two ways to fetch a hiring.cafe URL's HTML, both FREE (your own IP, no proxies, no paid scraper):
//
//   fetchViaHttp    — a plain HTTP GET. ~100× lighter than a browser (no Chromium context), so hundreds
//                     can run at once. hiring.cafe server-renders all job data into <script id="__NEXT_DATA__">,
//                     so the HTML alone carries everything — no JS execution needed. Most requests clear
//                     with just realistic headers.
//   fetchViaBrowser — the fingerprinted Playwright path (src/sources/browser.ts), used ONLY as a fallback
//                     for requests that hit a Cloudflare/anti-bot wall.
//
// The hcGate coordinator (hcFetchHtml) decides which lane to use per request. Both return the page HTML;
// the parsers in hiringcafe.ts extract __NEXT_DATA__ from it identically, so the two lanes are interchangeable.
import { runPage, looksBlocked } from "./browser.ts";

// A coherent, current desktop-Chrome header set. Cheap requests from one residential IP read as a normal
// browser; the adaptive gate keeps the rate below hiring.cafe's challenge threshold.
const HTTP_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

const HTTP_TIMEOUT_MS = Math.max(3000, Number(process.env.HC_HTTP_TIMEOUT_MS ?? 20000));

/** Plain HTTP GET → HTML. Throws "…blocked" on a bot wall (403/429/challenge) so the gate falls back to
 *  the browser; throws on network/timeout too (also a fallback trigger). Returns the HTML for any other
 *  status (incl. 404) — the parsers handle a missing __NEXT_DATA__ as an empty result, matching the
 *  browser path's behavior. */
export async function fetchViaHttp(url: string): Promise<string> {
  const res = await fetch(url, { headers: HTTP_HEADERS, redirect: "follow", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const html = await res.text();
  if (res.status === 403 || res.status === 429 || looksBlocked(html, res.status)) throw new Error("hiringcafe-blocked");
  return html;
}

/** Fingerprinted Playwright fetch → the rendered HTML (page.content()). The fallback lane. */
export async function fetchViaBrowser(url: string, timeoutMs = 45000): Promise<string> {
  return runPage({ site: "hiringcafe", timeoutMs }, async (page) => {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const html = await page.content();
    if (looksBlocked(html, resp?.status())) throw new Error("hiringcafe-blocked");
    return html;
  });
}
