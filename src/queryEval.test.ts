// Per-job evaluation of the advanced-filter tree (tracker-time matching), and parity with the SQL
// compiler on a shared fixture so the "filter a stored job" and "match a live job" paths agree.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalQueryTreeJob } from "./queryEval.ts";
import { db, upsertJob, dbAdminJobs, compileQueryTree } from "./db.ts";
import type { QueryGroup, RawJob } from "./types.ts";

function job(over: Partial<RawJob> = {}): RawJob {
  return {
    id: over.id ?? "j-" + Math.random().toString(36).slice(2),
    source: "hcorg", externalId: over.externalId ?? "x1", title: over.title ?? "Account Executive",
    company: over.company ?? "Acme", location: over.location ?? "New York, NY", state: over.state ?? "NY",
    remote: over.remote ?? false, url: over.url ?? "https://acme.example/j1", postedAt: over.postedAt ?? new Date().toISOString(),
    domain: over.domain ?? "acme.example", raw: over.raw ?? { seniority: "Senior Level", comp_min: 120000 },
    description: over.description ?? "Sell our Salesforce-based platform to SMBs.",
    ...over,
  };
}

test("empty / absent tree matches everything", () => {
  assert.ok(evalQueryTreeJob(undefined, job()));
  assert.ok(evalQueryTreeJob({ combinator: "AND", children: [] }, job()));
});

test("AND of title + description conditions", () => {
  const tree: QueryGroup = { combinator: "AND", children: [
    { field: "title", op: "contains", value: "executive" },
    { field: "description", op: "contains", value: "salesforce" },
  ] };
  assert.ok(evalQueryTreeJob(tree, job()));
  assert.ok(!evalQueryTreeJob(tree, job({ description: "No CRM here." })));
});

test("OR combinator", () => {
  const tree: QueryGroup = { combinator: "OR", children: [
    { field: "title", op: "contains", value: "engineer" },
    { field: "seniority", op: "anyof", value: ["Senior Level"] },
  ] };
  assert.ok(evalQueryTreeJob(tree, job()));                                   // matches on seniority
  assert.ok(!evalQueryTreeJob(tree, job({ raw: { seniority: "Entry Level" } })));
});

test("contains any of / does not contain any of (multi-value)", () => {
  const anyOf: QueryGroup = { combinator: "AND", children: [{ field: "title", op: "containsany", value: ["manager", "executive", "lead"] }] };
  assert.ok(evalQueryTreeJob(anyOf, job({ title: "Account Executive" })));   // matches "executive"
  assert.ok(!evalQueryTreeJob(anyOf, job({ title: "Software Engineer" })));   // none present
  const noneOf: QueryGroup = { combinator: "AND", children: [{ field: "description", op: "ncontainsany", value: ["senior", "principal"] }] };
  assert.ok(evalQueryTreeJob(noneOf, job({ description: "Entry level role." })));
  assert.ok(!evalQueryTreeJob(noneOf, job({ description: "Senior architect." })));
});

test("whole-word (exact) text operator", () => {
  const tree: QueryGroup = { combinator: "AND", children: [{ field: "title", op: "word", value: "account" }] };
  assert.ok(evalQueryTreeJob(tree, job({ title: "Account Executive" })));
  assert.ok(!evalQueryTreeJob(tree, job({ title: "Accountant" })));
});

test("stored-only fields (monitor/starred) never reject at match time", () => {
  const tree: QueryGroup = { combinator: "AND", children: [{ field: "monitor", op: "anyof", value: ["whatever"] }] };
  assert.ok(evalQueryTreeJob(tree, job()));
});

test("parity with the SQL compiler on a stored job", () => {
  // The DB's `description` column is composed by upsertJob from raw.description, so the body must live
  // in raw for the SQL path to see it — put it there and on the field so both paths read the same text.
  const body = "Salesforce and HubSpot admin.";
  const j = job({ id: "parity-1", title: "Senior Account Executive", description: body,
    raw: { seniority: "Senior Level", comp_min: 120000, description: body } });
  upsertJob(j);
  const tree: QueryGroup = { combinator: "AND", children: [
    { field: "title", op: "contains", value: "account" },
    { field: "description", op: "contains", value: "hubspot" },
  ] };
  // SQL path: the row is returned by the Jobs database when the tree matches.
  const rows = dbAdminJobs({ query: tree, limit: 200 }) as Array<{ id: string }>;
  const sqlMatched = rows.some((r) => r.id === "parity-1");
  // Per-job path:
  const jobMatched = evalQueryTreeJob(tree, j);
  assert.equal(jobMatched, true);
  assert.equal(sqlMatched, jobMatched);
  db.exec("DELETE FROM raw_jobs WHERE id = 'parity-1'");
});
