// Load .env before ANY other module runs, because most of them read process.env at import time
// (db.ts picks its file, server.ts its port, accountCheck.ts its concurrency). ESM evaluates
// imports in source order, so index.ts imports this module first and nothing else sees a
// half-populated environment.
//
// This exists because README.md and .env.example both told people to copy .env.example to .env and
// uncomment what they wanted — and nothing read the file, so every override was silently ignored.
// Making the documented behaviour real beats deleting the instruction.
//
// Hand-parsed rather than process.loadEnvFile(), for one behavioural reason: loadEnvFile
// OVERWRITES existing variables, which would make a stale .env silently beat an explicit
// `HOST=0.0.0.0 npm start`. Here the shell always wins — a key already present in the environment
// is left alone. No dependency either way; the format supported is KEY=value, # comments, blank
// lines, and optional surrounding quotes.
import { existsSync, readFileSync } from "node:fs";

const FILE = ".env";
if (existsSync(FILE)) {
  let loaded = 0;
  try {
    for (const raw of readFileSync(FILE, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue;   // an explicit shell value wins over the file
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
      loaded++;
    }
    if (loaded) console.log(`[env] loaded ${loaded} setting${loaded === 1 ? "" : "s"} from .env`);
  } catch (e) {
    console.warn(`[env] could not read .env — ignoring it: ${(e as Error).message}`);
  }
}
