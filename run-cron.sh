#!/bin/bash
# Daily driver for the NYCbound signal watcher. Weekdays, 1pm ET.
#
# Moved off the Cowork remote-device bridge onto launchd, running directly and natively on this
# Mac, 2026-09-18 (Phase 13 scope doc has the full record). The bridge capped every command at
# ~180 seconds and ran inside an isolated Linux VM, not this Mac -- neither fits a run against the
# full ~1,445-company watchlist. Absolute paths below exist because launchd does not source
# .zshrc/.bash_profile the way an interactive Terminal does, so PATH-based resolution of
# node/npm/python cannot be relied on.
#
# Idempotent and safe to re-run: each step only acts on what's new.
set -e
cd "$(dirname "$0")"

# Parent checkout that holds the Python pipeline and .env. Defaults to the directory above this one
# (the script cd's to its own directory first); override with REPO_ROOT=... if laid out differently.
REPO_ROOT="${REPO_ROOT:-$(cd .. && pwd)}"
PYTHON_BIN="$REPO_ROOT/.venv/bin/python3"
LOG_DIR="data"
LOCK_FILE="$LOG_DIR/.cron-lock"
RUN_LOG="$LOG_DIR/.cron-run-$(date +%s).log"

# launchd's default PATH doesn't include Homebrew's /usr/local/bin, which is where node/npm/npx
# live on this Mac -- set explicitly rather than relying on inherited PATH.
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"

# Everything from here down is both printed and appended to today's run log, so a Slack failure
# alert can quote the tail of it.
exec > >(tee -a "$RUN_LOG") 2>&1

# Drop run logs older than 30 days so this doesn't grow forever on a permanent daily schedule.
find "$LOG_DIR" -maxdepth 1 -name '.cron-run-*.log' -mtime +30 -delete 2>/dev/null || true

# Pull in SLACK_WEBHOOK_URL. The python steps below load their own secrets independently via
# python-dotenv from $REPO_ROOT/.env -- this is only so this shell script can post to Slack itself,
# since nothing is watching this run anymore to narrate it the way a Claude session used to.
set -a
source "$REPO_ROOT/.env"
set +a

