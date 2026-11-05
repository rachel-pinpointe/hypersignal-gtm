// One-shot company-signal scan for our cron-driven daily run.
//
// `npm run cycle` only fetches JOBS (src/ingest.ts runAllOnce) — it never calls runClientSignals,
// which is normally only reached from HyperSignal's own internal always-on scheduler (src/scheduler.ts)
// or its dashboard/API ("check signals now"). We don't run a persistent server (each cron firing is a
// fresh process), so this script calls runClientSignals directly for every active watchlist client.
//
// GDELT is rate-limited (~1 lookup/5.2s) and therefore doesn't run inline — runClientSignals queues it
// into the `slow_queue` table and returns immediately, expecting a long-running server's background
// timer (startSlowQueue) to drip through it over time. We have no long-running process, so after the
// scan we drain that queue ourselves, synchronously, until it's empty or a time budget runs out —
// otherwise GDELT coverage would never advance (queued items just pile up, unprocessed, forever).
//
// Usage: npx tsx scripts/run-signals-once.mts
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import { seedFromYaml, loadClients } from "../src/config.ts";
import { normalizeOrgDomain } from "../src/normalize.ts";
import { runClientSignals } from "../src/signals/index.ts";
import { drainOne, pacedProducers } from "../src/signals/slowQueue.ts";

const DRAIN_BUDGET_MS = Number(process.env.DRAIN_BUDGET_MS ?? 8 * 60 * 1000);

// Diagnostic block, not a gate -- never blocks the real scan, only logs. Added/expanded 2026-09-18
// chasing a scheduled-cron stall (nearly every producer for nearly every domain timing out at 45s,
// starting from the very first domain, across a ~1,445-domain watchlist) that has never reproduced
// outside that one scheduled-session environment: curl succeeds from the SAME failing session, and
// none of it reproduces in direct interactive testing against the same hosts.
//
// The first fix attempt (dns.resolve4/6 in safeFetch.ts instead of dns.lookup, plus a
// UV_THREADPOOL_SIZE bump) did NOT resolve it -- re-fired same day, identical stall. That is now
// significant evidence against the libuv-threadpool theory, not just an inconclusive retry: the
// "dns" producer (src/signals/dns.ts) timed out too, and it calls dns.resolveMx/resolveTxt directly
// -- c-ares-based, same as resolve4/6, NEVER touching the threadpool -- so a threadpool bottleneck
// cannot explain that producer hanging. Something more fundamental is blocking Node's own outbound
// DNS/network calls specifically in that environment, not a Node-side concurrency limit.
// This block isolates which layer: raw DNS protocol reachability, c-ares resolution, and a plain
// fetch(), each independently timed and reported, so the NEXT live run's Slack summary carries the
// actual answer instead of another guess needing a further round-trip to test.
async function withDeadline<T>(label: string, ms: number, fn: () => Promise<T>): Promise<void> {
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      fn().then((v) => ({ ok: true as const, v })),
      new Promise<{ ok: false; v: null }>((r) => setTimeout(() => r({ ok: false, v: null }), ms)),
    ]);
    const elapsed = Date.now() - t0;
    console.log(`[diag] ${label}: ${result.ok ? "OK" : "TIMED OUT"} after ${elapsed}ms${result.ok ? ` -> ${JSON.stringify(result.v).slice(0, 200)}` : ""}`);
  } catch (e) {
    console.log(`[diag] ${label}: ERROR after ${Date.now() - t0}ms -> ${(e as Error).message}`);
  }
}

