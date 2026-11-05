// The SSRF guard. It had no test coverage at all, which is the wrong state for the one function in
// the codebase whose job is to say no — every other module fetches scraped, third-party URLs through
// it (job apply links, company homepages guessed from a name, tech-stack probes), and its failure
// mode is silent: it returns "safe" and something on the LAN gets fetched and rendered back into the
// dashboard as if it were a company's website.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ipIsPrivate, assertPublicUrl } from "./safeFetch.ts";

test("blocks the classic internal ranges", () => {
  for (const ip of ["127.0.0.1", "127.13.9.2", "10.0.0.1", "10.255.255.254", "192.168.1.1",
                    "172.16.0.1", "172.31.255.255", "0.0.0.0", "100.64.0.1", "100.127.255.255"])
    assert.equal(ipIsPrivate(ip), true, ip);
});

test("blocks the cloud metadata address specifically", () => {
  // The single most valuable SSRF target on any cloud host — it serves credentials to whoever asks.
  assert.equal(ipIsPrivate("169.254.169.254"), true);
});

test("blocks the ranges that were missing", () => {
  assert.equal(ipIsPrivate("192.0.0.170"), true, "192.0.0.0/24 IETF protocol assignments");
  assert.equal(ipIsPrivate("198.18.0.1"), true, "198.18.0.0/15 benchmarking");
  assert.equal(ipIsPrivate("198.19.255.255"), true, "198.18.0.0/15 upper half");
  assert.equal(ipIsPrivate("224.0.0.1"), true, "multicast");
  assert.equal(ipIsPrivate("239.255.255.250"), true, "SSDP multicast — reaches LAN devices");
  assert.equal(ipIsPrivate("255.255.255.255"), true, "broadcast");
});

test("does NOT block ordinary public addresses", () => {
  // Over-blocking is a real cost: these are the addresses the app exists to fetch.
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1",
                    "192.167.0.1", "192.169.0.1", "100.63.0.1", "100.128.0.1", "198.17.0.1", "223.255.255.255"])
    assert.equal(ipIsPrivate(ip), false, ip);
});

test("blocks IPv6 loopback, link-local, unique-local and site-local", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "fec0::1"])
    assert.equal(ipIsPrivate(ip), true, ip);
  assert.equal(ipIsPrivate("2606:4700::1111"), false, "a public v6 address still passes");
});

test("blocks IPv4 smuggled inside an IPv6 literal", () => {
  assert.equal(ipIsPrivate("::ffff:127.0.0.1"), true, "IPv4-mapped");
  // IPv4-COMPATIBLE. Deprecated, but getaddrinfo still parses it, and it was walking straight
  // through the guard because the pattern only matched the ::ffff: form.
  assert.equal(ipIsPrivate("::127.0.0.1"), true, "IPv4-compatible");
  assert.equal(ipIsPrivate("::169.254.169.254"), true, "IPv4-compatible metadata address");
  assert.equal(ipIsPrivate("64:ff9b::7f00:1"), true, "NAT64 prefix always lands on IPv4");
});

test("anything unparseable is unsafe, not safe", () => {
  // Fail closed: an address this function cannot understand must never be reported as public.
  for (const s of ["", "not-an-ip", "999.999.999.999", "localhost"])
    assert.equal(ipIsPrivate(s), true, JSON.stringify(s));
});

test("assertPublicUrl rejects non-http protocols and private literals", async () => {
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), /blocked protocol/);
  await assert.rejects(assertPublicUrl("gopher://example.com"), /blocked protocol/);
  await assert.rejects(assertPublicUrl("http://127.0.0.1:8080/admin"), /blocked private ip/);
  await assert.rejects(assertPublicUrl("http://[::1]:4000/"), /blocked private ip/);
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /blocked private ip/);
  await assert.rejects(assertPublicUrl("not a url"), /invalid url/);
});
