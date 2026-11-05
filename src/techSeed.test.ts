// Technology import — the merge path has to be able to CHANGE something.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { db } from "./db.ts";
import { importTechnologies, parseImport, parseTheirStackCsv } from "./techSeed.ts";

const read = (canonical: string) =>
  db.prepare("SELECT name, category, aliases, companies_count FROM technologies WHERE canonical = ?").get(canonical) as
    { name: string; category: string | null; aliases: string | null; companies_count: number } | undefined;

test("a merge import can ADD aliases to an existing technology", () => {
  // Aliases were missing from the ON CONFLICT update list, so this reported success and did nothing.
  // They are the point of re-importing: a distinctive alias is what lets "spring framework" resolve
  // to Spring, and the detector treats such an alias as unambiguous where the bare name is not.
  importTechnologies([{ name: "Zeta", category: "db", companies: 10 }], "merge");
  assert.equal(read("zeta")?.aliases, null);
  importTechnologies([{ name: "Zeta", aliases: ["Zeta DB", "ZetaSQL"] }], "merge");
  assert.deepEqual(JSON.parse(read("zeta")!.aliases!), ["Zeta DB", "ZetaSQL"]);
});

test("a merge import that omits aliases does not erase the ones already stored", () => {
  importTechnologies([{ name: "Zeta", category: "database" }], "merge");
  assert.deepEqual(JSON.parse(read("zeta")!.aliases!), ["Zeta DB", "ZetaSQL"], "kept");
  assert.equal(read("zeta")?.category, "database", "category still updates");
});

test("counts only ever rise, so a partial list cannot zero a popularity it never mentions", () => {
  assert.equal(read("zeta")?.companies_count, 10);
  importTechnologies([{ name: "Zeta", companies: 0 }], "merge");
  assert.equal(read("zeta")?.companies_count, 10);
  importTechnologies([{ name: "Zeta", companies: 99 }], "merge");
  assert.equal(read("zeta")?.companies_count, 99);
});

test("the TheirStack CSV reader handles quoted commas and k/M counts", () => {
  const rows = parseTheirStackCsv('Technology,Category,Companies,Jobs\n"Acme, Inc. Tools",Build,"1,234",6.2M\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "Acme, Inc. Tools");
  assert.equal(rows[0]!.companies, 1234);
  assert.equal(rows[0]!.jobs, 6_200_000);
});

test("the simple list format parses name, category and pipe-separated aliases", () => {
  const rows = parseImport("Redis,cache,KeyDB|Valkey\nNginx,server\n");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.aliases, ["KeyDB", "Valkey"]);
  assert.equal(rows[1]!.category, "server");
});

// The dictionary has to SHIP. `data/` is gitignored, and for the whole of alpha 1 the only seed list
// lived at `data/theirstack-technologies.csv` — a path that existed on exactly one machine. Every
// clone therefore booted with zero technologies, the Technologies screen rendered an empty list, and
// the filter's typeahead searched an empty table and found nothing. It was reported as "entering a
// technology isn't working", which is what an unpopulated dictionary looks like from the outside.
//
// These two assert the files are present AND parse. Re-ignoring, renaming or truncating either one
// fails here instead of shipping a dead feature again.
test("the technology dictionary ships with the repo and parses", () => {
  const csv = "data/technologies.csv";
  assert.ok(existsSync(csv), `${csv} is missing — a fresh clone would boot with an empty dictionary`);
  const rows = parseTheirStackCsv(readFileSync(csv, "utf8"));
  assert.ok(rows.length > 20000, `expected >20000 seed technologies, parsed ${rows.length}`);
  // Adoption counts are what rank the leaderboard; a name-only list would sort arbitrarily.
  assert.ok(rows.some((r) => (r.companies ?? 0) > 0), "no adoption counts parsed from the seed CSV");
});

test("the webappanalyzer list ships with the repo and parses", () => {
  const f = "data/webappanalyzer.json";
  assert.ok(existsSync(f), `${f} is missing — the seeded dictionary would be short by ~7500 names`);
  const rows = JSON.parse(readFileSync(f, "utf8")) as Array<{ name?: unknown }>;
  assert.ok(Array.isArray(rows) && rows.length > 5000, `expected >5000 rows, got ${Array.isArray(rows) ? rows.length : "not an array"}`);
  assert.ok(rows.every((r) => typeof r?.name === "string" && r.name.trim()), "a row has no usable name");
});
