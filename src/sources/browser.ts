// Shared Playwright manager for browser-driven sources.
// Anti-bot strategy: a COHERENT fingerprint (UA + sec-ch-ua + platform + locale +
// timezone + screen all from one real browser, via fingerprint-injector) generated
// fresh PER SESSION, run at hourly cadence from the user's residential IP. Plain UA
// rotation is not used — an inconsistent fingerprint is more detectable, not less.
//
// playwright is heavy, so it is lazy-imported only when a browser source actually runs.
import type { Browser, BrowserContext, Page } from "playwright";

export type Engine = "chromium" | "firefox";

const browsers: Partial<Record<Engine, Browser>> = {};
// The IN-FLIGHT launch, not the finished Browser. The check-then-act version below tested
// `browsers[engine]` and then awaited twice before assigning it, so two cold-start callers both saw
// the empty slot and both launched: the loser's browser was never stored, which means closeBrowsers
// could never reach it and the process leaked for the lifetime of the server. runPage is explicitly
// NOT queued (see withPage's comment) and is called concurrently from the hiring.cafe browser lane
// and two signal producers, so the race is reachable on any cold boot.
const launching: Partial<Record<Engine, Promise<Browser>>> = {};

// A browser launch that never settles must fail fast, not hang forever. Found live 2026-09-18: the
// scheduled cron's chromium.launch() never resolved or rejected because the environment was missing a
// shared library the headless binary needs (libXdamage.so.1) -- no error, no stack trace, just a stuck
// promise. That hang propagated all the way up through a signal producer's Promise.all into the
// top-level `for (const client of clients) await runClientSignals(client)` in run-signals-once.mts,
// which Node eventually killed as an "unsettled top-level await" (exit code 13) -- taking the entire
// signal scan down with it, and with it signal ingest, main.py, and apollo_enroll for the whole day.
// A launch timeout turns that into an ordinary rejected promise, which the existing per-producer
// try/catch in signals/index.ts already handles exactly like any other producer failure: logged and
// skipped, everything else in the run proceeds.
const LAUNCH_TIMEOUT_MS = 20_000;

// Same class of bug as LAUNCH_TIMEOUT_MS above, found the same day (2026-09-18) in a different spot:
// newInjectedContext() and ctx.newPage() below also talk to the browser subprocess over CDP, and can
// hang forever with no error too -- reproduced live during the job-fetch step's browser fallback (the
// run just went silent, no timeout fired, no crash, nothing) once this Mac's own Chromium build
// replaced the old one. Wrapped with the same helper so a hang here becomes an ordinary rejected
// promise -- already handled per-domain by hcorg's own retry/skip logic -- instead of a silent freeze
// that blocks the whole watchlist batch from ever finishing (see the tracker for the full incident).
const CONTEXT_TIMEOUT_MS = 20_000;

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function getBrowser(engine: Engine): Promise<Browser> {
  const open = browsers[engine];
  if (open) return Promise.resolve(open);
  return (launching[engine] ??= (async () => {
    const pw = await import("playwright");
    const launcher = engine === "firefox" ? pw.firefox : pw.chromium;
    const b = await withTimeout(
      launcher.launch({
        headless: true,
        args: engine === "chromium" ? ["--disable-blink-features=AutomationControlled", "--no-sandbox"] : [],
      }),
      LAUNCH_TIMEOUT_MS,
      `${engine} browser launch`,
    );
    browsers[engine] = b;
    return b;
  })().finally(() => { delete launching[engine]; }));  // a FAILED launch must be retryable
}

// ── Optional anti-detect engine (experimental A/B) ──
// Set BROWSER_ENGINE=camoufox to drive Camoufox — a Firefox fork that spoofs fingerprints at the C++
// level (before any JS runs), which beats Cloudflare/DataDome more reliably than our JS-layer
// fingerprint-injector. Opt-in, since it pulls a ~100MB browser binary:
//   npm i camoufox-js && npx camoufox-js fetch
// camoufox-js is lazy-imported via a variable specifier, so it's only needed when the flag is set
// (the default Chromium path is untouched and needs nothing new installed). When on, Camoufox does the
// fingerprinting itself, so we do NOT layer fingerprint-injector on top; geoip makes the timezone/
// locale/geolocation coherent with the host's real (residential) IP.
export const USE_CAMOUFOX = (process.env.BROWSER_ENGINE ?? "").toLowerCase() === "camoufox";
let camoufoxBrowser: Browser | undefined;
let camoufoxLaunching: Promise<Browser> | undefined;   // same race, same fix as getBrowser above
function getCamoufox(): Promise<Browser> {
  if (camoufoxBrowser) return Promise.resolve(camoufoxBrowser);
  return (camoufoxLaunching ??= (async () => {
    const pkg: string = "camoufox-js"; // `: string` defeats literal narrowing → not statically resolved (optional dep)
    let mod: { Camoufox: (opts: Record<string, unknown>) => Promise<Browser> };
    try {
      mod = (await import(pkg)) as typeof mod;
    } catch {
      throw new Error("BROWSER_ENGINE=camoufox but camoufox-js isn't installed. Run: npm i camoufox-js && npx camoufox-js fetch");
    }
    camoufoxBrowser = await withTimeout(
      mod.Camoufox({ headless: true, os: "windows", geoip: true }),
      LAUNCH_TIMEOUT_MS,
      "camoufox browser launch",
    );
    console.log("[browser] Camoufox anti-detect engine active (BROWSER_ENGINE=camoufox)");
    return camoufoxBrowser;
  })().finally(() => { camoufoxLaunching = undefined; }));
}

