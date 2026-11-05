// One free governor for ALL hiring.cafe access (search, /org/ scans, account checks, JD enrichment).
//
// HTTP-FIRST with a browser FALLBACK, both from your own residential IP (no proxies, no paid scraper):
//   • HTTP lane  — lightweight fetch (transports.fetchViaHttp). Its concurrency self-tunes via AIMD (the
//                  TCP congestion idea): additive-increase while hiring.cafe is happy, multiplicative-
//                  decrease + a short global cooldown when it challenges us. Because HTTP is so light,
//                  the ceiling can be much higher than the browser's (HC_HTTP_CONCURRENCY).
//   • Browser lane — fingerprinted Playwright (transports.fetchViaBrowser), a small fixed pool
//                  (HC_MAX_CONCURRENCY, ~6). Used only when an HTTP request is challenged/fails.
//
// hcFetchHtml(url) is the single entry point every scraper calls; it returns the page HTML. The honest
// ceiling is what one IP tolerates — AIMD discovers it; the browser fallback keeps a challenged request
// from failing outright. Set HC_TRANSPORT=browser to force the old browser-only behavior, or =http to
// disable the fallback.
import { fetchViaHttp, fetchViaBrowser } from "./transports.ts";
import { Semaphore, sleep } from "./browser.ts";

const HTTP_MAX = Math.max(1, Number(process.env.HC_HTTP_CONCURRENCY ?? 24)); // HTTP ceiling when healthy (base, scaled by profile)
const HTTP_MIN = 1;
const BROWSER_MAX = Math.max(1, Number(process.env.HC_MAX_CONCURRENCY ?? 6)); // conservative fallback pool
const COOLDOWN_MS = Math.max(0, Number(process.env.HC_COOLDOWN_MS ?? 15000)); // global pause after a block (base)
const RAMP_AFTER = Math.max(1, Number(process.env.HC_RAMP_AFTER ?? 12));      // +1 HTTP concurrency per N clean (base)
const TRANSPORT = (process.env.HC_TRANSPORT ?? "").toLowerCase();             // "", "http", or "browser"
const HTTP_OFF = TRANSPORT === "browser";
const BROWSER_OFF = TRANSPORT === "http";

// ── Speed profile ("speed dial" in Settings): one knob scaling the whole free pipeline. The env vars
// above stay the BASE values; the profile multiplies them. AIMD still governs — aggressive just raises
// the ceiling and shortens pacing, it never disables backoff.
export type GateProfile = "gentle" | "normal" | "aggressive";
interface ProfileCfg { maxMul: number; rampMul: number; coolMul: number; wave: number; jitterMin: number; jitterMax: number; desc: number }
const PROFILE_CFG: Record<GateProfile, ProfileCfg> = {
  gentle:     { maxMul: 0.5, rampMul: 2.0, coolMul: 1.5, wave: 2, jitterMin: 500, jitterMax: 1000, desc: 4 },
  normal:     { maxMul: 1.0, rampMul: 1.0, coolMul: 1.0, wave: 4, jitterMin: 250, jitterMax: 600,  desc: 8 },
  aggressive: { maxMul: 2.0, rampMul: 0.5, coolMul: 0.75, wave: 6, jitterMin: 100, jitterMax: 300, desc: 12 },
};
let profile: GateProfile = "normal";
const cfg = () => PROFILE_CFG[profile];
const capMax = () => Math.max(HTTP_MIN, Math.round(HTTP_MAX * cfg().maxMul));
const rampAfter = () => Math.max(1, Math.round(RAMP_AFTER * cfg().rampMul));
const cooldownMs = () => Math.round(COOLDOWN_MS * cfg().coolMul);
export function setGateProfile(p: GateProfile): void {
  if (!PROFILE_CFG[p] || p === profile) return;
  profile = p;
  limit = Math.min(Math.max(limit, HTTP_MIN), capMax()); // clamp into the new ceiling
  console.log(`[hcgate] speed profile → ${p} (HTTP ceiling ${capMax()}, wave ${cfg().wave}, JD concurrency ${cfg().desc})`);
  admit(); // a raised ceiling may free queued waiters immediately
}
export const gateProfile = (): GateProfile => profile;
/** Pages fetched concurrently per wave by the scrapers (search pagination without a known total).
 *  While the gate is cooling down or heavily backed off (requests flowing through the slow browser
 *  lane), waves shrink to 2 — firing 4-6 pages at a struggling site just queues 25s browser stalls. */
export const gateWave = (): number =>
  (Date.now() < cooldownUntil || limit <= 2) ? Math.min(cfg().wave, 2) : cfg().wave;
/** Inter-wave jitter range (ms) — the only sleep left in pagination; the gate does the real pacing. */
export const gateWaveJitter = (): [number, number] => [cfg().jitterMin, cfg().jitterMax];
/** Concurrency for full-JD detail scrapes (ingest + account checks). Env override wins. */
export const gateDescConcurrency = (): number =>
  process.env.FETCH_DESC_CONCURRENCY ? Math.max(1, Number(process.env.FETCH_DESC_CONCURRENCY)) : cfg().desc;

const isBlock = (e: unknown) => /block/i.test(String((e as Error)?.message ?? e));

