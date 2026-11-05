# Credits

Based on [HyperSignal-Hiring](https://github.com/athm793/HyperSignal-Hiring) by athm793 (Apache License 2.0, see `LICENSE`); this copy builds on upstream commit `eeee8f6`.

## Added in this fork

- `scripts/run-signals-once.mts`: one-shot signal-scan runner for cron use, with GDELT slow-queue draining and `SIGNAL_SCAN_DOMAINS` to scope a catch-up pass
- Browser launch and per-producer timeouts: every Playwright launch, context and CDP round-trip (including `ctx.close()`) is timeout-guarded, and each signal producer has its own time limit
- Watchlist seed refresh fix: `seedFromYaml` now refreshes a watchlist that was already seeded instead of leaving it frozen
- Stall watchdog in `runClientSources`, so a hang is cut off after minutes instead of hours
- Wired into signal-driven-outbound (https://github.com/rachel-pinpointe/signal-driven-outbound), which syncs the watchlist from Fibery and runs Apollo enrollment downstream.
- `run-cron.sh`: daily launchd driver with time-boxing, a lock file, Slack alerts and a `SKIP_RESEARCH` catch-up mode
- ATS board discovery fixes: exact-match floor in `verifyBoard`, no more source-order starvation, hiring.cafe backfill, and hiring.cafe is skipped for domains with a confirmed ATS board
- Phase 21 board quarantine: stricter `verifyBoard`, a quarantine table plus a manual allow-list (`scripts/phase21-quarantine.mts`, `scripts/phase21-quarantine-seed.json`, `src/dbQuarantine.test.ts`)
- libuv threadpool fix (`UV_THREADPOOL_SIZE`) for the signal-scan stall

## Upstream files modified

- `.gitignore`
- `scripts/test.mjs`
- `src/config.ts`
- `src/config.test.ts`
- `src/db.ts`
- `src/ingest.ts`
- `src/safeFetch.ts`
- `src/signals/edgar.ts`
- `src/signals/index.ts`
- `src/signals/subdomains.ts`
- `src/signals/warn.ts`
- `src/sources/ats.ts`
- `src/sources/ats.test.ts`
- `src/sources/browser.ts`
- `src/sources/browser.test.ts`
