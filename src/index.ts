// Boot order is deliberate: the HTTP server starts listening FIRST so the dashboard (and its startup
// loading screen) are reachable instantly, THEN the heavy init (load config, schedule, backfill,
// resume paused tasks) runs in the background and flips the "ready" flag when done. Fetching happens
// on the per-client schedules + the manual button — never synchronously on boot — so a scraper error
// can't take down the dashboard.
import "./env.ts";   // MUST be first: populates process.env from .env before any module reads it
import { init, getClients } from "./engine.ts";
import { runAllOnce } from "./ingest.ts";
import { startServer, markReady, resumeAccountChecks, gracefulShutdown } from "./server.ts";
import { startSlowQueue, setSlowQueueDelivery } from "./signals/slowQueue.ts";
import { flushPendingDeliveries, deliverSignals, isRealtime } from "./delivery.ts";
import { registerTechTagger, dbMigrate } from "./db.ts";
import { seedTechnologiesIfEmpty } from "./techSeed.ts";
import { tagJobTech, backfillTech, techReady, techTagsStale } from "./techDetect.ts";
import { db as _db } from "./db.ts";
const dbJobTechCount = () => (_db.prepare("SELECT COUNT(*) c FROM job_technologies").get() as { c: number }).c;

// A stray scraper/browser error must never crash the server.
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
// Ctrl+C / kill → graceful shutdown (pause tasks, close browsers + schedules, save state, exit).
let signalled = false;
const onSignal = (sig: string) => { if (signalled) { process.exit(1); } signalled = true; void gracefulShutdown(sig); };
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

const port = Number(process.env.PORT ?? 4000);
startServer(port); // listens immediately; the dashboard shows a loading screen until /api/ready is ready

// Heavy init runs after the server is listening. Deferred a tick so the first page load + readiness
// poll are served before the synchronous backfill briefly blocks the event loop.
setTimeout(async () => {
  try {
    // Schema migrations that MOVE DATA (description/country backfills, the FTS index, the taxonomy
    // reconcile). These used to run at db.ts import time — i.e. before listen() — which is what made
    // the dashboard connection-refused rather than "loading" for the first 1-13 seconds. Each step is
    // gated and yields between chunks, so a steady-state boot does nothing and the loading screen
    // keeps painting while a first-time backfill runs.
    // The migration is one-time housekeeping (backfills, index stats). Everything after it — the
    // scheduler, the tech tagger, resuming paused checks — is what the app IS, and none of it
    // depends on the migration having finished. Sharing one try/catch meant a single failed
    // backfill silently skipped all of it and then called markReady(), so the dashboard opened
    // looking healthy with no schedules running and no way to tell. Isolate it: log loudly,
    // degrade to "search may be incomplete", and still bring the app up.
    try {
      await dbMigrate();
    } catch (e) {
      console.error("[boot] one-time database migration FAILED — the app is starting anyway, but"
        + " fuzzy search and some backfilled fields may be incomplete until it succeeds on a"
        + " later boot:", (e as Error).message);
    }
    // Technology dictionary: seed from the local CSV on first boot, register the ingest-time tagger,
    // and backfill detections over existing jobs if none are recorded yet.
    seedTechnologiesIfEmpty();
    registerTechTagger(tagJobTech);
    // Re-detect when there are no tags OR when the matching rules changed since they were written —
    // stored tags are a cache of those rules, and without the second test a rules fix never reaches
    // the 24k jobs already tagged.
    // Awaited, but it yields between batches now, so the loading screen keeps painting through it.
    if (techReady() && (dbJobTechCount() === 0 || techTagsStale())) await backfillTech();

    const clients = init(); // seed YAML → DB, load, schedule, backfill
    if (!clients.length) console.error("No client configs found. Add one via the dashboard or in clients/*.yaml.");
    console.log(`Loaded ${clients.length} client(s): ${clients.map((c) => c.name).join(", ") || "(none)"}`);
    resumeAccountChecks();   // re-launch any account check paused by a prior graceful shutdown
    // The paced worker inserts signals but has no way to deliver them — wire that up before starting
    // it, or everything it finds between scans waits for the next boot. Realtime clients only, the
    // same rule flushPendingDeliveries follows: a scheduled client's contract is "at the digest time",
    // and delivering early would break that promise rather than keep it.
    setSlowQueueDelivery(async (names) => {
      for (const name of names) {
        const client = getClients().find((c) => c.name === name);
        if (!client || client.active === false || !isRealtime(client)) continue;
        const n = await deliverSignals(client);
        if (n) console.log(`[deliver-signals:${name}] sent ${n} from the paced queue`);
      }
    });
    startSlowQueue();        // drip through work owed to rate-limited producers, left over from any prior run
    // Matches/signals a previous run persisted but never got to deliver. Not awaited: a slow or dead
    // webhook must not hold the dashboard on its loading screen, and the backlog stays queued either
    // way. See flushPendingDeliveries for why this is needed at all.
    void flushPendingDeliveries(clients).catch((e) => console.error("[deliver] boot flush failed:", (e as Error).message));
    markReady();             // dashboard reveals
    console.log(`Scheduler live. Dashboard: http://localhost:${port}`);
    if (process.env.INITIAL_FETCH === "1") {
      console.log("Running initial ingest cycle in background…");
      runAllOnce(getClients())
        .then(() => console.log("Initial ingest done."))
        .catch((e) => console.error("Initial ingest failed:", (e as Error).message));
    }
  } catch (e) {
    console.error("[boot] init failed:", (e as Error).message);
    markReady(); // reveal the dashboard anyway so the user isn't stuck on the loading screen
  }
}, 80);
