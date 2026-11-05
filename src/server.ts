import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { db, queryMatches, countMatches, dbGetSettings, dbSaveSettings, dbCountOldJobs, dbPurgeOldJobs,
  dbCountOldMatches, dbHideOldMatches, dbCountHidden, dbRestoreHidden, dbHideJob, dbUnhideJob, dbSweepClosed, dbStatusCounts,
  dbCreateAccountSearch, dbAccountProgress, dbFinishAccountSearch, dbListAccountSearches,
  dbGetAccountSearch, dbDeleteAccountSearch, dbDedupeJobs,
  dbAdminJobs, dbAdminJobsCount, dbAdminJobsForExport, dbAdminJob, dbUpdateJob, dbDeleteJob, dbBulkDeleteJobs, dbBulkSetStatus,
  dbCheckpoint, dbDeliveryHealth, dbDeliveryBacklog, dbIndustries, dbSetStar, dbCompanies, dbCompaniesPage, dbCompaniesForExport, dbSetCompanyDomain, dbGetCompanyDomain,
  dbListRuns, dbHealth, dbPurgeRuns, dbStartRun, dbFinishRun, dbSlowQueueStats,
  dbTechSearch, dbTechList, dbJobTechnologies, dbTechLeaderboard, dbTechCount,
  dbListSignals, dbListCurrentSignals, dbDismissSignal, dbSignalStats, dbGetDomainFlags,
  dbCheckCounters, dbCreateSignalCheck, dbSignalCheckProgress, dbFinishSignalCheck, dbListSignalChecks, dbGetSignalCheck, dbDeleteSignalCheck,
  DEFAULT_SETTINGS, type MatchFilter, type AppSettings, type AdminJobFilter, type QueryGroup } from "./db.ts";
import { SIGNAL_PRODUCERS, producerByKey, runClientSignals, checkDomainNow } from "./signals/index.ts";
import { dbUnverifiedStale } from "./db.ts";
import { stopSlowQueue, slowWorkInFlight, pacedProducers } from "./signals/slowQueue.ts";
import { testCompaniesHouseKey, companiesHouseKeyProblem } from "./signals/companiesHouse.ts";
import { AD_REGIONS, normalizeAdRegion } from "./signals/adActivity.ts";
import { SIGNAL_CATEGORIES, SIGNAL_TYPE_META, isCategory, attributionOf } from "./signals/taxonomy.ts";
import { runSignalCheck, type SignalCheckDomainResult, type SignalCheckProgress } from "./signalCheck.ts";
import { deliverSignals, deliverCheckSignals, isRealtime } from "./delivery.ts";
import { importTechnologies, parseImport } from "./techSeed.ts";
import { backfillTech } from "./techDetect.ts";
import { getClientRaw, saveClient, deleteClient, renameClient, DOMAIN_CAP } from "./config.ts";
import { getClients, reload, reloadAsync } from "./engine.ts";
import { runClientSources } from "./ingest.ts";
import { subscribeFetch, activeFetches, isFetching, isAnyFetching, requestFetchStop, fetchStarted, fetchProgress, fetchDone, clientKey, accountKey } from "./fetchBus.ts";
import { stopSchedules, getConfigWarnings } from "./scheduler.ts";
import { closeBrowsers } from "./sources/browser.ts";
import { closeTypeahead } from "./signals/metaPage.ts";
import { setGateProfile, hcGateStats } from "./sources/hcGate.ts";
import { runAccountCheck, type AccountHit, type AccountProgress } from "./accountCheck.ts";
import { normalizeOrgDomain, isDomainShaped } from "./normalize.ts";
import { asIso, publicSource, csvCell as cell, csvList } from "./payload.ts";
import { safeFetch, ownerFetch } from "./safeFetch.ts";
import { resolveCompanyBatch, resolveMissingDomains, autoResolveAfterFetch } from "./domainResolver.ts";
import { randomUUID } from "node:crypto";
import type { SearchSpec } from "./types.ts";

const FETCH_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between manual fetches
const lastManualFetch = new Map<string, number>();
const cooldownRemaining = (name: string) => Math.max(0, FETCH_COOLDOWN_MS - (Date.now() - (lastManualFetch.get(name) ?? 0)));

/** Epoch ms of the next time a cron fires. Handles the minute + hour fields (others assumed "*", which
 *  covers every cadence preset the UI offers). Drives the per-client "next auto-fetch in …" countdown. */
