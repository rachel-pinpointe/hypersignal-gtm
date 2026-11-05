// buildFetchTimers turns a client's schedule into concrete timers. The COUNT is the whole contract:
// zero timers means an active client silently never fetches again, and there is no other way to
// observe that without waiting for wall-clock time. Every assertion here is about how many timers
// a config produces, and whether a bad config fails LOUDLY rather than quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFetchTimers, deliveryWarnings, startSchedules, stopSchedules, getConfigWarnings } from "./scheduler.ts";
import type { ClientConfig } from "./types.ts";

const cfg = (extra: Partial<ClientConfig>): ClientConfig =>
  ({ name: "sched-test", active: true, kind: "search", search: { keywords: ["x"] }, ...extra } as ClientConfig);

/** Build, count, and ALWAYS stop — a leaked cron task keeps the test process alive. */
function count(client: ClientConfig): number {
  const timers = buildFetchTimers(client, () => {});
  try { return timers.length; } finally { for (const t of timers) t.stop(); }
}

test("an unset schedule falls back to the hourly default", () => {
  assert.equal(count(cfg({})), 1);
});

test("an INVALID refreshCron produces no timer — a typo must not silently become hourly", () => {
  // The dangerous version of this bug is the opposite: collapsing a typo onto the hourly default
  // schedules a scrape every hour that nobody asked for. Fail closed.
  assert.equal(count(cfg({ refreshCron: "not a cron" })), 0);
  assert.equal(count(cfg({ refreshCron: "*/15 * * * *" })), 1, "a valid one still works");
});

test("recurring builds one timer per valid time and drops the invalid ones", () => {
  assert.equal(count(cfg({ schedule: { mode: "recurring", times: ["09:00", "17:30"] } as never })), 2);
  assert.equal(count(cfg({ schedule: { mode: "recurring", times: ["09:00", "99:99"] } as never })), 1,
    "one good time, one nonsense time");
  // Every time unusable => NO schedule at all. This is the case that used to pass in silence.
  assert.equal(count(cfg({ schedule: { mode: "recurring", times: ["99:99", "25:00"] } as never })), 0);
});

test("recurring day filters do not change the timer count", () => {
  for (const days of [{ days: "weekdays" }, { days: "weekends" }, { daysOfWeek: [1, 3, 5] }, { daysOfMonth: [1, 15] }])
    assert.equal(count(cfg({ schedule: { mode: "recurring", times: ["09:00"], ...days } as never })), 1,
      `one time + ${JSON.stringify(days)} is still one timer`);
});

test("interval mode produces exactly one timer, whatever the unit", () => {
  for (const unit of ["minute", "hour", "day"])
    assert.equal(count(cfg({ schedule: { mode: "interval", every: 2, unit } as never })), 1, unit);
  // Past the ~24.8-day setTimeout ceiling, where a naive delay overflows to a 1ms timer that fires
  // continuously. It must still be ONE timer, chained internally.
  assert.equal(count(cfg({ schedule: { mode: "interval", every: 30, unit: "day" } as never })), 1);
});

test("a one-off in the future arms; one in the past does NOT fire late", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(count(cfg({ schedule: { mode: "once", at: future } as never })), 1);
  assert.equal(count(cfg({ schedule: { mode: "once", at: "2020-01-01T00:00:00Z" } as never })), 0,
    "a stale one-off must be skipped, not fired the moment the app starts");
  assert.equal(count(cfg({ schedule: { mode: "once", at: "not a date" } as never })), 0);
});

test("cron passthrough validates", () => {
  assert.equal(count(cfg({ schedule: { mode: "cron", expr: "0 */4 * * *" } as never })), 1);
  assert.equal(count(cfg({ schedule: { mode: "cron", expr: "every 4 hours please" } as never })), 0);
});

// ── Delivery config: every way a client can silently deliver nothing ──────────────────────────
//
// isRealtime() treats any mode that is not the literal "realtime" as scheduled, and that one test
// gates deliver() in ingest.ts and deliverSignals() here. Off realtime, the digest cron is the only
// remaining sink — so a missing or malformed cron means matches and signals queue up forever.
//
// The original check caught only a schedule that was present and malformed. Omitting it entirely
// gave the identical outcome and logged nothing, and it is the likelier mistake: the dashboard always
// writes mode "realtime", so a non-realtime mode arrives only by hand-editing YAML.

const warns = (delivery: unknown): string[] => deliveryWarnings(cfg({ delivery } as Partial<ClientConfig>));

test("a realtime client is never warned about delivery", () => {
  assert.deepEqual(warns({ mode: "realtime", webhook_url: "https://e.com/h" }), []);
  assert.deepEqual(warns(undefined), [], "an absent delivery block defaults to realtime");
  assert.deepEqual(warns({ webhook_url: "https://e.com/h" }), [], "an absent mode defaults to realtime");
});

test("scheduled with a valid cron is silent — it has a working sink", () => {
  assert.deepEqual(warns({ mode: "scheduled", schedule: "0 9 * * *", webhook_url: "https://e.com/h" }), []);
});

