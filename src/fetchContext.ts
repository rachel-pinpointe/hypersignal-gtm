// WHICH configured source is fetching right now.
//
// The job-close sweep needs to distinguish "we looked and the posting is gone" from "we never
// looked", and it cannot do that from last_seen_at alone. To ask the first question you need two
// things: a record of which source last saw each job, and a record of when each source last fetched
// successfully. This module supplies the first half — every job stamped with the source that saw it.
//
// AsyncLocalStorage for the same reason src/sources/degraded.ts uses it: FETCH_SOURCE_CONCURRENCY
// defaults to 8, so eight sources are in flight at once and a module-level variable would stamp jobs
// with whichever source happened to start last. Each runSource opens its own store; upsertJob reads
// it however deep in the call stack it happens to be.
//
// A write with no fetch in progress — a repair script, a test, a manual import — leaves origin_key
// untouched rather than guessing, which is the conservative side: a job with no recorded source is
// never closed, because nothing can prove we looked for it.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

/** The key of the source currently fetching, or null outside a fetch. */
export function currentSourceKey(): string | null {
  return store.getStore() ?? null;
}

/** Run `fn` with every job it stores attributed to `key`. */
export function withSourceKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return store.run(key, fn);
}