function nextCronRun(cron: string, from = new Date()): number | null {
  const parts = (cron || "").trim().split(/\s+/);
  if (parts.length < 5) return null;
  const hit = (field: string, val: number) => field === "*" ? true
    : field.startsWith("*/") ? (Number(field.slice(2)) > 0 && val % Number(field.slice(2)) === 0)
    : field.split(",").some((x) => Number(x) === val);
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 8; i++) { // search up to 8 days out
    if (hit(parts[0]!, d.getMinutes()) && hit(parts[1]!, d.getHours())) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The version the running code actually is, read from package.json rather than written out again
 * here. A second copy of a version string is a copy that goes stale, and a stale one is worse than
 * none: it is the app stating, in its own interface, something untrue about itself. Falls back to
 * "unknown" rather than to a guessed number, for the same reason every other reading in this
 * codebase reports "could not determine" instead of inventing a value.
 */
export const APP_VERSION: string = (() => {
  try {
    const raw = readFileSync(join(__dirname, "..", "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "") || "unknown";
  } catch { return "unknown"; }
})();
const WEB_DIR = join(__dirname, "..", "web");

// ── Graceful lifecycle: a ready flag (gates the dashboard's startup loading screen) + a clean
// shutdown that pauses in-flight tasks, closes browsers + schedules, and exits. The hooks are wired
// by startServer (which owns the http.Server + the account-run registry). ──
let _ready = false;
let _shuttingDown = false;
let _srv: import("node:http").Server | null = null;
let _pauseRuns: () => void = () => {};     // mark in-flight account checks "paused" (resumable)
let _resumeChecks: () => void = () => {};  // re-launch account checks paused by a prior graceful shutdown

export function markReady(): void { _ready = true; console.log("[boot] ready — dashboard live."); }
export function resumeAccountChecks(): void { try { _resumeChecks(); } catch (e) { console.error("[resume]", (e as Error).message); } }

/** Save in-flight task state, close background processes, then exit. Idempotent (safe on repeat signals). */
export async function gracefulShutdown(reason: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] ${reason}: pausing tasks + closing background processes…`);
  try { _pauseRuns(); } catch (e) { console.error("[shutdown] pause:", (e as Error).message); }   // account-check progress is already persisted; just mark them resumable
  try { stopSchedules(); } catch { /* best-effort */ }                                              // stop crons
  // Stop taking new queue items, then let the one in flight finish. A paced producer commits its diff
  // baseline inside check() and the signals are inserted after, so dying between those two writes
  // consumes the change without emitting it. Bounded: one item is seconds, and the queue is on disk.
  try {
    stopSlowQueue();
    for (let i = 0; i < 100 && slowWorkInFlight(); i++) await new Promise((r) => setTimeout(r, 100));
  } catch { /* best-effort */ }
  try { _srv?.close(); } catch { /* best-effort */ }                                                // stop accepting new connections
  // The ad-activity producer keeps ONE Ad Library page warm to replay Meta's advertiser typeahead
  // (see signals/metaPage.ts). It is idle-closed after 3 minutes, but a shutdown inside that window
  // would leave a context open, so release it before closing the browsers that own it.
  try { closeTypeahead(); } catch { /* best-effort */ }
  try { await closeBrowsers(); } catch (e) { console.error("[shutdown] browsers:", (e as Error).message); } // close Playwright (the one that leaks processes)
  try { dbCheckpoint(); } catch { /* best-effort */ }                                               // fold the WAL back into the main DB file
  console.log("[shutdown] state saved, background processes closed. Bye.");
  process.exit(0);
}

/** Starts the dashboard. Returns the http.Server so a caller can close it — gracefulShutdown ends
 *  in process.exit(0), which is right for the app and unusable from a test. Pass port 0 for an
 *  ephemeral port and read it back from srv.address(). */
export function startServer(port: number): import("node:http").Server {
  const app = express();

  // ---- Local-only guard ------------------------------------------------------------------------
  // This dashboard has no login: every route is fully trusted, and several destructive ones
  // (purge-old, shutdown, bulk-delete) take no body and no confirmation. The ONE thing that makes
  // that safe is the socket binding to loopback (see listen() at the bottom of this file).
  //
  // The Host check below is NOT a second lock — the Host header is client-controlled, so anything
  // that can reach the port can send "Host: localhost". Its real and only job is to stop DNS
  // rebinding, where a hostile page resolves its own name to 127.0.0.1 and thereby becomes
  // same-origin with us. It is enforced only while we are actually bound to loopback; if the
  // operator sets HOST to something reachable, they have deliberately exposed an unauthenticated
  // app and the boot warning says so, so pretending to check Host there would be theatre that
  // breaks the real browser (whose Host is the LAN IP) while stopping no attacker.
  const isLocalHostname = (h: string): boolean => {
    const s = h.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    return s === "localhost" || s === "127.0.0.1" || s === "::1";
  };
  // Split host:port without tripping over an IPv6 literal ("[::1]:4000" / "127.0.0.1:4000").
  const hostOnly = (v: string): string => {
    const s = v.trim();
    if (s.startsWith("[")) return s.slice(0, s.indexOf("]") + 1);
    const i = s.lastIndexOf(":");
    return i > 0 ? s.slice(0, i) : s;
  };
  const BOUND_LOCAL = isLocalHostname(process.env.HOST || "127.0.0.1");
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (BOUND_LOCAL && (!host || !isLocalHostname(hostOnly(host)))) {
      res.status(403).json({ error: "This dashboard only accepts requests from this computer." });
      return;
    }
    // Cross-site guard. Origin alone is NOT enough to decide this:
    //   - a sandboxed iframe sends the literal string "null", not a forgeable origin, and
    //   - <img>, <script>, <link> and form GETs send no Origin header at all,
    // so "if (origin && origin !== 'null')" waved through exactly the requests it existed to stop —
    // a hostile page could fire POST /api/jobs/purge-old from a sandboxed frame, or start a full
    // verify sweep with <img src=".../api/jobs/verify-stream">.
    //
    // One exemption, and it is load-bearing: a TOP-LEVEL DOCUMENT NAVIGATION by a safe method. That
    // is the user going to the page — from a bookmark, a chat message, the new-tab page — and the
    // browser labels it Sec-Fetch-Site: cross-site, so without this the dashboard 403s any link
    // that is not already on it (this is not hypothetical; the first version of this guard did
    // exactly that and served the error JSON instead of the app). It is safe because a navigation
    // only reads, and the attacker gains nothing they could not get by telling the user to click.
    // A cross-site form POST also navigates, so the exemption is restricted to GET/HEAD.
    //
    // The security headers are set FIRST, before any early return. They were previously set at the
    // bottom of this middleware, after the navigation exemption's `return` — so the one response that
    // needed them most, the dashboard HTML document itself, was served with none of them and the CSP
    // was inert. Subresources got all four (they take the long path); the document got zero.
    res.setHeader("X-Content-Type-Options", "nosniff");
    // SAMEORIGIN, not DENY: cross-origin framing is the clickjacking threat and is still blocked,
    // while the app being able to frame itself keeps same-origin responsive testing possible.
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    // No inline scripts anywhere (the few inline onclick= handlers were moved into app.js so this
    // can stay strict); inline style attributes are still generated, hence unsafe-inline on styles.
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'");

    const method = req.method.toUpperCase();
    const safeMethod = method === "GET" || method === "HEAD";
    // ...and the exemption must never cover /api/. "A navigation only reads" is true of the dashboard
    // document; it is NOT true of the API, where GET /api/jobs/verify-stream runs
    // UPDATE raw_jobs SET status='closed' over every open posting. A cross-site link straight to that
    // URL is a top-level document navigation by a safe method, so it walked through this exemption and
    // started a full sweep. The exemption exists to let a bookmark reach the app shell — nothing else.
    if (safeMethod && !req.path.startsWith("/api/")
        && req.headers["sec-fetch-mode"] === "navigate"
        && req.headers["sec-fetch-dest"] === "document") { next(); return; }
    // So: an Origin, if present, must be one of ours ("null" never is. It means "opaque").
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let ok = false;
      try { ok = origin !== "null" && isLocalHostname(new URL(origin).hostname); } catch { ok = false; }
      if (!ok) { res.status(403).json({ error: "Cross-site requests are not allowed." }); return; }
    } else {
      // No Origin. Every current browser still states the request's provenance in Sec-Fetch-Site:
      // "same-origin" (our own page), "none" (typed/bookmarked navigation) — both fine; "cross-site"
      // and "same-site" mean another page caused this, which is precisely the attack. A non-browser
      // client (curl on this machine, a script) sends neither header, and that is allowed: it is
      // already inside the loopback boundary, which is the actual security control here.
      const site = req.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin" && site !== "none") {
        res.status(403).json({ error: "Cross-site requests are not allowed." }); return;
      }
    }
    next();
  });

  // Only the three routes that receive a pasted list or a CSV need a large body; the other ~60
  // would happily buffer 50 MB of anything. express.json() no-ops if a body was already parsed.
  const bigBody = express.json({ limit: "50mb" });
  app.use("/api/account/searches", bigBody);   // pasted company list
  app.use("/api/signal-checks", bigBody);      // pasted domain list
  app.use("/api/technologies/import", bigBody); // technology CSV
  app.use(express.json({ limit: "1mb" }));
  // Tightening the default limit to 1mb made 413 reachable on ~60 routes. Express's built-in
  // handler answers those with an HTML page carrying a Node stack trace — which every caller here
  // then feeds to res.json(), so the user sees "Unexpected token <" instead of what went wrong.
  // Same for malformed JSON (400). Answer both in the shape the frontend actually parses.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (!e || res.headersSent) return next(err);
    if (e.type === "entity.too.large") {
      res.status(413).json({ error: "That request is too large. Paste a smaller list, or import it as a CSV." });
      return;
    }
    if (e.type === "entity.parse.failed") { res.status(400).json({ error: "The request body was not valid JSON." }); return; }
    next(err);
  });
  // Gzip the three text assets. 475 KB uncompressed, 128 KB gzipped (index.html 82->19 KB,
  // app.js 299->88 KB, styles.css 94->21 KB). Hand-rolled rather than pulling in `compression`:
  // this is the only place that needs it and it is ~15 lines.
  //
  // Cache-Control is deliberately left at express.static's default (max-age=0 + ETag). These files
  // change on every app update and the revalidation is a 304 over loopback — caching them harder
  // would serve a stale dashboard after an upgrade, which costs more than the round trip saves.
  //
  // Buffer-then-compress rather than a streaming wrapper: the three files are ~300 KB at most and
  // express.static has already read them into memory, so buffering costs nothing and avoids the two
  // ways a streaming wrapper gets this wrong — writing a gzip header onto a 304 (which must have no
  // body) and leaving a stale Content-Length behind.
  app.use((req, res, next) => {
    if (!/\.(html|js|css|svg)$/i.test(req.path) && req.path !== "/") return next();
    if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return next();
    res.setHeader("Vary", "Accept-Encoding");   // set even when we don't compress, or a shared cache mixes them up
    const end = res.end.bind(res);
    const chunks: Buffer[] = [];
    const collect = (c: unknown) => { if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); };
    res.write = ((chunk: unknown) => { collect(chunk); return true; }) as typeof res.write;
    res.end = ((chunk?: unknown) => {
      if (typeof chunk !== "function") collect(chunk);
      const body = Buffer.concat(chunks);
      // 204/304 carry no body, and an already-encoded response is not ours to touch.
      if (!body.length || res.statusCode !== 200 || res.getHeader("Content-Encoding")) {
        res.setHeader("Content-Length", String(body.length));
        return end(body.length ? body : undefined);
      }
      const gz = gzipSync(body, { level: 6 });
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Length", String(gz.length));
      return end(gz);
    }) as typeof res.end;
    next();
  });
  app.use(express.static(WEB_DIR));

  // Readiness gate, SERVER-side. dbMigrate runs after listen() and MOVES DATA (description and
  // country backfills, the FTS index rebuild, the taxonomy reconcile), but every data route
  // answered normally the whole time — so a query issued during that window could read a
  // half-migrated schema and get a confidently wrong answer with nothing in the response to say
  // so. The dashboard's loading screen only covered its own first load; a reload, a second tab, a
  // curl or a webhook consumer bypassed it entirely.
  //
  // 503 + Retry-After is the honest answer: "ask again in a moment", not a wrong number. Only data
  // routes are gated — /api/ready and /api/health must answer so the loading screen can poll, and
  // static assets must serve so there is something to show.
  const READY_EXEMPT = new Set(["/api/ready", "/api/health"]);
  app.use("/api", (req, res, next) => {
    if (_ready || READY_EXEMPT.has(req.baseUrl + req.path) || READY_EXEMPT.has(req.path)) return next();
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "Starting up — the database is still being prepared. Retry in a moment.", ready: false });
  });

  // Resolve a kind ("search"/"watchlist") to its client names — scopes the per-tab "All" view so the
  // Client Monitoring and Account Monitoring tabs never bleed into each other.
  const namesOfKind = (kind?: unknown): string[] | undefined => {
    const k = String(kind ?? "");
    if (k !== "search" && k !== "watchlist") return undefined;
    return getClients().filter((c) => (c.kind ?? "search") === k).map((c) => c.name);
  };
  // Resolve a request's scope for maintenance actions (hide/restore/verify): a specific ?client=,
  // else the active tab's ?kind= (so an action on the "All watchlists" tab only touches watchlists,
  // matching what's visible), else undefined = everything. Keeps these actions consistent with the
  // kind-scoped /api/matches + /api/stats views.
  const scopeOf = (q: Record<string, unknown>) =>
    q.client ? { client: String(q.client) } : { clients: namesOfKind(q.kind) };

  // Parse the advanced visual-filter tree from the `adv` param (URL-encoded JSON string). STRICT:
  // an adv that is present but oversized / unparseable / mis-shaped THROWS (→ the endpoint's 400)
  // instead of being silently dropped — a dropped tree would make list endpoints show, and bulk
  // endpoints DELETE, a broader set than the user asked for. compileQueryTree further validates
  // fields/ops + caps depth and also throws → 400.
  const parseAdv = (raw: unknown): QueryGroup | undefined => {
    if (raw == null || raw === "") return undefined;
    if (typeof raw !== "string") throw new Error("adv must be a JSON string");
    if (raw.length > 8000) throw new Error("adv filter too large");
    let o: unknown;
    try { o = JSON.parse(raw); } catch { throw new Error("adv is not valid JSON"); }
    if (!o || typeof o !== "object" || !Array.isArray((o as QueryGroup).children)) throw new Error("adv is not a filter tree");
    return o as QueryGroup;
  };
  const parseList = (raw: unknown): string[] | undefined => {
    if (raw == null || raw === "") return undefined;
    const a = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    return a.length ? a : undefined;
  };
  // NaN-safe number param: "abc" → the default, never a literal `LIMIT NaN` SQL error.
  const numParam = (raw: unknown, def: number, min: number, max: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
  };

  /** The matched-postings filter, read from the query string. Extracted so the list and the CSV export
   *  are driven by the SAME code: an export that rebuilds the filter separately silently drifts from
   *  what is on screen, and then "download what I am looking at" quietly stops being true. */
  const matchFilterOf = (q: Record<string, unknown>): MatchFilter => {
    const settings = dbGetSettings();
    return {
        client: q.client ? String(q.client) : undefined,
        clients: q.client ? undefined : namesOfKind(q.kind), // scope "All" to the active tab's kind
        grouped: !q.client, // "All" view → one row per job with aggregated client tags

        source: q.source ? String(q.source) : undefined,
        state: q.state ? String(q.state) : undefined,
        remote: q.remote === "1" ? true : q.remote === "0" ? false : undefined,
        sinceHours: q.sinceHours ? Number(q.sinceHours) : undefined,
        postedWithinDays: q.postedWithinDays ? Number(q.postedWithinDays) : undefined,
        // retention "hide" mode quietly drops jobs older than the cutoff from the dashboard
        hideOlderThanDays: settings.retentionMode === "hide" ? settings.retentionDays : undefined,
        status: q.status === "open" || q.status === "closed" ? q.status : undefined,
        q: q.q ? String(q.q) : undefined,
        fuzzy: q.fuzzy === "1" ? true : undefined,
        seniority: parseList(q.seniority),
        tech: parseList(q.tech),
        signalFlags: parseList(q.signals),      // "Company signal" filter (any of these producers flagged)
        starred: q.starred === "1" ? true : undefined,
        sort: q.sort ? String(q.sort) : undefined,
        dir: q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : undefined,
        query: parseAdv(q.adv),
    };
  };

  app.get("/api/matches", (req, res) => {
    const limit = numParam(req.query.limit, 25, 1, 200);
    const offset = numParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    try {
      const filter = matchFilterOf(req.query as Record<string, unknown>);
      res.json({ total: countMatches(filter), limit, offset, items: queryMatches({ ...filter, limit, offset }) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); } // bad advanced-filter tree
  });

  /**
   * The matched postings you are looking at, as CSV.
   *
   * Companies had an export and postings did not — but postings is the list you actually work in, so
   * "give me these roles as a spreadsheet" dead-ended. The Jobs database export is not a substitute:
   * that is the raw record store with its own filter set, not this monitor's matched, client-scoped view.
   *
   * Exports the WHOLE filtered set, not the current page (limit -1 is SQLite's "no limit"), because a
   * download that silently stops at 25 rows is worse than no download.
   */
  app.get("/api/matches/export", (req, res) => {
    let rows: Array<Record<string, unknown>>;
    try { rows = queryMatches({ ...matchFilterOf(req.query as Record<string, unknown>), limit: -1, offset: 0 }); }
    catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    // salary_currency and salary_period are not decoration. The webhook has always carried both; the
    // CSV shipped a bare number, so a reader could not tell 3,500,000 INR (about USD 42k) from
    // 3,500,000 USD — an 80x difference in a column literally named salary_max. The currency was
    // already being SELECTed for this query and simply never emitted.
    // salary_period is blank rather than "yearly" when the figure is too small to be an annual salary:
    // 35 rows in the live data are hourly wages ("Class A Driver 27-27 USD") or Indian lakh figures
    // ("Field Sales Consultant 24-30 INR" = ₹2.4M-3M). Same rule as delivery.ts — state what the data
    // supports, and nothing else.
    const cols = ["company", "domain", "role", "location", "state", "remote",
                  "salary_max", "salary_currency", "salary_period", "status",
                  "posted_at", "matched_at", "monitors", "source", "url"];
    const lines = rows.map((r) => [
      r.company, r.domain, r.title, r.location, r.state, r.remote ? "yes" : "no",
      r.compMax ?? "", r.currency ?? "", (typeof r.compMax === "number" && r.compMax >= 1000) ? "yearly" : "",
      r.status, asIso(r.postedAt), asIso(r.matchedAt), r.clients ?? r.client, publicSource(r.source), r.url,
    ].map(cell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="postings-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send([cols.join(","), ...lines].join("\n"));
  });

  // Technologies: typeahead for the filter picker, per-job detections, leaderboard, and list import.
  app.get("/api/technologies", (req, res) => {
    const q = req.query.q ? String(req.query.q) : "";
    if (q) return res.json({ count: dbTechCount(), total: dbTechCount(), items: dbTechSearch(q, 40) });
    // No query → browse the dictionary, most-adopted first (the Technologies view's default listing).
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { total, items } = dbTechList(limit, offset, req.query.sort ? String(req.query.sort) : undefined, req.query.dir ? String(req.query.dir) : undefined);
    res.json({ count: total, total, items });
  });
  app.get("/api/jobs/:id/technologies", (req, res) => {
    res.json({ technologies: dbJobTechnologies(req.params.id) });
  });
  app.get("/api/technologies/leaderboard", (req, res) => {
    const scope = req.query.client ? { client: String(req.query.client) } : { clients: namesOfKind(req.query.kind) };
    res.json({ items: dbTechLeaderboard(scope, 25) });
  });
  // async because backfillTech now yields between batches instead of holding the event loop for the
  // whole re-detect. The request still waits for the real retagged count, but the rest of the app
  // (and this dashboard) keeps responding while it runs.
  app.post("/api/technologies/import", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const mode = req.body?.mode === "replace" ? "replace" : "merge";
    if (!text.trim()) return res.status(400).json({ error: "no list content" });
    try {
      const rows = parseImport(text);
      if (!rows.length) return res.status(400).json({ error: "no technologies parsed from the input" });
      const n = importTechnologies(rows, mode);
      const tagged = await backfillTech(); // re-detect over existing jobs with the new dictionary
      res.json({ ok: true, imported: n, total: dbTechCount(), retagged: tagged });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // ---- Signals: the multi-signal feed (non-hiring sales signals) + producer catalog ----
  app.get("/api/signals/producers", (_req, res) => {
    // `flagged` says whether this producer writes a current-state domain_flags row, i.e. whether it
    // can appear in the "Company signal" filter. Served from the producer registry so the front end
    // stops keeping a second, hand-written list that drifted out of sync with it in both directions.
    res.json({ items: SIGNAL_PRODUCERS.map((p) => ({
      key: p.key, label: p.label, description: p.description,
      flagged: !!p.flagged,
      // `filterable` defaults to `flagged` — a producer only opts OUT, and only when its flag is
      // true for almost everything and so filters nothing. See SignalProducer.filterable.
      filterable: p.filterable ?? !!p.flagged,
    })) });
  });
  // Meta Ad Library regions, from the ONE list in src/signals/adActivity.ts. Both the Settings
  // default and the per-check picker are built from this, so they can't drift.
  app.get("/api/signals/ad-regions", (_req, res) => {
    res.json({ items: AD_REGIONS, default: dbGetSettings().adCountry });
  });
  // What every signal type MEANS — labels, plain-English explanations, categories, evidence ranks.
  // One source of truth (src/signals/taxonomy.ts) shared by the feed, the Guide and webhook routing.
  app.get("/api/signals/taxonomy", (_req, res) => {
    res.json({ categories: SIGNAL_CATEGORIES, types: SIGNAL_TYPE_META });
  });
  // Read the feed's filters off a query string. Shared by the list route and the CSV export so an
  // export can never disagree with the rows on screen.
  const signalFilterFrom = (q: Record<string, unknown>) => {
    const parseList = (v: unknown) => (v == null || v === "" ? undefined : String(v).split(",").map((s) => s.trim()).filter(Boolean));
    const cats = parseList(q.categories)?.filter(isCategory); // unknown keys dropped, never a 500
    return {
      client: q.client ? String(q.client) : undefined,
      checkId: q.check ? String(q.check) : undefined,
      types: parseList(q.types),
      categories: cats?.length ? cats : undefined,
      q: q.q ? String(q.q) : undefined,
      domain: q.domain ? String(q.domain) : undefined,
      since: q.since ? String(q.since) : undefined,   // event-date range for historical lookups
      until: q.until ? String(q.until) : undefined,
      sort: q.sort ? String(q.sort) : undefined,      // validated against SIGNAL_SORTS in db.ts
      dir: q.dir ? String(q.dir) : undefined,
      history: q.history === "1" || q.history === "true", // include dismissed = full record
      // Collapse (merge one event reported by several sources) is on by default, but NEVER for a
      // one-off check: that's an inventory of what's true for each domain, so hiding rows the user
      // explicitly asked to see would be wrong.
      collapse: q.check ? false : !(q.collapse === "0" || q.collapse === "false"),
    };
  };

  // CSV of the CURRENT feed — same filters, same grouping, no pagination. The daily working surface
  // had no export, no copy and no bulk action, so the only way anything left it was opening rows one
  // at a time.
  //
  // The 20,000-row cap is gone. It was declared in an X-HyperSignal-Truncated response header, which
  // is honest in principle and invisible in practice: this endpoint is reached by clicking a download
  // link, and a browser shows the file, never the headers. The user got a CSV that looked complete.
  // The matched-postings export next door is already uncapped and streams 16k rows carrying full job
  // descriptions; a signal row is a fraction of that, and the response is written in 2,000-row chunks,
  // so the cap was bounding the wrong thing anyway.
  app.get("/api/signals/export", (req, res) => {
    const f = signalFilterFrom(req.query as Record<string, unknown>);
    const { items } = dbListSignals({ ...f, limit: -1, offset: 0 });
    // Channel parity with the webhook (src/delivery.ts). The two were drifting in BOTH directions:
    // the webhook carried evidence_rank and a separate first_seen_at that this CSV did not, while
    // this CSV carried matched_by and reports_grouped the webhook did not. `when` collapses
    // observed_at and created_at into one column, so a signal we learned about late was
    // indistinguishable from one that happened late — first_seen tells them apart. evidence_rank
    // says how hard the evidence is (an official filing outranks a press mention), which is what a
    // reader needs to decide whether to act on a row.
    const cols = ["when", "first_seen", "company", "domain", "signal", "category", "evidence_rank",
      "matched_by", "title", "detail", "url", "monitor", "reports_grouped"];
    const rows = items.map((s) => [
      asIso(s.observedAt ?? s.createdAt), asIso(s.createdAt), s.company ?? "", s.domain ?? "", s.type,
      s.category ?? "other", s.evidenceRank ?? 0, attributionOf(String(s.type)), s.title,
      // A null detail is an EMPTY cell. JSON.stringify(s.detail ?? "") turned it into the two-character
      // string `""`, which the CSV writer then escaped to `""""` — a quote mark in every empty cell.
      s.detail == null ? "" : typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail),
      s.url ?? "", s.client ?? (s.checkId ? "check" : ""), s.groupCount ?? 1,
    ].map(cell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="signals-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(cols.join(",") + "\n");
    for (let k = 0; k < rows.length; k += 2000) res.write(rows.slice(k, k + 2000).join("\n") + "\n");
    res.end();
  });

  app.get("/api/signals", (req, res) => {
    const q = req.query;
    // Collapse (merge one event reported by several sources) is on by default, but NEVER for a
    // one-off check: that's an inventory of what's true for each domain, so hiding rows the user
    // explicitly asked to see would be wrong.
    res.json(dbListSignals({
      ...signalFilterFrom(q as Record<string, unknown>),
      limit: Math.min(Number(q.limit) || 15, 200),
      offset: Math.max(Number(q.offset) || 0, 0),
    }));
  });
  // CURRENT signals (present state, from domain_flags) — the feed's fallback when there are no change
  // events yet, so the Signals tab shows what's true right now instead of a blank feed.
  app.get("/api/signals/current", (req, res) => {
    res.json(dbListCurrentSignals({
      q: req.query.q ? String(req.query.q) : undefined,
      limit: Math.min(Number(req.query.limit) || 15, 200),
      offset: Math.max(Number(req.query.offset) || 0, 0),
    }));
  });
  app.get("/api/signals/stats", (req, res) => {
    // `group` mirrors the feed's grouping toggle (same default: on). The KPI strip and the category
    // breakdown sit directly above the feed and must count the same rows it shows.
    res.json(dbSignalStats({
      client: req.query.client ? String(req.query.client) : undefined,
      grouped: req.query.group !== "0",
    }));
  });
  // Current-state flags for one domain (the per-company signal panel — no re-scan).
  app.get("/api/signals/flags", (req, res) => {
    const domain = req.query.domain ? String(req.query.domain) : "";
    if (!domain) return res.status(400).json({ error: "domain required" });
    res.json({ domain, flags: dbGetDomainFlags(domain) });
  });
  // Batch of current HIT flags for many domains at once — powers the Accounts home "why now" chips
  // (one call for a page of companies instead of one per row). Only positive flags, with their summary.
  // `flags` carries only the hits, so a domain absent from it is ambiguous: never scanned, or
  // scanned and clean? The "Why now" column rendered those two identically. `checked` answers it —
  // a domain appears there once ANY producer has recorded a flag for it, hit or miss — along with
  // when we last looked, so the UI can date what it shows.
  // The 100 cap keeps one GET's query string well under any URL length limit, and the client chunks
  // to match. It used to be a bare .slice(0, 100) with nothing said about it, which is a silent
  // truncation sitting EXACTLY on the boundary: the page-size control offers 100 rows and this is
  // called with one domain per row, so a single extra option (or a row contributing a second domain)
  // would have started dropping companies with no symptom except a "Why now" column that quietly
  // reads "never scanned" for the tail of the page. `truncated` makes an overflow visible instead.
  const DOMAIN_FLAG_BATCH = 100;
  app.get("/api/domain-flags", (req, res) => {
    const asked = String(req.query.domains ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const domains = asked.slice(0, DOMAIN_FLAG_BATCH);
    if (asked.length > domains.length) {
      console.warn(`[domain-flags] asked for ${asked.length} domains, serving ${domains.length} — the caller should chunk`);
    }
    const flags: Record<string, Array<{ producer: string; summary: string | null; checkedAt: string | null }>> = {};
    const checked: Record<string, string | null> = {};
    for (const d of new Set(domains)) {
      const all = dbGetDomainFlags(d);
      if (!all.length) continue;                       // genuinely never scanned
      const stamps = all.map((f) => f.checkedAt).filter(Boolean) as string[];
      checked[d] = stamps.length ? stamps.sort().at(-1)! : null;
      const hits = all.filter((f) => f.hit).map((f) => ({ producer: f.producer, summary: f.summary, checkedAt: f.checkedAt ?? null }));
      if (hits.length) flags[d] = hits;
    }
    res.json({ flags, checked, ...(asked.length > domains.length ? { truncated: asked.length - domains.length } : {}) });
  });
  // On-demand check of ONE domain across all (or the chosen) producers — runs now, returns per-producer
  // facts + flags, and persists flags + new signals (so the job-view filters pick it up immediately).
  app.post("/api/signals/check-domain", async (req, res) => {
    const domain = req.body?.domain ? String(req.body.domain) : "";
    if (!domain) return res.status(400).json({ error: "domain required" });
    const keys = Array.isArray(req.body?.signals) ? req.body.signals.map(String) : undefined;
    const adCountry = normalizeAdRegion(req.body?.adCountry) ?? undefined; // unrecognised → Settings default
    try { res.json(await checkDomainNow(domain, keys, { adCountry })); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.post("/api/signals/:id/dismiss", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" }); // NaN would throw in the SQL bind → 500
    const ok = dbDismissSignal(id, req.body?.dismissed !== false);
    if (!ok) return res.status(404).json({ error: "signal not found" });
    res.json({ ok: true });
  });
  // Run a client's enabled producers NOW (the Feed's "Scan now" button) — responds immediately,
  // runs in the background, and delivers new signals through the client's webhook.
  app.post("/api/signals/run/:client", (req, res) => {
    const client = getClients().find((c) => c.name === req.params.client);
    if (!client) return res.status(404).json({ error: "client not found" });
    if (!client.signals?.length) return res.status(400).json({ error: "no signals enabled on this monitor" });
    res.json({ started: true });
    setImmediate(async () => {
      try { await trackBg(async () => { if (await runClientSignals(client) && isRealtime(client)) await deliverSignals(client); }); }
      catch (e) { console.warn(`[signals:${client.name}] manual run failed: ${(e as Error).message}`); }
    });
  });

  // System health: live gate state + DB/content stats (the System panel's top strip).
  app.get("/api/health", (_req, res) => {
    // deliveryFailures rides along on the endpoint the dashboard already polls, so a webhook that
    // has started failing surfaces in the UI instead of only in a console nobody opens.
    // signalQueue rides along here too: a paced producer finishing hours after the scan that asked
    // for it is invisible otherwise, and "GDELT shows nothing" is indistinguishable from "GDELT is
    // still working through 1,200 companies" without a number on screen.
    const paced = pacedProducers();
    // Seconds, not minutes: a two-item queue rounded to "0 minutes left", which reads as "finished".
    const queue = dbSlowQueueStats().map((s) => ({ ...s,
      etaSec: Math.round((s.queued * (producerByKey(s.producer)?.paceMs ?? 0)) / 1000) }));
    // unverifiedStale is the OTHER half of the job-close fix. The sweep now refuses to close a
    // posting whose source has not looked since, which is correct — and silent. Without a number on
    // screen, "this source has not been fetched in three weeks and 12,000 of its postings are
    // unverified" is indistinguishable from "everything is fine and nothing changed".
    res.json({ ...dbHealth(), gate: hcGateStats(), uptimeSec: Math.round(process.uptime()),
      deliveryFailures: dbDeliveryHealth().filter((d) => !d.ok),
      // deliveryBacklog is the third silence. A queued row is not "waiting for a webhook to be
      // configured" — delivery retires anything with no sink — it is work no pass has ever run over.
      // The dashboard reads the signals and matches tables directly, never the delivered flag, so a
      // backlog can age for days behind a screen that looks entirely healthy.
      deliveryBacklog: dbDeliveryBacklog(),
      unverifiedStale: dbUnverifiedStale(),
      // configWarnings is the fourth silence, and the loudest: a client that will never fetch, or
      // whose matches will queue undelivered forever, previously said so ONLY to the boot console.
      // These are the scheduler's own strings, recorded as it armed the timers — not a second
      // prediction of the same thing.
      configWarnings: getConfigWarnings(),
      version: APP_VERSION,
      signalQueue: { paced, items: queue } });
  });
  // Fetch-run history (paginated + sortable) for the System panel.
  app.get("/api/runs", (req, res) => {
    const limit = numParam(req.query.limit, 15, 1, 200);
    const offset = numParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const sort = req.query.sort ? String(req.query.sort) : "started_at";
    const dir = req.query.dir === "asc" ? "asc" : "desc";
    res.json({ limit, offset, ...dbListRuns(limit, offset, sort, dir) });
  });

  // Companies view: one row per hiring company in scope, with a hiring-signal score. Sorted + paginated.
  const companyFilterOf = (q: Record<string, unknown>): { client?: string; clients?: string[]; signalFlags?: string[]; q?: string; sort?: string; dir?: "asc" | "desc" } => ({
    client: q.client ? String(q.client) : undefined,
    clients: q.client ? undefined : namesOfKind(q.kind),
    signalFlags: parseList(q.signals),      // "Company signal" filter
    q: q.q ? String(q.q).trim() : undefined, // search box (company name / domain)
    sort: q.sort ? String(q.sort) : undefined,
    dir: q.dir === "asc" ? "asc" : "desc",
  });
  app.get("/api/companies", (req, res) => {
    const f = companyFilterOf(req.query as Record<string, unknown>);
    const limit = numParam(req.query.limit, 15, 1, 200);
    const offset = numParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    // One aggregation, not two: the page and its total come from the same pass now.
    const page = dbCompaniesPage({ ...f, limit, offset });
    res.json({ total: page.total, limit, offset, items: page.items });
  });
  // GTM export: every company in scope as CSV (company,domain,open_roles,roles,score,monitors,max_salary).
  app.get("/api/companies/export", (req, res) => {
    const rows = dbCompaniesForExport(companyFilterOf(req.query as Record<string, unknown>));
    const cols = ["company", "domain", "open_roles", "roles", "score", "monitors", "max_salary", "last_seen"];
    const lines = rows.map((r) => cell(r.company) + "," + cell((String(r.domains ?? "").split(",")[0]) || "") + "," +
      cell(r.openRoles) + "," + cell(r.roles) + "," + cell(r.score) + "," + cell(r.monitors) + "," + cell(r.maxSalary) + "," + cell(asIso(r.lastSeen)));
    const csv = [cols.join(","), ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="companies-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });
  // Every checkable company in the current scope/search (no pagination) — powers the bulk "Select all".
  // Returns only companies that have a website, since a signal check needs a domain.
  app.get("/api/companies/all-domains", (req, res) => {
    const rows = dbCompaniesForExport(companyFilterOf(req.query as Record<string, unknown>));
    const items = rows
      .map((r) => ({ company: String(r.company ?? ""), domain: String((String(r.domains ?? "").split(",").filter(Boolean)[0]) || "") }))
      .filter((x) => x.domain);
    res.json({ total: rows.length, withDomain: items.length, items });
  });
  // Manually set a company's domain (fills the Companies view + unlocks "Check signals"). Always 'manual'.
  // normalizeOrgDomain only strips scheme/www/path — it does NOT validate shape, so a stricter
  // domain-shape check gates junk like "not a domain" (the resolver's domains are already fetch-verified).
  // The regex used to live here, on this one-at-a-time route only, while the bulk Signal Check and
  // Account Check paths had no check at all — backwards. It is normalize.ts's isDomainShaped now, and
  // all three share it.
  app.post("/api/companies/domain", (req, res) => {
    const company = String(req.body?.company ?? "").trim();
    const domain = normalizeOrgDomain(String(req.body?.domain ?? ""));
    if (!company) return res.status(400).json({ error: "company required" });
    if (!isDomainShaped(domain)) return res.status(400).json({ error: "provide a valid domain, e.g. stripe.com" });
    dbSetCompanyDomain(company, domain, "manual");
    res.json({ ok: true, company, domain, source: "manual" });
  });
  // Auto-resolve domains for companies that have none: guess candidates from the name, fetch each
  // homepage, and store ONLY a verified match (source 'auto', badged in the UI). Bounded concurrency;
  // never overwrites a manual override. Fetches are async I/O so the server stays responsive throughout.
  // Resolve missing company websites. Two modes:
  //  { companies: [...] }      — resolve these specific names (page-scoped callers).
  //  { all: true, max?: 40 }   — one bounded batch of the WHOLE missing-domain backlog; returns
  //                              `remaining` so the UI loops with live progress until it hits 0.
  app.post("/api/companies/resolve-domains", async (req, res) => {
    if (req.body?.all === true) {
      const max = Math.max(1, Math.min(Number(req.body.max) || 40, 60));
      const r = await resolveMissingDomains(max);
      return res.json({ ok: true, ...r });
    }
    const names = Array.isArray(req.body?.companies)
      ? [...new Set((req.body.companies as unknown[]).map((x) => String(x).trim()).filter(Boolean))].slice(0, 60) : [];
    if (!names.length) return res.status(400).json({ error: "provide companies[] or all:true" });
    const r = await resolveCompanyBatch(names);
    res.json({ ok: true, ...r });
  });

  // Triage: star / unstar a job (per-job flag; starred jobs sort first everywhere).
  app.post("/api/jobs/:id/star", (req, res) => {
    const starred = req.body?.starred !== false; // default true
    const r = dbSetStar(req.params.id, starred);
    if (r === null) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, starred: r });
  });

  // Triage: hide / unhide one job's matches in scope (reversible; per-row "not interested" + undo).
  app.post("/api/jobs/:id/hide", (req, res) => {
    const scope = scopeOf(req.query as Record<string, unknown>);
    res.json({ ok: true, hidden: dbHideJob(req.params.id, scope) });
  });
  app.post("/api/jobs/:id/unhide", (req, res) => {
    const scope = scopeOf(req.query as Record<string, unknown>);
    res.json({ ok: true, restored: dbUnhideJob(req.params.id, scope) });
  });

  // Unseen counts per kind: matches found after ?since=<iso> (drives the sidebar NEW badges).
  app.get("/api/matches/unseen", (req, res) => {
    const since = req.query.since ? String(req.query.since) : null;
    if (!since) return res.json({ search: 0, watchlist: 0 });
    const count = (kind: "search" | "watchlist") => {
      const names = namesOfKind(kind);
      return countMatches({ clients: names, newSince: since });
    };
    res.json({ search: count("search"), watchlist: count("watchlist") });
  });

  app.get("/api/stats", (req, res) => {
    const client = req.query.client ? String(req.query.client) : null;
    // Scope: a specific client, else the active tab's kind (set of client names), else all.
    const kindNames = client ? undefined : namesOfKind(req.query.kind);
    // Build a reusable "AND <scope>" clause + params for the match-joined queries.
    let scope = "", cp: string[] = [];
    if (client) { scope = "AND m.client = ?"; cp = [client]; }
    else if (kindNames) { scope = "AND m.client IN (" + (kindNames.length ? kindNames.map(() => "?").join(",") : "?") + ")"; cp = kindNames.length ? kindNames : [" "]; }
    const mWhere = `WHERE m.dismissed = 0 ${scope}`;
    // "Jobs found" — distinct jobs matched within the active scope (a client, or the tab's kind), NOT the
    // global raw_jobs count. So Account Monitoring's "All" tab shows what account monitoring found, etc.
    // Both totals in one statement — they scan the identical set and differ only in DISTINCT.
    const totals = db.prepare(`SELECT COUNT(DISTINCT m.job_id) f, COUNT(*) t FROM matches m ${mWhere}`).get(...cp) as any;
    const totalFound = totals.f, totalMatches = totals.t;
    // ONE indexed pass over the join, tallied in JS, instead of three separate GROUP BY queries that
    // each re-walked the same rows. Measured on production: 140ms for the three, 72ms for this — and
    // because node:sqlite is synchronous, that 68ms was frozen server, not just a slow stat strip.
    // idx_jobs_facets (id, source, state, country, company, title) covers this read from the index.
    // (byClient was dropped: the dashboard never read it, and it was the one stat not scoped to the tab.)
    // These are NOT top-N — every state and country in scope drives its filter dropdown, so a cap would
    // make the ones past it unselectable. Cardinality is ~50 and ~200, so unbounded is fine. A NULL
    // country means "we couldn't tell", never "US", so those rows are simply absent from the facet.
    const facetRows = db.prepare(
      `SELECT j.source, j.state, j.country FROM matches m JOIN raw_jobs j ON j.id=m.job_id ${mWhere}`).all(...cp) as
      Array<{ source: string | null; state: string | null; country: string | null }>;
    const srcT = new Map<string, number>(), stT = new Map<string, number>(), coT = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const r of facetRows) {
      const s = String(r.source ?? "");
      bump(srcT, s.includes(":") ? s.slice(0, s.indexOf(":")) : s);   // same as substr(...instr(':')-1)
      if (r.state !== null) bump(stT, r.state);
      if (r.country) bump(coT, r.country);
    }
    // Count desc, then name asc. The old SQL ordered by count alone, so equal-count states and
    // countries came back in whatever order SQLite happened to produce and the filter dropdowns could
    // reshuffle between requests. Ties now break deterministically.
    const desc = (m: Map<string, number>, key: string) =>
      [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([k, c]) => ({ [key]: k, c }));
    const bySource = desc(srcT, "src"), byState = desc(stT, "state"), byCountry = desc(coT, "country");
    // Currencies present, for the query builder's Currency dropdown. Its own statement rather than a
    // column on the facet pass above: that pass is covered by idx_jobs_facets, and adding one more
    // column to it took the pass from 19ms to 320ms when measured. This is an index-only scan over the
    // partial idx_jobs_currency — 0.24ms — and is deliberately NOT scoped to the tab, because the
    // builder also runs against the whole jobs database, where a currency the current tab happens not
    // to contain still needs to be selectable.
    const byCurrency = (db.prepare("SELECT DISTINCT currency FROM raw_jobs WHERE currency IS NOT NULL ORDER BY currency").all() as Array<{ currency: string }>)
      .map((r) => ({ currency: r.currency }));
    // Top hiring companies — computed live from matches so the combined ("All") view DEDUPES a
    // company that several searches/watchlists track (grouping per-client would list the same
    // employer once per client and inflate the count).
    // Top companies AND the true company count from ONE aggregation. These were two full passes over
    // the same join (48ms + 44ms). The HAVING moved into JS to make that possible: a window function
    // runs AFTER HAVING, so keeping it would have made COUNT(*) OVER () count only the companies with
    // 2+ roles rather than every company hiring. Rows are already ordered by open_roles DESC, so the
    // ones with >= 2 are all at the front and slicing the first 25 of them is the same set as before.
    const topRaw = db.prepare(
      `SELECT j.company AS company,
              COUNT(DISTINCT j.title) AS open_roles,
              (COUNT(DISTINCT j.id) > COUNT(DISTINCT j.title)) AS has_repeat,
              GROUP_CONCAT(DISTINCT m.client) AS clients,
              COUNT(*) OVER () AS _companies
       FROM matches m JOIN raw_jobs j ON j.id = m.job_id
       ${mWhere} AND j.company IS NOT NULL AND j.company <> ''
       GROUP BY jslower(j.company)
       -- name tiebreak is not cosmetic: with LIMIT 25 and ties on open_roles, an arbitrary order
       -- means WHICH companies make the cut can change between identical requests.
       ORDER BY open_roles DESC, jslower(j.company) ASC LIMIT 25`).all(...cp) as Array<Record<string, unknown>>;
    // True count of distinct companies with ≥1 visible matched role in scope (not capped, not doubled).
    const companiesHiring = topRaw.length ? Number(topRaw[0]?._companies ?? 0) : 0;
    const topCompanies = topRaw
      .filter((r) => Number(r.open_roles) >= 2)
      .map(({ _companies, ...rest }) => rest);   // window column is plumbing, not part of the response
    const statusCounts = dbStatusCounts(client ?? undefined, kindNames);
    res.json({ client, totalFound, totalMatches, bySource, byState, byCountry, byCurrency, topCompanies, companiesHiring, statusCounts });
  });

  // Configured clients + setup summary + live match counts (drives the view tabs).
  app.get("/api/config", (_req, res) => {
    const counts = db.prepare("SELECT client, COUNT(*) c FROM matches WHERE dismissed = 0 GROUP BY client").all() as { client: string; c: number }[];
    const cmap = new Map(counts.map((r) => [r.client, r.c]));
    res.json(getClients().map((c) => {
      const s = c.search ?? { keywords: [] };
      return {
        name: c.name, active: c.active,
        kind: c.kind ?? "search",
        orgDomains: (s.orgDomains ?? []).length,
        sourceMode: s.sourceMode ?? "corporate",
        keywords: s.keywords?.length ?? 0,
        location: s.locations?.[0]?.formatted_address ?? null,
        locationCount: s.locations?.length ?? 0,
        workplaceTypes: s.workplaceTypes ?? [],
        seniorityLevels: s.seniorityLevels ?? [],
        datePostedDays: s.datePostedDays ?? 0,
        searchDepth: s.searchDepth ?? "deep",
        hasWebhook: !!c.delivery?.webhook_url, deliveryMode: c.delivery?.mode ?? "realtime",
        deliverySchedule: c.delivery?.schedule ?? null,
        signalsEnabled: (c.signals ?? []).length > 0,
        matches: cmap.get(c.name) ?? 0,
      };
    }));
  });

  // ---- App settings (job retention + webhook batching) ----
  // The stored Companies House key never leaves the server. The dashboard only needs to know
  // WHETHER one is set (to label the field and offer "Remove"); handing the secret itself to
  // every caller of a no-auth GET is a needless way to lose it.
  const publicSettings = (s: AppSettings) => {
    const { companiesHouseKey, ...rest } = s;
    return { ...rest, companiesHouseKeySet: companiesHouseKey.trim().length > 0 };
  };
  app.get("/api/settings", (_req, res) => {
    const s = dbGetSettings();
    res.json({ ...publicSettings(s), oldJobCount: dbCountOldJobs(s.retentionDays) });
  });
  app.put("/api/settings", (req, res) => {
    const b = req.body ?? {};
    // Preserve fields a partial PUT omits, so they aren't reset. These four used to fall back to
    // DEFAULT_SETTINGS rather than the CURRENT value, which meant a PUT carrying only one field
    // (e.g. "remove my Companies House key") silently reset retention, batch size and fetch speed.
    const cur = dbGetSettings();
    const mode = ["off", "hide", "delete"].includes(b.retentionMode) ? b.retentionMode : cur.retentionMode;
    const days = b.retentionDays === undefined ? cur.retentionDays : Math.max(1, Math.min(3650, Number(b.retentionDays) || cur.retentionDays));
    // `Number(x) || 0` turned any unparsable value into 0, and 0 means UNLIMITED batching here — so
    // a typo silently switched the user from 100-signal batches to one giant POST. Every other field
    // in this block falls back to the current value on bad input; this one now does too.
    const batchRaw = b.webhookBatchSize === undefined ? undefined : Number(b.webhookBatchSize);
    const batch = batchRaw === undefined || !Number.isFinite(batchRaw)
      ? cur.webhookBatchSize
      : Math.max(0, Math.min(10000, Math.trunc(batchRaw)));
    const speed = ["gentle", "normal", "aggressive"].includes(b.fetchSpeed) ? b.fetchSpeed : cur.fetchSpeed;
    const autoShutdown = typeof b.autoShutdown === "boolean" ? b.autoShutdown : cur.autoShutdown;
    // Reject an obviously-wrong key (autofilled email, stray spaces) instead of storing it and
    // failing later with a confusing 401 on every check row.
    let companiesHouseKey = cur.companiesHouseKey;
    if (typeof b.companiesHouseKey === "string") {
      const typed = b.companiesHouseKey.trim().slice(0, 200);
      const problem = companiesHouseKeyProblem(typed);
      if (problem) return res.status(400).json({ error: problem });
      companiesHouseKey = typed;
    }
    const autoResolveDomains = typeof b.autoResolveDomains === "boolean" ? b.autoResolveDomains : cur.autoResolveDomains;
    // Ad Library region — validated against the one offered list, so an unrecognised code keeps the
    // current value rather than silently narrowing the search to a scope the user never picked.
    const adCountry = normalizeAdRegion(b.adCountry) ?? cur.adCountry;
    const next: AppSettings = { retentionMode: mode, retentionDays: days, webhookBatchSize: batch, fetchSpeed: speed, autoShutdown, companiesHouseKey, autoResolveDomains, adCountry };
    dbSaveSettings(next);
    setGateProfile(next.fetchSpeed); // apply the speed dial to the live gate immediately
    res.json({ ok: true, ...publicSettings(next), oldJobCount: dbCountOldJobs(days) });
  });

  // ---- Auto-quit: shut down shortly after the LAST dashboard tab closes (opt-in "autoShutdown") ----
  // Each open tab registers a session id (heartbeat on load / when it returns to the foreground). On
  // close the browser fires a sendBeacon "bye". When no tabs remain AND the setting is on, we gracefully
  // shut down after a short grace window — long enough that a reload or navigation (which also fires
  // "bye") re-registers and cancels it. Backgrounding a tab does NOT fire "bye", so it won't false-quit.
  const liveTabs = new Set<string>();
  let autoQuitTimer: NodeJS.Timeout | null = null;
  const cancelAutoQuit = () => { if (autoQuitTimer) { clearTimeout(autoQuitTimer); autoQuitTimer = null; } };
  // Work in flight = a fetch, an account check, or a signal check. Quitting mid-fetch aborts the
  // browser and loses the run (seen in the wild: a hiring.cafe fetch died at page 14 on tab close),
  // so auto-quit WAITS for idle instead of killing work.
  // Auto-quit counted fetches and saved checks and nothing else, so it would exit mid signals-scan.
  // That is the worst thing to interrupt: a diff producer commits its new baseline inside its own
  // check() while the caller only records the resulting signals afterwards, so an exit in between
  // consumes the diff and the change event is gone — not delayed, gone, because the next scan sees no
  // difference. bgWork covers the three background jobs that were invisible here: signals scans,
  // webhook deliveries and domain resolution.
  let bgWork = 0;
  const trackBg = async <T>(fn: () => Promise<T>): Promise<T> => {
    bgWork++;
    try { return await fn(); } finally { bgWork--; }
  };
  // slowWorkInFlight covers the paced-producer worker's CURRENT item only, deliberately — not its
  // queue depth. The queue is measured in hours; treating "work is owed" as "the app is busy" would
  // mean autoShutdown never fires again. The worker's idle timer is unref'd for the same reason, and
  // the queue is on disk, so whatever is unfinished simply resumes on the next boot.
  const workInFlight = (): boolean => isAnyFetching() || acRuns.size > 0 || scRuns.size > 0 || bgWork > 0 || slowWorkInFlight();
  const maybeScheduleAutoQuit = () => {
    cancelAutoQuit();
    if (!dbGetSettings().autoShutdown || liveTabs.size > 0) return;
    const tick = () => {
      autoQuitTimer = null;
      if (!dbGetSettings().autoShutdown || liveTabs.size > 0) return;   // re-opened / turned off meanwhile
      if (workInFlight()) { autoQuitTimer = setTimeout(tick, 15000); return; } // busy → check again shortly
      void gracefulShutdown("dashboard closed");
    };
    autoQuitTimer = setTimeout(tick, 6000);
  };
  app.post("/api/session/ping", (req, res) => {
    const id = String((req.body ?? {}).id ?? "");
    if (id) { liveTabs.add(id); cancelAutoQuit(); }
    res.status(204).end();
  });
  app.post("/api/session/bye", (req, res) => {
    const id = String((req.body ?? {}).id ?? "");
    if (id) liveTabs.delete(id);
    maybeScheduleAutoQuit();
    res.status(204).end();
  });
  // Flip the "quit when I close the window" setting on its own (instant-apply UI toggle).
  app.post("/api/app/auto-quit", (req, res) => {
    const enabled = !!(req.body ?? {}).enabled;
    dbSaveSettings({ ...dbGetSettings(), autoShutdown: enabled });
    if (!enabled) cancelAutoQuit(); // turning it off cancels any pending shutdown
    res.json({ ok: true, autoShutdown: enabled });
  });

  // Test the Companies House key (optionally saving a newly-typed one first) — one cheap live probe
  // with a precise diagnosis, so a bad key is caught in Settings instead of erroring on every check row.
  app.post("/api/companies-house/test", async (req, res) => {
    const typed = typeof req.body?.key === "string" ? req.body.key.trim().slice(0, 200) : null;
    if (typed) { const problem = companiesHouseKeyProblem(typed); if (problem) return res.status(400).json({ ok: false, message: problem }); }
    // An EMPTY string means "test what is already saved", not "clear it". `typed !== null` treated
    // "" as a new value and wrote it, so pressing Test on a form whose password field had been
    // cleared (or never populated, which is how the UI renders a saved key) silently DESTROYED the
    // stored key — and then reported whatever testing an empty key returns. Clearing the key is the
    // Settings save path's job; a test never writes unless it was given something to write.
    if (typed && typed !== dbGetSettings().companiesHouseKey) {
      dbSaveSettings({ ...dbGetSettings(), companiesHouseKey: typed });
    }
    const result = await testCompaniesHouseKey();
    // A failed test answered HTTP 200 with an error body, so anything reading the status (a proxy
    // log, a retry policy, a future caller) saw success.
    res.status(result.ok ? 200 : 502).json(result);
  });

  // Live count of jobs older than ?days (for the settings preview, before saving).
  app.get("/api/jobs/old-count", (req, res) => {
    const days = Math.max(1, Number(req.query.days) || dbGetSettings().retentionDays);
    res.json({ days, count: dbCountOldJobs(days) });
  });

  // ---- Reversible "hide old jobs", scoped to a search (?client=) or ALL ----
  // Summary drives the dashboard buttons: how many old jobs could be hidden, how many are hidden now.
  app.get("/api/jobs/old-summary", (req, res) => {
    const scope = scopeOf(req.query as Record<string, unknown>);
    const days = Math.max(1, Number(req.query.days) || dbGetSettings().retentionDays);
    res.json({ days, scope: scope.client ?? String(req.query.kind ?? "all"), oldCount: dbCountOldMatches(days, scope), hiddenCount: dbCountHidden(scope) });
  });
  // Hide old jobs (reversible) for one search, the active kind, or all. Jobs stay in the DB.
  app.post("/api/jobs/hide-old", (req, res) => {
    const scope = scopeOf(req.query as Record<string, unknown>);
    const days = Math.max(1, Number(req.query.days) || dbGetSettings().retentionDays);
    res.json({ ok: true, hidden: dbHideOldMatches(days, scope), scope: scope.client ?? String(req.query.kind ?? "all"), days });
  });
  // Restore everything previously hidden in scope.
  app.post("/api/jobs/restore", (req, res) => {
    const scope = scopeOf(req.query as Record<string, unknown>);
    res.json({ ok: true, restored: dbRestoreHidden(scope), scope: scope.client ?? String(req.query.kind ?? "all") });
  });

  // ---- Open/Closed lifecycle ----
  // Automatic sweep: close expired + long-unseen (disappeared) jobs. Safe to run anytime.
  app.post("/api/jobs/sweep", (_req, res) => {
    const r = dbSweepClosed();
    res.json({ ok: true, ...r });
  });
  // On-demand "verify": re-check EVERY open posting's URL in scope and close ones that 404/410 (gone).
  // Streams progress over SSE because it checks ALL open postings (no cap) — for a large scope this is
  // one request per posting and can take a few minutes, so the UI shows a live checked/total count.
  const VERIFY_CONCURRENCY = Math.max(1, Number(process.env.VERIFY_CONCURRENCY ?? 12));
  app.get("/api/jobs/verify-stream", async (req, res) => {
    const scope = scopeOf(req.query as Record<string, unknown>);
    let scl = "", sp: string[] = [];
    if (scope.client) { scl = "AND m.client = ?"; sp = [scope.client]; }
    else if (scope.clients) { scl = "AND m.client IN (" + (scope.clients.length ? scope.clients.map(() => "?").join(",") : "?") + ")"; sp = scope.clients.length ? scope.clients : [" "]; }
    const rows = db.prepare(
      `SELECT DISTINCT j.id, j.url FROM matches m JOIN raw_jobs j ON j.id = m.job_id
       WHERE m.dismissed = 0 AND j.status = 'open' AND j.url IS NOT NULL ${scl}
       ORDER BY j.last_seen_at ASC`,
    ).all(...sp) as { id: string; url: string }[];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("start", { total: rows.length });

    const close = db.prepare("UPDATE raw_jobs SET status='closed', closed_at=datetime('now') WHERE id=?");
    let checked = 0, closed = 0, idx = 0, aborted = false;
    req.on("close", () => { aborted = true; }); // user navigated away / closed the stream → stop early
    async function worker() {
      while (idx < rows.length && !aborted) {
        const r = rows[idx++]!;
        checked++;
        try {
          // safeFetch: SSRF-guarded (public host only, redirects re-validated per hop). A blocked or
          // unreachable URL throws → caught below → job left open (unknown), never closed on a guard error.
          const ctl = AbortSignal.timeout(8000);
          let resp = await safeFetch(r.url, { method: "HEAD", signal: ctl }).catch(() => null);
          if (!resp || resp.status === 405) resp = await safeFetch(r.url, { method: "GET", signal: ctl }).catch(() => null);
          if (resp && (resp.status === 404 || resp.status === 410)) { close.run(r.id); closed++; } // only hard-gone; 403/bot-walls left open
        } catch { /* network error → leave open (unknown) */ }
        if (checked % 10 === 0) send("progress", { checked, closed, total: rows.length });
      }
    }
    await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, worker));
    if (!aborted) {
      send("progress", { checked, closed, total: rows.length });
      send("done", { checked, closed, total: rows.length, scope: scope.client ?? String(req.query.kind ?? "all") });
    }
    res.end();
  });
  // Manual one-off purge of jobs older than ?days (defaults to the configured retentionDays).
  app.post("/api/jobs/purge-old", (req, res) => {
    const s = dbGetSettings();
    const days = Math.max(1, Number(req.query.days) || s.retentionDays);
    const removed = dbPurgeOldJobs(days);
    reload({ backfill: false });
    res.json({ ok: true, removed, days });
  });

  // Collapse duplicate job rows (same posting via multiple boards / keyword search + /org/ scan).
  app.post("/api/jobs/dedupe", (_req, res) => {
    const r = dbDedupeJobs();
    res.json({ ok: true, ...r });
  });

  // ---- Admin: manage the jobs DB directly (filter / view / edit / delete / bulk) ----
  const ADMIN_FILTER_KEYS = new Set(["q", "fuzzy", "source", "status", "state", "remote", "postedWithinDays", "hasMatches", "seniority", "tech", "monitor", "signals", "hasDescription", "adv", "sort", "dir"]);
  // strict=true (the bulk-delete / bulk-status / export bodies): an unknown key THROWS instead of
  // being ignored. A silently-ignored key here is catastrophic fail-open — a caller that spells a
  // filter wrong would bulk-delete a far broader set than intended (up to the whole table).
  const adminFilter = (q: Record<string, unknown>, strict = false): AdminJobFilter => {
    if (strict) {
      for (const k of Object.keys(q)) if (!ADMIN_FILTER_KEYS.has(k)) throw new Error(`unknown filter key "${k}"`);
    }
    return {
      q: q.q ? String(q.q) : undefined,
      fuzzy: q.fuzzy === "1" || q.fuzzy === true ? true : undefined,
      source: q.source ? String(q.source) : undefined,
      status: q.status === "open" || q.status === "closed" ? q.status : undefined,
      state: q.state ? String(q.state) : undefined,
      remote: q.remote === "1" || q.remote === true ? true : q.remote === "0" || q.remote === false ? false : undefined,
      postedWithinDays: q.postedWithinDays ? Number(q.postedWithinDays) : undefined,
      hasMatches: q.hasMatches === "yes" || q.hasMatches === "no" ? q.hasMatches : undefined,
      seniority: parseList(q.seniority),
      tech: parseList(q.tech),                              // filter by detected technology (any of)
      monitor: parseList(q.monitor),                        // filter by the search/watchlist that produced the jobs
      signalFlags: parseList(q.signals),                    // "Company signal" filter (any of these producers flagged)
      hasDescription: q.hasDescription === "yes" || q.hasDescription === "no" ? q.hasDescription : undefined,
      sort: q.sort ? String(q.sort) : undefined,
      dir: q.dir === "asc" ? "asc" : q.dir === "desc" ? "desc" : undefined,
      query: parseAdv(q.adv),
    };
  };
  // True when a filter effectively targets the WHOLE table — a destructive bulk op with one of these
  // must carry an explicit { all: true } acknowledgment. This is answered SEMANTICALLY (by counting),
  // not structurally: an advanced-filter tree can have children that still compile to a tautology
  // (conditions with empty value arrays → "1=1", nested empty groups → "((1=1))"), which a
  // `children.length > 0` check wrongly reads as "narrowing" — letting a no-op tree wipe every row
  // without the { all: true } guard. Comparing the filter's row count to the full-table count closes
  // that hole for any tree, however it compiles. Runs only on the rare destructive bulk path.
  const filterMatchesEverything = (f: AdminJobFilter): boolean => {
    const matched = dbAdminJobsCount(f);
    if (matched === 0) return false;            // an empty result set is not "everything" — nothing to guard
    return matched >= dbAdminJobsCount({});     // narrows to no fewer rows than the whole table
  };
  app.get("/api/admin/jobs", (req, res) => {
    const limit = numParam(req.query.limit, 50, 1, 200);
    const offset = numParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    try {
      const f = adminFilter(req.query as Record<string, unknown>);
      res.json({ total: dbAdminJobsCount(f), limit, offset, items: dbAdminJobs({ ...f, limit, offset }) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); } // bad advanced-filter tree
  });
  // CSV export of ALL jobs matching the current filters (full set, not just the page). Registered
  // before the :id route so "/export" isn't captured as an id.
  app.get("/api/admin/jobs/export", (req, res) => {
    let rows: ReturnType<typeof dbAdminJobsForExport>;
    try { rows = dbAdminJobsForExport(adminFilter(req.query as Record<string, unknown>)); }
    catch (e) { return res.status(400).json({ error: (e as Error).message }); } // bad filter → 400, not 500
    // seniority…salary_currency are ADDED at the end, deliberately: a CSV consumer with a saved
    // column mapping keeps working when new fields append, and breaks when they are inserted.
    const cols = ["company", "title", "location", "state", "remote", "status", "source", "domain", "matches", "clients", "technologies", "posted_at", "first_seen_at", "url", "description",
      "seniority", "commitment", "workplace_type", "max_salary", "salary_currency"];
    const lines = rows.map((r) => {
      // The stored description column (scraped JD, or composed from hiring.cafe's structured fields)
      // — the same text the dashboard shows. raw.description alone is blank for keyword-search jobs.
      const description = (r.description as string) ?? "";
      const rec: Record<string, unknown> = {
        company: r.company, title: r.title, location: r.location, state: r.state, remote: r.remote ? "yes" : "no",
        status: r.status, source: publicSource(r.source), domain: r.domain, matches: r.matchCount, clients: r.clients,
        technologies: r.technologies, posted_at: asIso(r.postedAt), first_seen_at: asIso(r.seenAt), url: r.url, description,
        seniority: r.seniority, commitment: csvList(r.commitment), workplace_type: r.workplaceType,
        max_salary: r.compMax, salary_currency: r.currency,
      };
      return cols.map((c) => cell(rec[c])).join(",");
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="jobs-database-${new Date().toISOString().slice(0, 10)}.csv"`);
      // Streamed in chunks rather than concatenated. At 16k rows the single join built a ~20 MB
      // string on top of the rows already in memory, spiking the heap and blocking the loop for its
      // whole duration — and because node:sqlite is synchronous that is the WHOLE server, not just
      // this route.
      res.write(cols.join(",") + "\n");
      for (let k = 0; k < lines.length; k += 2000) res.write(lines.slice(k, k + 2000).join("\n") + "\n");
      res.end();
  });
  app.get("/api/admin/jobs/:id", (req, res) => {
    const j = dbAdminJob(req.params.id);
    if (!j) return res.status(404).json({ error: "not found" });
    res.json(j);
  });
  app.patch("/api/admin/jobs/:id", (req, res) => {
    const b = { ...(req.body ?? {}) };
    if ("status" in b && b.status !== "open" && b.status !== "closed") delete b.status; // guard the lifecycle enum
    if (!dbUpdateJob(req.params.id, b)) return res.status(400).json({ error: "no changes or not found" });
    res.json({ ok: true });
  });
  app.delete("/api/admin/jobs/:id", (req, res) => {
    if (!dbDeleteJob(req.params.id)) return res.status(404).json({ error: "job not found" });
    res.json({ ok: true });
  });
  // Parse a destructive bulk body STRICTLY. Unknown filter keys, a bad adv tree, or an
  // effectively-empty filter without an explicit { all: true } all → 400. Never fail open: a filter
  // that doesn't round-trip must not silently widen into "everything".
  const parseBulkTarget = (body: Record<string, unknown> | undefined): { ids?: string[]; filter?: AdminJobFilter } => {
    const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).map(String) : undefined;
    if (ids) return { ids };
    if (!body?.filter || typeof body.filter !== "object") throw new Error("provide ids or filter");
    const filter = adminFilter(body.filter as Record<string, unknown>, true); // strict: unknown keys throw
    if (body.all !== true && filterMatchesEverything(filter)) {
      throw new Error("filter matches every record — pass { all: true } to confirm acting on the whole database");
    }
    return { filter };
  };
  // Bulk delete: body { ids:[...] } OR { filter:{ q,source,status,... }, all?: true } (same filter shape as the list).
  app.post("/api/admin/jobs/bulk-delete", (req, res) => {
    try {
      const target = parseBulkTarget(req.body);
      res.json({ ok: true, removed: dbBulkDeleteJobs(target) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  // Bulk set open/closed: body { status, ids:[...] | filter:{...}, all?: true }.
  app.post("/api/admin/jobs/bulk-status", (req, res) => {
    const status = req.body?.status === "closed" ? "closed" : req.body?.status === "open" ? "open" : null;
    if (!status) return res.status(400).json({ error: "status must be 'open' or 'closed'" });
    try {
      const target = parseBulkTarget(req.body);
      res.json({ ok: true, changed: dbBulkSetStatus(status, target) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // Full editable config for one client (stored form, pre env-interpolation).
  app.get("/api/clients/:name", (req, res) => {
    const cfg = getClientRaw(req.params.name);
    if (!cfg) return res.status(404).json({ error: "not found" });
    res.json(cfg);
  });

  // Create or update a client. Validates, persists, hot-reloads schedules + backfills.
  // Persist the config (fast) and ACKNOWLEDGE immediately, then run the match reconcile in the
  // background. The reconcile can take a moment on a large job pool (esp. a broad new search that
  // matches many historical jobs), and there's no reason to hold the Save button hostage to it —
  // the config is already saved + scheduled; matches populate right after.
  // reloadAsync, not reload: this fires while the user is looking at the dashboard, so the
  // reconcile yields between steps instead of blocking the server for the whole sequence.
  const reloadSoon = () => { void reloadAsync().catch((e: unknown) => console.error("[clients] post-save reconcile failed:", (e as Error).message)); };
  app.put("/api/clients/:name", (req, res) => {
    try {
      const oldName = req.params.name;
      const body = req.body ?? {};
      const saved = body.name && body.name !== oldName
        ? renameClient(oldName, body)            // rename (keeps match history)
        : saveClient({ ...body, name: oldName });
      res.json({ ok: true, name: saved.name });
      reloadSoon();
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/api/clients", (req, res) => {
    try {
      const saved = saveClient(req.body);
      res.json({ ok: true, name: saved.name });
      reloadSoon();
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.delete("/api/clients/:name", (req, res) => {
    deleteClient(req.params.name);
    reload({ backfill: false });
    res.json({ ok: true });
  });

  // Manual "Fetch New Jobs" button state + the next scheduled-fetch time (drives the countdown).
  app.get("/api/clients/:name/fetch-status", (req, res) => {
    const name = req.params.name;
    const client = getClients().find((c) => c.name === name);
    const nextFetchAt = client?.active ? nextCronRun(client.refreshCron ?? "0 * * * *") : null;
    res.json({ inProgress: isFetching(clientKey(name)), cooldownMs: cooldownRemaining(name), cooldownTotalMs: FETCH_COOLDOWN_MS, nextFetchAt });
  });

  // Trigger a manual fetch. Runs in the BACKGROUND; progress streams to every open dashboard over
  // /api/activity (the same feed scheduled fetches use). ?override=1 skips the cooldown.
  app.post("/api/clients/:name/fetch", (req, res) => {
    const name = req.params.name;
    const client = getClients().find((c) => c.name === name);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (isFetching(clientKey(name))) return res.json({ started: false, running: true });
    const rem = cooldownRemaining(name);
    if (rem > 0 && req.query.override !== "1") return res.json({ started: false, cooldown: true, cooldownMs: rem });
    lastManualFetch.set(name, Date.now());
    runClientSources(client, getClients())
      .then(async () => {
        // Non-hiring signals after a manual fetch too (same as the scheduled path) — fail-soft.
        if (client.signals?.length) {
          try { await trackBg(async () => { if (await runClientSignals(client) && isRealtime(client)) await deliverSignals(client); }); }
          catch (e) { console.warn(`[signals:${name}] ${(e as Error).message}`); }
        }
        // Auto-find websites for newly-seen companies missing one (Settings toggle; bounded batch).
        if (dbGetSettings().autoResolveDomains) void trackBg(() => autoResolveAfterFetch());
      })
      .catch((e) => console.warn(`[fetch:${name}] ${(e as Error).message}`));
    res.json({ started: true });
  });

  // Stop an in-progress manual/scheduled fetch gracefully — the source (or discovery domain) in flight
  // finishes and everything already scraped is kept; queued sources are skipped. Mirrors the account /
  // signal-check stop endpoints. `stopping:false` means nothing was running, so the UI just re-syncs.
  app.post("/api/clients/:name/stop-fetch", (req, res) => {
    const stopping = requestFetchStop(clientKey(req.params.name));
    res.json({ ok: true, stopping });
  });

  // Live feed of ALL fetch activity (manual AND scheduled) → the dashboard's progress UI + the running
  // "new jobs found" counter + the completion notification. A tab that connects mid-fetch gets a snapshot.
  app.get("/api/activity", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", { active: activeFetches() });
    const unsub = subscribeFetch((event, data) => send(event, data));
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* connection closed */ } }, 25000);
    res.req.on("close", () => { clearInterval(ping); unsub(); });
  });

  // ---- Location autocomplete: proxy hiring.cafe's /api/searchLocation (plain fetch works, no
  // Cloudflare) so the filter UI typeahead can embed the structured placeDetail into searchState. ----
  // Suggestions for the industry filter. Unlike every other filter vocabulary, this one is NOT a
  // closed list — hiring.cafe's industry field is open-ended (841 distinct values across the stored
  // rows, long tail), so the field accepts free text and these are hints drawn from what we have
  // actually fetched. `total` lets the UI say so honestly instead of implying the list is complete.
  app.get("/api/industries", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    res.json(dbIndustries(q, numParam(req.query.limit, 20, 1, 50)));
  });
  app.get("/api/location-autocomplete", async (req, res) => {
    const q = String(req.query.q ?? req.query.query ?? "").trim();
    if (!q) return res.json({ items: [] });
    try {
      const r = await fetch(`https://hiring.cafe/api/searchLocation?query=${encodeURIComponent(q)}`, {
        headers: { "user-agent": "Mozilla/5.0", accept: "application/json" }, signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return res.status(502).json({ items: [], error: `upstream ${r.status}` });
      const data = (await r.json()) as Array<{ label: string; placeDetail: unknown }>;
      res.json({ items: (Array.isArray(data) ? data : []).map((d) => ({ label: d.label, place: d.placeDetail })) });
    } catch (e) {
      res.status(502).json({ items: [], error: (e as Error).message });
    }
  });

  // ---- Account Check: saved, named, stoppable searches that build their export in real time ----
  // Runs live server-side (independent of any open browser tab), persist progress to the DB, and
  // fan out live updates to subscribed SSE clients. A run survives a tab close; reconnecting
  // re-syncs from the DB snapshot then tails live events.
  // ONE number for both surfaces. This used to read the env var itself, so an Account Check and a
  // watchlist could disagree about the ceiling — and the watchlist had no ceiling at all.
  const ACCOUNT_CAP = DOMAIN_CAP;
  // No cumulative hits array: the reconnect snapshot is served from the DB (GET .../stream reads
  // dbGetAccountSearch), and holding a second copy of a 9,588-domain run in memory bought nothing.
  interface AcRun { control: { stopped: boolean; paused?: boolean }; listeners: Set<(e: string, d: unknown) => void> }
  const acRuns = new Map<string, AcRun>();

  function startAccountRun(id: string, name: string, domains: string[], search: SearchSpec, maxPages: number, scrapeDescriptions = false, resume = false) {
    // Count what will actually run: runAccountCheck dedups/normalizes internally, so a list with
    // duplicates or junk rows would otherwise leave the progress bar stuck below 100% forever.
    const uniqueTotal = new Set(domains.map((d) => normalizeOrgDomain(d)).filter(Boolean)).size;
    const params = { mode: "domain", domains, search, maxPages, scrapeDescriptions };
    if (resume) dbFinishAccountSearch(id, "running"); else dbCreateAccountSearch(id, name, params, uniqueTotal); // resume reuses the existing row (keeps its hits)
    const run: AcRun = { control: { stopped: false }, listeners: new Set() };
    acRuns.set(id, run);
    const acKey = accountKey(id);
    let lastP: AccountProgress | undefined;
    // Also publish to the shared fetch feed so this check shows in the top-right "active fetches" dock
    // (alongside Client/Account Monitoring fetches). Its prominent progress stays in the detail view.
    fetchStarted(acKey, { client: name, kind: "account-check", total: uniqueTotal });
    const runId = dbStartRun(acKey, name, "account-check"); // run-history row (System panel)
    // Read the stored counters rather than the last progress tick: a resumed run restarts its own
    // checked/found/totalHits at zero, so the tick under-reports everything the first pass did.
    const acTotals = () => { const c = dbCheckCounters("account_searches", id); return { fetched: c.totalHits, fresh: c.totalHits, matched: c.found }; };
    const broadcast = (event: string, data: unknown) => { for (const l of run.listeners) l(event, data); };
    (async () => {
      try {
        const results = await runAccountCheck(domains, search, {
          maxPages, scrapeDescriptions,
          originTag: "ac:" + id, // stamp newly-inserted jobs → "Matched by" attribution in the Jobs database
          control: run.control,
          onProgress: (p: AccountProgress) => {
            lastP = p;
            // Append the DELTA. This used to hand over the whole cumulative array, which the DB layer
            // re-serialised into one column on every callback — 25.8 GB of writes on a real 9,588-domain
            // run. It also meant a resumed run's empty starting array overwrote everything found before.
            dbAccountProgress(id, { checked: p.checked, found: p.found, newHits: p.newHits });
            broadcast("progress", p); // newHits delta + cumulative counters
            fetchProgress(acKey, { completed: p.checked, fetched: p.totalHits, fresh: p.totalHits, matched: p.found });
          },
        });
        const status = run.control.paused ? "paused" : run.control.stopped ? "stopped" : "done";
        // A run where some lookups FAILED is not the same as one where those companies are not hiring,
        // and it used to finish byte-identically: status done, error null, found 0. Record what broke,
        // while still keeping the status "done" — the rest of the results are real.
        const failed = results.filter((r) => (r.errors?.length ?? 0) > 0);
        const first = failed[0];
        const note = first
          ? `${failed.length} of ${results.length} companies could not be checked (e.g. ${first.input}: ${first.errors?.[0] ?? "lookup failed"}) — they are NOT reported as "not hiring".`
          : null;
        dbFinishAccountSearch(id, status, note);
        broadcast("done", { status, unchecked: failed.length });
        fetchDone(acKey, acTotals());
        dbFinishRun(runId, { fetched: acTotals().fetched, fresh: acTotals().fresh, matched: acTotals().matched });
      } catch (e) {
        // a shutdown that aborts in-flight scrapes lands here too — keep it resumable when pausing
        const status = run.control.paused ? "paused" : "error";
        dbFinishAccountSearch(id, status, status === "error" ? (e as Error).message : null);
        broadcast(status === "paused" ? "done" : "error", status === "paused" ? { status } : { message: (e as Error).message });
        fetchDone(acKey, acTotals(), status === "error" ? (e as Error).message : undefined);
        dbFinishRun(runId, { fetched: acTotals().fetched, fresh: acTotals().fresh, matched: acTotals().matched, error: status === "error" ? (e as Error).message : null });
      } finally {
        acRuns.delete(id);
      }
    })();
  }

  // ---- Signal checks: multi-signal runs over an uploaded domain list (mirrors the account-check harness) ----
  interface ScRun { control: { stopped: boolean; paused?: boolean }; listeners: Set<(e: string, d: unknown) => void> }
  const scRuns = new Map<string, ScRun>();

  function startSignalCheckRun(id: string, name: string, domains: string[], signalKeys: string[], resume = false, webhook?: string, adCountry?: string) {
    const uniqueTotal = new Set(domains.map((d) => normalizeOrgDomain(d)).filter(Boolean)).size;
    // adCountry is stored in params so the detail screen can show which region the run used — a result
    // grid that says "no ads" is only meaningful next to the region it was measured in.
    if (resume) dbFinishSignalCheck(id, "running"); else dbCreateSignalCheck(id, name, { domains, signals: signalKeys, webhook: webhook || "", adCountry: adCountry || "" }, uniqueTotal);
    const run: ScRun = { control: { stopped: false }, listeners: new Set() };
    scRuns.set(id, run);
    const scKey = "sc:" + id;
    let lastP: SignalCheckProgress | undefined;
    fetchStarted(scKey, { client: name, kind: "signal-check", total: uniqueTotal }); // top-right dock
    const runId = dbStartRun(scKey, name, "signal-check");
    const totals = () => { const c = dbCheckCounters("signal_checks", id); return { fetched: c.totalHits, fresh: c.totalHits, matched: c.found }; };
    const broadcast = (event: string, data: unknown) => { for (const l of run.listeners) l(event, data); };
    (async () => {
      try {
        await runSignalCheck(domains, signalKeys, {
          checkId: id, control: run.control, adCountry,
          onProgress: (p) => {
            lastP = p;
            dbSignalCheckProgress(id, { newResults: p.newResults }); // delta only — see dbSignalCheckProgress
            broadcast("progress", p);
            fetchProgress(scKey, { completed: p.checked, fetched: p.totalHits, fresh: p.totalHits, matched: p.found });
          },
        });
        const status = run.control.paused ? "paused" : run.control.stopped ? "stopped" : "done";
        dbFinishSignalCheck(id, status);
        broadcast("done", { status });
        fetchDone(scKey, totals());
        dbFinishRun(runId, totals());
        // "One-off checks can POST too": deliver this check's new signals to its webhook (resume reads it back).
        if (status === "done") {
          // On resume, `webhook` arg is undefined — read it off the stored params, which dbGetSignalCheck
          // returns ALREADY PARSED (an object), so index it directly (a JSON.parse(String(obj)) would break).
          const hook = webhook ?? ((dbGetSignalCheck(id)?.params as { webhook?: string } | undefined)?.webhook ?? "");
          // CALLED UNCONDITIONALLY. deliverCheckSignals already handles "no webhook" correctly — it
          // marks the rows delivered, because the dashboard is then the only sink and there is nothing
          // to send. Guarding the CALL on `hook` meant a check without a webhook never retired its
          // signals at all, and no other pass covers them: deliverSignals() is scoped to a client, and
          // a check's signals carry check_id with client NULL. They stayed queued permanently.
          // Measured on the live database: 110 signals from two checks in July, still undelivered.
          try { const n = await deliverCheckSignals(id, hook); if (n) console.log(`[deliver-signals:check ${id.slice(0, 8)}] sent ${n}`); }
          catch (e) { console.warn(`[deliver-signals:check] ${(e as Error).message}`); }
        }
      } catch (e) {
        const status = run.control.paused ? "paused" : "error";
        dbFinishSignalCheck(id, status, status === "error" ? (e as Error).message : null);
        broadcast(status === "paused" ? "done" : "error", status === "paused" ? { status } : { message: (e as Error).message });
        fetchDone(scKey, totals(), status === "error" ? (e as Error).message : undefined);
        dbFinishRun(runId, { ...totals(), error: status === "error" ? (e as Error).message : null });
      } finally {
        scRuns.delete(id);
      }
    })();
  }

  // Shutdown hook: mark every in-flight check "paused" (its progress is already persisted) so it resumes next boot.
  _pauseRuns = () => {
    for (const run of acRuns.values()) { run.control.paused = true; run.control.stopped = true; }
    for (const run of scRuns.values()) { run.control.paused = true; run.control.stopped = true; }
    try {
      db.exec("UPDATE account_searches SET status='paused', updated_at=datetime('now') WHERE status='running'");
      db.exec("UPDATE signal_checks SET status='paused', updated_at=datetime('now') WHERE status='running'");
    } catch { /* best-effort */ }
  };
  // Boot hook: re-launch any check left "paused" by a graceful shutdown (cached domains return instantly,
  // so it picks up where it left off; the persisted hits are rebuilt without duplicates).
  _resumeChecks = () => {
    for (const s of dbListAccountSearches()) {
      if (s.status !== "paused") continue;
      const full = dbGetAccountSearch(s.id);
      const p = (full?.params ?? {}) as { domains?: string[]; companies?: string[]; search?: SearchSpec; maxPages?: number; scrapeDescriptions?: boolean };
      const domains = (p.domains ?? p.companies ?? []).map(String).filter(Boolean);
      if (!domains.length) { dbFinishAccountSearch(s.id, "done"); continue; }
      console.log(`[resume] account check "${s.name}" — ${domains.length} domain(s)`);
      startAccountRun(s.id, s.name, domains, (p.search ?? { keywords: [] }) as SearchSpec, p.maxPages ?? 8, !!p.scrapeDescriptions, true);
    }
    for (const s of dbListSignalChecks()) {
      if (s.status !== "paused") continue;
      const full = dbGetSignalCheck(s.id);
      const p = (full?.params ?? {}) as { domains?: string[]; signals?: string[]; webhook?: string; adCountry?: string };
      const domains = (p.domains ?? []).map(String).filter(Boolean);
      if (!domains.length || !(p.signals ?? []).length) { dbFinishSignalCheck(s.id, "done"); continue; }
      console.log(`[resume] signal check "${s.name}" — ${domains.length} domain(s)`);
      // Carry the run's own webhook + ad region across the restart — resuming under different
      // settings would silently finish the run with a different region than it started in.
      startSignalCheckRun(s.id, s.name, domains, p.signals!, true, p.webhook, normalizeAdRegion(p.adCountry) ?? undefined);
    }
  };

  // Create + start a saved search. Returns the new id; the run continues in the background.
  // Domain-only: each row is a company domain, scanned deterministically via hiring.cafe's
  // /org/<domain> page (no name matching), with optional full-description scraping.
  app.post("/api/account/searches", (req, res) => {
    const rawList = req.body?.domains ?? req.body?.companies; // tolerate an older client's key
    const all = Array.isArray(rawList) ? rawList.map((s: unknown) => String(s).trim()).filter(Boolean) : [];
    const list = all.slice(0, ACCOUNT_CAP);
    if (!list.length) return res.status(400).json({ error: "No domains provided" });
    const search = (req.body?.search ?? { keywords: [] }) as SearchSpec;
    // Pages of /org/<domain> to scan per company. Defaults to a deep ceiling (the scraper stops early
    // once it has the company's whole list), so a company with hundreds of openings isn't truncated at
    // ~12 pages. Sane upper bound guards against a pathological request value.
    const maxPages = Math.max(1, Math.min(250, Number(req.body?.maxPages) || 90));
    const scrapeDescriptions = !!req.body?.scrapeDescriptions;
    const name = String(req.body?.name ?? "").trim() || `Check — ${new Date().toLocaleString()}`;
    const id = randomUUID();
    startAccountRun(id, name, list, search, maxPages, scrapeDescriptions);
    res.json({ id, name, count: list.length, submitted: all.length, capped: all.length > ACCOUNT_CAP, cap: ACCOUNT_CAP, mode: "domain" });
  });

  // List saved searches (newest first); ?q= filters by name.
  app.get("/api/account/searches", (req, res) => {
    res.json({ items: dbListAccountSearches(req.query.q ? String(req.query.q) : undefined) });
  });

  // Full saved search: params (for "see the search params") + the results array + live state.
  app.get("/api/account/searches/:id", (req, res) => {
    const s = dbGetAccountSearch(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    res.json({ ...s, live: acRuns.has(req.params.id) });
  });

  // Stop a running search — in-flight batches finish, queued ones skip; partial results are kept.
  app.post("/api/account/searches/:id/stop", (req, res) => {
    const run = acRuns.get(req.params.id);
    if (run) run.control.stopped = true;
    res.json({ ok: true, stopping: !!run });
  });

  app.delete("/api/account/searches/:id", (req, res) => {
    const run = acRuns.get(req.params.id);
    if (run) run.control.stopped = true; // halt an in-flight run before removing its row
    dbDeleteAccountSearch(req.params.id);
    res.json({ ok: true });
  });

  // Server-side CSV export of a saved search's results.
  app.get("/api/account/searches/:id/export", (req, res) => {
    const s = dbGetAccountSearch(req.params.id);
    if (!s) return res.status(404).send("not found");
    const cols = ["input_company", "matched_company", "title", "location", "state", "remote", "status", "posted_at", "url", "description"];
    const rows = (s.hits as Record<string, unknown>[]).map((h) => cols.map((c) => cell(h[c])).join(","));
    const csv = [cols.join(","), ...rows].join("\n");
    const fname = (s.name || "account-check").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-") || "account-check";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}.csv"`);
    res.send(csv);
  });

  // ---- Signal-check endpoints (create/list/detail/stream/stop/delete/export) ----
  app.post("/api/signal-checks", (req, res) => {
    const all = Array.isArray(req.body?.domains) ? req.body.domains.map((s: unknown) => String(s).trim()).filter(Boolean) : [];
    const list = all.slice(0, ACCOUNT_CAP);
    if (!list.length) return res.status(400).json({ error: "No domains provided" });
    const signalKeys = (Array.isArray(req.body?.signals) ? req.body.signals.map(String) : []).filter((k: string) => SIGNAL_PRODUCERS.some((p) => p.key === k));
    if (!signalKeys.length) return res.status(400).json({ error: "Pick at least one signal type" });
    const name = String(req.body?.name ?? "").trim() || `Signal check — ${new Date().toLocaleString()}`;
    // Optional: POST findings. Validate the shape — an unvalidated typo saves fine and then silently
    // never delivers (the watchlist path already validates via zod; this one didn't).
    const webhook = typeof req.body?.webhook === "string" ? req.body.webhook.trim() : "";
    if (webhook) {
      let okUrl = false;
      try { const u = new URL(webhook); okUrl = u.protocol === "http:" || u.protocol === "https:"; } catch { okUrl = false; }
      if (!okUrl) return res.status(400).json({ error: "That webhook isn't a valid URL — it must start with https:// (or http://)." });
    }
    // Ad Library region for THIS run, picked next to the "Meta ad activity" checkbox. Only meaningful
    // when that producer is selected; anything unrecognised falls back to the Settings default.
    const adCountry = signalKeys.includes("ads") ? (normalizeAdRegion(req.body?.adCountry) ?? undefined) : undefined;
    const id = randomUUID();
    startSignalCheckRun(id, name, list, signalKeys, false, webhook, adCountry);
    res.json({ id, name, count: list.length, submitted: all.length, capped: all.length > ACCOUNT_CAP, cap: ACCOUNT_CAP });
  });
  app.get("/api/signal-checks", (req, res) => {
    res.json({ items: dbListSignalChecks(req.query.q ? String(req.query.q) : undefined) });
  });
  app.get("/api/signal-checks/:id", (req, res) => {
    const s = dbGetSignalCheck(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    res.json({ ...s, live: scRuns.has(req.params.id) });
  });
  app.post("/api/signal-checks/:id/stop", (req, res) => {
    const run = scRuns.get(req.params.id);
    if (run) run.control.stopped = true;
    res.json({ ok: true, stopping: !!run });
  });
  app.delete("/api/signal-checks/:id", (req, res) => {
    const run = scRuns.get(req.params.id);
    if (run) run.control.stopped = true;
    dbDeleteSignalCheck(req.params.id); // removes the check AND its recorded signals
    res.json({ ok: true });
  });
  // CSV export: one row per domain; a column per selected producer fact (flattened "producer.fact").
  app.get("/api/signal-checks/:id/export", (req, res) => {
    const s = dbGetSignalCheck(req.params.id);
    if (!s) return res.status(404).send("not found");
    const results = s.results as SignalCheckDomainResult[];
    const factCols: string[] = [];
    for (const r of results) for (const [pk, facts] of Object.entries(r.facts ?? {})) for (const fk of Object.keys(facts)) {
      const col = `${pk}.${fk}`; if (!factCols.includes(col)) factCols.push(col);
    }
    const cols = ["domain", "signals", "signal_types", ...factCols];
    const rows = results.map((r) => [
      r.domain, r.signals, (r.types ?? []).join("; "),
      ...factCols.map((c) => { const [pk, ...rest] = c.split("."); return r.facts?.[pk!]?.[rest.join(".")] ?? ""; }),
    ].map(cell).join(","));
    const fname = (s.name || "signal-check").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-") || "signal-check";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}.csv"`);
    res.send([cols.join(","), ...rows].join("\n"));
  });
  // Live updates for a running signal check — same snapshot-then-tail SSE contract as account checks.
  app.get("/api/signal-checks/:id/stream", (req, res) => {
    const id = req.params.id;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const s = dbGetSignalCheck(id);
    if (!s) { send("error", { message: "not found" }); res.end(); return; }
    send("snapshot", { ...s, live: scRuns.has(id) });
    const run = scRuns.get(id);
    if (!run) { send("done", { status: s.status }); res.end(); return; }
    const listener = (event: string, data: unknown) => send(event, data);
    run.listeners.add(listener);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25000);
    res.req.on("close", () => { clearInterval(ping); run.listeners.delete(listener); });
  });

  // Live updates for a search. Sends a full snapshot first (re-sync), then tails progress events.
  app.get("/api/account/searches/:id/stream", (req, res) => {
    const id = req.params.id;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const s = dbGetAccountSearch(id);
    if (!s) { send("error", { message: "Search not found." }); return res.end(); }
    // Snapshot brings the client fully up to date (covers the gap before the listener attaches).
    send("snapshot", { status: s.status, total: s.total, checked: s.checked, found: s.found, totalHits: s.totalHits, hits: s.hits });

    const run = acRuns.get(id);
    if (!run) { send("done", { status: s.status }); return res.end(); } // already finished
    const listener = (event: string, data: unknown) => {
      send(event, data);
      if (event === "done" || event === "error") { run.listeners.delete(listener); res.end(); }
    };
    run.listeners.add(listener);
    req.on("close", () => run.listeners.delete(listener));
  });

  // Send a sample payload to a webhook URL to verify it works.
  app.post("/api/test-webhook", async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Provide a valid http(s) URL" });
    try {
      const client = req.body?.client ?? "test";
      const r = await ownerFetch(url, {   // same rules as real delivery: own LAN ok, off-host redirects not
        method: "POST",
        signal: AbortSignal.timeout(12000), // don't let the Test button hang on an unresponsive URL
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "HyperSignal-Hiring/1.0",
          "X-HyperSignal-Event": "matches.new",
          "X-HyperSignal-Schema": "2",
          "X-HyperSignal-Client": String(client),
          "X-HyperSignal-Delivery": "test-delivery",
          "X-HyperSignal-Batch": "1/1",
          "X-HyperSignal-Count": "1",
        },
        body: JSON.stringify({
          event: "matches.new", schema_version: 2, client, delivery_id: "test-delivery", test: true,
          batch: { index: 1, total: 1, size: 1 }, count: 1, total_count: 1,
          signals: [{
            id: "test", title: "Customer Support Specialist", company: "Acme Co",
            company_domain: "acme.com", location: "Austin, TX, United States", state: "TX", remote: false,
            status: "open", url: "https://jobs.acme.com/cs-specialist", source: "hiringcafe",
            posted_at: new Date(Date.now() - 86400e3).toISOString(), first_seen_at: new Date().toISOString(),
            match_reason: "corporate · geo:TX",
            seniority: "Entry Level", years_experience_min: 0, job_category: "Customer Service",
            commitment: "Full Time", workplace_type: "Onsite", visa_sponsorship: false, security_clearance: "None",
            compensation: { min: 45000, max: 55000, currency: "USD", period: "yearly" },
            company_info: { industry: "Software", employees: 320, founded: 2014, org_type: "private", funding_type: "series b", funding_year: 2022 },
          }],
        }),
      });
      res.json({ ok: r.ok, status: r.status });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // ---- Lifecycle: readiness (gates the dashboard's startup loading screen) + graceful shutdown ----
  app.get("/api/ready", (_req, res) => res.json({ ready: _ready, shuttingDown: _shuttingDown }));
  app.post("/api/shutdown", (_req, res) => {
    if (_shuttingDown) return res.json({ ok: true, already: true });
    res.json({ ok: true });                                    // flush the response first…
    setTimeout(() => gracefulShutdown("dashboard request"), 250); // …then tear down cleanly
  });

  // THE LAST NET. Everything above it is a route; this catches what a route throws.
  //
  // Express 4 does not await an async handler, so a rejected promise inside one never reaches an
  // error middleware at all — it becomes an unhandledRejection, and index.ts installs a process-wide
  // listener for those that only console.errors. The request itself is simply never answered: the
  // browser holds the connection until fjson's 20-second timeout gives up, and the surface shows
  // "couldn't load this — retrying" with no way to learn why. A synchronous throw does reach here,
  // and without a handler Express replies with an HTML stack trace that the frontend then tries to
  // JSON.parse ("Unexpected token <").
  //
  // Registered LAST because Express matches middleware in order, and an error handler is recognised
  // only by its four-argument shape.
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[server] ${req.method} ${req.path} failed:`, err);
    if (res.headersSent) { res.end(); return; }   // a stream already started — end it rather than append JSON
    res.status(500).json({ error: msg.slice(0, 300) });
  });

  // Bind loopback ONLY. Without a host argument Node binds 0.0.0.0 + ::, which would put every
  // destructive route above on the local network for anything that could reach this machine.
  // HOST is a deliberate escape hatch, and it is a REAL exposure, not a guarded one: this app has
  // no authentication, so anyone who can reach the port owns it. Nothing in the request can change
  // that — the Host header is client-controlled, so a guard on it would only block the operator's
  // own phone (whose Host is the LAN IP) while an attacker sends "Host: localhost" and sails past.
  // The only honest thing to do is bind loopback by default and say plainly what HOST costs.
  const host = process.env.HOST || "127.0.0.1";
  if (!isLocalHostname(host)) {
    console.warn(
      `[server] ⚠  HOST=${host} — the dashboard is bound beyond loopback and has NO LOGIN.\n` +
      `[server] ⚠  Anyone who can reach ${host}:${port} can purge jobs, delete records and shut it down.\n` +
      `[server] ⚠  Only do this on a network you trust, and unset HOST when you are done.`);
  }
  const srv = app.listen(port, host, () => console.log(`[server] dashboard on http://localhost:${port}`));
  _srv = srv;
  srv.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(`[server] port ${port} is already in use — another copy of the app is running. Close it (or set PORT) and retry.`);
    else console.error("[server] listen error:", e.message);
    process.exit(1);
  });
  return srv;
}
