// One-shot CLI for verification: `npm run cycle` runs a full ingest cycle once and exits.
import "./env.ts";   // MUST be first: only src/index.ts imported this, so `npm run cycle` — documented
                     // twelve lines below the "copy .env.example to .env" instruction — silently
                     // ignored every override in that file.
import { loadClients, seedFromYaml } from "./config.ts";
import { runAllOnce, backfillMatches } from "./ingest.ts";

const cmd = process.argv[2] ?? "cycle";

if (cmd === "cycle") {
  seedFromYaml();
  const clients = loadClients();
  if (!clients.length) { console.error("No valid clients in clients/*.yaml"); process.exit(1); }
  console.log(`Loaded ${clients.length} client(s): ${clients.map((c) => c.name).join(", ")}\n`);
  backfillMatches(clients);
  const stats = await runAllOnce(clients);
  const totals = stats.reduce((a, s) => ({ fetched: a.fetched + s.fetched, fresh: a.fresh + s.fresh, matched: a.matched + s.matched }), { fetched: 0, fresh: 0, matched: 0 });
  const errs = stats.filter((s) => s.error && s.error !== "disabled");
  console.log(`\n=== CYCLE DONE === fetched=${totals.fetched} new=${totals.fresh} matched=${totals.matched}`);
  if (errs.length) console.log(`errors: ${errs.map((e) => `${e.type}@${e.owner}(${e.error})`).join(", ")}`);
  process.exit(0);
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
