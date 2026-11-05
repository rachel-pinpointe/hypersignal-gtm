import cron from "node-cron";
import { runClientSources } from "./ingest.ts";
import { deliver, deliverSignals, isRealtime } from "./delivery.ts";
import { runClientSignals } from "./signals/index.ts";
import { autoResolveAfterFetch } from "./domainResolver.ts";
import { dbGetSettings, dbPurgeOldJobs, dbSweepClosed, dbPurgeRuns, dbPurgeAccountCache } from "./db.ts";
import { CACHE_TTL_HOURS } from "./accountCheck.ts";
import type { ClientConfig } from "./types.ts";

/** Anything the scheduler holds that can be torn down on reload (cron task, interval, or timeout).
 *  `destroy` is optional because only node-cron tasks have one — and they need it: node-cron keeps a
 *  module-global registry and removes a task only on its "task:destroyed" event. stop() emits
 *  "task:stopped", so a stopped-but-undestroyed task stays in that map for the life of the process,
 *  pinning the clients array it closed over. Stopped tasks provably cannot fire, so this leaked
 *  memory rather than misfiring — but every config reload stranded another generation. */
type Stoppable = { stop: () => void; destroy?: () => void };
let tasks: Stoppable[] = [];

const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout ceiling (~24.8 days) — chain for further-out one-offs
const MIN_INTERVAL_MS = 60_000;  // floor arbitrary intervals at 1 min so a typo can't hammer the sources

/** Turn a client's `schedule` (or the legacy `refreshCron` fallback) into concrete timers that call
 *  `onFire`. Returns the stoppables so a reload can tear them down. Fully covers the three modes the
 *  UI offers — arbitrary interval, recurring times-on-days, and a one-off exact date-time — plus a raw
 *  cron passthrough. Nothing fires at boot; the first run is at the next scheduled moment. */
// Exported for tests only. The timer COUNT is the whole contract — zero means the client silently
// never runs — and it is not observable any other way without waiting for wall-clock time.
/**
 * Every way a client's delivery config can end up delivering NOTHING, in silence.
 *
 * isRealtime() treats any mode other than the literal "realtime" as scheduled, and that single test
 * gates deliver() in ingest.ts and deliverSignals() in the scheduler. Once a client is off realtime,
 * the digest cron is the only remaining sink — so if that cron is missing or malformed, matches and
 * signals queue up forever with nothing written to the log.
 *
 * The original check caught only a schedule that was present and malformed. Omitting the schedule
 * entirely produces the identical outcome and said nothing at all, and it is the likelier mistake:
 * the dashboard always writes mode "realtime", so a non-realtime mode can only arrive by hand-editing
 * YAML — precisely where a forgotten or mistyped field goes unnoticed.
 *
 * Returned rather than logged so the rules can be tested; startScheduler prints them.
 */
export function deliveryWarnings(client: ClientConfig): string[] {
  if (isRealtime(client)) return [];
  const out: string[] = [];
  const mode = client.delivery?.mode;
  const digest = client.delivery?.schedule?.trim();
  if (!digest) out.push(`delivery mode is "${mode}" but no delivery.schedule is set — NO digest will be sent and matches will queue up undelivered`);
  else if (!cron.validate(digest)) out.push(`delivery schedule "${digest}" is not a valid cron — NO digest will be sent and matches will queue up undelivered`);
  // A mode this code does not recognise is almost certainly a typo ("realtim", "manual"). Its effect
  // is to silently switch off the delivery the author was asking for, so name it separately: the
  // schedule may be perfectly valid and the client still not behave as intended.
  if (mode !== "scheduled") out.push(`delivery.mode "${mode}" is neither "realtime" nor "scheduled" — treating it as scheduled, which disables delivery on fetch`);
  return out;
}

