// Neuter the audit copy before it is ever booted.
//
// The snapshot carries the user's real client configs, and those configs are LIVE: schedules that
// fire real scrapes against hiring.cafe, and delivery settings that POST to real webhook endpoints.
// Booting a second instance of them means the audit quietly doubles the user's outbound traffic and
// can deliver duplicate results to whatever consumes those hooks. Blank both, in the DB and in the
// YAML fixture dir, before first boot.
//
// Writes ONLY to data/audit.db and clients-audit/. Never to data/signals.db or clients/.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const DB = "data/audit.db";
const DIR = "clients-audit";

// 30 February — node-cron rejects it, and for `schedule.mode === "cron"` that means scheduler.ts:36
// arms NO timer at all ("invalid cron … — skipped"). That is exactly what the audit wants: the
// client still looks normal in the UI, but nothing can ever fire.
//
// Do NOT defang by blanking the schedule instead. It is a trap that does the opposite: config.ts:111
// re-applies `?? "0 * * * *"` when refreshCron is absent, and scheduler.ts:30 falls back to that same
// hourly default when the legacy cron fails validation — so an empty string arms an HOURLY scrape.
// (The two branches disagreeing about what an invalid cron means is itself a defect — see LEDGER
// f0001. Keep this pinned to the `schedule.mode === "cron"` branch, which fails closed.)
const NEVER = "0 0 30 2 *";

function defang(cfg) {
  cfg.delivery = { ...(cfg.delivery ?? {}), webhook_url: "", mode: "manual" };
  cfg.refreshCron = NEVER;
  cfg.schedule = { mode: "cron", expr: NEVER };
  cfg.signalWebhooks = undefined;
  cfg.sigRoutes = undefined;
  return cfg;
}

const db = new DatabaseSync(DB);
const upd = db.prepare("UPDATE clients SET config = ? WHERE name = ?");
for (const r of db.prepare("SELECT name, config FROM clients").all()) {
  upd.run(JSON.stringify(defang(JSON.parse(r.config))), r.name);
  console.log(`db   defanged ${r.name}`);
}
db.close();

if (existsSync(DIR)) {
  for (const f of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const p = join(DIR, f);
    writeFileSync(p, yaml.dump(defang(yaml.load(readFileSync(p, "utf8")) ?? {}), { lineWidth: 100 }));
    console.log(`yaml defanged ${f}`);
  }
}
