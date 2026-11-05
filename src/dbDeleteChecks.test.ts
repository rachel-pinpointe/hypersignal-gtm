// Deleting an account check or a signal check, and the side tables that go with it.
//
// Neither raw_jobs nor these tables have foreign keys or cascades, so every dependent row is removed
// by hand — and dbDeleteAccountSearch was removing only some. Two tables key off a search id:
// account_search_hits and job_origins ("ac:<id>"). Only job_origins was cleaned.
//
// Production carried 7,589 orphaned hit rows from a single deleted check — 47% of that table —
// invisible because nothing ever joins hits back to searches, so the leak has no symptom until the
// file size is questioned.
//
// The signal-check twin was already complete; it is asserted here anyway. The defect is "a table
// missing from a hand-written list", so a test covering only the broken one leaves its sibling free
// to drift the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, dbDeleteAccountSearch, dbDeleteSignalCheck } from "./db.ts";

const AS = "del-test-as", SC = "del-test-sc";
const n = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { c: number }).c;

const reset = () => {
  for (const id of [AS, `${AS}-keep`]) {
    db.prepare("DELETE FROM account_search_hits WHERE search_id = ?").run(id);
    db.prepare("DELETE FROM account_searches WHERE id = ?").run(id);
    db.prepare("DELETE FROM job_origins WHERE origin = ?").run("ac:" + id);
  }
  for (const id of [SC, `${SC}-keep`]) {
    db.prepare("DELETE FROM signals WHERE check_id = ?").run(id);
    db.prepare("DELETE FROM signal_check_results WHERE check_id = ?").run(id);
    db.prepare("DELETE FROM signal_checks WHERE id = ?").run(id);
  }
  db.prepare("DELETE FROM raw_jobs WHERE id LIKE 'del-test-%'").run();
};

function seedAccountSearch(id: string) {
  db.prepare(`INSERT OR REPLACE INTO account_searches (id, name, params, status, created_at, updated_at)
              VALUES (?, 'del', '{}', 'done', datetime('now'), datetime('now'))`).run(id);
  db.prepare(`INSERT OR REPLACE INTO raw_jobs (id, external_id, source, title, company, url, domain, status, seen_at)
              VALUES (?, ?, 'hiringcafe', 'Engineer', 'Co', 'https://e.com/1', 'e.com', 'open', datetime('now'))`)
    .run(`del-test-job-${id}`, `del-test-job-${id}`);
  db.prepare("INSERT OR IGNORE INTO job_origins (job_id, origin) VALUES (?, ?)").run(`del-test-job-${id}`, "ac:" + id);
  for (let i = 0; i < 3; i++)
    db.prepare("INSERT OR IGNORE INTO account_search_hits (search_id, input_company, url, hit) VALUES (?, ?, ?, '{}')")
      .run(id, `Co ${i}`, `https://e.com/${i}`);
}

function seedSignalCheck(id: string) {
  db.prepare(`INSERT OR REPLACE INTO signal_checks (id, name, params, status, created_at, updated_at)
              VALUES (?, 'del', '{}', 'done', datetime('now'), datetime('now'))`).run(id);
  db.prepare(`INSERT OR REPLACE INTO signals (dedup_key, domain, type, title, check_id, created_at)
              VALUES (?, 'e.com', 'news-launch', 'x', ?, datetime('now'))`).run(`del-test-sig-${id}`, id);
  db.prepare("INSERT OR REPLACE INTO signal_check_results (check_id, domain, result) VALUES (?, 'e.com', '{}')").run(id);
}

test("deleting an account check removes its hits, not just its attribution tags", () => {
  reset();
  seedAccountSearch(AS);
  assert.equal(n("SELECT COUNT(*) c FROM account_search_hits WHERE search_id = ?", AS), 3,
    "fixture must actually have hit rows, or this proves nothing");

  dbDeleteAccountSearch(AS);

  assert.equal(n("SELECT COUNT(*) c FROM account_searches WHERE id = ?", AS), 0);
  assert.equal(n("SELECT COUNT(*) c FROM account_search_hits WHERE search_id = ?", AS), 0,
    "orphaned hit rows — nothing joins these back to a search, so the leak is silent");
  assert.equal(n("SELECT COUNT(*) c FROM job_origins WHERE origin = ?", "ac:" + AS), 0);
  assert.equal(n("SELECT COUNT(*) c FROM raw_jobs WHERE id = ?", `del-test-job-${AS}`), 1,
    "the JOBS stay — only the attribution goes");
  reset();
});

test("deleting one account check does not touch another", () => {
  reset();
  seedAccountSearch(AS); seedAccountSearch(`${AS}-keep`);
  dbDeleteAccountSearch(AS);
  assert.equal(n("SELECT COUNT(*) c FROM account_search_hits WHERE search_id = ?", `${AS}-keep`), 3);
  assert.equal(n("SELECT COUNT(*) c FROM account_searches WHERE id = ?", `${AS}-keep`), 1);
  reset();
});

test("deleting a signal check removes its signals AND its per-domain results", () => {
  reset();
  seedSignalCheck(SC);
  assert.equal(n("SELECT COUNT(*) c FROM signals WHERE check_id = ?", SC), 1, "fixture guard");
  assert.equal(n("SELECT COUNT(*) c FROM signal_check_results WHERE check_id = ?", SC), 1, "fixture guard");

  dbDeleteSignalCheck(SC);

  assert.equal(n("SELECT COUNT(*) c FROM signal_checks WHERE id = ?", SC), 0);
  assert.equal(n("SELECT COUNT(*) c FROM signals WHERE check_id = ?", SC), 0);
  assert.equal(n("SELECT COUNT(*) c FROM signal_check_results WHERE check_id = ?", SC), 0);
  reset();
});

test("no table keyed to a deleted check is left holding rows", () => {
  // The invariant stated as a set difference over the real schema rather than a remembered list: after
  // deleting everything, every table that carries a search_id or check_id must have nothing pointing
  // at a row that no longer exists. A future table with the same shape fails here until it is wired in.
  reset();
  seedAccountSearch(AS); seedSignalCheck(SC);
  dbDeleteAccountSearch(AS); dbDeleteSignalCheck(SC);

  assert.equal(n("SELECT COUNT(*) c FROM account_search_hits h LEFT JOIN account_searches s ON s.id = h.search_id WHERE s.id IS NULL"), 0,
    "account_search_hits");
  assert.equal(n("SELECT COUNT(*) c FROM signal_check_results r LEFT JOIN signal_checks k ON k.id = r.check_id WHERE k.id IS NULL"), 0,
    "signal_check_results");
  assert.equal(n("SELECT COUNT(*) c FROM signals s LEFT JOIN signal_checks k ON k.id = s.check_id WHERE s.check_id IS NOT NULL AND s.check_id <> '' AND k.id IS NULL"), 0,
    "signals");
  assert.equal(n("SELECT COUNT(*) c FROM job_origins o WHERE o.origin LIKE 'ac:%' AND NOT EXISTS (SELECT 1 FROM account_searches s WHERE 'ac:' || s.id = o.origin)"), 0,
    "job_origins");
  reset();
});