export function buildFetchTimers(client: ClientConfig, onFire: () => void): Stoppable[] {
  const sched = client.schedule;
  const log = (desc: string) => console.log(`[scheduler] ${client.name} ${desc}`);

  if (!sched) { // legacy / unset → single cron (default hourly)
    // An UNSET cron means "use the default"; a cron that is set but does not parse means the user
    // asked for something specific and got it wrong, and those are not the same thing. This branch
    // used to collapse both onto the hourly default, so a typo silently scheduled a scrape every
    // hour — the loudest possible failure, arrived at silently. The schedule.mode === "cron" branch
    // below already fails closed on the same input; match it, and say why.
    const expr = client.refreshCron?.trim();
    if (expr && !cron.validate(expr)) {
      console.warn(`[scheduler] ${client.name} invalid refreshCron "${expr}" — skipped (fix it, or clear it to fall back to hourly)`);
      return [];
    }
    const use = expr || "0 * * * *";
    log(`refreshes "${use}"`);
    return [cron.schedule(use, onFire)];
  }

  if (sched.mode === "cron") {
    if (!cron.validate(sched.expr)) { console.warn(`[scheduler] ${client.name} invalid cron "${sched.expr}" — skipped`); return []; }
    log(`cron "${sched.expr}"`);
    return [cron.schedule(sched.expr, onFire)];
  }

  if (sched.mode === "interval") {
    const unitMs = sched.unit === "minute" ? 60_000 : sched.unit === "hour" ? 3_600_000 : 86_400_000;
    const ms = Math.max(MIN_INTERVAL_MS, Math.round(sched.every * unitMs));
    log(`every ${sched.every} ${sched.unit}(s)`);
    // setInterval's delay is a 32-bit signed int: anything past MAX_TIMEOUT (~24.8 days) overflows
    // and silently becomes a 1 ms timer that fires continuously. Both the schedule form and the
    // validator accept >= 25 days, so "every 30 days" used to hammer the engine forever. The `once`
    // branch below already chains across the same ceiling; this one now does too.
    let handle: ReturnType<typeof setTimeout>;
    const armEvery = (remaining: number) => {
      handle = setTimeout(() => {
        if (remaining > MAX_TIMEOUT) { armEvery(remaining - MAX_TIMEOUT); return; }  // still counting down
        armEvery(ms);   // re-arm BEFORE firing so the period doesn't drift by the handler's duration
        onFire();
      }, Math.min(remaining, MAX_TIMEOUT));
    };
    armEvery(ms);
    return [{ stop: () => clearTimeout(handle) }];
  }

  if (sched.mode === "once") {
    const at = new Date(sched.at).getTime();
    if (!isFinite(at)) { console.warn(`[scheduler] ${client.name} invalid one-off date "${sched.at}"`); return []; }
    const delay = at - Date.now();
    if (delay <= 0) { log(`one-off ${sched.at} already passed — skipped`); return []; } // never fire a stale one-off late
    let handle: ReturnType<typeof setTimeout>;
    const arm = (remaining: number) => { // chain across the setTimeout ceiling for far-future dates
      handle = setTimeout(() => { if (remaining > MAX_TIMEOUT) arm(remaining - MAX_TIMEOUT); else onFire(); }, Math.min(remaining, MAX_TIMEOUT));
    };
    arm(delay);
    log(`one-off at ${sched.at}`);
    return [{ stop: () => clearTimeout(handle) }];
  }

  // recurring: one cron per time-of-day; days is either a preset, specific weekdays, or days-of-month.
  const dowField = sched.daysOfWeek?.length ? sched.daysOfWeek.join(",")
    : sched.days === "weekdays" ? "1-5" : sched.days === "weekends" ? "0,6" : "*";
  const domField = sched.daysOfMonth?.length ? sched.daysOfMonth.join(",") : "*";
  const out: Stoppable[] = [];
  for (const time of sched.times) {
    const [h, m] = time.split(":").map(Number);
    // Say WHY a time was dropped. These two `continue`s were silent, so a single mistyped time
    // quietly reduced how often a client ran, and a config where EVERY time was bad left it with no
    // schedule at all — the same silent-disable this file already refuses to allow for refreshCron.
    if (!isFinite(h!) || !isFinite(m!) || h! > 23 || m! > 59) {
      console.warn(`[scheduler] ${client.name} ignoring invalid time "${time}" (expected HH:MM, 00:00-23:59)`);
      continue;
    }
    const expr = `${m} ${h} ${domField} * ${dowField}`;
    if (!cron.validate(expr)) {
      console.warn(`[scheduler] ${client.name} time "${time}" produced an invalid schedule "${expr}" — skipped`);
      continue;
    }
    out.push(cron.schedule(expr, onFire));
    log(`recurring "${expr}"`);
  }
  // Standard cron ORs day-of-month against day-of-week when BOTH are restricted, so setting specific
  // dates AND specific weekdays fires on either, not on their intersection. The config schema allows
  // both to be set, so say so rather than letting a client run far more often than intended.
  if (domField !== "*" && dowField !== "*") {
    console.warn(`[scheduler] ${client.name} has both days-of-month (${domField}) and days-of-week (${dowField}) set — cron treats these as OR, so it will run on EITHER, not only on days that satisfy both`);
  }
  return out;
}

