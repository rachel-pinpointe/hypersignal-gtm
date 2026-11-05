// Boot the app for the UI audit against the ISOLATED copy, on its own port.
//
// Every one of these three env vars is load-bearing. SIGNAL_DB keeps writes off the real 1.1GB
// database. CLIENTS_DIR keeps the client editor's save / rename / DELETE paths off the user's real
// watchlist YAML — src/config.ts guards that path with nothing, so an audit clicking "Delete client"
// on a default-env instance would destroy clients/Docxster.yaml. PORT keeps this off :4000, which is
// production and is off-limits for the whole sweep.
//
// Run: npx tsx scripts/start-audit.mjs   (prepare the copy first — see scripts/audit-snapshot.mjs)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));

for (const [path, how] of [
  ["data/audit.db", "node scripts/audit-snapshot.mjs && node scripts/audit-defang.mjs"],
  ["clients-audit", "cp -r clients/ clients-audit/ && node scripts/audit-defang.mjs"],
]) if (!existsSync(path)) { console.error(`missing ${path} — run:  ${how}`); process.exit(1); }

process.env.SIGNAL_DB = "data/audit.db";
process.env.CLIENTS_DIR = "clients-audit";
process.env.PORT = "4056";

console.log("[audit] db=data/audit.db  clients=clients-audit/  port=4056  (production :4000 is off-limits)");
await import("../src/index.ts");
