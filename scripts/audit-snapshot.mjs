// Make an isolated copy of the production database for the UI audit to run against.
//
// The source is opened READ-ONLY, by construction — not by convention. data/signals.db is 1.1GB of
// the user's real data and the audit instance will be clicked through by an agent pressing every
// destructive control it can find; nothing in that loop may be able to reach the real file.
//
// VACUUM INTO (not a file copy) because:
//   • it is transactionally consistent even if another process is writing, whereas copying the .db
//     without its -wal is a torn snapshot and copying all three under a live writer is racy;
//   • it rebuilds the file without the freelist, so the copy is much smaller and the audit instance
//     is faster than production.
import { DatabaseSync } from "node:sqlite";
import { rmSync, existsSync, statSync } from "node:fs";

const SRC = "data/signals.db";
const OUT = "data/audit.db";

if (!existsSync(SRC)) { console.error(`missing ${SRC}`); process.exit(1); }
const before = statSync(SRC);

for (const f of [OUT, `${OUT}-wal`, `${OUT}-shm`]) if (existsSync(f)) rmSync(f, { force: true });

const src = new DatabaseSync(SRC, { readOnly: true }); // the guarantee
src.exec(`VACUUM INTO '${OUT}'`);
src.close();

const after = statSync(SRC);
const untouched = before.size === after.size && before.mtimeMs === after.mtimeMs;
const mb = (n) => (n / 1e6).toFixed(0);

console.log(`source  ${SRC}  ${mb(before.size)} MB  ${untouched ? "UNCHANGED ✓" : "*** MODIFIED ***"}`);
console.log(`copy    ${OUT}  ${mb(statSync(OUT).size)} MB`);
if (!untouched) { console.error("the source database changed — stop and investigate"); process.exit(1); }
