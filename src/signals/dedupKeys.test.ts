// Dedup-key shape invariant, checked across EVERY producer's source.
//
// WHY THIS IS A SOURCE-LEVEL TEST AND NOT A BEHAVIOURAL ONE. The bug it guards is not "this producer
// is wrong" — it is "this producer was fixed and its four siblings were not". atsSwitch.ts found the
// trap first and documented it precisely: keyed on the destination alone, a company going
// Lever -> Ashby -> Lever never fires the second move, because dbInsertSignal is
// ON CONFLICT(dedup_key) DO NOTHING and signals are never purged. That fix stayed in one file.
// tech-added, dns-tool-added and app-published kept the un-scoped shape for months, each one silently
// unable to ever report a re-adoption — while their tech-removed / dns-tool-removed / app-stale
// counterparts, written by the same hand in the same files, all carried a month. Only a check that
// looks at every producer at once catches that; a per-producer test would have passed on the one
// producer someone happened to write a test for.
//
// A re-adoption ("they dropped Outreach, now they're back on it") is one of the most valuable events
// this app can report, and it was structurally impossible to emit.
//
// Run: npx tsx --test src/signals/dedupKeys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

// Is this key template scoped to a point in time, so the same real-world event recurring later is a
// DIFFERENT key? Three shapes count, and all three are in use — the first version of this test only
// recognised the inline slice and duly accused four correct keys (ads-started, ads-stopped,
// dns-mx-changed, velocity-spike) that hoist the same value into a `month`/`day` const first.
//   1. an inline `.slice(0, 7)` / `.slice(0, 10)` off an ISO string
//   2. a hoisted `${month}` / `${day}` const holding the same thing
//   3. ats-switched's `from->to`, which encodes the transition itself and is time-scoped in effect:
//      re-observing the SAME transition is correctly suppressed, a later different one is not.
const isTimeScoped = (template: string): boolean =>
  /slice\(0,\s*(7|10)\)/.test(template) || /\$\{(month|day)\}/.test(template) || /->/.test(template);

/** Every `dedupKey: \`...\`` template literal in the producers, with its file and line. */
function dedupKeyTemplates(): Array<{ file: string; line: number; template: string }> {
  const out: Array<{ file: string; line: number; template: string }> = [];
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const lines = readFileSync(join(DIR, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      const m = /dedupKey:\s*`([^`]+)`/.exec(text);
      if (m) out.push({ file, line: i + 1, template: m[1]! });
    });
  }
  return out;
}

// Deliberately NOT time-scoped, each for a reason that must be stated to stay on this list.
const EXEMPT: Record<string, string> = {
  "velocity-location":
    "Its key is the ONLY suppressor — unlike the others it is not gated by a stored state diff, and it "
    + "re-fires on every scan for the 30 days after a location's first-ever appearance. Adding a month "
    + "would emit a DUPLICATE at any month boundary inside that window. Its semantics are 'first ever "
    + "seen in our record', so a genuine later reappearance is out of scope by design.",
  "subdomain-new":
    "A subdomain appearing in certificate transparency is a once-ever fact; CT logs are append-only, so "
    + "the same name cannot legitimately become 'new' a second time.",
  "velocity-repost":
    "Keyed on the normalized title: 'this role is being reposted' is a standing condition, not a dated "
    + "event, and re-emitting it every scan would be noise.",
};

test("every state-diff 'appeared' signal is time-scoped, so a re-adoption can fire again", () => {
  // The pairs that matter: something appearing on a company's estate. Each has a '-removed'/'-stale'
  // sibling that already carries a month; the point is that the two halves must agree.
  const APPEARED = /^(tech-added|dns-tool-added|app-published|ats-switched):/;
  const offenders = dedupKeyTemplates()
    .filter((t) => APPEARED.test(t.template))
    .filter((t) => !isTimeScoped(t.template))
    .map((t) => `${t.file}:${t.line}  ${t.template}`);

  assert.deepEqual(offenders, [],
    "These keys can only ever fire ONCE per (domain, thing), forever — dedup is permanent and signals "
    + "are never purged. A company that drops a tool and re-adopts it would be silent. Add a "
    + "`${new Date().toISOString().slice(0, 7)}` month suffix, as the matching '-removed' key already "
    + "has, or bake in the origin the way ats-switched does.");
});

test("every 'removed'/'stale' signal stays time-scoped too", () => {
  // The other half of the pair. These fire from a state diff that can recur, so without a date they
  // would report a churn event once and never again.
  const GONE = /^(tech-removed|dns-tool-removed|app-stale|ads-started|ads-stopped):/;
  const offenders = dedupKeyTemplates()
    .filter((t) => GONE.test(t.template))
    .filter((t) => !isTimeScoped(t.template))
    .map((t) => `${t.file}:${t.line}  ${t.template}`);
  assert.deepEqual(offenders, [], "a recurring churn event must not be keyed so it can fire only once");
});

test("anything exempt from time-scoping is on the list with a written reason", () => {
  // Stops the exemption from being the silent default: a new un-scoped key has to be argued for here.
  const unexplained = dedupKeyTemplates()
    .filter((t) => !isTimeScoped(t.template))
    // Keys built from a stable external id (an accession, a filing id, a URL hash) are inherently
    // unique per real-world event and need no date.
    .filter((t) => !/\$\{(hash|f\.accession|h\.id|f\.transaction_id|dedupKey)/.test(t.template))
    .map((t) => t.template.split(":")[0]!)
    .filter((prefix) => !prefix.startsWith("${") && !(prefix in EXEMPT));

  assert.deepEqual([...new Set(unexplained)], [],
    "a dedup key with no date and no unique external id can fire only once, ever — either time-scope "
    + "it or add it to EXEMPT with the reason");
});
