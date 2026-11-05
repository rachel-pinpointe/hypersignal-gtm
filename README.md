# HyperSignal GTM

A production-hardened version of [HyperSignal-Hiring](https://github.com/athm793/HyperSignal-Hiring), the open-source hiring-signal radar by athm793. I took it from a local dashboard tool to an unattended daily job feeding my outbound system, [signal-driven-outbound](https://github.com/rachel-pinpointe/signal-driven-outbound), across ~1,500 companies.

## What I added

**Headless daily runs.** Upstream only ran signal scans from a long-running server. I wrote `scripts/run-signals-once.mts` so a scheduled one-shot process can run every signal producer and drain the rate-limited news queue before it exits.

**A stall watchdog.** Two daily runs froze, one silently for 19 hours. Instead of guessing which call hung, the fetch now watches for the symptom: if nothing completes for 30 minutes, it stops cleanly and keeps everything already saved.

**The watchlist bug.** I found the scanner had been stuck on 20 stale companies while my target list grew to 1,445. Fixed, tested, and confirmed live.

**Skip the slow source when there's a better one.** Companies with a confirmed job board skip the rate-limited source entirely, freeing it for companies that need it.

**Timeouts everywhere.** Browser launches and every signal producer have hard limits, so one bad request can't take down a run.

Full list and every modified upstream file: [CREDITS.md](CREDITS.md)

## Known issues

- On Nov 2 the watchdog fired at 61 minutes instead of 30. Cause not yet confirmed.
- A run stopped by the watchdog reports 0 jobs in its summary even when jobs were saved.

## Running it

Same as upstream: Node 22.5+, `npm install`, `npm start`. Set `CONTACT_EMAIL` in `.env` to enable SEC lookups. Upstream's original README is in [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md).

For the daily headless job:

- **Signal scan only:** `npx tsx scripts/run-signals-once.mts`. It scans every active `kind: watchlist` client in `clients/*.yaml`. No env vars are required. Optional: `CONTACT_EMAIL` (SEC lookups), `SIGNAL_SCAN_DOMAINS` (comma-separated domains to scope a catch-up pass), `DRAIN_BUDGET_MS` (news-queue drain budget, default 8 min).
- **Full daily pipeline:** `./run-cron.sh`, scheduled with launchd. It expects this repo to sit inside a [signal-driven-outbound](https://github.com/rachel-pinpointe/signal-driven-outbound) checkout (override with `REPO_ROOT`), with that checkout's `.env` and `.venv`. Optional: `SLACK_WEBHOOK_URL` (alerts), `SKIP_SYNC`, `SKIP_RESEARCH`, `STALL_TIMEOUT_MS` (fetch stall watchdog, default 30 min), and per-step budgets `JOB_FETCH_BUDGET_SECONDS`, `SIGNAL_SCAN_BUDGET_SECONDS`, `MAIN_BUDGET_SECONDS`, `APOLLO_BUDGET_SECONDS`, `WATCHDOG_TIMEOUT_HOURS` (default 24).

## License

Apache 2.0, same as upstream. See [LICENSE](LICENSE).