/**
 * The whole daily housekeeping pass, in one exported function so what it does can be asserted.
 *
 * Everything here runs unattended at 3am and nothing surfaces in the UI, so an item silently dropped
 * from this list has no symptom at all — the growth or the staleness is just never cleaned. That is
 * how account_cache reached 103.7 MB of rows no reader could return. A test that only proved
 * dbPurgeAccountCache works would not have noticed if it were never called from here.
 *
 * Returns what it did rather than only logging it, so a caller — and the test — can see the counts.
 */
export function runDailyMaintenance(): { expired: number; stale: number; runs: number; cache: number; jobs: number } {
  const swept = dbSweepClosed();
  if (swept.expired || swept.stale) console.log(`[retention] closed ${swept.expired} expired + ${swept.stale} stale job(s)`);
  const runs = dbPurgeRuns(30); // fetch-run history: keep 30 days
  if (runs) console.log(`[retention] pruned ${runs} old fetch-run record(s)`);
  // account_cache is READ with a TTL but was never evicted, so it only grew — one row per company
  // checked, each holding that company's whole job list as JSON. On production all 5,282 rows
  // (103.7 MB, ~10% of the database file) were already past the TTL and unreadable by any code path.
  const cache = dbPurgeAccountCache(CACHE_TTL_HOURS);
  if (cache) console.log(`[retention] evicted ${cache} stale account-cache row(s)`);
  const s = dbGetSettings();
  let jobs = 0;
  if (s.retentionMode === "delete") {
    jobs = dbPurgeOldJobs(s.retentionDays);
    if (jobs) console.log(`[retention] purged ${jobs} job(s) older than ${s.retentionDays} days`);
  }
  return { expired: swept.expired, stale: swept.stale, runs, cache, jobs };
}

/** Daily 3am maintenance: close expired/disappeared jobs, evict stale caches, then (if enabled)
 *  hard-purge old ones. */
function startMaintenance(): void {
  tasks.push(cron.schedule("0 3 * * *", () => { runDailyMaintenance(); }));
}

/**
 * One cron per client (client.refreshCron, default hourly) that runs ALL of its
 * materialized sources. Scheduled-delivery clients also get a digest cron.
 */
/**
 * THE WARNINGS BELOW WERE ONLY EVER PRINTED TO A CONSOLE NOBODY OPENS.
 *
 * "This client is ACTIVE but will never fetch" and "matches will queue up undelivered forever" are
 * the two most consequential things this file can discover, and both went to console.warn and
 * nowhere else. This runs as a desktop app — the terminal is behind the window, on a scroll buffer
 * that a long boot has already pushed the line off. On screen the client reads ACTIVE and the
 * dashboard looks entirely healthy, which is the same silence the delivery-backlog card and the
 * unverified-stale counter were both added to break.
 *
 * So the warnings are RECORDED as well as printed, and ride along on /api/health, which the
 * dashboard already polls. Nothing here re-derives the decision: these are the exact strings the
 * scheduler produced from the timers it actually armed, captured at the moment it armed them. A
 * second implementation that predicted the same thing would be free to drift from the first.
 *
 * startSchedules re-runs on every config reload (engine.ts "restart-schedules"), and the list is
 * cleared at the top of it, so what the endpoint reports is always the live configuration.
 */
