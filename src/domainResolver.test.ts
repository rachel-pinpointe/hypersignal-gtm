// The gate that decides whether a guessed domain really belongs to a company.
//
// The resolver invents candidate domains from a company NAME ("Nightfall" → nightfall.com,
// nightfall.io, nightfall.co, nightfall.ai …) and accepts the first whose homepage calls itself that
// company. Everything rests on that check, because company_domains feeds the DNS, tech-stack,
// subdomain, news, ads, WARN and filings producers — one wrong row aims all of them at a stranger,
// and the wrong domain also ships to the user's CRM in the webhook payload.
//
// The check had two holes, both found by running the resolver against the live 2,047-company backlog:
//
//   Circana   → circana.net   "circana.net | fruits"
//   Nightfall → nightfall.in  "Buy nightfall.in – Premium Domain Name for Your Brand | DaaZ"
//
// Both are PARKED domains. A parking page's title IS the domain name, and the domain name is what we
// guessed FROM the company name, so the evidence is circular and a parked domain passes by
// construction. Chasing that exposed a third: nightfall.co redirects to nightfall.games, a tabletop
// RPG publisher whose title honestly reads "Nightfall Games" and which a name check cannot tell from
// the AI-security company Nightfall.
//
// Every title below is the real one, captured live while investigating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageProvesCompany, stripSelfReference, looksParked } from "./domainResolver.ts";

const proves = (domain: string, siteNames: string[], wanted: string[], finalUrl?: string) =>
  pageProvesCompany({ domain, finalUrl, siteNames, wanted });

test("a real homepage still verifies — the guards must not cost correct answers", () => {
  assert.equal(proves("nightfall.ai", ["Nightfall: AI Data Security & Data Loss Prevention Platform"], ["Nightfall"], "https://www.nightfall.ai/"), true,
    "www → apex is the same registrable domain and must not be treated as landing elsewhere");
  assert.equal(proves("spreetail.com", ["Spreetail | Ecommerce Accelerator, End-to-end Ecommerce Services."], ["Spreetail"]), true);
  assert.equal(proves("stripe.com", ["Stripe | Financial Infrastructure to Grow Your Revenue"], ["Stripe"]), true);
});

test("a parked page whose title is just the domain is rejected", () => {
  // The circular case: the only reason "circana.net | fruits" mentions Circana is that we guessed
  // circana.net from the name Circana.
  assert.equal(proves("circana.net", ["circana.net | fruits"], ["Circana"]), false);
});

test("a domain-broker sale page is rejected", () => {
  assert.equal(proves("nightfall.in", ["Buy nightfall.in – Premium Domain Name for Your Brand | DaaZ"], ["Nightfall"]), false);
});

test("the registrar 'Resources and Information' template is rejected", () => {
  // Survives stripSelfReference on its own — removing "nightfall.io" still leaves the word
  // "nightfall" in "nightfall Resources and Information." — so the parked-phrase check has to catch it.
  assert.equal(proves("nightfall.io", ["nightfall.io - nightfall Resources and Information."], ["Nightfall"]), false);
});

test("a candidate that redirects to a DIFFERENT company is rejected", () => {
  // nightfall.co → nightfall.games. The title is genuine and genuinely matches; only the destination
  // gives it away.
  assert.equal(proves("nightfall.co", ["Nightfall Games | Explore Unique RPG Worlds"], ["Nightfall"], "https://nightfall.games/"), false);
  // …and the same title on its OWN domain is a legitimate answer for that company.
  assert.equal(proves("nightfall.games", ["Nightfall Games | Explore Unique RPG Worlds"], ["Nightfall Games"], "https://nightfall.games/"), true);
});

test("a page with no self-declared name proves nothing", () => {
  // circana.com serves no <title> at all. Returning nothing is the honest answer, and is what made
  // the parked .net look attractive before these guards existed.
  assert.equal(proves("circana.com", [], ["Circana"]), false);
});

test("stripSelfReference removes the full domain but never the bare label", () => {
  // Removing the label would gut the genuine "Nightfall: AI Data Security…" and reject a right answer.
  assert.equal(stripSelfReference("circana.net | fruits", "circana.net"), "| fruits");
  assert.equal(stripSelfReference("Nightfall: AI Data Security", "nightfall.ai"), "Nightfall: AI Data Security");
  assert.equal(stripSelfReference("Zalando | www.zalando.com", "zalando.com"), "Zalando |",
    "a www-prefixed self-reference is the same self-reference");
  assert.equal(stripSelfReference("Acme (acme.com) - Home", "acme.com"), "Acme ( ) - Home".replace(/\s+/g, " "));
});

test("looksParked does not fire on ordinary marketing copy", () => {
  // A blocklist that catches real homepages is worse than none — it would silently drop good answers.
  for (const ok of [
    "Stripe | Financial Infrastructure to Grow Your Revenue",
    "Ivanti | Everywhere Work, Powered by Ivanti",
    "Spreetail | Ecommerce Accelerator, End-to-end Ecommerce Services.",
    "Notion – The all-in-one workspace",
  ]) assert.equal(looksParked(ok), false, ok);
  for (const parked of [
    "Buy nightfall.in – Premium Domain Name for Your Brand | DaaZ",
    "nightfall.io - nightfall Resources and Information.",
    "This domain is for sale",
    "acme.com is coming soon",
  ]) assert.equal(looksParked(parked), true, parked);
});
