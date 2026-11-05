// Resolve a domain to the Meta advertiser PAGE that belongs to it — by identity, not by name.
//
// Why this module exists. The ad-activity producer used to answer "how many ads in the Ad Library
// mention this company's name?" and present the answer as "how many ads is this company running?".
// Those are different questions. A keyword search for "Compass" or "Alliance" or "Gateway" matches
// every advertiser whose copy contains the word, and the live data showed exactly that: 43 domains
// pinned at Meta's 50,000-result ceiling and an implausible 49% of all watched domains flagged as
// active advertisers.
//
// The approach here is ported from the meta-ads-scraper project in this workspace
// (src/lib/socialHandles.ts + the typeahead in src/lib/scraper.ts), which solved the same problem
// and settled on a deterministic chain:
//
//   1. Read the brand's own Facebook/Instagram handle off its own website. A company's footer links
//      to its real profile; nobody else's footer links to it.
//   2. Ask Meta's advertiser typeahead for pages matching the company name — it returns each page's
//      page_alias (FB handle) and Instagram username alongside the page id.
//   3. Match the two EXACTLY. Same handle = same entity. That is an identity check, not a guess.
//   4. No match → say so. Never fall back to counting keyword hits.
//
// Then the ads themselves come from view_all_page_id + search_type=page, which returns that
// advertiser's ads and nothing else, so the count means what the UI says it means.
import { safeFetch, assertPublicUrl } from "../safeFetch.ts";
import { runPage } from "../sources/browser.ts";
import type { BrowserContext, Page } from "playwright";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_BYTES = 1_000_000;   // footer links sit near the top; a full page body is never needed

export interface SiteHandles {
  facebook?: string;
  instagram?: string;
  fetched: boolean;   // true if we got HTML at all — distinguishes "no handles" from "couldn't look"
  via: "fetch" | "browser" | null;
}
export interface AdvertiserPage {
  pageId: string;
  name: string;
  pageAlias?: string;
  igUsername?: string;
}

// ---------------------------------------------------------------------------------------------
// Handle extraction — pure, and the part most likely to need tuning, so it is exported and tested.
// ---------------------------------------------------------------------------------------------