// Sequential queue — concurrency 1 so we never run two browser sessions at once.
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task, task);
  tail = result.then(() => {}, () => {});
  return result as Promise<T>;
}

/** A simple concurrency limiter — lets a caller (e.g. the account-check) run N browser
 *  sessions in parallel while the normal scrapers keep their serial concurrency-1 queue. */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); }
    finally { this.release(); }
  }
  // Count the permit at the admission point (not after the waiter resumes), so a freed slot can't be
  // taken by both a queued waiter AND a fresh caller — which would transiently exceed `max`.
  private acquire(): Promise<void> {
    if (this.active < this.max) { this.active++; return Promise.resolve(); }
    return new Promise<void>((r) => this.waiters.push(r));
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();        // hand the held permit straight to the next waiter (active unchanged)
    else this.active--;      // no one waiting → release the permit
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min = 600, max = 1600) => sleep(min + Math.random() * (max - min));

export interface PageOpts { engine?: Engine; site?: string; timeoutMs?: number; }

/** Run `fn` with a fresh fingerprinted page (a new coherent fingerprint per call). NOT queued —
 *  callers that want serialization use withPage; callers managing their own concurrency use this. */
export async function runPage<T>(opts: PageOpts, fn: (page: Page, ctx: BrowserContext) => Promise<T>): Promise<T> {
  // Anti-detect engine: Camoufox spoofs at the engine level, so use a plain context (geoip already
  // made locale/timezone/geo coherent at launch — overriding them here would create a mismatch).
  if (USE_CAMOUFOX) {
    const browser = await getCamoufox();
    const ctx = await withTimeout(browser.newContext(), CONTEXT_TIMEOUT_MS, "camoufox newContext");
    ctx.setDefaultTimeout(opts.timeoutMs ?? 30000);
    const page = await withTimeout(ctx.newPage(), CONTEXT_TIMEOUT_MS, "camoufox newPage");
    try { return await fn(page, ctx); }
    finally { await withTimeout(ctx.close(), CONTEXT_TIMEOUT_MS, "camoufox ctx.close").catch(() => {}); }
  }
  const engine = opts.engine ?? "chromium";
  const browser = await getBrowser(engine);
  const { newInjectedContext } = await import("fingerprint-injector");
  const ctx = await withTimeout(
    newInjectedContext(browser as any, {
      fingerprintOptions: {
        browsers: [engine === "firefox" ? "firefox" : "chrome"],
        operatingSystems: ["windows"],
        devices: ["desktop"],
        locales: ["en-US"],
      },
      newContextOptions: { locale: "en-US", timezoneId: "America/New_York" },
    }),
    CONTEXT_TIMEOUT_MS,
    "newInjectedContext",
  );
  ctx.setDefaultTimeout(opts.timeoutMs ?? 30000);
  const page = await withTimeout(ctx.newPage(), CONTEXT_TIMEOUT_MS, "newPage");
  try {
    return await fn(page, ctx);
  } finally {
    // Same class of bug as LAUNCH_TIMEOUT_MS/CONTEXT_TIMEOUT_MS above (2026-09-18): ctx.close() is
    // also a raw CDP round-trip and can hang forever with no error if the browser subprocess has
    // gone unresponsive. Not directly confirmed with a stack trace, but the leading suspect for a
    // real 2026-09-20 incident matching this exact signature: the full-watchlist run went silent
    // ~75 minutes in, right after a string of hiring.cafe blocks pushed everything onto the browser
    // fallback lane, with the process still alive but doing essentially nothing (near-zero CPU) for
    // hours afterward. A wedged close() here would starve hcGate's browserLane Semaphore one permit
    // at a time (a permit that's never released is a permit that's gone) until the fallback lane
    // deadlocks entirely -- consistent with what was observed. Wrapped with the same withTimeout
    // helper used above so a hang here becomes an ordinary (swallowed) timeout instead of a silent
    // freeze, regardless of whether this turns out to be the exact cause.
    await withTimeout(ctx.close(), CONTEXT_TIMEOUT_MS, "ctx.close").catch(() => {});
  }
}

/** Run `fn` with a fresh fingerprinted page, serialized against other sessions (concurrency 1). */
export function withPage<T>(opts: PageOpts, fn: (page: Page, ctx: BrowserContext) => Promise<T>): Promise<T> {
  return enqueue(() => runPage(opts, fn));
}

/** Heuristic: did we hit a bot wall rather than real content? */
export function looksBlocked(html: string, status?: number): boolean {
  if (status === 403 || status === 429) return true;
  const low = html.slice(0, 6000).toLowerCase();
  return /just a moment|cf-challenge|verify you are human|enable javascript and cookies|attention required|px-captcha|perimeterx|datadome|captcha-delivery|unusual traffic/.test(low);
}

/** Close browsers (call on shutdown; safe to skip in long-running process). */
export async function closeBrowsers(): Promise<void> {
  for (const k of Object.keys(browsers) as Engine[]) {
    await browsers[k]?.close().catch(() => {});
    delete browsers[k];   // a closed Browser left in the map is handed to the next runPage
  }
  await camoufoxBrowser?.close().catch(() => {});
  camoufoxBrowser = undefined;
}
