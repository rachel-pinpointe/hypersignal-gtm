// Webhook payload and CSV export must carry the SAME facts. The two are written in different files
// by different code paths, so they drift silently: a field added to one is simply absent from the
// other, and nothing fails — the export just quietly says less than the webhook, or vice versa.
//
// Measured drift when this was written, in BOTH directions:
//   webhook had evidence_rank + first_seen_at that the CSV did not
//   CSV had matched_by + reports_grouped that the webhook did not
//   and the webhook had no per-signal ID AT ALL, despite at-least-once delivery
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, dbListSignals, dbInsertSignal } from "./db.ts";
import { toSignal } from "./delivery.ts";

const SRC = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");

test("the signals CSV exports evidence_rank and first_seen", () => {
  const cols = /const cols = \[([^\]]*)\];/.exec(SRC("server.ts").split("/api/signals/export")[1] ?? "");
  assert.ok(cols, "could not find the signals export column list — this test is measuring nothing");
  const names = [...cols[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  for (const c of ["when", "first_seen", "company", "domain", "signal", "category", "evidence_rank",
                   "matched_by", "title", "detail", "url", "monitor", "reports_grouped"])
    assert.ok(names.includes(c), `signals CSV is missing the "${c}" column (has: ${names.join(", ")})`);
});

test("the signal webhook item carries a stable per-signal id", () => {
  // Delivery is at-least-once BY DESIGN: a batch is marked delivered only after the receiver returns
  // 2xx, so a crash in between re-sends it. `delivery_id` + `batch` identify the ENVELOPE, not the
  // signal — without a per-item id a receiver cannot tell a re-send from a new finding.
  const src = SRC("delivery.ts");
  assert.match(src, /\bsignal_id:\s*r\.id\b/, "webhook items must carry signal_id for a consumer to dedupe on");
  for (const f of ["signal_type", "signal_category", "evidence_rank", "observed_at", "first_seen_at", "company_domain"])
    assert.match(src, new RegExp(`\\b${f}:`), `webhook item lost the "${f}" field`);
});

test("dbListSignals returns evidenceRank on BOTH of its query paths", () => {
  // The function branches on f.collapse into two entirely separate SELECTs. Adding a column to one
  // gives callers a field that exists or is undefined depending on a setting they never asked about
  // — which is exactly what happened: the CSV would have exported rank 0 for every row.
  const id = `paritytest:${Math.floor(Number(process.hrtime.bigint() % 1000000n))}`;
  dbInsertSignal({ dedupKey: id, domain: "acme.test", company: "Acme", type: "warn-layoff",
    title: "Parity fixture", detail: null, url: null, client: "_paritytest", observedAt: null });
  try {
    for (const collapse of [false, true]) {
      const { items } = dbListSignals({ client: "_paritytest", limit: 5, offset: 0, collapse } as never);
      assert.ok(items.length > 0, `no rows back with collapse=${collapse}`);
      for (const s of items)
        assert.equal(typeof s.evidenceRank, "number", `evidenceRank missing with collapse=${collapse}`);
    }
  } finally {
    db.prepare("DELETE FROM signals WHERE client = '_paritytest'").run();
  }
});

// ── the JOBS channel, which this file never checked — which is why it drifted ─────────────────────
//
// Every test above is about SIGNALS. The jobs channel is the busier of the two (16,659 matches for
// one client on the live install) and had no parity check at all, so it had drifted in both
// directions:
//   the CSV had technologies, matches and clients that the webhook did not
//   the webhook had seniority, commitment, workplace_type and salary that the CSV did not
//
// `technologies` was the one that mattered. matcher.ts can GATE a match on it — "only alert me when
// these companies hire for React" — so a client could ask to hear only about React roles, be told
// about one, and never be told React was the reason the match happened.
//
// This test is deliberately a set difference with a NAMED exclusion list, not a spot check. A spot
// check is what let four fields go missing while every assertion above passed.

/** The webhook item's top-level keys, from the real toSignal — not from source text. */
function webhookJobKeys(): string[] {
  const s = toSignal({
    id: "j1", title: "Engineer", company: "Acme", domain: "acme.com", location: "Austin, TX",
    state: "TX", remote: 0, status: "open", url: "https://x.test/1", source: "hiringcafe",
    posted_at: "2026-07-01", seen_at: "2026-07-02 10:00:00", matched_at: "2026-07-03 10:00:00",
    matchReason: "corporate", technologies: "React; Kubernetes", raw: JSON.stringify({ seniority: "Senior" }),
  });
  return Object.keys(s);
}

/** The jobs CSV column list, read from the route that defines it. */
function jobsCsvCols(): string[] {
  const after = SRC("server.ts").split('/api/admin/jobs/export')[1] ?? "";
  const m = /const cols = \[([\s\S]*?)\];/.exec(after);
  assert.ok(m, "could not find the jobs export column list — this test is measuring nothing");
  return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

test("the instruments find both channels, before anything is asserted with them", () => {
  // Guard the instrument first: two empty lists would make every assertion below vacuously pass,
  // which is how a broken parity test looks exactly like two channels in perfect agreement.
  assert.ok(webhookJobKeys().length >= 15, `webhook item parsed as near-empty: ${webhookJobKeys().length} keys`);
  assert.ok(jobsCsvCols().length >= 15, `CSV columns parsed as near-empty: ${jobsCsvCols().join(",")}`);
});

test("every fact the jobs CSV exports is also in the webhook item", () => {
  // CSV-only fields, each with the reason it is CSV-only. Anything NOT on this list that goes missing
  // is a defect, and the list is short on purpose — a growing exclusion list is a parity test giving up.
  const csvOnly = new Set([
    "matches",       // cross-client match COUNT: an admin view of the whole pool, not this client's business
    "clients",       // which OTHER clients matched — deliberately never sent to one of them
    "first_seen_at", // spelled first_seen_at in both; listed because the webhook nests nothing here
  ]);
  // The same FACT under a different name or shape is parity, not drift — but it has to be written
  // down, or "we renamed it" becomes the excuse that waves a genuinely missing field through. Each
  // of these was found by running this test, and each is verified below to actually carry a value.
  const alias: Record<string, string> = {
    domain: "company_domain",          // the webhook qualifies it; the CSV has always said "domain"
    max_salary: "compensation.max",    // the webhook nests salary as an object, which is better JSON
    salary_currency: "compensation.currency",
  };
  const keys = new Set(webhookJobKeys());
  const item = toSignal({ id: "j4", title: "T", company: "C", url: "u", domain: "acme.com", seen_at: null,
    raw: JSON.stringify({ comp_max: 120000, currency: "USD" }) }) as Record<string, unknown>;
  const at = (path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), item);
  const missing = jobsCsvCols().filter((c) => {
    if (csvOnly.has(c) || keys.has(c)) return false;
    const a = alias[c];
    // An alias only counts if the webhook really carries a VALUE there. A mapping to a field that is
    // always null would hide the drift it claims to explain.
    return !(a && at(a) != null);
  });
  assert.deepEqual(missing, [], `the jobs CSV exports these and the webhook does not: ${missing.join(", ")}`);
});

test("technologies reaches the webhook as a LIST, since the matcher can gate on it", () => {
  // The field this test was written for. An array, not the CSV's "; "-joined string: a JSON consumer
  // should not have to re-split a list we already had as one.
  const s = toSignal({ id: "j2", title: "T", company: "C", url: "u", seen_at: null,
    technologies: "React; Kubernetes; PostgreSQL", raw: "{}" }) as Record<string, unknown>;
  assert.deepEqual(s.technologies, ["React", "Kubernetes", "PostgreSQL"]);
});

test("no detected technology is an empty list, not null", () => {
  // "We looked and found none" is an answer — the same measured-vs-unknown distinction the signal
  // producers make. A consumer branching on `.length` must not have to null-check first.
  const s = toSignal({ id: "j3", title: "T", company: "C", url: "u", seen_at: null, technologies: null, raw: "{}" }) as Record<string, unknown>;
  assert.deepEqual(s.technologies, []);
});

// ── the DOCS are a third channel, and they drift exactly like the other two ───────────────────────
//
// The webhook payload is a published contract: someone builds a CRM integration against the example
// in docs/webhooks.md. A field that ships without being documented is a feature nobody can use, and a field
// documented after being removed is an integration that breaks on a null nobody expected.
//
// Found by running this as a one-off: `matched_at` had been shipping undocumented since it was added,
// and `technologies` was added in this same sweep. Both are the same silent drift that
// channelParity.test.ts already guards between code and code — this is the identical set difference
// between code and the docs, so it stops being a thing anyone has to remember.

/** Every field name in the README's matches.new example, including nested objects. */
function documentedPayloadFields(): Set<string> {
  const md = SRC("../docs/webhooks.md");
  const after = md.split('"event": "matches.new"')[1];
  assert.ok(after, "docs/webhooks.md no longer contains a matches.new example — this test is measuring nothing");
  const block = after.split("```")[0]!;
  return new Set([...block.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]!));
}