const FB_RE = /https?:\/\/(?:www\.|m\.|web\.)?(?:facebook|fb)\.com\/([^\s"'<>?#/]+)/gi;
const IG_RE = /https?:\/\/(?:www\.)?instagram\.com\/([^\s"'<>?#/]+)/gi;
// profile.php?id=NNN needs its own pattern. FB_RE's path segment deliberately stops at "?", so the
// id never appeared in its match and the branch that reads it could not fire — the upstream project
// this was ported from has the same gap. A numeric id is the single most useful thing a site can
// publish, since it IS a Meta page id and needs no handle matching at all, so it gets its own match.
const FB_PROFILE_ID_RE = /https?:\/\/(?:www\.|m\.|web\.)?(?:facebook|fb)\.com\/profile\.php\?(?:[^"'\s<>]*&)?id=(\d{6,})/i;

// First path segments that are Facebook's own plumbing rather than a brand's profile. Without this
// list the winner is whatever share button appears first in the markup — every site would resolve to
// "sharer.php", and every site would then match the same page.
const FB_REJECT = new Set([
  "sharer", "sharer.php", "plugins", "tr", "tr.php", "events", "event.php", "groups", "group.php",
  "pages", "marketplace", "watch", "gaming", "help", "policies", "login", "login.php", "dialog",
  "permalink.php", "story.php", "photo.php", "photo", "hashtag", "people", "public", "l.php", "flx",
  "ajax", "home.php", "recover", "reg", "privacy", "about", "careers", "business",
]);
const IG_REJECT = new Set([
  "p", "reel", "reels", "tv", "explore", "accounts", "stories", "direct", "about", "developer",
  "legal", "privacy", "tags", "web", "challenge", "emails", "session",
]);
const GENERIC = new Set(["facebook", "instagram", "meta", "share", "home", "intent", "profile"]);

function cleanSegment(seg: string): string | null {
  const s = seg.trim().toLowerCase().replace(/^@/, "").replace(/\/+$/, "");
  if (!s || s.length < 2 || s.length > 80) return null;
  if (GENERIC.has(s)) return null;
  return s;
}

/** Pull the first real FB/IG profile handle out of a page's HTML. */
export function extractHandlesFromHtml(html: string): { facebook?: string; instagram?: string } {
  const out: { facebook?: string; instagram?: string } = {};
  // A numeric page id beats any handle, so it is looked for first rather than in document order.
  const byId = FB_PROFILE_ID_RE.exec(html);
  if (byId) out.facebook = byId[1]!;
  if (!out.facebook) for (const m of html.matchAll(FB_RE)) {
    const raw = m[1]!.toLowerCase();
    if (raw.startsWith("profile.php") || FB_REJECT.has(raw)) continue;
    const h = cleanSegment(raw);
    if (h) { out.facebook = h; break; }
  }
  for (const m of html.matchAll(IG_RE)) {
    const raw = m[1]!.toLowerCase();
    if (IG_REJECT.has(raw)) continue;
    const h = cleanSegment(raw);
    if (h) { out.instagram = h; break; }
  }
  return out;
}

/** Normalize a handle for EXACT comparison. Both sides go through this or the match is meaningless. */
export function normHandle(s?: string | null): string {
  return String(s ?? "").trim().toLowerCase().replace(/^@/, "").replace(/\/+$/, "");
}

/**
 * The identity check. A typeahead suggestion is this company's page only when its own handle equals
 * a handle published on the company's website. Facebook is preferred because page_alias is what the
 * Ad Library itself keys on; Instagram is the fallback for brands that only link IG.
 *
 * There is deliberately no "close enough" branch. A near-match is the failure mode this whole module
 * exists to remove.
 */
export function pickHandleMatch(
  pages: AdvertiserPage[], site: { facebook?: string; instagram?: string },
): { page: AdvertiserPage; via: "fb" | "ig" } | null {
  const fb = normHandle(site.facebook), ig = normHandle(site.instagram);
  if (fb) {
    const hit = pages.find((p) => p.pageAlias && normHandle(p.pageAlias) === fb);
    if (hit) return { page: hit, via: "fb" };
    // A profile.php?id= link on the site gives the page id outright.
    if (/^\d{6,}$/.test(fb)) {
      const byId = pages.find((p) => p.pageId === fb);
      if (byId) return { page: byId, via: "fb" };
    }
  }
  if (ig) {
    const hit = pages.find((p) => p.igUsername && normHandle(p.igUsername) === ig);
    if (hit) return { page: hit, via: "ig" };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Tier 1/2 site fetch.
// ---------------------------------------------------------------------------------------------

/** Read at most MAX_BYTES of a response body without buffering the whole thing. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.length;
    if (received >= MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

async function tierFetch(domain: string, timeoutMs: number): Promise<{ facebook?: string; instagram?: string } | null> {
  try {
    // safeFetch, not fetch: `domain` arrives from scraped job data and uploaded lists, and it
    // re-validates every redirect hop, so a site cannot bounce us onto localhost or the LAN.
    const res = await safeFetch(`https://${domain}`, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) return null;
    return extractHandlesFromHtml(await readCapped(res));
  } catch { return null; }
}

async function tierBrowser(domain: string): Promise<{ facebook?: string; instagram?: string } | null> {
  try {
    // page.goto does not go through safeFetch, so this is the one outbound navigation in the module
    // with no private-IP rule on it. `domain` comes from a watchlist or an uploaded check list — text
    // the app did not author — so a host resolving to 127.0.0.1 or a LAN address would have the
    // headless browser fetch an internal page on the user's own network. The plain-fetch tier above
    // is already guarded because safeFetch applies this same check; the browser fallback was not.
    await assertPublicUrl(`https://${domain}`);
    return await runPage({ site: "sitehandles", timeoutMs: 15000 }, async (page) => {
      await page.goto(`https://${domain}`, { waitUntil: "domcontentloaded", timeout: 12000 });
      return extractHandlesFromHtml(await page.content());
    });
  } catch { return null; }
}

/**
 * Resolve a domain's FB/IG handles. Plain fetch first, Playwright only when that found nothing —
 * most footers are in the static HTML, and a browser session per domain is far too expensive to
 * spend when it is not needed.
 *
 * `fetched` matters as much as the handles: "we read the site and it links no social profile" is a
 * real answer, while "we could not read the site" is not, and the caller must not treat them alike.
 */
export async function resolveSiteHandles(
  domain: string, opts: { timeoutMs?: number; allowBrowser?: boolean } = {},
): Promise<SiteHandles> {
  const { timeoutMs = 8000, allowBrowser = true } = opts;
  if (!domain) return { fetched: false, via: null };
  const t1 = await tierFetch(domain, timeoutMs);
  if (t1?.facebook || t1?.instagram) return { ...t1, fetched: true, via: "fetch" };
  if (!allowBrowser) return { fetched: t1 !== null, via: null };
  const t2 = await tierBrowser(domain);
  if (t2?.facebook || t2?.instagram) return { ...t2, fetched: true, via: "browser" };
  return { fetched: t1 !== null || t2 !== null, via: null };
}

// ---------------------------------------------------------------------------------------------
// Meta advertiser typeahead.
//
// The Ad Library's search box calls a GraphQL query that returns advertiser PAGES with their
// handles. There is no documented endpoint for it, so the signature (doc_id + CSRF tokens) is
// captured once by driving the real search box, then replayed in-page for every later lookup. One
// warm browser serves the whole scan instead of one per domain.
// ---------------------------------------------------------------------------------------------

interface WarmCtx { page: Page; form: Record<string, string>; expires: number; close: () => void }
let warm: WarmCtx | null = null;
let warming: Promise<WarmCtx> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Signature capture failed — Meta renamed the query. Distinct from a transient error on purpose:
 *  this one must be visible, because it silently disables advertiser matching for every domain. */
export class MetaSignatureError extends Error {}

export function closeTypeahead(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const w = warm; warm = null;
  w?.close();
}
function bumpIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(closeTypeahead, 3 * 60_000);
  idleTimer.unref?.();   // a warm scraper page must never hold the process open
}

async function buildWarm(): Promise<WarmCtx> {
  return new Promise<WarmCtx>((resolve, reject) => {
    let settled = false;
    // runPage owns the context and closes it in its finally, so the session is held open by not
    // resolving `fn` until close() is called. That keeps the fingerprinting and teardown in one place.
    void runPage({ site: "metaads", timeoutMs: 40000 }, async (page: Page, _ctx: BrowserContext) => {
      let form: Record<string, string> | null = null;
      page.on("request", (req) => {
        if (form || req.method() !== "POST" || !req.url().includes("/api/graphql")) return;
        const post = req.postData() ?? "";
        if (!/useAdLibraryTypeaheadSuggestion/i.test(post)) return;
        const f: Record<string, string> = {};
        new URLSearchParams(post).forEach((v, k) => { f[k] = v; });
        if (f.variables && /queryString/.test(f.variables)) form = f;
      });
      try {
        await page.goto("https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&media_type=all&q=ad&search_type=keyword_unordered",
          { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3500);
        // Consent interstitials block the search box in the EU and sometimes elsewhere.
        for (const sel of ['button[data-cookiebanner="accept_only_essential_button"]', 'button:has-text("Decline optional cookies")', 'button:has-text("Only allow essential cookies")']) {
          await page.locator(sel).first().click({ timeout: 1500 }).catch(() => {});
        }
        const box = page.locator('input[type="search"], input[placeholder*="eyword"], input[placeholder*="dvertiser"]').first();
        await box.click({ timeout: 6000 }).catch(() => {});
        await page.keyboard.type("nike", { delay: 140 }).catch(() => {});
        for (let i = 0; i < 30 && !form; i++) await page.waitForTimeout(200);
        if (!form) throw new MetaSignatureError("could not capture Meta's advertiser typeahead query (expected useAdLibraryTypeaheadSuggestionDataSourceQuery) — advertiser matching is unavailable until this is updated");
        const ctx: WarmCtx = { page, form, expires: Date.now() + 10 * 60_000, close: () => {} };
        await new Promise<void>((release) => { ctx.close = release; warm = ctx; settled = true; resolve(ctx); });
      } catch (e) {
        if (!settled) { settled = true; reject(e); }
      }
    }).catch((e) => { if (!settled) { settled = true; reject(e); } });
  });
}

async function getWarm(): Promise<WarmCtx> {
  if (warm && Date.now() < warm.expires && !warm.page.isClosed()) return warm;
  closeTypeahead();
  warming ??= buildWarm().finally(() => { warming = null; });
  return warming;
}

const atPath = (o: unknown, path: string[]): unknown => {
  let cur: unknown = o;
  for (const k of path) { if (!cur || typeof cur !== "object") return undefined; cur = (cur as Record<string, unknown>)[k]; }
  return cur;
};

/** Advertiser pages Meta suggests for a query. Empty on any transient failure; throws only when the
 *  query signature itself could not be captured, which is a real "Meta changed their API" event. */
export async function searchAdvertisers(query: string, country = "US"): Promise<AdvertiserPage[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const run = async (ctx: WarmCtx): Promise<AdvertiserPage[]> => {
    const form = { ...ctx.form };
    let vars: Record<string, unknown>;
    try { vars = JSON.parse(form.variables!) as Record<string, unknown>; } catch { return []; }
    vars.queryString = q; vars.country = country;
    form.variables = JSON.stringify(vars);
    const body = new URLSearchParams(form).toString();
    const { status, text } = await ctx.page.evaluate(async ({ body, lsd }) => {
      const r = await fetch("/api/graphql/", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-fb-lsd": lsd },
        body, credentials: "include",
      });
      return { status: r.status, text: await r.text() };
    }, { body, lsd: form.lsd ?? "" });
    if (status === 403 || status === 429 || status >= 500) return [];
    // Meta prefixes its JSON with a loop-guard.
    let json: unknown = null;
    try { json = JSON.parse(text.replace(/^for\s*\(;;\);/, "")); } catch { return []; }
    type PR = { page_id?: string | number; name?: string; page_alias?: string; page_is_deleted?: boolean;
                ig_username?: string; instagram_username?: string; ig_handle?: string; instagram_actor?: string };
    const pages = (atPath(json, ["data", "ad_library_main", "typeahead_suggestions", "page_results"]) as PR[] | undefined) ?? [];
    return pages.filter((p) => p?.page_id && !p.page_is_deleted).map((p) => ({
      pageId: String(p.page_id), name: String(p.name ?? ""), pageAlias: p.page_alias,
      // Meta's exact IG-handle key is undocumented and has moved before; take whichever is present.
      igUsername: p.ig_username ?? p.instagram_username ?? p.ig_handle ?? p.instagram_actor,
    }));
  };
  try { const r = await run(await getWarm()); bumpIdle(); return r; }
  catch (e) {
    if (e instanceof MetaSignatureError) throw e;
    closeTypeahead();                                    // one retry on a stale/closed page
    try { const r = await run(await getWarm()); bumpIdle(); return r; }
    catch (e2) { if (e2 instanceof MetaSignatureError) throw e2; return []; }
  }
}

/**
 * Domain (+ its company name) → the Meta advertiser page that provably belongs to it, or null.
 *
 * `null` is a first-class answer and callers must treat it as "we do not know", never as "they run
 * no ads". Roughly half of small B2B companies link no social profile at all, and a company with no
 * Facebook page is invisible here whether or not it advertises.
 */
export async function resolveAdvertiserPage(
  domain: string, company: string, country = "US",
): Promise<{ page: AdvertiserPage; via: "fb" | "ig"; handles: SiteHandles } | { page: null; handles: SiteHandles }> {
  const handles = await resolveSiteHandles(domain);
  if (!handles.facebook && !handles.instagram) return { page: null, handles };
  let pages = await searchAdvertisers(company, country);
  let hit = pickHandleMatch(pages, handles);
  if (!hit) {
    // The company's legal name and its Meta page name often differ ("Acme Logistics Inc" vs
    // "AcmeShip"). Searching the HANDLE finds the page even when the names never overlap.
    const byHandle = handles.facebook || handles.instagram;
    if (byHandle) {
      pages = await searchAdvertisers(byHandle, country);
      hit = pickHandleMatch(pages, handles);
    }
  }
  return hit ? { ...hit, handles } : { page: null, handles };
}
