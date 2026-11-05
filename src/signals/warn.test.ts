// WARN layoff notices, driven end to end through a stubbed fetch — the real CSV parser, the real
// date handling, the real signal shape.
//
// The defect this pins: a WARN filing carries a notice date (when it was filed) and an effective date
// (when the layoff happens). The effective date is routinely in the FUTURE, and when a filing has no
// notice date the parser falls back to it. That fallback was then used three ways it should not be:
// as the signal's observedAt, as detail.noticeDate, and as a bare date printed beside the company.
//
// On production two signals said they were observed 2026-08-07 and 2026-08-31 while being created on
// 2026-07-27 — 11 and 35 days in the future. A feed sorted by when-it-happened puts a layoff that has
// not happened yet above everything that has, and the drawer labelled the effective date "Notice
// date", which is a different fact about the world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { warnProducer } from "./warn.ts";
import type { ProducerCtx } from "../signals/types.ts";

const HEADER = "hash_id,notice_date,effective_date,postal_code,company,location,jobs,is_closure,is_temporary,is_superseded";
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Serve one aggregate CSV to fetchAggregate and fail the NY feed, so the test owns the whole row set. */
async function run(csvRows: string[], company: string) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("dol.ny.gov")) throw new Error("NY feed disabled for this test");
    return new Response([HEADER, ...csvRows].join("\n"), { status: 200 });
  }) as typeof fetch;
  try {
    return await warnProducer.check("acme.com", { company } as ProducerCtx);
  } finally { globalThis.fetch = real; }
}

// The producer caches its row set for a while, so each test uses a distinct company and a distinct
// row — one fetch populates the cache and the rest read it, which is fine because every test asserts
// on a different filing.
const CSV = [
  `h-filed,${iso(-3)},${iso(+20)},CA,Filedco,San Jose,42,false,false,false`,
  `h-undated,,${iso(+25)},CA,Undatedco,San Jose,185,true,false,false`,
];

test("a filing WITH a notice date reports that date as when it happened", async () => {
  const r = await run(CSV, "Filedco");
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0]!.observedAt, iso(-3), "the filing date, not the effective date");
  assert.equal((r.signals[0]!.detail as Record<string, unknown>).noticeDate, iso(-3));
  assert.equal((r.signals[0]!.detail as Record<string, unknown>).effectiveDate, iso(+20));
});

test("a filing with NO notice date never claims a future observation", async () => {
  const r = await run(CSV, "Undatedco");
  assert.equal(r.signals.length, 1);
  const s = r.signals[0]!;
  assert.equal(s.observedAt, null,
    "an unknown filing date must be null — an effective date is in the future and would sort a layoff that has not happened above everything that has");
  assert.equal((s.detail as Record<string, unknown>).noticeDate, null,
    "the effective date must not be relabelled as the notice date");
  assert.equal((s.detail as Record<string, unknown>).effectiveDate, iso(+25),
    "the real effective date is still carried, so nothing is lost by refusing to guess");
});

test("a date printed beside the company says which date it is", async () => {
  // A bare date next to an employer name reads as "filed on". For an undated filing the only date
  // available is in the future, so printing it bare asserts something that has not happened.
  const filed = await run(CSV, "Filedco");
  assert.ok(filed.signals[0]!.title.includes(iso(-3)));
  assert.ok(!filed.signals[0]!.title.includes("effective"), "a real filing date needs no qualifier");

  const undated = await run(CSV, "Undatedco");
  assert.ok(undated.signals[0]!.title.includes(`effective ${iso(+25)}`),
    `an undated filing must qualify its date: ${undated.signals[0]!.title}`);
  assert.match(String(undated.facts.WARN), /effective/, "the facts line carries the same qualifier");
});

test("no observedAt on any signal is ever in the future", async () => {
  // The invariant, stated once against everything the producer can emit from this fixture.
  for (const company of ["Filedco", "Undatedco"]) {
    for (const s of (await run(CSV, company)).signals) {
      if (!s.observedAt) continue;
      assert.ok(Date.parse(s.observedAt) <= Date.now() + 86_400_000,
        `${company}: observedAt ${s.observedAt} is in the future`);
    }
  }
});
