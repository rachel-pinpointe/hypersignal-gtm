// normalizeOrgDomain reduces input to an org key. It deliberately does NOT validate — and a
// `.filter(Boolean)` gate reads "reduced to something" as "is a domain". Those are different claims,
// and the difference is what let junk become a company.
//
// "https://" and "?a=b" reduce to "" and were correctly dropped. But "www." reduces to "www", ".com"
// to "com", and "a" stays "a" — all truthy, none a domain. The bulk Signal Check and Account Check
// paths accepted all three, ran every producer against them, and wrote the answers into domain_flags,
// domain_state and signals under that key, where nothing distinguishes them from a real company that
// genuinely has no signals. The strict shape check already existed — but only on the one-at-a-time
// route, not the thousand-at-a-time one.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrgDomain, isDomainShaped } from "./normalize.ts";

test("inputs that reduce to a truthy non-domain are rejected", () => {
  for (const input of ["www.", ".com", "a", "com", "localhost", "..", "-.com", "x.c"]) {
    const norm = normalizeOrgDomain(input);
    assert.equal(isDomainShaped(norm), false,
      `${JSON.stringify(input)} normalized to ${JSON.stringify(norm)} and must NOT pass as a domain`);
  }
});

test("the truthy-but-wrong cases are exactly the ones a Boolean gate would have let through", () => {
  // The regression this guards: each of these is non-empty after normalizing, so `.filter(Boolean)`
  // kept it. Naming them here means a future change to normalizeOrgDomain cannot quietly re-open it.
  for (const input of ["www.", ".com", "a"]) {
    assert.ok(normalizeOrgDomain(input), `${input} is truthy after normalizing — that is the trap`);
    assert.equal(isDomainShaped(normalizeOrgDomain(input)), false);
  }
});

test("real domains still pass, in every shape the app accepts", () => {
  for (const input of [
    "stripe.com", "https://stripe.com", "www.stripe.com", "careers.acme.co.uk",
    "jobs.acme.com/openings?x=1", "ACME.COM", "  acme.com  ", "sub.domain.example.org",
    "a-b.com", "acme.io:8080",
  ]) {
    const norm = normalizeOrgDomain(input);
    assert.equal(isDomainShaped(norm), true,
      `${JSON.stringify(input)} normalized to ${JSON.stringify(norm)} and must pass`);
  }
});

test("null, undefined and empty are rejected without throwing", () => {
  for (const input of [null, undefined, "", "   "]) {
    assert.equal(isDomainShaped(normalizeOrgDomain(input)), false);
    assert.equal(isDomainShaped(input as unknown as string), false);
  }
});