// ── HTTP lane: adaptive (AIMD), waiter-queue based (no busy-poll) ──
let limit = capMax(), inflight = 0, okStreak = 0, cooldownUntil = 0;
const waiters: Array<() => void> = [];
function admit(): void { while (waiters.length && Date.now() >= cooldownUntil && inflight < limit) { inflight++; waiters.shift()!(); } }
// Three outcomes, three AIMD effects: "ok" ramps, "block" halves + cools down, "fail" (timeout /
// DNS / connection reset — trouble, but not a challenge) is NEUTRAL: it must not ramp concurrency
// (an outage where every request times out would otherwise score as a clean streak and push the lane
// toward HTTP_MAX at the worst possible moment), and it shouldn't halve either (a flaky request
// isn't hiring.cafe telling us to back off).
type LaneResult = "ok" | "block" | "fail";
function onResult(r: LaneResult): void {
  if (r === "block") {
    const cd = cooldownMs();
    limit = Math.max(HTTP_MIN, Math.floor(limit / 2));
    cooldownUntil = Date.now() + cd;
    okStreak = 0;
    console.warn(`[hcgate] hiring.cafe block → HTTP concurrency=${limit}, cooldown=${cd}ms (falling back to browser)`);
    if (cd) setTimeout(admit, cd + 10);
  } else if (r === "fail") { okStreak = 0; }
  else if (limit < capMax() && ++okStreak >= rampAfter()) { limit++; okStreak = 0; }
}
function acquireHttp(): Promise<void> {
  if (Date.now() >= cooldownUntil && inflight < limit) { inflight++; return Promise.resolve(); }
  return new Promise<void>((res) => waiters.push(res));
}
function releaseHttp(r: LaneResult): void { inflight--; onResult(r); admit(); }

// ── browser lane: small fixed pool (the fallback) ──
const browserLane = new Semaphore(BROWSER_MAX);
// Browser page-load timeout. The old 45s meant every blocked/stuck deep page burned a dead 45s before
// failing; a page that hasn't painted DOM in 25s is effectively blocked — failing fast + cooling down
// beats waiting. Retried once (shorter) before giving up.
const BROWSER_TIMEOUT_MS = Math.max(5000, Number(process.env.HC_BROWSER_TIMEOUT_MS ?? 25000));
let browserTimeouts = 0; // CONSECUTIVE goto-timeouts across the lane — 2+ in a row reads as a block
const isTimeout = (e: unknown) => /timeout/i.test(String((e as Error)?.message ?? e));

/** Browser fallback with timeout resilience: respects the global cooldown, retries a timed-out page
 *  once (shorter timeout, brief backoff), and converts REPEATED timeouts into one coordinated gate
 *  cooldown instead of serially burning the full timeout on every remaining page. */
async function browserFetch(url: string): Promise<string> {
  await hcCooldownWait(); // a site that's stalling browser pages needs a pause, not more pages
  return browserLane.run(async () => {
    try {
      const html = await fetchViaBrowser(url, BROWSER_TIMEOUT_MS);
      browserTimeouts = 0;
      return html;
    } catch (e) {
      if (!isTimeout(e)) throw e; // block/other → caller handles (partial-keep semantics unchanged)
      await sleep(1500 + Math.random() * 1000); // brief backoff, then one fast retry
      try {
        const html = await fetchViaBrowser(url, Math.round(BROWSER_TIMEOUT_MS * 0.8));
        browserTimeouts = 0;
        return html;
      } catch (e2) {
        if (isTimeout(e2) && ++browserTimeouts >= 2) {
          const cd = cooldownMs();
          cooldownUntil = Math.max(cooldownUntil, Date.now() + cd);
          browserTimeouts = 0;
          console.warn(`[hcgate] repeated browser page timeouts → treating as a block, cooling down ${cd}ms`);
          if (cd) setTimeout(admit, cd + 10);
        }
        throw e2;
      }
    }
  });
}

/** Fetch a hiring.cafe URL's HTML: HTTP-first under the adaptive gate, falling back to the fingerprinted
 *  browser on a block/failure. Throws only if BOTH lanes fail (or the active single lane fails). */
export async function hcFetchHtml(url: string): Promise<string> {
  if (!HTTP_OFF) {
    await acquireHttp();
    if (COOLDOWN_MS) await sleep(Math.random() * 120); // micro-jitter so co-admitted requests don't fire in lockstep
    try {
      const html = await fetchViaHttp(url);
      releaseHttp("ok"); // clean → AIMD ramps
      return html;
    } catch (e) {
      releaseHttp(isBlock(e) ? "block" : "fail"); // block → back off + cooldown; timeout/network → neutral
      if (BROWSER_OFF) throw e; // http-only mode: no fallback
      // fall through to the browser fallback
    }
  }
  return browserFetch(url);
}

/** Wait out any active global cooldown WITHOUT taking a slot — for caller-managed retry loops. */
export async function hcCooldownWait(): Promise<void> {
  while (Date.now() < cooldownUntil) await sleep(Math.min(cooldownUntil - Date.now(), 500));
}

/** Current gate state (for logging/diagnostics + the System health panel). */
export function hcGateStats(): { profile: GateProfile; httpLimit: number; httpCeiling: number; httpInflight: number; waiting: number; cooldownMs: number; browserMax: number } {
  return { profile, httpLimit: limit, httpCeiling: capMax(), httpInflight: inflight, waiting: waiters.length, cooldownMs: Math.max(0, cooldownUntil - Date.now()), browserMax: BROWSER_MAX };
}
