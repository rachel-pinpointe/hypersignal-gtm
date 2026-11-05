// migrateIfLegacy (via validateClient) — the legacy-config rewrite must not silently change WHAT a
// client is. It runs on every load, so anything it drops is dropped constantly and quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateClient, loadClients, seedFromYaml } from "./config.ts";
import { db } from "./db.ts";

// `search.remote` is one of the legacy markers, so this object takes the migration path.
const legacyWatchlist = {
  name: "acme watch",
  kind: "watchlist",
  search: { keywords: ["driver"], remote: "onsite", orgDomains: ["ups.com", "fedex.com"] },
  signals: ["velocity", "news"],
  signal_webhooks: { funding: "https://example.com/funding" },
  schedule: { mode: "interval", every: 6, unit: "hour" },
};

test("a legacy WATCHLIST stays a watchlist through migration", () => {
  // The failure this guards is not a crash. A watchlist gives every company a domain-scoped /org/
  // scan; a search fires a market-wide query per keyword. Dropping `kind` turns the first into the
  // second under the same name — it stops monitoring the accounts and starts crawling the whole job
  // market, silently.
  const c = validateClient(legacyWatchlist) as any;
  assert.equal(c.kind, "watchlist");
  assert.deepEqual(c.search.orgDomains, ["ups.com", "fedex.com"]);
});

test("a legacy config keeps its signals, signal_webhooks and schedule", () => {
  const c = validateClient(legacyWatchlist) as any;
  assert.deepEqual(c.signals, ["velocity", "news"]);
  assert.deepEqual(c.signal_webhooks, { funding: "https://example.com/funding" });
  assert.deepEqual(c.schedule, { mode: "interval", every: 6, unit: "hour" });
});

test("the migration still does its actual job", () => {
  const c = validateClient(legacyWatchlist) as any;
  assert.deepEqual(c.search.workplaceTypes, ["Onsite"], "remote:onsite maps to a workplace type");
  assert.equal("remote" in c.search, false, "the legacy key itself is gone");
});

test("a modern config passes through untouched", () => {
  const modern = {
    name: "acme search", kind: "search",
    search: { keywords: ["sdr"], workplaceTypes: ["Remote"] },
    signals: ["velocity"],
  };
  const c = validateClient(modern) as any;
  assert.equal(c.kind, "search");
  assert.deepEqual(c.signals, ["velocity"]);
  assert.deepEqual(c.search.workplaceTypes, ["Remote"]);
});

test("a watchlist with no domains to monitor is still rejected", () => {
  // The migration must not accidentally satisfy this by dropping `kind`.
  assert.throws(() => validateClient({ name: "empty watch", kind: "watchlist", search: { keywords: [], remote: "onsite" } }),
    /at least one domain/);
});

// ---------------------------------------------------------------------------------------------
// One unreadable client config must not take down every other client.
//
// loadClients() mapped straight over the rows, so a single unparseable config threw out of the
// whole function. Every caller is boot or reload, which made the blast radius total: the app would
// not start, and no client fetched, matched or delivered anything, because of one row.
// ---------------------------------------------------------------------------------------------

test("a corrupt client config is skipped, and the healthy ones still load", () => {
  const good = JSON.stringify({ name: "good-one", kind: "search", active: true, search: { keywords: ["driver"] } });
  db.prepare("INSERT OR REPLACE INTO clients (name, config) VALUES (?, ?)").run("good-one", good);
  db.prepare("INSERT OR REPLACE INTO clients (name, config) VALUES (?, ?)").run("broken-one", "{not json");

  const loaded = loadClients();
  const names = loaded.map((c) => c.name);
  assert.ok(names.includes("good-one"), `the healthy client must survive; got ${JSON.stringify(names)}`);
  assert.ok(!names.includes("broken-one"), "the unreadable one is skipped, not half-loaded");

  db.prepare("DELETE FROM clients WHERE name IN ('good-one','broken-one')").run();
});

