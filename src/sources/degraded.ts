// A channel for "this fetch worked, but not completely".
//
// THE PROBLEM. Every adapter catches its own failures and returns an empty (or partial) array:
//   ats.ts          catch (e) { console.warn(...); return []; }
//   craigslist.ts   catch (e) { console.warn(...); break; }   and a non-200 search returns []
//   remoteBoards.ts .catch((e) => { console.warn(...); return []; })  per board
//   simplyhired.ts  looksBlocked -> break, returning what it has so far
//
// That is deliberate — one dead board must not take down a whole run — but it makes SourceStats.error
// structurally unreachable, because ingest.ts only fills that field from an exception that ESCAPES
// the adapter. So a broken scraper is recorded and displayed as a successful run that found zero
// jobs, and console.warn is the only trace. On a desktop app with a dashboard, the console has no
// reader.
//
// The consequence is worse than a blank screen. dbSweepClosed(14) closes any posting not re-seen for
// 14 days, and it runs every reconcile. Two weeks of a silently-broken adapter therefore auto-closes
// that source's entire open inventory, and the dashboard attributes the collapse to the market
// rather than to the scraper.
//
// This is the same standard src/uiHonesty.test.ts already enforces on the client — "a failed request
// must never be rendered as a fact about the data" — applied to the half of the app that guard
// cannot see, because it only reads web/app.js.
//
// THE MECHANISM. AsyncLocalStorage, not a module-level array: sources run up to
// FETCH_SOURCE_CONCURRENCY (8) at a time, and a shared bucket would attribute one source's failures
// to another. Each runSource call opens its own store; anything reported inside that async context —
// however deep, across any number of awaits — lands in the right one. A report made outside a run
// (a one-off script, a test) is simply dropped rather than throwing.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string[]>();

/** Record that this fetch is incomplete, and why. Safe to call from anywhere, at any depth. */
export function reportDegraded(message: string): void {
  const bucket = store.getStore();
  if (bucket && bucket.length < 20) bucket.push(message.slice(0, 200));
}

/** Run `fn` with a fresh collector; returns its result alongside whatever was reported inside it. */
export async function collectDegraded<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const bucket: string[] = [];
  const result = await store.run(bucket, fn);
  return { result, warnings: bucket };
}