console.log(`[diag] node=${process.version} platform=${process.platform} UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? "(unset, default 4)"}`);
try {
  console.log(`[diag] /etc/resolv.conf:\n${fs.readFileSync("/etc/resolv.conf", "utf8").trim().split("\n").map((l) => "  " + l).join("\n")}`);
} catch (e) {
  console.log(`[diag] could not read /etc/resolv.conf: ${(e as Error).message}`);
}
// Layer 1: raw TCP reachability to a well-known DNS server on port 53 -- is outbound DNS-port
// traffic possible AT ALL, independent of c-ares's own query logic?
await withDeadline("raw TCP connect to 8.8.8.8:53", 6000, () => new Promise((resolve, reject) => {
  const sock = net.createConnection({ host: "8.8.8.8", port: 53, timeout: 5500 });
  sock.on("connect", () => { sock.destroy(); resolve("connected"); });
  sock.on("error", (e) => reject(e));
  sock.on("timeout", () => { sock.destroy(); reject(new Error("socket timeout")); });
}));
// Layer 2: raw TCP reachability to a well-known HTTPS port -- isolates "any outbound TCP" from
// "DNS-port TCP specifically."
await withDeadline("raw TCP connect to 1.1.1.1:443", 6000, () => new Promise((resolve, reject) => {
  const sock = net.createConnection({ host: "1.1.1.1", port: 443, timeout: 5500 });
  sock.on("connect", () => { sock.destroy(); resolve("connected"); });
  sock.on("error", (e) => reject(e));
  sock.on("timeout", () => { sock.destroy(); reject(new Error("socket timeout")); });
}));
// Layer 3: c-ares resolution (what dns.ts's resolveMx/resolveTxt use) against a domain that is
// certain to have both.
await withDeadline("dns.resolve4('google.com') [c-ares]", 6000, () => dns.resolve4("google.com"));
await withDeadline("dns.resolveMx('google.com') [c-ares]", 6000, () => dns.resolveMx("google.com"));
// Layer 4: libuv-threadpool-based lookup, for comparison against Layer 3.
await withDeadline("dns.lookup('google.com', {all:true}) [threadpool]", 6000, () => dns.lookup("google.com", { all: true }));
// Layer 5: fetch() by hostname (needs its own DNS resolution internally, whatever undici uses).
await withDeadline("fetch('https://google.com') [by hostname]", 6000, () => fetch("https://google.com", { method: "HEAD" }).then((r) => `status ${r.status}`));
// Layer 6: fetch() straight to an IP literal with a Host header -- skips DNS resolution entirely, so
// this isolates "is fetch()'s TLS/socket layer itself the problem" from "is DNS resolution the
// problem." A pass here while Layer 5 fails would point squarely at DNS; a fail here too would mean
// it's not DNS-specific at all.
await withDeadline("fetch('https://142.250.80.46') [by IP, Host header, skips DNS]", 6000, () =>
  fetch("https://142.250.80.46", { method: "HEAD", headers: { Host: "google.com" } }).then((r) => `status ${r.status}`));
console.log("[diag] --- end diagnostic block ---");

seedFromYaml();
let clients = loadClients().filter((c) => c.active !== false && c.kind === "watchlist");

// Opt-in scoping for a catch-up pass against a specific subset of an existing watchlist -- e.g. the
// companies a hung/killed job-fetch run already covered, so the OTHER signal producers (funding,
// layoffs, tooling, growth, marketing, news -- everything runClientSignals does, none of it touches
// hiring.cafe) can still run for them without re-attempting the full, currently-unreliable watchlist.
// Same idiom as this repo's other opt-in env knobs (SKIP_SYNC, SKIP_RESEARCH, HCORG_CHUNK): unset
// changes nothing, so ordinary scheduled runs are unaffected.
const scanDomains = process.env.SIGNAL_SCAN_DOMAINS;
if (scanDomains) {
  const wanted = new Set(scanDomains.split(",").map((d) => normalizeOrgDomain(d)).filter(Boolean));
  clients = clients
    .map((c) => ({ ...c, search: { ...c.search, orgDomains: (c.search?.orgDomains ?? []).filter((d) => wanted.has(normalizeOrgDomain(String(d)))) } }))
    .filter((c) => (c.search?.orgDomains?.length ?? 0) > 0);
  console.log(`[signals] SIGNAL_SCAN_DOMAINS set: scoped to ${wanted.size} domain(s) across ${clients.length} client(s)`);
}

if (!clients.length) {
  console.error(scanDomains
    ? "No active watchlist client has any domain matching SIGNAL_SCAN_DOMAINS"
    : "No active watchlist clients found in clients/*.yaml");
  process.exit(1);
}

let total = 0;
for (const client of clients) {
  const fresh = await runClientSignals(client);
  console.log(`[signals] ${client.name}: ${fresh} new signal(s)`);
  total += fresh;
}

const paced = pacedProducers();
if (paced.length) {
  console.log(`\n[slowqueue] draining paced producers (${paced.join(", ")}), budget ${DRAIN_BUDGET_MS / 1000}s...`);
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  let drained = 0;
  outer: while (Date.now() < deadline) {
    let any = false;
    for (const key of paced) {
      if (Date.now() >= deadline) break outer;
      const did = await drainOne(key);
      if (did) { any = true; drained++; }
    }
    if (!any) break; // every paced queue is empty
  }
  console.log(`[slowqueue] drained ${drained} item(s)${Date.now() >= deadline ? " (hit time budget, rest carries to next run)" : " (queue empty)"}`);
}

console.log(`\n=== SIGNAL SCAN DONE === new=${total}`);
process.exit(0);