test("every field the webhook actually sends is in the documented example", () => {
  // Envelope keys are asserted separately below; this is about the per-signal item.
  const item = toSignal({
    id: "j", title: "T", company: "C", domain: "acme.com", location: "Austin, TX", state: "TX",
    remote: 0, status: "open", url: "u", source: "hiringcafe", posted_at: "2026-07-01",
    seen_at: "2026-07-02 10:00:00", matched_at: "2026-07-03 10:00:00", matchReason: "corporate",
    technologies: "React", raw: JSON.stringify({ comp_max: 1, currency: "USD", seniority: "Senior" }),
  }) as Record<string, unknown>;
  const flat = (o: Record<string, unknown>, out = new Set<string>()): Set<string> => {
    for (const [k, v] of Object.entries(o)) {
      out.add(k);
      if (v && typeof v === "object" && !Array.isArray(v)) flat(v as Record<string, unknown>, out);
    }
    return out;
  };
  const doc = documentedPayloadFields();
  const undocumented = [...flat(item)].filter((k) => !doc.has(k));
  assert.deepEqual(undocumented, [],
    `the webhook sends these and docs/webhooks.md never mentions them: ${undocumented.join(", ")}`);
});

test("the docs do not promise a field the webhook stopped sending", () => {
  // The other direction, and the one that breaks a live integration rather than merely hiding a
  // feature. Envelope keys are excluded because they are siblings of `signals`, not fields of it.
  const ENVELOPE = new Set(["event", "schema_version", "client", "delivery_id", "batch", "index",
    "total", "size", "count", "total_count", "signals"]);
  const item = toSignal({ id: "j", title: "T", company: "C", domain: "acme.com", url: "u",
    seen_at: "2026-07-02 10:00:00", matched_at: "2026-07-03 10:00:00", technologies: "React",
    raw: JSON.stringify({ comp_max: 1, currency: "USD" }) }) as Record<string, unknown>;
  const flat = (o: Record<string, unknown>, out = new Set<string>()): Set<string> => {
    for (const [k, v] of Object.entries(o)) {
      out.add(k);
      if (v && typeof v === "object" && !Array.isArray(v)) flat(v as Record<string, unknown>, out);
    }
    return out;
  };
  const sent = flat(item);
  const phantom = [...documentedPayloadFields()].filter((k) => !ENVELOPE.has(k) && !sent.has(k));
  assert.deepEqual(phantom, [],
    `docs/webhooks.md documents these and the webhook does not send them: ${phantom.join(", ")}`);
});

test("the documented CSV column COUNT matches the export", () => {
  // A number in prose is the easiest thing in a README to leave behind: it said "15 columns" while
  // the route emitted 20. Read from the route rather than trusted.
  const n = jobsCsvCols().length;
  const claimed = /`GET \/api\/admin\/jobs\/export`,\s*(\d+)\s*columns/.exec(SRC("../docs/exports.md"));
  assert.ok(claimed, "docs/exports.md no longer states a column count for the jobs export");
  assert.equal(Number(claimed[1]), n, `docs/exports.md says ${claimed[1]} columns, the route emits ${n}`);
});