test("scheduled with NO schedule is warned about — this was the silent case", () => {
  const w = warns({ mode: "scheduled", webhook_url: "https://e.com/h" });
  assert.equal(w.length, 1, `expected exactly one warning, got ${JSON.stringify(w)}`);
  assert.match(w[0]!, /no delivery\.schedule is set/);
  assert.match(w[0]!, /queue up undelivered/, "the warning must state the consequence, not just the fault");
});

test("scheduled with a MALFORMED schedule is still warned about", () => {
  const w = warns({ mode: "scheduled", schedule: "not a cron", webhook_url: "https://e.com/h" });
  assert.equal(w.length, 1);
  assert.match(w[0]!, /not a valid cron/);
});

test("an unrecognised mode is called out separately from the schedule", () => {
  // "manual" and "realtim" both read as deliberate to a human and as scheduled to isRealtime(). The
  // schedule can be perfectly valid and the client still not do what its author asked for, so this
  // is its own warning rather than a branch of the schedule check.
  const typo = warns({ mode: "realtim", schedule: "0 9 * * *", webhook_url: "https://e.com/h" });
  assert.equal(typo.length, 1, `a valid cron leaves only the mode complaint: ${JSON.stringify(typo)}`);
  assert.match(typo[0]!, /neither "realtime" nor "scheduled"/);

  // Both faults at once produce both warnings — neither hides the other.
  const both = warns({ mode: "manual", webhook_url: "https://e.com/h" });
  assert.equal(both.length, 2, `expected both warnings, got ${JSON.stringify(both)}`);
  assert.ok(both.some((s) => /no delivery\.schedule/.test(s)) && both.some((s) => /neither/.test(s)));
});

// ── The warnings reached a console nobody opens ──────────────────────────────────────────────────
//
// "This client is ACTIVE but will never fetch" and "matches will queue up undelivered forever" are
// the two most consequential things this file can discover, and both went to console.warn and
// nowhere else. This runs as a desktop app: the terminal is behind the window, on a scroll buffer a
// long boot has already pushed the line off. On screen the client reads ACTIVE and the dashboard
// looks entirely healthy — the same silence the delivery-backlog card was added to break.
//
// They are now RECORDED as well as printed, and ride along on /api/health. Nothing re-derives the
// decision: these are the strings the scheduler produced from the timers it actually armed.
test("a client that can never fetch is recorded, not just printed", () => {
  try {
    startSchedules([cfg({ name: "never-runs", schedule: { mode: "cron", expr: "0 0 30 2 *" } } as Partial<ClientConfig>)]);
    const w = getConfigWarnings().filter((x) => x.client === "never-runs");
    assert.equal(w.length, 1, "the one thing that matters must be reported exactly once");
    assert.equal(w[0]!.kind, "schedule");
    // It must read as a whole sentence: the card puts the client's NAME above it as a heading, so a
    // fragment written to follow the name in a log line ("is ACTIVE but has no…") reads as broken.
    assert.match(w[0]!.warning, /never fetch by itself/);
    assert.match(w[0]!.warning, /^[A-Z]/, "it stands alone on screen, under the client's name");
  } finally { stopSchedules(); }
});

test("a client whose matches will queue undelivered forever is recorded too", () => {
  try {
    startSchedules([cfg({ name: "never-sends", delivery: { mode: "scheduled" } } as Partial<ClientConfig>)]);
    const w = getConfigWarnings().filter((x) => x.client === "never-sends" && x.kind === "delivery");
    assert.ok(w.length >= 1, "a scheduled client with no digest schedule delivers nothing");
    assert.match(w.map((x) => x.warning).join(" "), /queue up undelivered/);
  } finally { stopSchedules(); }
});

test("a healthy client reports nothing — a warning on every boot is a warning nobody reads", () => {
  try {
    startSchedules([cfg({ name: "healthy", refreshCron: "0 * * * *", delivery: { mode: "realtime" } } as Partial<ClientConfig>)]);
    assert.deepEqual(getConfigWarnings().filter((x) => x.client === "healthy"), []);
  } finally { stopSchedules(); }
});

test("fixing the config clears the warning — the list is rebuilt, never appended to", () => {
  // startSchedules re-runs on every config reload. If the list accumulated instead of resetting, a
  // problem the user had already fixed would stay on screen forever, which is worse than silence:
  // it teaches them to ignore the card.
  try {
    startSchedules([cfg({ name: "fixme", schedule: { mode: "cron", expr: "0 0 30 2 *" } } as Partial<ClientConfig>)]);
    assert.equal(getConfigWarnings().length, 1);
    stopSchedules();
    startSchedules([cfg({ name: "fixme", refreshCron: "0 * * * *", delivery: { mode: "realtime" } } as Partial<ClientConfig>)]);
    assert.deepEqual(getConfigWarnings(), [], "the fixed config must clear the card");
  } finally { stopSchedules(); }
});

test("an INACTIVE client is not warned about — it is switched off on purpose", () => {
  try {
    startSchedules([cfg({ name: "off", active: false, schedule: { mode: "cron", expr: "0 0 30 2 *" } } as Partial<ClientConfig>)]);
    assert.deepEqual(getConfigWarnings(), []);
  } finally { stopSchedules(); }
});