slack_notify() {
  local text="$1"
  [ -z "$SLACK_WEBHOOK_URL" ] && return 0
  local payload
  payload=$("$PYTHON_BIN" -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$text" 2>/dev/null) || return 0
  # Retry a few times -- added 2026-09-22. The exact network blip that crashed the 2026-09-21 run
  # (a transient DNS resolution failure) also silently ate the FAILURE ALERT meant to report it --
  # curl's failure was swallowed by `|| true` with no retry, so the run died with zero notification.
  # These blips are usually gone within seconds, so a short retry loop is enough to not lose the
  # alert to the same kind of hiccup that caused it.
  local attempt
  for attempt in 1 2 3; do
    curl -s -X POST -H 'Content-type: application/json' --data "$payload" "$SLACK_WEBHOOK_URL" > /dev/null && return 0
    sleep 5
  done
  echo "slack_notify: failed to reach Slack webhook after 3 attempts" >&2
}

# run_timeboxed <budget_seconds> <description> -- <command...>
#
# Phase 14 (2026-09-22): runs <command...> under a wall-clock budget instead of letting a slow or
# stalled step (hiring.cafe/GDELT throttling, a wedged network call, whatever caused the 9/21
# 6537-domain stall) run for hours and eat the whole day's window. If the command finishes on its
# own, its real exit status is returned. If it's still alive after <budget_seconds>, the WHOLE
# process group is sent SIGTERM (then SIGKILL if that doesn't land within 5s) and 124 is returned,
# matching GNU coreutils' `timeout` -- deliberately hand-rolled rather than depending on `timeout`/
# `gtimeout`, since neither is confirmed reliably present on this Mac (only checked from the Linux
# VM the Cowork bridge runs in, a different machine from where this script actually executes).
#
# `set -m` (job control) is what makes the backgrounded command its own process group, so
# `kill -TERM "-$pid"` (leading dash = process GROUP, not just the one pid) reaches an entire
# `npm run cycle` -> tsx -> node child chain together instead of orphaning grandchildren that keep
# running after the top-level command is gone. Known limitation: a child that calls setsid/setpgid
# itself would escape this and keep running -- none of the commands this wraps are known to do
# that, but it's a real edge this doesn't cover.
run_timeboxed() {
  local budget="$1"; shift
  local desc="$1"; shift
  [ "${1:-}" = "--" ] && shift

  set -m
  ( "$@" ) &
  local pid=$!
  set +m

  local waited=0
  local interval=5
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$budget" ]; then
      echo "=== $(date) : $desc exceeded ${budget}s budget -- sending SIGTERM to process group $pid ==="
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 5
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
  wait "$pid"
  return $?
}

# Refuse to start on top of a still-running (or crashed-and-never-cleaned-up) previous run, rather
# than risk two instances writing to signals.db or enrolling contacts at the same time.
if [ -f "$LOCK_FILE" ]; then
  echo "Lock file present ($LOCK_FILE) -- a previous run appears to still be in progress. Skipping."
  slack_notify ":warning: HyperSignal cron: previous run still in progress, today's run skipped. Check $LOCK_FILE if this keeps happening -- it may mean a run crashed without cleaning up."
  exit 0
fi
echo $$ > "$LOCK_FILE"

# Keep the Mac awake for exactly as long as this run takes -- added 2026-09-19 after a real run got
# suspended (not killed) when Rachel manually stopped a separate caffeinate she'd started for an
# unrelated reason, letting the Mac sleep mid-run. The process didn't crash or exit -- it just froze,
# confirmed still alive (0% CPU, no progress) the next morning, with no Slack alert ever firing because
# nothing had actually errored. Tied to this script's own PID via -w so it starts and stops with the
# run automatically; no human needs to remember to manage it.
caffeinate -i -w $$ &
CAFFEINATE_PID=$!

# Coarse safety net, added 2026-09-19 after Friday's run went silently wedged for hours with no
# alert -- if this run is somehow still going after WATCHDOG_TIMEOUT_HOURS (default 24, generous
# headroom over the time-boxed budgets below), force-kill it and post to Slack, instead of it
# hanging forever unnoticed again. This does NOT fire under normal operation, even now that the
# individual steps below are time-boxed -- it's a last-resort catch for a NEW, not-yet-understood
# way this could wedge (e.g. inside a step's own cleanup/wait logic), the same way Friday's cause
# was new and not-yet-understood at the time.
# $$ inside a backgrounded subshell still refers to THIS script's PID, not the subshell's own.
WATCHDOG_TIMEOUT_HOURS=${WATCHDOG_TIMEOUT_HOURS:-24}
(
  sleep $((WATCHDOG_TIMEOUT_HOURS * 3600))
  if kill -0 $$ 2>/dev/null; then
    echo "=== $(date) : WATCHDOG -- run exceeded ${WATCHDOG_TIMEOUT_HOURS}h, force-killing (PID $$) ===" >> "$RUN_LOG"
    slack_notify ":rotating_light: HyperSignal cron: still running after ${WATCHDOG_TIMEOUT_HOURS}h, force-killed by the watchdog (was likely wedged, not just slow). Log: $RUN_LOG"
    kill -9 $$ 2>/dev/null || true
    kill "$CAFFEINATE_PID" 2>/dev/null || true
    rm -f "$LOCK_FILE"
  fi
) &
WATCHDOG_PID=$!

STEP="startup"
on_error() {
  local exit_code="${1:-$?}"
  slack_notify ":x: HyperSignal cron FAILED at step: *$STEP* (exit $exit_code).
\`\`\`
$(tail -n 30 "$RUN_LOG" 2>/dev/null)
\`\`\`"
}
trap 'on_error "$?"' ERR
trap 'rm -f "$LOCK_FILE"; kill "$CAFFEINATE_PID" 2>/dev/null || true; kill "$WATCHDOG_PID" 2>/dev/null || true' EXIT

# Node's async fs/dns/crypto/zlib calls all share ONE process-wide thread pool, sized 4 by default.
# Found live 2026-09-18 chasing a stall where nearly every producer for nearly every domain timed out
# after the first couple, during a real run against the ~1,445-domain watchlist -- a 4-thread pool is
# plausibly too small for that much concurrent DNS-bound work (measured ~50x queueing vs the
# threadpool-free dns.resolve4/6 path -- see src/safeFetch.ts). Kept as real headroom even though the
# actual stall that day turned out to have a different cause (see the tracker, Section 0).
export UV_THREADPOOL_SIZE=128

# Real macOS Chromium/ffmpeg builds, installed 2026-09-18 directly on this Mac (not through Cowork,
# which only ever had Linux builds available -- see the Phase 13 scope doc). Set explicitly rather
# than relying on Playwright's own $HOME-based default, since launchd's environment for a
# LaunchAgent isn't guaranteed to match an interactive Terminal's.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"

STEP="sync watchlist from Fibery"
if [ -n "$SKIP_SYNC" ]; then
  echo "=== $(date) : $STEP -- SKIPPED (SKIP_SYNC set) ==="
else
  echo "=== $(date) : $STEP ==="
  "$PYTHON_BIN" ../src/sync_watchlist.py
fi

# Phase 14 (2026-09-22): job fetch, the company signal scan, main.py's research pass, and Apollo
# enrollment are each wrapped in run_timeboxed below so one slow/stalled step gets cut off and the
# pipeline moves on, rather than the whole run taking 15+ hours the way 9/21's did. Budgets are a
# deliberately conservative starting point (20/20/30/15 min) -- see
# claude/nycbound-gtm-phase14-tiered-chunking-scope.md (Sales & Marketing claude.ai Project) for the
# reasoning -- and are env-overridable without a code change if real runs show room to raise them.
# A timeout (rc 124) is expected/non-fatal and just logged; any OTHER nonzero exit is treated
# exactly as it always was (Slack failure alert, hard stop) so a genuine crash still surfaces loudly.

STEP="job fetch (npm run cycle)"
echo ""
echo "=== $(date) : $STEP ==="
JOB_FETCH_BUDGET_SECONDS=${JOB_FETCH_BUDGET_SECONDS:-1200}
rc=0
run_timeboxed "$JOB_FETCH_BUDGET_SECONDS" "$STEP" -- npm run cycle || rc=$?
if [ "$rc" -eq 124 ]; then
  echo "=== $(date) : $STEP timed out after ${JOB_FETCH_BUDGET_SECONDS}s -- moving on. Chunks already completed before the cutoff are still saved (materialize.ts persists each hcorg chunk incrementally as it finishes), so this is a partial pass, not a lost one. ==="
elif [ "$rc" -ne 0 ]; then
  on_error "$rc"
  exit "$rc"
fi

STEP="commit today's rotation batch (sync_watchlist.py --commit-rotation)"
echo ""
echo "=== $(date) : $STEP ==="
# Runs whether job fetch finished cleanly or hit its time budget above (both are "we tried", not a
# crash) -- only a genuine job-fetch failure (handled by the exit above) skips this. No-ops safely
# if there's no pending batch (e.g. SKIP_SYNC was set this run).
"$PYTHON_BIN" ../src/sync_watchlist.py --commit-rotation

STEP="company signal scan"
echo ""
echo "=== $(date) : $STEP ==="
SIGNAL_SCAN_DOMAINS_FILE="data/today-signal-scan-domains.txt"
if [ -s "$SIGNAL_SCAN_DOMAINS_FILE" ]; then
  # today-signal-scan-domains.txt (written by sync_watchlist.py) is newline-separated; the script's
  # own SIGNAL_SCAN_DOMAINS env knob expects comma-separated.
  SIGNAL_SCAN_DOMAINS="$(paste -sd, "$SIGNAL_SCAN_DOMAINS_FILE")"
  export SIGNAL_SCAN_DOMAINS
  echo "SIGNAL_SCAN_DOMAINS scoped to $(wc -l < "$SIGNAL_SCAN_DOMAINS_FILE" | tr -d ' ') domain(s) (today's job-fetch batch + every active Tier 1 company)."
else
  echo "No $SIGNAL_SCAN_DOMAINS_FILE found (e.g. SKIP_SYNC was set) -- scanning the full watchlist YAML, unscoped."
fi
SIGNAL_SCAN_BUDGET_SECONDS=${SIGNAL_SCAN_BUDGET_SECONDS:-1200}
rc=0
run_timeboxed "$SIGNAL_SCAN_BUDGET_SECONDS" "$STEP" -- npx tsx scripts/run-signals-once.mts || rc=$?
unset SIGNAL_SCAN_DOMAINS
if [ "$rc" -eq 124 ]; then
  echo "=== $(date) : $STEP timed out after ${SIGNAL_SCAN_BUDGET_SECONDS}s -- moving on (run-signals-once.mts also drains GDELT's rate-limited slow_queue on its own internal budget, so a cutoff here just leaves the rest for tomorrow's scan) ==="
elif [ "$rc" -ne 0 ]; then
  on_error "$rc"
  exit "$rc"
fi

STEP="push new signals to Fibery"
echo ""
echo "=== $(date) : $STEP ==="
"$PYTHON_BIN" ../src/signal_ingest.py

STEP="research pipeline (main.py --input fibery)"
echo ""
echo "=== $(date) : $STEP ==="
if [ -n "$SKIP_RESEARCH" ]; then
  echo "SKIPPED (SKIP_RESEARCH set) -- signals are synced/scanned/pushed to Fibery above; stopping "
  echo "before main.py/apollo_enroll. Used for a hiring.cafe-only catch-up pass (e.g. the first "
  echo "full 1,445-company backlog run) without also kicking off research + Apollo enrollment on "
  echo "top of it the same run."
else
  # Phase 17 (2026-10-01): one cheap Anthropic call before anything expensive starts.
  #
  # main.py exits 0 even when every LLM call it makes fails. That's deliberate --
  # research_likely_priorities() and research_stated_goal() both skip rather than ship under
  # the bar -- and it's right for one bad response. It is wrong for an exhausted credit
  # balance, where every call fails: the run still spends real String/QuickEnrich/Apollo
  # credits, writes Contacts with no Likely Priorities, and finishes here with
  # ":white_check_mark: completed OK". Apollo enrollment then skips those same contacts for
  # the missing field, so the day produces nothing and says nothing. Fail loudly instead.
  #
  # Run in an explicit subshell rather than via a `cd ..` helper function: the helpers below
  # are only ever invoked inside run_timeboxed's own `( ... ) &` subshell, which contains
  # their cd. Calling one directly here would move THIS script's cwd out of hypersignal/ and
  # break every relative path after it ("$LOG_DIR", data/.last_success).
  STEP="Anthropic preflight (credit/API check)"
  echo ""
  echo "=== $(date) : $STEP ==="
  rc=0
  ( cd .. && "$PYTHON_BIN" -m src.preflight_anthropic ) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "=== $(date) : $STEP FAILED (exit $rc) -- aborting before main.py. Exit 3 = Anthropic"
    echo "    credit balance/billing (nothing downstream can work today); 2 = ANTHROPIC_API_KEY"
    echo "    missing from .env; 4 = any other API failure (network, auth, model id, outage)."
    echo "    No research, no enrollment, and no success marker for this run. ==="
    on_error "$rc"
    exit "$rc"
  fi

  # main.py/apollo_enroll.py both import src.providers, which uses package-relative imports --
  # same reason main.py has always been invoked as `python -m src.main` (see README.md/CLAUDE.md),
  # never as a bare script. Each runs in its own function/subshell so `cd ..` doesn't affect the
  # rest of this script (cwd needs to stay hypersignal/ for the dead-man's-switch marker path below).
  # PYTHONUNBUFFERED (Phase 18): python buffers stdout in ~8KB blocks when it is a pipe rather
  # than a tty, and this whole script's output IS a pipe (the `exec > >(tee -a "$RUN_LOG")` at the
  # top). So a run that gets SIGTERMed by the time-box lost its last partial block -- the final
  # few companies' progress lines never reached the log, which is exactly the stretch you need to
  # see when diagnosing why it ran long. main.py's own flush=True on the per-company line only
  # covered that one print; this covers everything, including the deadline and ledger output.
  _step_main_py() {
    cd ..
    PYTHONUNBUFFERED=1 "$PYTHON_BIN" -m src.main --input fibery
  }
  MAIN_BUDGET_SECONDS=${MAIN_BUDGET_SECONDS:-1800}
  rc=0
  # STEP is reset here on purpose (Phase 18 fix). The preflight block above set it to "Anthropic
  # preflight (credit/API check)" and never restored it, so a main.py timeout printed "Anthropic
  # preflight ... timed out after 1800s" and any failure alert named the wrong step -- pointing
  # whoever read it at the one step that had already succeeded.
  STEP="research pipeline (main.py --input fibery)"
  run_timeboxed "$MAIN_BUDGET_SECONDS" "$STEP" -- _step_main_py || rc=$?
  if [ "$rc" -eq 124 ]; then
    echo "=== $(date) : $STEP timed out after ${MAIN_BUDGET_SECONDS}s -- moving on to Apollo enrollment with whatever main.py finished writing back to Fibery before the cutoff ==="
  elif [ "$rc" -ne 0 ]; then
    on_error "$rc"
    exit "$rc"
  fi
  # Preserved because $rc is reused by the Apollo step below, and the success marker at the
  # bottom re-checks main.py's own outcome independently of it.
  MAIN_PY_RC="$rc"

  STEP="Apollo enrollment (Phase 12, staged rollout)"
  echo ""
  echo "=== $(date) : $STEP ==="
  _step_apollo() {
    cd ..
    PYTHONUNBUFFERED=1 "$PYTHON_BIN" -m src.apollo_enroll
  }
  APOLLO_BUDGET_SECONDS=${APOLLO_BUDGET_SECONDS:-900}
  rc=0
  run_timeboxed "$APOLLO_BUDGET_SECONDS" "$STEP" -- _step_apollo || rc=$?
  if [ "$rc" -eq 124 ]; then
    echo "=== $(date) : $STEP timed out after ${APOLLO_BUDGET_SECONDS}s -- moving on. Whatever it enrolled before the cutoff is done; the rest picks up next run. ==="
  elif [ "$rc" -ne 0 ]; then
    on_error "$rc"
    exit "$rc"
  fi
fi

# Dead-man's-switch marker: only written if every step above succeeded (set -e), including any
# explicit `exit "$rc"` above for a real (non-timeout) failure.
#
# Phase 17: re-check the research pipeline's own exit code here before claiming success. The
# `exit "$rc"` in main.py's step above already prevents reaching this line on a real failure,
# so today this is a backstop rather than a live fix -- its job is to make a false "completed
# OK" impossible to reintroduce by editing that block, since the success marker and the Slack
# ":white_check_mark:" are what Rachel actually trusts. 124 (hit its time budget) is a partial
# pass, not a failure, and is deliberately allowed through exactly as it is above.
if [ "${MAIN_PY_RC:-0}" -ne 0 ] && [ "${MAIN_PY_RC:-0}" -ne 124 ]; then
  echo "=== $(date) : research pipeline exited ${MAIN_PY_RC} -- NOT marking this run successful ==="
  STEP="research pipeline (main.py --input fibery)"
  on_error "$MAIN_PY_RC"
  exit "$MAIN_PY_RC"
fi

date -u +%s > data/.last_success
echo ""
echo "=== $(date) : run-cron.sh completed OK ==="

slack_notify ":white_check_mark: HyperSignal cron completed OK. Full log: $RUN_LOG"
