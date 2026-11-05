// CONTACT_EMAIL drives the User-Agent sent to SEC EDGAR, crt.sh/Cert Spotter and the WARN feeds.
// There is no built-in default address. With it unset, EDGAR must not be called at all (SEC's
// fair-access policy requires a contact) and the other two must send a User-Agent with no email.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contactEmail, contactUserAgent } from "./contact.ts";
import { edgarProducer } from "./edgar.ts";
import { warnProducer } from "./warn.ts";
import { subdomainsProducer } from "./subdomains.ts";
import type { ProducerCtx } from "./types.ts";

/** Run `fn` with CONTACT_EMAIL set to `value` (undefined = unset), restoring the original after. */
async function withContact<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CONTACT_EMAIL;
  if (value === undefined) delete process.env.CONTACT_EMAIL; else process.env.CONTACT_EMAIL = value;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.CONTACT_EMAIL; else process.env.CONTACT_EMAIL = prev; }
}

/** Stub fetch, recording each URL and the User-Agent it was sent with. */
function stubFetch(body: string): { calls: Array<{ url: string; ua: string | null }>; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; ua: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ua: new Headers(init?.headers).get("user-agent") });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("unset or blank CONTACT_EMAIL means no contact and an email-free User-Agent", async () => {
  for (const v of [undefined, "", "   "]) {
    await withContact(v, async () => {
      assert.equal(contactEmail(), null);
      assert.equal(contactUserAgent(), "HyperSignal-Hiring/1.0");
    });
  }
  await withContact("ops@example.com", async () => {
    assert.equal(contactUserAgent(), "HyperSignal-Hiring/1.0 (ops@example.com)");
  });
});

test("EDGAR is skipped, with a clear reason and no request, when CONTACT_EMAIL is unset", async () => {
  const s = stubFetch("{}");
  try {
    const r = await withContact(undefined, () =>
      edgarProducer.check("edgar-nocontact.test", { company: "Northwind Logistics" } as ProducerCtx));
    assert.equal(s.calls.length, 0, "no request may reach SEC without a contact email");
    assert.match(String(r.facts.EDGAR), /CONTACT_EMAIL/);
    assert.match(String(r.facts.EDGAR), /SEC requires/);
    assert.equal(r.flag, undefined, "a skip measured nothing, so it must not overwrite the last answer");
    assert.deepEqual(r.signals, []);
  } finally { s.restore(); }
});

test("WARN requests carry no email in the User-Agent when CONTACT_EMAIL is unset", async () => {
  const s = stubFetch("hash_id,notice_date,effective_date,postal_code,company,location,jobs,is_closure,is_temporary,is_superseded\n");
  try {
    await withContact(undefined, () => warnProducer.check("acme.com", { company: "Acme" } as ProducerCtx));
    assert.ok(s.calls.length > 0, "WARN still runs without a contact");
    for (const c of s.calls) assert.equal(c.ua, "HyperSignal-Hiring/1.0", `${c.url} sent ${c.ua}`);
  } finally { s.restore(); }
});

test("certificate-transparency requests carry no email in the User-Agent when CONTACT_EMAIL is unset", async () => {
  const s = stubFetch("[]");
  try {
    await withContact(undefined, () => subdomainsProducer.check("ct-nocontact.test", {} as ProducerCtx));
    assert.ok(s.calls.length > 0, "the subdomain lookup still runs without a contact");
    for (const c of s.calls) assert.equal(c.ua, "HyperSignal-Hiring/1.0", `${c.url} sent ${c.ua}`);
  } finally { s.restore(); }
});