test("a config that is valid JSON but the wrong shape is also survivable", () => {
  // migrateIfLegacy can throw on a shape it does not recognise; that is the same failure with a
  // different cause, and it must be contained the same way.
  db.prepare("INSERT OR REPLACE INTO clients (name, config) VALUES (?, ?)").run("weird-one", "12345");
  assert.doesNotThrow(() => loadClients());
  db.prepare("DELETE FROM clients WHERE name = 'weird-one'").run();
});


// ---------------------------------------------------------------------------------------------
// seedFromYaml() refreshing an already-seeded client's domain list.
//
// Found live 2026-09-18: this function used to skip a client entirely once it existed in the DB,
// so sync_watchlist.py's daily Fibery -> YAML rewrite of orgDomains never reached the DB-stored
// config loadClients() actually reads at scan time. The real watchlist had been frozen at its
// original 20-domain seed since inception -- almost the whole company universe added since (the
// ~1,535-company Paradigm import) was never actually signal-scanned. This must never regress.
// ---------------------------------------------------------------------------------------------

function withTempClientsDir(files: Record<string, string>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hs-clients-test-"));
  const prevDir = process.env.CLIENTS_DIR;
  process.env.CLIENTS_DIR = dir;
  try {
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
    fn();
  } finally {
    process.env.CLIENTS_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("seedFromYaml refreshes an existing client's domain list from the file", () => {
  db.prepare("INSERT OR REPLACE INTO clients (name, config) VALUES (?, ?)").run(
    "refresh-test",
    JSON.stringify({ name: "refresh-test", kind: "watchlist", active: true, signals: ["velocity", "news"], search: { orgDomains: ["old1.com", "old2.com"] } }),
  );
  withTempClientsDir({
    "refresh-test.yaml": "name: refresh-test\nkind: watchlist\nsearch:\n  orgDomains:\n    - new1.com\n    - new2.com\n    - new3.com\n",
  }, () => {
    seedFromYaml();
  });
  const [row] = loadClients().filter((c) => c.name === "refresh-test");
  assert.deepEqual(row!.search?.orgDomains, ["new1.com", "new2.com", "new3.com"], "domains refreshed from the file");
  assert.deepEqual(row!.signals, ["velocity", "news"], "non-domain fields (a live dashboard edit) survive the refresh untouched");
  db.prepare("DELETE FROM clients WHERE name = 'refresh-test'").run();
});

test("seedFromYaml does not blank out a live watchlist when the file's domain list is empty", () => {
  db.prepare("INSERT OR REPLACE INTO clients (name, config) VALUES (?, ?)").run(
    "no-wipe-test",
    JSON.stringify({ name: "no-wipe-test", kind: "watchlist", active: true, search: { orgDomains: ["keep-me.com"] } }),
  );
  withTempClientsDir({
    "no-wipe-test.yaml": "name: no-wipe-test\nkind: watchlist\nsearch:\n  orgDomains: []\n",
  }, () => {
    seedFromYaml();
  });
  const [row] = loadClients().filter((c) => c.name === "no-wipe-test");
  assert.deepEqual(row!.search?.orgDomains, ["keep-me.com"], "an empty/unreadable file must never wipe a live watchlist");
  db.prepare("DELETE FROM clients WHERE name = 'no-wipe-test'").run();
});

test("seedFromYaml still does a full seed for a client not yet in the DB", () => {
  withTempClientsDir({
    "brand-new-test.yaml": "name: brand-new-test\nkind: watchlist\nsearch:\n  orgDomains:\n    - fresh.com\n",
  }, () => {
    seedFromYaml();
  });
  const [row] = loadClients().filter((c) => c.name === "brand-new-test");
  assert.ok(row, "a never-seen client is still seeded from scratch");
  assert.deepEqual(row!.search?.orgDomains, ["fresh.com"]);
  db.prepare("DELETE FROM clients WHERE name = 'brand-new-test'").run();
});
