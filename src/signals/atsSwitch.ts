// ATS detection + switch signal — nearly free: the app ALREADY probes every watched domain for
// Greenhouse/Lever/Ashby boards (src/sources/ats.ts, cached in ats_boards). This producer surfaces
// the current vendor(s) as facts and turns a vendor-set CHANGE into an ats-switched signal —
// a company moving ATS (e.g. Lever → Ashby) is re-tooling its hiring stack (growth / new budget).
import { discoverAndCacheAts } from "../sources/ats.ts";
import { dbGetDomainState, dbReplaceDomainState } from "../db.ts";
import type { SignalProducer, SignalDraft, ProducerResult } from "./types.ts";

export const atsSwitchProducer: SignalProducer = {
  key: "ats",
  label: "ATS in use",
  description: "Which applicant-tracking system (Greenhouse/Lever/Ashby) the company runs — and an alert when it switches.",
  flagged: true,
  async check(domain, ctx): Promise<ProducerResult> {
    if (ctx.stop?.()) return { facts: {}, signals: [] };
    const boards = await discoverAndCacheAts(domain); // cached probe (positive 24h / negative 7d TTL)
    const state: Record<string, string> = {};
    for (const b of boards) state[b.vendor] = b.slug;
    const facts: Record<string, string> = {
      "ATS": boards.length ? boards.map((b) => `${b.vendor} (${b.slug})`).join(", ") : "none detected",
    };
    const prior = dbGetDomainState(domain, "ats");
    const priorVendors = [...prior.keys()].filter((k) => k !== "none");
    const haveNow = Object.keys(state).length > 0;
    const signals: SignalDraft[] = [];
    if (prior.size > 0) { // baseline exists → diff the vendor set ("none" sentinel = a probed empty state)
      const before = priorVendors.sort().join(",");
      const after = Object.keys(state).sort().join(",");
      // Only a change TO a detected vendor set signals (real switch or adoption). A drop to "none" is
      // NOT signalled: an empty board (hiring freeze), a wrong-slug miss, and a transient outage are
      // indistinguishable, so "vendor → none" would fabricate a switch from a benign state.
      if (before !== after && after) {
        // Source link: the NEW vendor's public job board (proof the switch is live).
        const BOARD_URL: Record<string, (slug: string) => string> = {
          greenhouse: (s) => `https://boards.greenhouse.io/${encodeURIComponent(s)}`,
          lever: (s) => `https://jobs.lever.co/${encodeURIComponent(s)}`,
          ashby: (s) => `https://jobs.ashbyhq.com/${encodeURIComponent(s)}`,
        };
        const newVendor = Object.keys(state).find((v) => !priorVendors.includes(v)) ?? Object.keys(state)[0]!;
        const url = BOARD_URL[newVendor]?.(state[newVendor]!) ?? null;
        signals.push({
          // The key needs the ORIGIN too. Keyed on the destination alone, a company that goes
          // Lever -> Ashby -> Lever never fires the second Lever move: ON CONFLICT(dedup_key) DO
          // NOTHING drops it as a duplicate of the first. from->to makes each distinct transition
          // its own event while still being idempotent — re-observing the SAME transition (which is
          // what a re-scan sees until the vendor set changes again) is still suppressed.
          dedupKey: `ats-switched:${domain}:${before || "none"}->${after}`, type: "ats-switched",
          title: `ATS changed: ${before || "none"} → ${after}`,
          url,
          detail: { from: before || null, to: after, boards: state },
        });
      }
    }
    // Persist. Never overwrite a KNOWN vendor set with an empty probe — a freeze/outage would wipe the
    // baseline and later fabricate a "none → vendor" adoption on recovery. Write "none" only as a real
    // baseline (first probe, or previously-empty) so a genuine later adoption still diffs.
    if (!ctx.readonly) { // readonly probe: don't consume the diff baseline
      if (haveNow) dbReplaceDomainState(domain, "ats", state);
      else if (!priorVendors.length) dbReplaceDomainState(domain, "ats", { none: "1" });
    }
    // Flag mirrors the persist logic: a definite vendor set → hit; a definite empty baseline → no hit;
    // an ambiguous empty probe over a known vendor (freeze/outage) → no flag (leave the prior flag).
    const flag = haveNow ? { hit: true, summary: `Uses ${Object.keys(state).join(", ")}` }
      : !priorVendors.length ? { hit: false, summary: "No ATS detected" } : undefined;
    return { facts, signals, flag };
  },
};