export interface ConfigWarning { client: string; kind: "schedule" | "delivery"; warning: string }
let configWarnings: ConfigWarning[] = [];
export function getConfigWarnings(): ConfigWarning[] { return configWarnings; }

export function startSchedules(clients: ClientConfig[]): number {
  let n = 0;
  configWarnings = [];
  startMaintenance(); // daily retention purge (no-op unless retentionMode = delete)
  for (const client of clients) {
    if (!client.active) continue;

    const fire = async () => {
      // Never let a failed scheduled fetch escape as an unhandled rejection — log and let the next
      // firing try again. (The manual route has its own .catch; this is the scheduled equivalent.)
      let skipped = false;
      try { skipped = !!(await runClientSources(client, clients, undefined, { scheduled: true }))?.skipped; }
      catch (e) { console.error(`[scheduler] ${client.name} fetch failed: ${(e as Error).message}`); }
      // Non-hiring signals (velocity, tech changes, …) for clients that enabled them: run the
      // producers over the client's domains, then deliver new signals through the same webhook.
      //
      // The overlap guard has to cover this too. runClientSources claims a key and returns
      // { skipped: true } when the previous firing is still going — but that result was discarded
      // and the signals scan ran anyway, with no lock of its own. On a schedule shorter than a scan
      // (a 50-domain watchlist can take minutes) two scans ran concurrently over the same domains,
      // both diffing against the same baseline and racing to advance it.
      if (skipped) { console.log(`[scheduler] ${client.name} still running — skipping this firing`); return; }
      if (client.signals?.length) {
        try {
          const fresh = await runClientSignals(client);
          if (fresh && isRealtime(client)) await deliverSignals(client);
        } catch (e) { console.error(`[scheduler] ${client.name} signals failed: ${(e as Error).message}`); }
      }
      // Auto-find websites for companies missing one (Settings toggle; bounded batch, self-throttled).
      if (dbGetSettings().autoResolveDomains) void autoResolveAfterFetch();
    };

    const timers = buildFetchTimers(client, () => { void fire(); });
    tasks.push(...timers);
    n += timers.length;
    // An ACTIVE client with no timers will never fetch again, and until now nothing said so in one
    // place. buildFetchTimers returns [] from four different branches — an invalid refreshCron, an
    // invalid cron expression, a one-off date already in the past, and a recurring schedule whose
    // times were all unusable — each logging its own line, which is easy to miss in a boot that
    // prints a line per client anyway. This is the single statement of the consequence.
    if (!timers.length) {
      // Written to stand on its own, because it is now read in two places: after the client's name in
      // the boot log, and under the client's name on the System card. "is ACTIVE but has no working
      // schedule" reads as a sentence fragment once the name is a heading above it rather than the
      // words before it.
      const w = "This client is switched on but has no working schedule, so it will never fetch by itself. Fix its schedule, or press Fetch to run it by hand.";
      console.warn(`[scheduler] ${client.name}: ${w}`);
      configWarnings.push({ client: client.name, kind: "schedule", warning: w });
    }

    for (const w of deliveryWarnings(client)) {
      console.warn(`[scheduler] ${client.name}: ${w}`);
      configWarnings.push({ client: client.name, kind: "delivery", warning: w });
    }
    const digest = client.delivery?.schedule?.trim();
    if (!isRealtime(client) && digest && cron.validate(digest)) {
      tasks.push(cron.schedule(digest, async () => {
        try {
          const sent = await deliver(client);
          const sentSig = client.signals?.length ? await deliverSignals(client) : 0;
          if (sent || sentSig) console.log(`[deliver] ${client.name}: ${sent} matches + ${sentSig} signals (scheduled digest)`);
        } catch (e) { console.error(`[deliver] ${client.name} digest failed: ${(e as Error).message}`); }
      }));
      n++;
      console.log(`[scheduler] delivery digest @${client.name} on "${digest}"`);
    }
  }
  return n;
}

export function stopSchedules(): void {
  for (const t of tasks) { t.stop(); t.destroy?.(); }   // destroy() is what actually frees a cron task
  tasks = [];
}
